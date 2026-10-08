/**
 * Revealing a long string argument parses the streamed call a bounded number of times, and every step
 * still shows the value the one-shot decode of the same prefix shows.
 *
 * WHY. The reveal parsed the whole growing call again every STREAMING_JSON_PARSE_MIN_GROWTH bytes while
 * the bytes that arrived since the last parse all belonged to a string argument its extractor already
 * decodes. A parse could recover nothing new: the arguments before that value were parsed already, none
 * after it had arrived, and the extractor's value replaces the parsed one. Revealing a 128 KB `write` in
 * 100-character steps parsed 27 MB of JSON.
 *
 * THE CLASS. Any argument the reveal decodes incrementally whose growth makes the reveal parse the call
 * again. Every key of every tool in `STREAMING_STRING_KEYS_BY_TOOL` is swept at run time, so a tool or a
 * key added to the table is driven here without a row. Each reveal counts the JSON characters handed to
 * `JSON.parse`, which every streaming parse tries first, and pins them under a small multiple of the
 * call. Each step's value for the key must equal what `decodeStreamedToolArgs` reads from the same
 * prefix. The argument ahead of the long value is longer than the throttle window, so it is still
 * arriving when the parse before the value runs, and it must be whole once the value has grown by the
 * window; the argument behind the value must arrive once the reveal ends. A reveal that stops parsing
 * as soon as a value opens, or for good once one has, is caught by one or the other.
 *
 * WHAT IT DOES NOT CATCH. A nested argument (`edits[].diff`) and an argument of a tool the table does not
 * list, which no extractor reads and which the throttled parse still decodes; a reveal that parses through
 * a parser other than `parseStreamingJson`.
 */
import { afterEach, describe, expect, it, spyOn, vi } from "bun:test";
import {
	decodeStreamedToolArgs,
	STREAMING_STRING_KEYS_BY_TOOL,
	ToolArgsRevealController,
} from "@veyyon/coding-agent/modes/terminal/controllers/tool-args-reveal";
import { STREAMING_JSON_PARSE_MIN_GROWTH } from "@veyyon/utils";

/** About 20 KB of source with quotes, backslashes, tabs and non-ASCII text, so every escape kind streams. */
const LONG_VALUE = Array.from(
	{ length: 400 },
	(_, line) => `\tconst value${line} = "item \\"${line}\\"" + 'é'.repeat(${line % 3}); // step ${line}`,
).join("\n");
/** Longer than the throttle window, so it is still arriving at the last parse before the long value. */
const LEAD = `ahead ${"a".repeat(STREAMING_JSON_PARSE_MIN_GROWTH + 44)} end`;
/** Past the throttle window, so the argument ahead of the tail is parsed before the reveal ends. */
const TAIL = "t".repeat(600);
/** Characters each step reveals, which is not a divisor of any escape's length. */
const STEP = 97;
/** JSON characters a reveal may hand the parser, as a multiple of the call's length. */
const PARSED_PER_CALL_CHARACTER = 6;

function callFor(key: string): string {
	return `{"lead":${JSON.stringify(LEAD)},${JSON.stringify(key)}:${JSON.stringify(LONG_VALUE)},"behind":1,"tail":${JSON.stringify(TAIL)}}`;
}

/** Each key once per distinct key list, since the extractor is built from the list. */
const CASES = [
	...new Map(
		Object.entries(STREAMING_STRING_KEYS_BY_TOOL).flatMap(([tool, keys]) =>
			keys.map(key => [`${keys.join(",")}|${key}`, { tool, key, keys }] as const),
		),
	).values(),
];

describe("revealing a long argument parses the call a bounded number of times", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("sweeps at least the tools whose arguments stream a file", () => {
		expect(CASES.map(({ tool, key }) => `${tool}.${key}`)).toEqual(
			expect.arrayContaining(["write.content", "edit.input", "eval.code", "bash.command"]),
		);
	});

	for (const { tool, key, keys } of CASES) {
		it(`${tool}.${key}`, () => {
			const call = callFor(key);
			const opened = call.indexOf(JSON.stringify(LONG_VALUE)) + 1;
			const source = { rawInput: false, streamingStringKeys: keys };
			const prefixes: string[] = [];
			for (let end = STEP; end < call.length + STEP; end += STEP) {
				prefixes.push(call.slice(0, Math.min(end, call.length)));
			}
			const expected = prefixes.map(prefix => decodeStreamedToolArgs(prefix, source)[key]);
			/** The steps by which the long value has grown past the throttle window. */
			const settled = prefixes.flatMap((prefix, step) =>
				prefix.length >= opened + STREAMING_JSON_PARSE_MIN_GROWTH + STEP ? [step] : [],
			);

			const parse = spyOn(JSON, "parse");
			const controller = new ToolArgsRevealController({ getSmoothStreaming: () => false, requestRender: () => {} });
			const target = { rawInput: false, exposeRawPartialJson: false, streamingStringKeys: keys };
			const shown = prefixes.map(prefix => controller.setTarget("call", prefix, target));
			const parsed = parse.mock.calls.reduce((sum, [text]) => sum + String(text).length, 0);
			parse.mockRestore();

			expect(shown.map(args => args[key])).toEqual(expected);
			expect(settled.length).toBeGreaterThan(0);
			expect(settled.map(step => shown[step]?.lead)).toEqual(settled.map(() => LEAD));
			expect(shown.at(-1)?.behind).toBe(1);
			expect(parsed).toBeLessThanOrEqual(PARSED_PER_CALL_CHARACTER * call.length);
		});
	}
});
