import { describe, expect, it } from "bun:test";
import type { Tool, ToolCall } from "@veyyon/ai/types";
import { validateToolArguments } from "@veyyon/ai/utils/validation";
import { scope } from "arktype";

/**
 * A tool-validation failure is read by the model on every retry, so it has two
 * jobs: name the offending field and its accepted values, and stay small. The
 * failure recorded in the field (a Claude/Cursor-shaped `TodoWrite` call sent
 * to veyyon's `todo`) did neither: it re-embedded the caller's whole eight-item
 * array, twice, and named no legal `op`.
 *
 * ArkType words a rejection differently when it compiles its validators and
 * when it interprets them. Compiled, a described literal union lists its
 * members (`op must be "append", … or "view"`); jitless, as the CLI configures
 * it, the union reports its description (`op must be operation to apply`) and
 * only the accepted-values hint names the members. Every ArkType contract below
 * therefore runs once per mode, each schema built in a scope of that mode, so a
 * contract that holds only in the mode the test process happens to run in
 * fails here.
 */
const ARKTYPE_MODES = [
	{ name: "compiled", jitless: false },
	{ name: "jitless", jitless: true },
] as const;

const TODO_OPS = ["init", "start", "done", "rm", "drop", "append", "view"] as const;
const TODO_OP_UNION = '"init" | "start" | "done" | "rm" | "drop" | "append" | "view"';

/** Verbatim from section 1 of the operator's failure log. */
const TODO_WRITE_PAYLOAD = {
	merge: true,
	todos: [
		{ id: "4", content: "Install from GitHub releases path", status: "completed" },
		{ id: "5", content: "Run real-world usage scenarios", status: "completed" },
		{ id: "6", content: "Catalog speed reliability robustness flaws", status: "completed" },
		{ id: "7", content: "Fix blocking real-world flaws", status: "completed" },
		{ id: "8", content: "Rewrite multi-OS install docs", status: "completed" },
		{ id: "9", content: "Verify install copy-paste paths", status: "completed" },
		{ id: "10", content: "Encode fixes in tests", status: "completed" },
		{ id: "11", content: "Smoke test release readiness", status: "completed" },
	],
};

function failureFor(tool: Tool, args: ToolCall["arguments"]): string {
	try {
		validateToolArguments(tool, { type: "toolCall", id: "c1", name: tool.name, arguments: args });
	} catch (error) {
		if (error instanceof Error) return error.message;
		throw error;
	}
	throw new Error("expected validation to fail");
}

/** The issue lines of a failure, without its header or the echoed arguments. */
function issuesOf(message: string, toolName: string): string {
	return message.slice(
		`Validation failed for tool "${toolName}":\n`.length,
		message.indexOf("\n\nReceived arguments:"),
	);
}

/** How many times each todo op appears as a standalone token in the issue lines. */
function opMentions(message: string): string[] {
	const tokens = issuesOf(message, "todo").split(/[^A-Za-z0-9_$-]+/);
	return TODO_OPS.map(op => `${op}: ${tokens.filter(token => token === op).length}`);
}

for (const mode of ARKTYPE_MODES) {
	describe(`validation error bounds (ArkType ${mode.name})`, () => {
		const { type } = scope({}, { jitless: mode.jitless });
		/** The todo schema's shape, close enough that its accepted `op` set is real. */
		const todoTool: Tool = {
			name: "todo",
			description: "",
			parameters: type({
				op: type(TODO_OP_UNION).describe("operation to apply"),
				"task?": type("string").describe("task content"),
			}),
		};

		it("names the accepted op values instead of only reporting the field as missing", () => {
			const message = failureFor(todoTool, TODO_WRITE_PAYLOAD);

			expect(message).toContain("op must be operation to apply (was missing)");
			expect(message).toContain("(accepted: append | done | drop | init | rm | start | view)");
		});

		it("elides the caller's array instead of echoing every element", () => {
			const message = failureFor(todoTool, TODO_WRITE_PAYLOAD);

			// One element survives so the shape is still diagnosable.
			expect(message).toContain("Install from GitHub releases path");
			expect(message).toContain("… 7 more of 8 element(s) elided");
			for (const content of TODO_WRITE_PAYLOAD.todos.slice(1)) {
				expect(message).not.toContain(content.content);
			}
		});

		it("keeps the whole failure short enough to re-read on every retry", () => {
			const message = failureFor(todoTool, TODO_WRITE_PAYLOAD);

			// The logged failure ran past 1400 characters and was injected twice.
			expect(message.length).toBeLessThan(600);
		});

		it("drops the normalized half when it carries nothing the original did not", () => {
			const message = failureFor(todoTool, TODO_WRITE_PAYLOAD);

			expect(message).not.toContain('"normalized"');
		});

		it("bounds a payload whose fields are individually under the per-string cap", () => {
			const wide: Record<string, string> = { op: "nope" };
			for (let index = 0; index < 40; index++) wide[`field${index}`] = `value ${index}`;

			const message = failureFor(todoTool, wide);

			expect(message).toContain("more of 41 key(s) elided");
			expect(message.length).toBeLessThan(900);
		});

		/**
		 * Locks out: the set named twice (the validator's list plus the hint) or
		 * not at all (a description plus no hint). Whichever of the two names
		 * it, every accepted value appears exactly once.
		 */
		it("names every accepted value once when the op is present but not one of them", () => {
			const message = failureFor(todoTool, { op: "finish" });

			expect(opMentions(message)).toEqual(TODO_OPS.map(op => `${op}: 1`));
		});

		/**
		 * Locks out: an oversized rejected VALUE escaping every bound because the
		 * caps were per-argument and the validator quotes the value inside the
		 * issue line, not in the echoed arguments. Measured before the fix: a 50k
		 * `op` produced a 50,437-character failure, re-read by the model on every
		 * retry, which is 35x the payload the operator's log already called too
		 * big. Jitless, the accepted values follow that quote, so the line is
		 * bounded before the hint is appended: cut after it, the failure named no
		 * legal value.
		 */
		it("bounds the whole failure when the rejected value dwarfs every per-field cap", () => {
			const message = failureFor(todoTool, { op: "x".repeat(50_000) });

			expect(message.length).toBeLessThanOrEqual(1200);
			// The useful half survives the cut: the field and every accepted value.
			expect(message).toContain("op must be");
			expect(opMentions(message)).toEqual(TODO_OPS.map(op => `${op}: 1`));
			expect(message).toContain("[truncated");
			expect(message).not.toContain("x".repeat(1000));
		});

		/**
		 * Locks out: a deeply nested payload overflowing the stack inside the
		 * schema-agnostic normalization walks, so `validateToolArguments` threw
		 * `RangeError: Maximum call stack size exceeded` instead of a
		 * `ValidationError`. `JSON.parse` accepts 100k levels, so the depth
		 * reaches this code intact. If it regresses, a malformed tool call stops
		 * being a recoverable validation failure and becomes an unhandled runtime
		 * error.
		 */
		it("reports a validation failure rather than overflowing on a deeply nested payload", () => {
			let blob: Record<string, unknown> = { leaf: 1 };
			for (let level = 0; level < 20_000; level++) blob = { nested: blob };

			const message = failureFor(todoTool, { op: "nope", blob });

			expect(message).toContain('Validation failed for tool "todo"');
			expect(message).toContain("op must be");
			expect(message).toContain("elided below depth 8");
			expect(message.length).toBeLessThanOrEqual(1200);
		});

		/**
		 * Locks out: trusting the per-node caps to compose. Each hostile shape
		 * below targets a different cap (issue text, key count, array length,
		 * nesting), and the contract is one ceiling over the whole message
		 * regardless of which one the payload attacks.
		 */
		it("holds one ceiling across every hostile payload shape", () => {
			let deep: Record<string, unknown> = { leaf: 1 };
			for (let level = 0; level < 500; level++) deep = { nested: deep };
			const wide = Object.fromEntries([
				["op", "nope"],
				...Array.from({ length: 500 }, (_, index) => [`field${index}`, `value ${index}`]),
			]);
			const payloads: Array<[string, ToolCall["arguments"]]> = [
				["long rejected value", { op: "z".repeat(50_000) }],
				["long string argument", { op: "nope", task: "y".repeat(50_000) }],
				["many keys", wide],
				["huge array", { op: "nope", items: Array.from({ length: 5_000 }, (_, index) => `item ${index}`) }],
				["deep nesting", { op: "nope", blob: deep }],
			];

			for (const [label, args] of payloads) {
				const message = failureFor(todoTool, args);
				expect(`${label}: ${message.length <= 1200}`).toBe(`${label}: true`);
			}
		});

		it("stays silent about accepted values when the field is not a closed set", () => {
			const openTool: Tool = { name: "open", description: "", parameters: type({ task: "string" }) };

			// A boolean is the one type the string coercion refuses, so this reaches
			// the failure path instead of being repaired into "true".
			const message = failureFor(openTool, { task: true });

			expect(message).toContain("task");
			expect(message).not.toContain("accepted:");
		});

		/**
		 * Locks out: the fix for the substring suppression below turning into
		 * "always annotate", which would double-print the set on every ArkType
		 * rejection that already quotes each literal. An undescribed literal
		 * union is listed by ArkType in both modes.
		 */
		it("does not re-list a set the validator already spelled out", () => {
			const spelledOutTool: Tool = { name: "todo", description: "", parameters: type({ op: TODO_OP_UNION }) };

			const message = failureFor(spelledOutTool, { op: "xxx" });

			expect(message).toContain(
				'- op: op must be "append", "done", "drop", "init", "rm", "start" or "view" (was "xxx")',
			);
			expect(message).not.toContain("accepted:");
		});
	});
}

describe("validation error bounds (JSON Schema)", () => {
	/**
	 * Locks out: the accepted-values hint suppressed by ACCIDENTAL substring
	 * matches. The suppression check was `values.every(v => message.includes(v))`,
	 * raw containment anywhere in the text, so the enum `['a','b']` was read as
	 * "already listed" by the plain JSON-Schema boilerplate `must be one of the
	 * allowed enum values` — 'a' inside "allowed", 'b' inside "be". If it
	 * regresses, every closed set whose values are all substrings of the
	 * boilerplate (single letters, `['s','m','l']`) silently loses its hint on
	 * every MCP server and custom tool, leaving the model no legal value.
	 */
	it("names the accepted values when every value is a substring of the boilerplate", () => {
		const substringEnumTool: Tool = {
			name: "ab",
			description: "",
			parameters: {
				type: "object",
				properties: {
					nested: { type: "object", properties: { mode: { type: "string", enum: ["a", "b"] } } },
				},
			} as unknown as Tool["parameters"],
		};

		const message = failureFor(substringEnumTool, { nested: { mode: "q" } });

		expect(message).toContain("- nested/mode: must be one of the allowed enum values (accepted: a | b)");
	});

	/**
	 * Locks out: the issue-length bound evicting the one actionable line. Issues
	 * arrive in schema-property order and `boundErrorText` keeps the HEAD, so a
	 * wide rejection spent the whole 400-char budget on generic "is required"
	 * lines and cut the enum's accepted-values line entirely (it used to stop at
	 * `- f18: … [truncated 286 chars]`). Both halves are asserted because either
	 * alone is satisfiable by breaking the other: keeping the line by raising the
	 * cap, or holding the cap by dropping the line.
	 */
	it("keeps the accepted-values line ahead of generic required lines under the bound", () => {
		const properties: Record<string, unknown> = {};
		const required: string[] = [];
		for (let index = 0; index < 30; index++) {
			properties[`f${index}`] = { type: "string" };
			required.push(`f${index}`);
		}
		properties.op = { type: "string", enum: ["init", "view"] };
		required.push("op");
		const wideTool: Tool = {
			name: "wide",
			description: "",
			parameters: { type: "object", properties, required } as unknown as Tool["parameters"],
		};

		const issues = issuesOf(failureFor(wideTool, {}), "wide");

		expect(issues.split("\n")[0]).toBe("  - op: is required (accepted: init | view)");
		expect(issues.length).toBeLessThanOrEqual(400);
		expect(issues).toContain("[truncated ");
	});
});
