import { describe, expect, it } from "bun:test";
import type { Tool } from "@veyyon/ai/types";
import { validateToolArguments } from "@veyyon/ai/utils/validation";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { createTools, type ToolSession } from "@veyyon/coding-agent/tools";

/**
 * THE BUG THIS LOCKS OUT.
 *
 * A single hostile tool call, `{ op: "x".repeat(50000) }` against `todo`, produced a
 * 50,437-character validation failure. Nothing in the payload was individually
 * oversized by the rules that were in place: the message was assembled from parts that
 * each had their own cap (a per-string cap, a per-array sample, a per-object key
 * budget, a depth marker) and NONE of those caps composed into a bound on the whole.
 * The rejected value was echoed inside an issue line, the issue lines were joined, the
 * received arguments were re-serialized alongside them, and the sum was unbounded.
 *
 * WHY IT MATTERS. A validation failure is not a log line. It is written into the
 * model's context and re-read on every retry, so an unbounded one displaces real
 * content inside the context window and is paid for again on each attempt.
 *
 * WHY THIS FILE EXISTS SEPARATELY FROM THE UNIT TEST. `packages/ai` has a bounds test
 * that drives a hand-written arktype schema shaped like `todo`. That proves the
 * bounding ALGORITHM composes. It cannot prove the bound survives contact with the
 * schemas veyyon actually ships: a real tool's issue text is produced from its own
 * `describe()` strings, enum sets and nested object shapes, and a tool whose schema
 * names a large closed set or a deep object can push a message past a ceiling the
 * synthetic schema never approaches. This suite drives EVERY builtin through the real
 * registry, which is where a regression would actually reach an operator.
 *
 * IF IT REGRESSES: a retry loop feeds the model tens of kilobytes of its own rejected
 * arguments, once per attempt, and the useful half of the message (the field name and
 * its accepted values) is buried where the model will not act on it.
 */

/**
 * The ceiling, stated as a bare number on purpose.
 *
 * `MAX_ERROR_MESSAGE_LENGTH` is deliberately NOT imported. A test that asserts
 * `message.length <= MAX_ERROR_MESSAGE_LENGTH` follows the constant wherever someone
 * moves it, so raising the cap to 50_000 would leave this suite green while restoring
 * the exact defect it is named after. The number is the contract.
 */
const CEILING = 1200;

function toolSession(): ToolSession {
	return {
		cwd: "/tmp/validation-ceiling",
		hasUI: true,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated(),
	};
}

/** Returns the failure message, or null when the payload was somehow accepted. */
function failureFor(tool: Tool, args: Record<string, unknown>): string | null {
	try {
		validateToolArguments(tool, { type: "toolCall", id: "c1", name: tool.name, arguments: args });
		return null;
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
}

/** An object nested `depth` levels deep, each level carrying a long string. */
function deepPayload(depth: number): Record<string, unknown> {
	let node: Record<string, unknown> = { leaf: "L".repeat(4_000) };
	for (let i = 0; i < depth; i += 1) node = { [`level${i}`]: node, sibling: "S".repeat(1_000) };
	return node;
}

/**
 * The four hostile shapes, one per mechanism that failed to compose.
 *
 * Each is INDIVIDUALLY capable of blowing the ceiling through a different part of the
 * assembled message, which is the point: the original caps bounded each part in
 * isolation and the total was the sum. A suite that only sent the huge single string
 * would have gone green the moment the per-string cap was added, and the array, key
 * and depth paths would have shipped unbounded exactly as they did.
 */
const HOSTILE_SHAPES: Array<[label: string, args: Record<string, unknown>]> = [
	// 1. One enormous scalar. This is the reported 50,437-char failure verbatim: the
	//    rejected value is echoed INSIDE the issue line, so a cap on the arguments echo
	//    alone never touched it.
	["one huge string", { op: "x".repeat(50_000) }],
	// 2. Many small strings in an array. Every element is far under any per-string cap,
	//    so a per-string cap bounds nothing here; only an array sample does.
	["huge array of small strings", { op: "nope", items: Array.from({ length: 5_000 }, (_, i) => `item ${i}`) }],
	// 3. Deep nesting. Indentation alone makes a deep echo mostly whitespace, and the
	//    echo walk is recursive, so this is both a size and a stack-safety case.
	["deeply nested object", { op: "nope", blob: deepPayload(200) }],
	// 4. Many keys. Each value is tiny and shallow; only a key budget bounds the count.
	["many keys", Object.fromEntries([["op", "nope"], ...Array.from({ length: 2_000 }, (_, i) => [`k${i}`, `v${i}`])])],
	// 5. Every mechanism at once, because the defect WAS composition. If the four above
	//    each stay under the ceiling but their sum does not, only this case fails.
	[
		"all four mechanisms combined",
		Object.fromEntries([
			["op", "x".repeat(50_000)],
			["items", Array.from({ length: 5_000 }, (_, i) => `item ${i}`)],
			["blob", deepPayload(200)],
			...Array.from({ length: 2_000 }, (_, i) => [`k${i}`, `v${i}`]),
		]),
	],
];

const tools = await createTools(toolSession() as never);
const BUILTINS: Tool[] = tools.filter(tool => tool?.parameters !== undefined);

/**
 * Every (shape, tool) failure message, computed ONCE.
 *
 * Driving 20 real schemas against payloads carrying a 200-deep object and a 5,000-element
 * array is genuinely expensive, and recomputing it per assertion pushed one case past the
 * default per-test timeout when the file ran alongside the rest of the suite. A test that
 * only fails under load is a flake, not a contract, so the work happens here and every
 * case below reads the same table. `null` means the payload was accepted.
 */
const FAILURES = new Map<string, string | null>(
	HOSTILE_SHAPES.flatMap(([label, args]) =>
		BUILTINS.map((tool): [string, string | null] => [`${label}|${tool.name}`, failureFor(tool, args)]),
	),
);

describe("a tool validation failure has a hard total ceiling", () => {
	/** Guards the guard: if the registry ever hands back nothing, every case below would pass vacuously. */
	it("drives the real builtin registry, not a synthetic schema", () => {
		expect(BUILTINS.length).toBeGreaterThanOrEqual(15);
		expect(BUILTINS.map(tool => tool.name)).toContain("todo");
		expect(BUILTINS.map(tool => tool.name)).toContain("bash");
	});

	for (const [label] of HOSTILE_SHAPES) {
		/**
		 * Reported as one assertion per SHAPE across all tools, with the offenders named
		 * in the expected value, so a failure says which tool and how far over rather
		 * than only that some tool was over.
		 */
		it(`bounds every builtin's failure to ${CEILING} characters for a ${label} payload`, () => {
			const over: string[] = [];
			let rejected = 0;
			for (const tool of BUILTINS) {
				const message = FAILURES.get(`${label}|${tool.name}`);
				if (message === null || message === undefined) continue;
				rejected += 1;
				if (message.length > CEILING) over.push(`${tool.name}=${message.length}`);
			}
			// The ceiling is only meaningful over payloads that actually got rejected.
			// Without this, a schema change that started ACCEPTING the hostile payload
			// would make the bound assertion pass while testing nothing.
			expect(`rejected>0: ${rejected > 0}`).toBe("rejected>0: true");
			expect(over).toEqual([]);
		});
	}

	/**
	 * The exact payload from the failure log, against the real `todo` schema, asserted
	 * on the reported number rather than on "it is bounded". 50,437 is the observed
	 * defect; anything in that neighbourhood is the defect back.
	 */
	it("keeps the reported 50,437-character todo failure under the ceiling", () => {
		const todo = BUILTINS.find(tool => tool.name === "todo");
		expect(todo?.name).toBe("todo");
		const message = failureFor(todo as Tool, { op: "x".repeat(50_000) });
		expect(message).not.toBeNull();
		expect((message as string).length).toBeLessThanOrEqual(CEILING);
		// And the useful half survived the cut. A ceiling met by truncating away the
		// field name would bound the cost and destroy the message's only purpose.
		expect(message).toContain("op");
	});

	/**
	 * A ceiling that is met by emitting a stub is not a fix. The message still has to
	 * carry the tool name so the model knows which call to correct.
	 */
	it("still names the failing tool at the ceiling", () => {
		const unnamed: string[] = [];
		for (const [key, message] of FAILURES) {
			if (message === null) continue;
			const toolName = key.slice(key.indexOf("|") + 1);
			if (!message.includes(toolName)) unnamed.push(key);
		}
		expect(unnamed).toEqual([]);
	});
});
