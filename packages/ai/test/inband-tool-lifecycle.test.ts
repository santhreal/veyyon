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
 * the same id and the same name — for truncated, malformed, and well-formed
 * bodies alike. Both dialects run on `dialect/json-tool-call-scanner.ts`.
 *
 * Companion text contract: a block's bytes appear exactly once. A call carries
 * them on its toolEnd `rawBlock` and adds no visible text (qwen3 used to repeat a
 * cut-off body as text after its toolEnd); a block that yields no call is shown
 * as the text it was (hermes used to drop everything after an unclosed tag).
 *
 * NOT CAUGHT. The every-dialect sweep cuts each call off once, after its argument value; a cut inside
 * a tag, a name or a nested value is covered only for hermes and qwen3. The text contract is asserted
 * only for hermes and qwen3.
 */
import { describe, expect, it } from "bun:test";
import type { ToolCall } from "@veyyon/ai";
import { createInbandScanner, type Dialect, getDialectDefinition, type InbandScanEvent } from "@veyyon/ai/dialect";
import { DIALECTS } from "@veyyon/catalog/identity";

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

/** Assert every announced toolStart has exactly one matching toolEnd with the same id and name. */
function expectBalanced(events: InbandScanEvent[]): void {
	const s = starts(events);
	const e = ends(events);
	expect(e.length).toBe(s.length);
	for (const start of s) {
		expect(e.filter(end => end.id === start.id).map(end => end.name)).toEqual([start.name]);
	}
}

function visible(events: InbandScanEvent[]): string {
	let text = "";
	for (const event of events) if (event.type === "text") text += event.text;
	return text;
}

const JSON_BODY_DIALECTS: readonly Dialect[] = ["hermes", "qwen3"];

describe("in-band tool-call lifecycle is always balanced", () => {
	for (const dialect of JSON_BODY_DIALECTS) {
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
			// The bytes ride on the toolEnd's rawBlock; they are not shown again as text.
			expect(visible(events)).toBe("");
		});

		it(`${dialect}: a call named after its arguments is announced with its name when the tag closes`, () => {
			const events = feed(dialect, `<tool_call>\n{"arguments": {"path": "/a"}, "name": "read"}\n</tool_call>`);
			expectBalanced(events);
			expect(starts(events).map(start => start.name)).toEqual(["read"]);
			expect(ends(events)[0]!.arguments).toEqual({ path: "/a" });
		});

		it(`${dialect}: a block that names no call is shown as the text it was, closed or cut off`, () => {
			for (const text of [
				"Wrap each call in <tool_call></tool_call>.",
				"<tool_call>\n%%not a call%%\n</tool_call>",
				"The <tool_call> tag opens a call",
			]) {
				const events = feed(dialect, text);
				expect(starts(events)).toEqual([]);
				expect(ends(events)).toEqual([]);
				expect(visible(events), text).toBe(text);
			}
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

/**
 * The same balance for every dialect in the catalog, so a new dialect arrives covered: each one's own
 * rendered call is cut off just after its argument value, fed whole and per character, and every call
 * the scanner announced must end `unterminated`, carrying the argument value read before the cut. Fed
 * whole, nothing is left buffered at flush, which is where harmony left an announced call open; a JSON
 * body cut off before its closing brace is where deepseek, harmony and kimi ended a call with no
 * arguments. The whole rendered call ends once, never marked `unterminated`: the marker is what the
 * leaked-markup healer drops, so a closed call carrying it would never run.
 */
describe("a call the stream ends inside still ends with the arguments read, in every dialect", () => {
	const value = "src/a.ts";
	const call: ToolCall = { type: "toolCall", id: "call_0", name: "read", arguments: { path: value } };
	const unannounced: Dialect[] = [];

	function scan(dialect: Dialect, pieces: readonly string[]): InbandScanEvent[] {
		const scanner = createInbandScanner(dialect, { tools: TOOLS, parseThinking: true });
		const events = pieces.flatMap(piece => scanner.feed(piece));
		events.push(...scanner.flush());
		return events;
	}

	for (const dialect of DIALECTS) {
		it(dialect, () => {
			const rendered = getDialectDefinition(dialect).renderAssistantToolCalls([call], { tools: TOOLS });
			const cut = rendered.slice(0, rendered.indexOf(value) + value.length);
			for (const pieces of [[cut], [...cut]]) {
				const events = scan(dialect, pieces);
				expectBalanced(events);
				for (const end of ends(events)) {
					expect(end.arguments).toEqual({ path: value });
					expect(end.unterminated).toBe(true);
				}
				if (starts(events).length === 0) unannounced.push(dialect);
			}
			for (const pieces of [[rendered], [...rendered]]) {
				const closed = ends(scan(dialect, pieces));
				expect(closed.map(end => [end.name, end.arguments, end.unterminated])).toEqual([
					["read", { path: value }, undefined],
				]);
			}
		});
	}

	// A dialect that announces nothing before the cut proves nothing above; each is a recorded exception.
	// gemini (`tool_code` fence) and gemma (`<|tool_call>`) parse a call only once its closer
	// arrives and announce start and end together, so a call cut off before its closer is never announced.
	it("leaves only the recorded dialects unannounced before the cut", () => {
		expect([...new Set(unannounced)].sort()).toEqual(["gemini", "gemma"]);
	});
});
