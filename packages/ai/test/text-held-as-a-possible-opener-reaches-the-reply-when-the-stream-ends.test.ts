/**
 * Text a scanner held back as a possible opener is released as visible text when the stream ends.
 *
 * WHY THIS SUITE EXISTS. A scanner holds a suffix of outside text that could start an opener
 * (`<thi`, "```tool", `<|channel`) until the next delta shows whether the tag completes.
 * `emitTextHoldingPartialTag` in `dialect/coercion.ts` is the one statement of that hold, and it
 * releases the suffix only when the scanner passes `final` from `flush()`. A reply whose last
 * characters look like the start of a tag (`x <`, "see ```") would lose them if the hold outlived
 * the stream. The Hermes and Qwen3 scanner lost a whole opener: `<tool_call>` followed by anything
 * that is not a call body came back as text, but a stream ending on the bare `<tool_call>` emitted
 * nothing, because the block was entered with an empty buffer and the end-of-stream pass ran only
 * over a non-empty one. The chunking sweep does not see either, because every chunking drops the
 * same tail.
 *
 * CLASS CLOSED. Every dialect in `DIALECTS` (read from the catalog at run time, so a new dialect
 * arrives covered) and the leaked-idiom healer `ThinkingInbandScanner` are fed visible text
 * followed by each strict prefix of that dialect's own rendered thinking and tool-call markup. A
 * prefix is outside text when the scanner returns it as text once the stream continues with a
 * character no tag contains. Ending the stream at that prefix instead, fed whole or one character
 * at a time, emits the same text and nothing else. A scanner that holds on `final`, passes `false`
 * where it means `final`, or stops calling the shared helper on its outside path fails here.
 *
 * NOT CAUGHT. A prefix that opened a block is excluded: what a cut-off block emits is held by
 * `a-call-the-stream-ends-inside-*` and `a-healed-thinking-section-*`. Openers no dialect renders,
 * such as the bare harmony analysis channel, are not swept.
 */
import { describe, expect, it } from "bun:test";
import type { Context, ToolCall } from "@veyyon/ai";
import {
	createInbandScanner,
	getDialectDefinition,
	type InbandScanEvent,
	type InbandScanner,
	ThinkingInbandScanner,
} from "@veyyon/ai/dialect";
import { DIALECTS } from "@veyyon/catalog/identity";

const TOOLS = [
	{
		name: "read",
		description: "Read a file",
		parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
	},
] as unknown as NonNullable<Context["tools"]>;

const CALL: ToolCall = { type: "toolCall", id: "functions.read:0", name: "read", arguments: { path: "a.ts" } };

const LEAD = "Reply ";
/** Continues a stream with a character no opener or closer contains, so any held suffix is released. */
const CONTINUATION = "\u0001";

function scan(scanner: InbandScanner, pieces: readonly string[]): InbandScanEvent[] {
	const events: InbandScanEvent[] = [];
	for (const piece of pieces) events.push(...scanner.feed(piece));
	events.push(...scanner.flush());
	return events;
}

/** Visible text the scanner emitted, or `undefined` once it opened any block. */
function visibleTextOnly(events: readonly InbandScanEvent[]): string | undefined {
	let visible = "";
	for (const event of events) {
		if (event.type !== "text") return undefined;
		visible += event.text;
	}
	return visible;
}

interface Sweep {
	/** Outside-text prefixes the scanner withheld part of until the stream ended. */
	held: number;
	/** Outside-text inputs that came back short of themselves, or with a block, when the stream ended there. */
	lost: string[];
}

function sweep(createScanner: () => InbandScanner, markup: readonly string[]): Sweep {
	const result: Sweep = { held: 0, lost: [] };
	for (const rendered of markup) {
		for (let end = 1; end < rendered.length; end++) {
			const input = LEAD + rendered.slice(0, end);
			const continued = input + CONTINUATION;
			if (visibleTextOnly(scan(createScanner(), [continued])) !== continued) continue;
			if (visibleTextOnly(createScanner().feed(input)) !== input) result.held++;
			for (const pieces of [[input], [...input]]) {
				const visible = visibleTextOnly(scan(createScanner(), pieces));
				if (visible !== input) result.lost.push(`${JSON.stringify(input)} -> ${JSON.stringify(visible)}`);
			}
		}
	}
	return result;
}

function renderedMarkup(dialect: (typeof DIALECTS)[number]): string[] {
	const definition = getDialectDefinition(dialect);
	return [definition.renderThinking("plan"), definition.renderAssistantToolCalls([CALL], { tools: TOOLS })];
}

describe("text held as a possible opener reaches the reply when the stream ends", () => {
	for (const dialect of DIALECTS) {
		it(`${dialect}: the dialect scanner releases every held prefix of its own markup`, () => {
			const result = sweep(
				() => createInbandScanner(dialect, { tools: TOOLS, parseThinking: true }),
				renderedMarkup(dialect),
			);
			expect(result.lost).toEqual([]);
			expect(result.held).toBeGreaterThan(0);
		});

		it(`${dialect}: the leaked-idiom healer releases every held prefix of its thinking opener`, () => {
			const result = sweep(
				() => new ThinkingInbandScanner(),
				[getDialectDefinition(dialect).renderThinking("plan")],
			);
			expect(result.lost).toEqual([]);
			expect(result.held).toBeGreaterThan(0);
		});
	}
});
