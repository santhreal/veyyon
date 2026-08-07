/**
 * A tool called from an eval cell is validated against its own schema, exactly
 * as one the model calls through the agent loop is.
 *
 * WHY THIS SUITE EXISTS. `agent-loop.ts` runs `validateToolArguments` before
 * `tool.execute`, so a model that omits a required argument gets a tool result
 * naming the field. The eval bridge called `execute` directly, which made a
 * cell the one caller in the process that could hand a tool a shape its schema
 * rejects. That is not a cosmetic gap: `tool.ask({ questions: [{ id, options
 * }] })` reached the ask dialog with no question text, `replaceTabs(undefined)`
 * threw inside a render pass, and an uncaught exception in the render loop took
 * down the session and every subagent under it.
 *
 * WHAT CLASS THIS CLOSES. For every tool the bridge can reach that declares a
 * required argument, a call missing that argument is refused before `execute`
 * runs. The tool list is enumerated from `BUILTIN_TOOLS` / `HIDDEN_TOOLS` at run
 * time and the required arguments come from each tool's own schema, so a new
 * tool, or a new required field on an existing one, is covered the day it lands
 * rather than when someone remembers to extend a list here. The bridge is also
 * the single choke point for all four transports (the JS worker, the kernel HTTP
 * bridge that serves Python and Ruby, the browser tab worker and cmux), and the
 * kernel case below drives that HTTP server for real rather than trusting that
 * a shared helper is shared.
 *
 * WHAT IT DOES NOT CATCH. A tool whose schema declares nothing required
 * validates nothing: validation cannot invent a contract the tool never
 * stated. A cross-field rule expressed in code rather than in the schema is
 * likewise still the tool's own business. And a bridge added later that calls
 * `tool.execute` itself instead of `callSessionTool` is a new caller, not a
 * regression of this one: it would need its own case here.
 */

import { describe, expect, it } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentTool, AgentToolResult } from "@veyyon/agent-core";
import type { TSchema } from "@veyyon/ai/types";
import { toolWireSchema } from "@veyyon/ai/utils/schema/wire";
import { callSessionTool } from "@veyyon/coding-agent/eval/js/tool-bridge";
import {
	disposeKernelToolBridge,
	ensureKernelToolBridge,
	registerKernelToolBridge,
} from "@veyyon/coding-agent/eval/kernel-tool-bridge";
import { BUILTIN_TOOLS, HIDDEN_TOOLS } from "@veyyon/coding-agent/tools";
import { AskTool } from "@veyyon/coding-agent/tools/ask";
import { INTENT_FIELD } from "@veyyon/wire";
import { type } from "arktype";
import { makeToolSession } from "../helpers/tool-session";

/**
 * The parts of a tool this suite reads. A concrete tool class narrows
 * `execute` to its own schema, so `AskTool` is not assignable to the erased
 * `AgentTool`; naming the members actually used keeps the real classes usable
 * without a cast.
 */
interface ToolUnderTest {
	name: string;
	label?: string;
	description: string;
	parameters: TSchema;
	lenientArgValidation?: boolean;
}

/** Thrown by every stand-in `execute`, so "the call got through" is observable. */
const EXECUTED = "the tool executed";

function ok(text: string): AgentToolResult {
	return { content: [{ type: "text", text }] };
}

/**
 * A stand-in carrying the real tool's name and schema but not its behaviour.
 * Validation is the thing under test, so a call that gets past it must be
 * observable without running `bash`, writing a file, or opening a dialog.
 *
 * `parameters` is delegated through a getter rather than copied: `edit`, `eval`
 * and `task` compute theirs from session state inside a getter that reads
 * `#private` fields, so a spread or an `Object.create` clone loses the schema
 * (or throws reading it) and the sweep would pass for the wrong reason.
 */
function refusingClone(real: ToolUnderTest): AgentTool {
	return {
		name: real.name,
		label: real.label ?? real.name,
		description: real.description,
		get parameters() {
			return real.parameters;
		},
		lenientArgValidation: real.lenientArgValidation,
		execute: async () => {
			throw new Error(EXECUTED);
		},
	};
}

/** The argument names a tool's own schema declares mandatory. */
function requiredArguments(tool: ToolUnderTest): string[] {
	const schema = toolWireSchema(tool);
	const required = schema.required;
	if (!Array.isArray(required)) return [];
	return required.filter((key): key is string => typeof key === "string" && key !== INTENT_FIELD);
}

describe("an eval cell cannot run a tool with arguments its schema rejects", () => {
	it("refuses the ask payload that killed a session: a question with no text", async () => {
		const ask = new AskTool(makeToolSession());
		const session = makeToolSession({ getToolByName: () => refusingClone(ask) });

		// The reported shape: every field but the one the dialog renders.
		const call = callSessionTool(
			"ask",
			{ questions: [{ id: "dest", header: "Skill dest", options: [{ label: "packages/argot" }], multi: false }] },
			{ session },
		);

		const error = await call.then(
			() => undefined,
			(err: unknown) => (err instanceof Error ? err : new Error(String(err))),
		);
		expect(error?.message).toContain('Validation failed for tool "ask"');
		expect(error?.message).toContain("question");
		// Never reached `execute`, so nothing rendered and nothing was recorded.
		expect(error?.message).not.toContain(EXECUTED);
	});

	it("refuses a missing required argument for every reachable tool that declares one", async () => {
		// Two stub gaps that would otherwise silence the sweep: `ask` is only
		// registered for a session that has a UI, and `ssh` resolves its host list
		// from the profile dir, so the settings stub has to answer
		// `getAgentDir()`. An empty dir yields no ssh hosts and that factory
		// returns null, which the sweep reads as "not reachable" rather than as a
		// tool it failed to check.
		const session = makeToolSession({
			hasUI: true,
			settings: { get: () => undefined, getAgentDir: () => path.join(os.tmpdir(), "veyyon-eval-bridge-sweep") },
		});
		const factories = Object.entries({ ...BUILTIN_TOOLS, ...HIDDEN_TOOLS });
		const checked: string[] = [];
		const unconstructable: string[] = [];
		const accepted: string[] = [];
		const optedOut: string[] = [];

		for (const [name, factory] of factories) {
			let real: AgentTool | null = null;
			try {
				real = await factory(session);
			} catch {
				unconstructable.push(name);
				continue;
			}
			if (!real) continue;
			if (requiredArguments(real).length === 0) continue;
			if (real.lenientArgValidation) {
				optedOut.push(real.name);
				continue;
			}

			const guarded = makeToolSession({ getToolByName: () => refusingClone(real) });
			const failure = await callSessionTool(real.name, {}, { session: guarded }).then(
				() => "accepted",
				(err: unknown) => (err instanceof Error ? err.message : String(err)),
			);
			checked.push(real.name);
			if (!failure.includes("Validation failed for tool") || failure.includes(EXECUTED)) {
				accepted.push(`${real.name}: ${failure}`);
			}
		}

		expect(accepted).toEqual([]);
		// A tool that cannot even be constructed here is a hole in the sweep, not
		// a tool that is safe.
		expect(unconstructable).toEqual([]);
		// `lenientArgValidation` switches this gate off for one tool, so the set
		// that opts out is pinned rather than counted. `yield` validates its own
		// structured payload against the caller's schema in `execute`; a second
		// name showing up here is a tool that stopped being validated by anyone,
		// and this assertion is where that decision gets recorded.
		expect(optedOut).toEqual(["yield"]);
		// The sweep is only a proof while it actually sweeps: a registry that
		// stops yielding tools with required arguments is a broken test, not a
		// codebase without contracts.
		expect(checked.length).toBeGreaterThan(5);
		expect(checked).toContain("ask");
	});

	it("still applies the schema's own repairs, so a numeric string keeps working", async () => {
		let seen: unknown;
		const tool: AgentTool = {
			name: "counter",
			label: "Counter",
			description: "counter",
			parameters: type({ limit: "number" }),
			execute: async (_id: string, args: unknown) => {
				seen = args;
				return ok("counted");
			},
		};
		const session = makeToolSession({ getToolByName: () => tool });

		expect(await callSessionTool("counter", { limit: "3" }, { session })).toBe("counted");
		expect(seen).toEqual({ limit: 3, [INTENT_FIELD]: "js prelude" });
	});

	it("keeps the injected intent out of validation but on the executed arguments", async () => {
		let seen: unknown;
		// A closed JSON schema, the shape an MCP server publishes. Validating the
		// harness-injected `i` against it would reject every bridge call.
		const tool: AgentTool = {
			name: "closed",
			label: "Closed",
			description: "closed",
			parameters: {
				type: "object",
				properties: { path: { type: "string" } },
				required: ["path"],
				additionalProperties: false,
			},
			execute: async (_id: string, args: unknown) => {
				seen = args;
				return ok("read");
			},
		};
		const session = makeToolSession({ getToolByName: () => tool });

		expect(await callSessionTool("closed", { path: "src/foo.ts" }, { session })).toBe("read");
		expect(seen).toEqual({ path: "src/foo.ts", [INTENT_FIELD]: "js prelude" });

		// The same closed schema still enforces itself.
		await expect(callSessionTool("closed", {}, { session })).rejects.toThrow(/Validation failed for tool "closed"/);
	});

	it("refuses arguments that are not an object at all", async () => {
		const tool: AgentTool = {
			name: "reader",
			label: "Reader",
			description: "reader",
			parameters: type({ path: "string" }),
			execute: async () => ok("read"),
		};
		const session = makeToolSession({ getToolByName: () => tool });

		await expect(callSessionTool("reader", "src/foo.ts", { session })).rejects.toThrow(
			/expects an object of arguments, received string/,
		);
		await expect(callSessionTool("reader", 7, { session })).rejects.toThrow(
			/expects an object of arguments, received number/,
		);
		await expect(callSessionTool("reader", null, { session })).rejects.toThrow(
			/expects an object of arguments, received null/,
		);
	});

	it("honors a tool that opts out of validation", async () => {
		let seen: unknown;
		const tool: AgentTool = {
			name: "lenient",
			label: "Lenient",
			description: "lenient",
			parameters: type({ path: "string" }),
			lenientArgValidation: true,
			execute: async (_id: string, args: unknown) => {
				seen = args;
				return ok("ran");
			},
		};
		const session = makeToolSession({ getToolByName: () => tool });

		expect(await callSessionTool("lenient", {}, { session })).toBe("ran");
		expect(seen).toEqual({ [INTENT_FIELD]: "js prelude" });
	});

	it("gates the Python and Ruby transport, not only the JS one", async () => {
		// The kernel languages reach a tool over the loopback HTTP bridge rather
		// than through the worker, so this drives that server for real: a shared
		// helper is only a shared gate if every transport actually goes through it.
		const ask = new AskTool(makeToolSession());
		const session = makeToolSession({ getToolByName: () => refusingClone(ask) });
		const info = await ensureKernelToolBridge();
		const unregister = registerKernelToolBridge("eval-arg-validation", "run-1", { toolSession: session });
		try {
			const res = await fetch(`${info.url}/v1/tool`, {
				method: "POST",
				headers: { "Content-Type": "application/json", Authorization: `Bearer ${info.token}` },
				body: JSON.stringify({
					session: "eval-arg-validation",
					run: "run-1",
					name: "ask",
					args: {
						questions: [{ id: "dest", options: [{ label: "packages/argot" }] }],
						[INTENT_FIELD]: "py prelude",
					},
				}),
			});
			const body = (await res.json()) as { ok: boolean; error?: string };
			expect(body.ok).toBe(false);
			expect(body.error).toContain('Validation failed for tool "ask"');
			expect(body.error).not.toContain(EXECUTED);
		} finally {
			unregister();
			await disposeKernelToolBridge();
		}
	});

	it("passes a well-formed call through unchanged", async () => {
		let seen: unknown;
		const tool: AgentTool = {
			name: "reader",
			label: "Reader",
			description: "reader",
			parameters: type({ path: "string", "offset?": "number" }),
			execute: async (_id: string, args: unknown) => {
				seen = args;
				return ok("contents");
			},
		};
		const session = makeToolSession({ getToolByName: () => tool });

		expect(
			await callSessionTool("reader", { path: "src/foo.ts", offset: 12, i: "reading a file" }, { session }),
		).toBe("contents");
		expect(seen).toEqual({ path: "src/foo.ts", offset: 12, [INTENT_FIELD]: "reading a file" });
	});
});
