/**
 * In-band tool-call lifecycle balance for hermes/qwen3 (state-machine fix).
 *
 * The bug this suite locks out (hermes-qwen-toolstart-no-toolend-empty-args,
 * found 2026-07-22, MEDIUM): the hermes and qwen3 in-band scanners emit
 * `toolStart` the moment a NAME can be extracted from a partial `<tool_call>`
 * body, but emitted the matching `toolEnd` ONLY when the closed body parsed. Two
 * reachable branches left a toolStart with no toolEnd: (a) the stream ends with
 * no closing tag, and (b) the tag closes but the body does not parse. Because
 * these dialects set arguments only at toolEnd, the downstream projector — which
 * seeds the toolCall block with `arguments: {}` on toolStart — dispatched the
 * named tool with EMPTY arguments (or left a half-open block). The fix emits a
 * best-effort toolEnd on every exit path so a toolStart is always balanced.
 *
 * Companion Law-10 fix (HUNT2-silentfallback-toolargs-double-encoded-drop): a
 * double-encoded arguments string that fails to parse no longer silently becomes
 * {} inside #parseCall; it flows through the one best-effort-end path instead.
 *
 * Invariant asserted: every `toolStart` is matched by exactly one `toolEnd` with
 * the same id and the started name — for truncated, malformed, and well-formed
 * bodies alike.
 */
import { describe, expect, it } from "bun:test";
import { createInbandScanner, type Dialect, type InbandScanEvent } from "@veyyon/ai/dialect";

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

function starts(events: InbandScanEvent[]): Extract<InbandScanEvent, { type: "toolStart" }>[] {
	return events.filter((e): e is Extract<InbandScanEvent, { type: "toolStart" }> => e.type === "toolStart");
}
function ends(events: InbandScanEvent[]): Extract<InbandScanEvent, { type: "toolEnd" }>[] {
	return events.filter((e): e is Extract<InbandScanEvent, { type: "toolEnd" }> => e.type === "toolEnd");
}

/** Assert every announced toolStart has exactly one matching toolEnd (same id).
 *  The toolEnd name may be MORE complete than the start's (the start can fire on
 *  a partial streamed name like "r" before "read" finishes), so the toolStart's
 *  name must be a prefix of the toolEnd's — never a different tool, never absent. */
function expectBalanced(events: InbandScanEvent[]): void {
	const s = starts(events);
	const e = ends(events);
	expect(e.length).toBe(s.length);
	for (const start of s) {
		const matched = e.filter(end => end.id === start.id);
		expect(matched.length).toBe(1);
		expect(matched[0]!.name.startsWith(start.name)).toBe(true);
	}
}

const DIALECTS: readonly Dialect[] = ["hermes", "qwen3"];

describe("in-band tool-call lifecycle is always balanced", () => {
	for (const dialect of DIALECTS) {
		it(`${dialect}: a truncated tool_call (no closing tag) still emits a toolEnd`, () => {
			// A name is present so toolStart fires, then the stream is cut off
			// mid-arguments with no </tool_call>. Pre-fix: toolStart, no toolEnd,
			// tool dispatched with {} args.
			const events = feed(dialect, `<tool_call>\n{"name": "read", "arguments": {"path": "/etc/host`);
			expect(starts(events).length).toBe(1);
			expectBalanced(events);
			// The name was fully received before truncation, so the balancing toolEnd
			// carries the complete "read", not a stale partial prefix.
			expect(ends(events)[0]!.name).toBe("read");
		});

		it(`${dialect}: a closed tool_call with an unrepairable double-encoded args string stays balanced`, () => {
			// arguments is a STRING (double-encoded) whose inner content is not JSON.
			// Pre-fix the inner parse failure silently became {} inside #parseCall;
			// now it flows to the best-effort end. Either way the lifecycle balances.
			const events = feed(dialect, `<tool_call>\n{"name": "read", "arguments": "%%not-json%%"}\n</tool_call>`);
			expectBalanced(events);
		});

		it(`${dialect}: a well-formed tool_call carries its real arguments through to toolEnd`, () => {
			const events = feed(
				dialect,
				`<tool_call>\n{"name": "read", "arguments": {"path": "/etc/hosts"}}\n</tool_call>`,
			);
			expectBalanced(events);
			const end = ends(events)[0]!;
			expect(end.name).toBe("read");
			expect(end.arguments).toEqual({ path: "/etc/hosts" });
		});

		it(`${dialect}: a well-formed double-encoded args string is decoded, not dropped`, () => {
			// The model JSON-stringified the arguments object; a valid inner JSON must
			// be decoded to the real object, never lost.
			const events = feed(
				dialect,
				`<tool_call>\n{"name": "read", "arguments": "{\\"path\\": \\"/tmp/x\\"}"}\n</tool_call>`,
			);
			expectBalanced(events);
			expect(ends(events)[0]!.arguments).toEqual({ path: "/tmp/x" });
		});
	}
});
