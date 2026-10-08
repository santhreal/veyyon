/**
 * A tool call whose string argument carries wire tags, its own dialect's or another's, scans to the same events
 * however the provider cut the stream, and comes back as it was rendered unless the tag is its dialect's closer.
 *
 * WHY THIS SUITE EXISTS. Each in-band scanner reads a call body up to a literal closer through `BlockBody` in
 * `dialect/coercion.ts`, which moves the text proven to precede the closer out of the unread buffer and holds back
 * only a suffix that could begin it. Before it, every scanner kept the whole body in its buffer and searched it again
 * on each delta, which cost O(n·k) for n bytes in k deltas. A hold that is one character short emits half a closer as
 * body text; a hold kept after the body closes, or a rejected closer counted again at the stream's end, moves text
 * between the call and the reply. Each shows only at some chunk boundaries. pi-native also read a `</call:NAME>`
 * inside a string element as the call's end when the delta that carried it was the one that settled the body's form,
 * so the argument came back cut at one chunking and whole at another.
 *
 * CLASS CLOSED. Every dialect in `DIALECTS` (read from the catalog at run time) is scanned with every tag any dialect
 * renders, and every proper prefix of one, inside a string argument: whole, per character, and in 2-, 3-, 5- and
 * 7-byte pieces must yield one event sequence, argument deltas joined. The arguments that do not come back are
 * pinned per dialect by exact equality, so a new dialect, a new rendered tag, or a scanner that starts losing a tag
 * turns the suite red. Every reply is also cut off at every offset, which reaches the end-of-stream path with a
 * partial closer held, a rejected closer pending, and a body never closed: the cut reply scans the same whole and per
 * character; a call it ends `unterminated` has a raw block that runs to the end of the input, with no text after it,
 * so a partial closer is neither dropped nor shown; a second flush emits nothing, since the Ollama turn flushes its
 * healer on the `done` line and again when the turn ends; and a reply fed after the flush scans as it does on a new
 * scanner. The last two are what `createInbandScanner` makes of every dialect: DeepSeek emitted a cut-off call's
 * partial name as text on the second flush, and Kimi, DeepSeek, Harmony, Gemini and Gemma swallowed a following
 * reply after a flush inside a call.
 *
 * NOT CAUGHT. Timing: a hold that delays a delta but still emits it is invisible, because only the final stream is
 * compared. Apart from the raw-block rule, a cut-off reply is compared across chunkings rather than with an expected
 * result, so a truncated call that every chunking scans the same wrong way passes. `BlockBody` itself is held to its
 * contract in `a-block-body-reads-to-its-first-accepted-closer-however-its-buffer-is-cut.test.ts`.
 */
import { describe, expect, it } from "bun:test";
import { isDeepStrictEqual } from "node:util";
import type { Context, ToolCall } from "@veyyon/ai";
import { createInbandScanner, getDialectDefinition, type InbandScanEvent } from "@veyyon/ai/dialect";
import { DIALECTS } from "@veyyon/catalog/identity";

type Dialect = (typeof DIALECTS)[number];

const TOOLS = [
	{
		name: "write",
		description: "Write a file",
		parameters: {
			type: "object",
			properties: { path: { type: "string" }, content: { type: "string" } },
			required: ["path", "content"],
		},
	},
] as unknown as NonNullable<Context["tools"]>;

/** Characters a JSON-bodied scanner reads as string or object structure, which no renderer emits as a tag. */
const STRUCTURAL = ['"', "\\", "}", "]", '"}', "\n"];

/** Every tag-shaped run a dialect puts on the wire around thinking and a call: `<…>` spans and backtick fences. */
function renderedTags(dialect: Dialect): string[] {
	const definition = getDialectDefinition(dialect);
	const call: ToolCall = {
		type: "toolCall",
		id: "functions.write:0",
		name: "write",
		arguments: { path: "p", content: "c\nd" },
	};
	const wire = `${definition.renderThinking("t")}\n${definition.renderAssistantToolCalls([call], { tools: TOOLS })}`;
	return wire.match(/<[^<>\n]+>|`{2,}[a-z_]*/g) ?? [];
}

/** Every tag any dialect renders; and those, every proper prefix of one at least two characters long, and {@link STRUCTURAL}. */
function hostileTags(): { tags: string[]; withPrefixes: string[] } {
	const tags = new Set<string>();
	for (const dialect of DIALECTS) for (const tag of renderedTags(dialect)) tags.add(tag);
	const withPrefixes = new Set(STRUCTURAL);
	for (const tag of tags) for (let end = 2; end <= tag.length; end++) withPrefixes.add(tag.slice(0, end));
	return { tags: [...tags].sort(), withPrefixes: [...withPrefixes].sort() };
}

function scan(dialect: Dialect, pieces: readonly string[]): InbandScanEvent[] {
	const scanner = createInbandScanner(dialect, { tools: TOOLS, parseThinking: true });
	const events: InbandScanEvent[] = [];
	for (const piece of pieces) events.push(...scanner.feed(piece));
	events.push(...scanner.flush());
	return events;
}

function cut(text: string, size: number): string[] {
	const out: string[] = [];
	for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
	return out;
}

/**
 * The stream with adjacent text, thinking and same-argument deltas joined, and minted ids replaced by their order:
 * the only parts of a stream that may depend on where it was cut.
 */
function comparable(events: readonly InbandScanEvent[]): string {
	const out: InbandScanEvent[] = [];
	const ids = new Map<string, string>();
	for (const source of events) {
		if ("id" in source && !ids.has(source.id)) ids.set(source.id, `#${ids.size}`);
		const event = "id" in source ? { ...source, id: ids.get(source.id) ?? source.id } : source;
		const last = out[out.length - 1];
		if (event.type === "text" && last?.type === "text") {
			out[out.length - 1] = { ...last, text: last.text + event.text };
		} else if (event.type === "thinkingDelta" && last?.type === "thinkingDelta") {
			out[out.length - 1] = { ...last, delta: last.delta + event.delta };
		} else if (
			event.type === "toolArgDelta" &&
			last?.type === "toolArgDelta" &&
			last.id === event.id &&
			last.key === event.key
		) {
			out[out.length - 1] = { ...last, delta: last.delta + event.delta };
		} else {
			out.push(event);
		}
	}
	return JSON.stringify(out);
}

function reply(dialect: Dialect, token: string): { text: string; call: ToolCall } {
	const call: ToolCall = {
		type: "toolCall",
		id: "functions.write:0",
		name: "write",
		arguments: { path: "src/a.ts", content: `a${token}b ${token}${token}c` },
	};
	const definition = getDialectDefinition(dialect);
	return { text: `ok ${definition.renderAssistantToolCalls([call], { tools: TOOLS })} done`, call };
}

/**
 * The tokens inside a string argument that do not come back, per dialect: the closer its wire cannot escape, a prefix
 * that doubles into it, or a token the scanner reads as structure (harmony's special tokens, and the unterminated
 * `</parameter` the xml family accepts as a closer).
 */
const LOST: Record<Dialect, string[]> = {
	glm: ["</arg_value>"],
	hermes: ["</tool_call>"],
	kimi: ["<|tool_call_end|>"],
	xml: ["</parameter", "</parameter>"],
	anthropic: ["</parameter", "</parameter>"],
	deepseek: ["<｜tool▁call▁end｜>"],
	harmony: ["<|call|>", "<|channel|>", "<|end|>", "<|message|>", "<|start|>"],
	qwen3: ["</tool_call>"],
	gemini: [
		"``",
		"```",
		"```t",
		"```th",
		"```thi",
		"```thin",
		"```think",
		"```thinki",
		"```thinkin",
		"```thinking",
		"```to",
		"```too",
		"```tool",
		"```tool_",
		"```tool_c",
		"```tool_co",
		"```tool_cod",
		"```tool_code",
	],
	gemma: ['<|"|>'],
	minimax: ["</parameter", "</parameter>"],
	"pi-native": [],
};

const { tags: TAGS, withPrefixes: TOKENS } = hostileTags();

describe("a tool argument carrying wire tags streams the same however it is cut", () => {
	it("draws its tags from what the dialects render", () => {
		// The sweep is only as wide as the tags it finds; these are the closers the scanners read a body up to.
		const closers = [
			"</tool_call>",
			"<|tool_call_end|>",
			"</parameter>",
			"<｜tool▁call▁end｜>",
			"```",
			'<|"|>',
			"</call:write>",
		];
		for (const closer of closers) expect(TAGS).toContain(closer);
	});

	it("loses only the tags each dialect cannot carry in a string argument", () => {
		const lost: Record<string, string[]> = {};
		for (const dialect of DIALECTS) {
			lost[dialect] = [];
			for (const token of TOKENS) {
				const { text, call } = reply(dialect, token);
				const ends = scan(dialect, [text]).filter(event => event.type === "toolEnd");
				const back = ends.length === 1 && ends[0]?.type === "toolEnd" ? ends[0].arguments : undefined;
				if (!isDeepStrictEqual(back, call.arguments)) lost[dialect].push(token);
			}
		}
		expect(lost).toEqual(LOST);
	});

	for (const dialect of DIALECTS) {
		it(`${dialect}: whole and in 1-, 2-, 3-, 5- and 7-byte pieces agree for every tag`, () => {
			for (const token of TOKENS) {
				const { text } = reply(dialect, token);
				const whole = comparable(scan(dialect, [text]));
				for (const size of [1, 2, 3, 5, 7]) {
					expect(
						comparable(scan(dialect, cut(text, size))),
						`${JSON.stringify(token)} in ${size}-byte pieces`,
					).toBe(whole);
				}
			}
		});

		it(`${dialect}: a reply cut off at any offset ends cleanly and leaves the scanner ready for the next`, () => {
			const next = reply(dialect, "").text;
			const fresh = comparable(scan(dialect, [next]));
			for (const token of TAGS) {
				const { text } = reply(dialect, token);
				for (let end = 1; end < text.length; end++) {
					const prefix = text.slice(0, end);
					const label = JSON.stringify(prefix);
					const scanner = createInbandScanner(dialect, { tools: TOOLS, parseThinking: true });
					const events = [...scanner.feed(prefix), ...scanner.flush()];
					expect(comparable(scan(dialect, [...prefix])), `${label} per character`).toBe(comparable(events));

					const at = events.findIndex(event => event.type === "toolEnd" && event.unterminated === true);
					const cutOff = events[at];
					if (cutOff?.type === "toolEnd") {
						const raw = cutOff.rawBlock;
						expect(raw !== undefined && prefix.endsWith(raw), `${label} raw block ${JSON.stringify(raw)}`).toBe(
							true,
						);
						const after = events.slice(at + 1).filter(event => !event.type.startsWith("thinking"));
						expect(after, `${label} after its cut-off call`).toEqual([]);
					}

					expect(scanner.flush(), `${label} second flush`).toEqual([]);
					expect(comparable([...scanner.feed(next), ...scanner.flush()]), `${label} then a new reply`).toBe(fresh);
				}
			}
		});
	}

	it("pi-native: a cut-off element body closes at its first rejected closer and scans what follows once", () => {
		const text = '<call:write>\n<content>a</call:write>b</call:write><call:write path="b" content="c"/> tail';
		const expected = comparable([
			{ type: "toolStart", id: "first", name: "write" },
			{
				type: "toolEnd",
				id: "first",
				name: "write",
				arguments: {},
				rawBlock: "<call:write>\n<content>a</call:write>",
			},
			{ type: "text", text: "b</call:write>" },
			{ type: "toolStart", id: "second", name: "write" },
			{
				type: "toolEnd",
				id: "second",
				name: "write",
				arguments: { path: "b", content: "c" },
				rawBlock: '<call:write path="b" content="c"/>',
			},
			{ type: "text", text: " tail" },
		]);
		for (const pieces of [[text], [...text], cut(text, 3)])
			expect(comparable(scan("pi-native", pieces))).toBe(expected);
	});
});
