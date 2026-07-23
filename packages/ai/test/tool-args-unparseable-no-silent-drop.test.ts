/**
 * Law-10 (no silent fallback) + dialect parity for unparseable tool arguments.
 *
 * The bug this suite locks out (BACKLOG HUNT2-silentfallback-toolargs-double-
 * encoded-drop, 2026-07-22): hermes/qwen3 #parseCall handled a double-encoded
 * arguments value (the model JSON-stringified the object, so `arguments` arrives
 * as a STRING) with an inner `try { args = repair(args) } catch { args = {} }`.
 * When the inner string was unrepairable the model's real arguments were SILENTLY
 * replaced with {} and the tool was invoked with empty args — no error, no trace.
 *
 * The fix removed that inner silent substitution: an unrepairable inner string now
 * throws to the single best-effort-end path, which still yields `arguments: {}`
 * (an unparseable blob is not a record) BUT the failure is no longer silent —
 * (1) the original bytes survive verbatim in the toolEnd `rawBlock`, so nothing is
 *     dropped from the record of what the model emitted, and
 * (2) empty arguments then hit the tool's own schema validation loudly (e.g. read
 *     rejects a missing `path`), instead of the parser fabricating a fake {}.
 *
 * Dialect parity is the OTHER half of the finding. The row hypothesized deepseek
 * "preserves the raw" for this case; it does not. deepseek's `return raw` lives in
 * coerceDsmlValue, which is PER-FIELD-VALUE inside its DSML format. For a whole
 * unparseable arguments blob deepseek's #parseArgs returns {} exactly like the
 * fixed hermes/qwen3 (recordOrEmpty / catch both give {}). So the three dialects
 * AGREE on this case — {} arguments, raw kept in rawBlock — which is what these
 * tests pin. (Implementing the row's literal "arguments not empty" would have made
 * hermes/qwen3 DIVERGE from deepseek, the opposite of the goal.)
 */
import { describe, expect, it } from "bun:test";
import { createInbandScanner, type Dialect, type InbandScanEvent } from "@veyyon/ai/dialect";
import { DEEPSEEK_TOOL_CALL_BEGIN, DEEPSEEK_TOOL_CALL_END, DEEPSEEK_TOOL_SEPARATOR } from "@veyyon/ai/dialect/deepseek";

const TOOLS = [
	{
		name: "read",
		description: "Read a file",
		parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
	},
] as unknown as NonNullable<Parameters<typeof createInbandScanner>[1]>["tools"];

function feed(dialect: Dialect, text: string): InbandScanEvent[] {
	const scanner = createInbandScanner(dialect, { tools: TOOLS, parseThinking: true });
	const events: InbandScanEvent[] = [];
	for (const char of text) events.push(...scanner.feed(char));
	events.push(...scanner.flush());
	return events;
}

function onlyToolEnd(events: InbandScanEvent[]): Extract<InbandScanEvent, { type: "toolEnd" }> {
	const ends = events.filter((e): e is Extract<InbandScanEvent, { type: "toolEnd" }> => e.type === "toolEnd");
	expect(ends.length).toBe(1);
	return ends[0]!;
}

const UNPARSEABLE = "%%definitely-not-json%%";

// The exact wire text each dialect uses for one `read` call whose arguments is a
// double-encoded / raw blob that cannot be parsed into an object.
function unparseableCall(dialect: Dialect): string {
	if (dialect === "deepseek") {
		// deepseek modern-JSON form: begin, name, sep, args-blob, end.
		return `${DEEPSEEK_TOOL_CALL_BEGIN}read${DEEPSEEK_TOOL_SEPARATOR}${UNPARSEABLE}${DEEPSEEK_TOOL_CALL_END}`;
	}
	// hermes/qwen3: arguments is a STRING (double-encoded) whose inner text is junk.
	return `<tool_call>\n{"name": "read", "arguments": "${UNPARSEABLE}"}\n</tool_call>`;
}

// A WELL-FORMED double-encoded args string for the positive twin: the inner JSON
// is valid and MUST be decoded to the real object, never dropped by the fix.
function wellFormedDoubleEncoded(dialect: Dialect): string {
	if (dialect === "deepseek") {
		return `${DEEPSEEK_TOOL_CALL_BEGIN}read${DEEPSEEK_TOOL_SEPARATOR}{"path": "/tmp/x"}${DEEPSEEK_TOOL_CALL_END}`;
	}
	return `<tool_call>\n{"name": "read", "arguments": "{\\"path\\": \\"/tmp/x\\"}"}\n</tool_call>`;
}

const DIALECTS: readonly Dialect[] = ["hermes", "qwen3", "deepseek"];

describe("unparseable tool arguments never silently vanish (Law 10) and agree across dialects", () => {
	for (const dialect of DIALECTS) {
		it(`${dialect}: an unparseable args blob yields empty arguments but preserves the raw bytes in rawBlock`, () => {
			const end = onlyToolEnd(feed(dialect, unparseableCall(dialect)));

			// The tool name still resolves so the call is dispatched (and then fails
			// LOUDLY at schema validation because required `path` is absent).
			expect(end.name).toBe("read");
			// No record could be built from the junk, so arguments is empty — the same
			// answer deepseek's #parseArgs gives, so the three dialects agree.
			expect(end.arguments).toEqual({});
			// The load-bearing anti-silent-drop assertion: the original bytes are NOT
			// discarded — they survive verbatim in rawBlock, so the operator/record can
			// still see exactly what the model emitted.
			expect(end.rawBlock ?? "").toContain(UNPARSEABLE);
		});

		it(`${dialect}: a WELL-FORMED double-encoded args string is decoded to the real object, not dropped`, () => {
			const end = onlyToolEnd(feed(dialect, wellFormedDoubleEncoded(dialect)));
			expect(end.name).toBe("read");
			// The valid inner JSON is decoded — proving the fix removed only the SILENT
			// {} substitution, not the legitimate decode of a parseable inner payload.
			expect(end.arguments).toEqual({ path: "/tmp/x" });
		});
	}

	it("all three dialects produce the SAME empty-arguments answer for the same unparseable blob (parity)", () => {
		const results = DIALECTS.map(dialect => onlyToolEnd(feed(dialect, unparseableCall(dialect))).arguments);
		for (const args of results) expect(args).toEqual({});
		// Explicit cross-dialect equality: hermes === qwen3 === deepseek.
		expect(results[0]).toEqual(results[1]!);
		expect(results[1]).toEqual(results[2]!);
	});
});
