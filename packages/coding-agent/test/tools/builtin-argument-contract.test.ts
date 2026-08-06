import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Tool } from "@veyyon/ai";
import { toolWireSchema, validateToolArguments } from "@veyyon/ai";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { createTools } from "@veyyon/coding-agent/tools";
import { removeWithRetries } from "@veyyon/utils";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "../helpers/settings-test-state";
import { makeToolSession } from "../helpers/tool-session";

/**
 * TOOLE-1: every builtin tool must reject a malformed call with a clear error,
 * across the whole set rather than one tool at a time.
 *
 * A model produces tool calls from a schema it was shown, and it gets them
 * wrong: a required field omitted, a number where a string belongs, a whole
 * object where a scalar was asked for. What happens next decides whether the
 * agent recovers. A validation error naming the tool and the field is a
 * correction the model can act on in one turn. A crash ends the turn, and a
 * silent no-op is worse than either, because the model believes the call
 * succeeded and builds on a result that never happened.
 *
 * This is asserted at the VALIDATOR, on the real schema every builtin publishes,
 * rather than by executing each tool. That is deliberate on two counts:
 *
 *  - validation is where the contract actually lives. `agent-loop` runs
 *    `validateToolArguments` before `execute`, so a tool never sees arguments
 *    that failed it, and testing through `execute` would be testing the wrong
 *    layer;
 *  - executing 30-odd builtins to see them reject bad input would spawn shells,
 *    open browsers, and reach the network for no added coverage.
 *
 * The table is derived from the real registry, so a builtin added later is
 * covered the day it lands, with no list here to remember to update.
 */
describe("every builtin tool's argument contract", () => {
	let settingsState: SettingsTestState | undefined;
	let tmpDir = "";
	let tools: Tool[] = [];

	beforeAll(async () => {
		settingsState = beginSettingsTest();
		await Settings.init({ inMemory: true });
	});

	afterAll(() => {
		restoreSettingsTestState(settingsState);
		settingsState = undefined;
	});

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "builtin-args-"));
		tools = await createTools(
			makeToolSession({
				cwd: tmpDir,
				hasUI: false,
				getSessionFile: () => null,
				getSessionSpawns: () => "*",
				getArtifactsDir: () => path.join(tmpDir, "artifacts"),
				allocateOutputArtifact: async () => ({ id: "a", path: path.join(tmpDir, "a.log") }),
				settings: Settings.isolated({}),
				enableLsp: false,
				// The eval tool probes for language kernels at construction; skipping it
				// keeps this suite from shelling out just to build the table.
				skipPythonPreflight: true,
				getPlanModeState: () => ({ enabled: false }),
			}),
		);
	});

	afterEach(async () => {
		if (tmpDir) {
			await removeWithRetries(tmpDir);
			tmpDir = "";
		}
	});

	/**
	 * The tool's parameters as JSON Schema.
	 *
	 * Tools declare ArkType (or Zod) schemas, not raw JSON Schema, so reading
	 * `tool.parameters.required` directly yields a validator internal rather than
	 * a field list. `toolWireSchema` is the same conversion the validator and the
	 * wire format use, which keeps this table describing what the model is
	 * actually shown.
	 */
	function schemaOf(tool: Tool): { required?: string[]; properties?: Record<string, { type?: string }> } {
		return toolWireSchema(tool) as { required?: string[]; properties?: Record<string, { type?: string }> };
	}

	/** Tools that declare at least one required argument, the only ones a missing-arg case applies to. */
	function toolsWithRequiredArgs(): Tool[] {
		return tools.filter(tool => (schemaOf(tool).required?.length ?? 0) > 0);
	}

	/** Validate a call and return the error, or undefined when it was accepted. */
	function validationError(tool: Tool, args: Record<string, unknown>): Error | undefined {
		try {
			validateToolArguments(tool, { type: "toolCall", id: "call-1", name: tool.name, arguments: args });
			return undefined;
		} catch (err) {
			return err as Error;
		}
	}

	it("the table is built from the real registry and is not empty", () => {
		// The guard that keeps this file honest. Every test below iterates the table,
		// so an empty or tiny one would turn the whole suite into a no-op that
		// reports success.
		// Named rather than counted: a count drifts as settings gate tools in and
		// out (this session builds 18 of the ~37 declared names), while these five
		// are the ones every agent turn depends on, so their absence means the table
		// was built wrong rather than merely built small.
		const names = tools.map(tool => tool.name);
		for (const required of ["read", "write", "edit", "bash", "grep"]) {
			expect(names).toContain(required);
		}
		expect(toolsWithRequiredArgs().length).toBeGreaterThan(5);
	});

	it("every tool publishes a schema the validator can read", () => {
		// A tool with no parameter schema is unvalidatable: the loop would pass
		// whatever the model produced straight into `execute`.
		const missing = tools.filter(tool => !tool.parameters).map(tool => tool.name);

		expect(missing).toEqual([]);
	});

	describe("a call missing a required argument", () => {
		it("is rejected by every tool that has one", () => {
			// The single most common malformed call. Reported as one list rather than
			// per-tool assertions so a failure names every offender at once instead of
			// stopping at the first.
			const accepted = toolsWithRequiredArgs()
				.filter(tool => validationError(tool, {}) === undefined)
				.map(tool => tool.name);

			expect(accepted).toEqual([]);
		});

		it("and the rejection names the tool", () => {
			// The model sees several tool results per turn. Without the name it cannot
			// tell which call to fix.
			const unnamed = toolsWithRequiredArgs()
				.filter(tool => !validationError(tool, {})?.message.includes(tool.name))
				.map(tool => tool.name);

			expect(unnamed).toEqual([]);
		});

		it("and the rejection names the missing field", () => {
			// Naming the tool but not the field leaves the model to guess which of
			// several arguments it forgot, which is how a retry loop starts.
			const silentAboutField = toolsWithRequiredArgs()
				.filter(tool => {
					const field = schemaOf(tool).required?.[0];
					const message = validationError(tool, {})?.message ?? "";
					return field !== undefined && !message.includes(field);
				})
				.map(tool => tool.name);

			expect(silentAboutField).toEqual([]);
		});
	});

	describe("a wrong-typed argument, and how far the repair reaches", () => {
		// The validator deliberately repairs LLM quirks rather than failing on them:
		// numeric strings become numbers, JSON-encoded containers are parsed, and an
		// object in a string field is stringified (a documented, separately tested
		// contract in `packages/ai/test/tool-argument-coercion.test.ts`). Each of
		// those recovers a value the model plainly meant. A boolean does not, which
		// is where the repair now stops.

		it("a boolean in a required string field is REJECTED, not coerced", () => {
			// The defect this suite found (TOOLE1-SCALAR-TO-STRING-REACH). Before the
			// fix, `bash({command: true})` validated as `{command: "true"}` and ran the
			// real `true` binary, and `read({path: true})` read a file named "true":
			// both a plausible-looking success the model had no way to learn from.
			const accepted = tools
				.filter(tool => {
					const schema = schemaOf(tool);
					const field = schema.required?.find(name => schema.properties?.[name]?.type === "string");
					if (field === undefined) return false;
					return validationError(tool, { [field]: true }) === undefined;
				})
				.map(tool => tool.name);

			expect(accepted).toEqual([]);
		});

		it("named for the two that made it dangerous", () => {
			// Asserted by name as well as by sweep, because these are the calls whose
			// coerced form did real work: one runs a program, one opens a file.
			const bash = tools.find(tool => tool.name === "bash");
			const read = tools.find(tool => tool.name === "read");
			expect(bash).toBeDefined();
			expect(read).toBeDefined();

			expect(validationError(bash as Tool, { command: true })?.message).toContain("bash");
			expect(validationError(read as Tool, { path: true })?.message).toContain("read");
		});

		it("a value of a type with no repair rule is still rejected", () => {
			// WHY: the repair has a floor. A NUMBER field given a non-numeric string
			// cannot be reconciled, and must surface as a validation error naming the
			// tool rather than as NaN reaching the tool and being used as an offset, a
			// line number, or a timeout.
			//
			// The call is otherwise well formed (every required string filled), so the
			// only thing that can reject it is the number field itself. An earlier
			// version of this test scanned for a REQUIRED numeric field, found none,
			// and asserted nothing at all.
			const cases = tools.flatMap(tool => {
				const schema = schemaOf(tool);
				const required = schema.required ?? [];
				const allStrings = required.every(field => {
					const property = schema.properties?.[field] as { type?: string; enum?: unknown[] } | undefined;
					return property?.type === "string" && property.enum === undefined;
				});
				if (!allStrings) return [];
				const numeric = Object.entries(schema.properties ?? {}).find(
					([, property]) => property?.type === "number" || property?.type === "integer",
				);
				if (!numeric) return [];
				const args: Record<string, unknown> = {};
				for (const field of required) args[field] = "x";
				args[numeric[0]] = "not-a-number";
				return [{ name: tool.name, field: numeric[0], error: validationError(tool, args) }];
			});

			// Named rather than counted, the way the registry guard above is: these two
			// are always built, so their absence means the sweep found nothing.
			const covered = cases.map(c => c.name);
			expect(covered).toContain("bash");
			expect(covered).toContain("glob");

			const accepted = cases.filter(c => c.error === undefined).map(c => `${c.name}.${c.field}`);
			expect(accepted).toEqual([]);
			for (const c of cases) expect(c.error?.message).toContain(c.name);
		});
	});

	describe("what must NOT be rejected", () => {
		it("a well-formed minimal call passes for every plain-string tool", () => {
			// The control, and the one that makes the rest meaningful: a validator that
			// rejected everything would satisfy every assertion above while making the
			// agent unable to call a single tool.
			//
			// Scoped to tools whose required fields are all plain strings. The others
			// (enums, unions, interdependent fields) have no generic "valid" value a
			// table can synthesize, and guessing one would fail for a reason that says
			// nothing about the contract under test; their happy paths are covered by
			// their own suites.
			const plainStringTools = tools.filter(tool => {
				const schema = schemaOf(tool);
				const required = schema.required ?? [];
				if (required.length === 0) return false;
				return required.every(field => {
					const property = schema.properties?.[field] as { type?: string; enum?: unknown[] } | undefined;
					return property?.type === "string" && property.enum === undefined;
				});
			});
			expect(plainStringTools.length).toBeGreaterThan(3);

			const rejected = plainStringTools
				.filter(tool => {
					const args: Record<string, unknown> = {};
					for (const field of schemaOf(tool).required ?? []) args[field] = "x";
					return validationError(tool, args) !== undefined;
				})
				.map(tool => tool.name);

			expect(rejected).toEqual([]);
		});
	});

	describe("a call that never parsed as JSON", () => {
		it("is reported as a parse failure, not as a missing argument", () => {
			// A truncated stream leaves the loop with a parse marker instead of
			// arguments. Reporting that as "missing required field" would send the
			// model off adding a field it already sent, when the real fix is to emit
			// valid JSON.
			const tool = toolsWithRequiredArgs()[0];
			expect(tool).toBeDefined();

			const error = validationError(tool as Tool, {
				__parseError: "Unexpected end of JSON input",
				__rawJson: '{"path": "a.ts"',
			});

			expect(error?.message).toContain("not valid JSON");
			expect(error?.message).toContain("Unexpected end of JSON input");
		});
	});
});
