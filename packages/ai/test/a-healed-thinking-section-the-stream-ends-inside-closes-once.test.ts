/**
 * WHY: `ThinkingInbandScanner` heals reasoning a model leaked into its visible text in any dialect's
 * thinking idiom. A tag-closed section the stream ended inside streamed its text as thinking and
 * never emitted `thinkingEnd`, because the text left nothing in the buffer for the flush to close
 * the section with. Every in-band scanner is held to one `thinkingEnd` per `thinkingStart`; the
 * dialect scanners are swept for it in `dialect-thinking.test.ts`, and this suite holds the healer
 * to the same contract.
 *
 * The class closed: for every dialect in the catalog, its own rendered thinking opener, cut off with
 * nothing held, cut off with a partial close held, and fed whole or one character at a time, closes
 * exactly once with no text leaking into the visible channel. A dialect added to the catalog is swept
 * with no change here.
 *
 * Not caught: a leaked idiom no dialect renders, such as the bare harmony analysis channel.
 */
import { describe, expect, it } from "bun:test";
import { getDialectDefinition, type InbandScanEvent, ThinkingInbandScanner } from "@veyyon/ai/dialect";
import { DIALECTS } from "@veyyon/catalog/identity";

function heal(chunks: readonly string[]): InbandScanEvent[] {
	const scanner = new ThinkingInbandScanner();
	const events: InbandScanEvent[] = [];
	for (const chunk of chunks) events.push(...scanner.feed(chunk));
	events.push(...scanner.flush());
	return events;
}

function summary(events: readonly InbandScanEvent[]) {
	let thinking = "";
	let visible = "";
	let starts = 0;
	let ends = 0;
	for (const event of events) {
		if (event.type === "thinkingDelta") thinking += event.delta;
		else if (event.type === "text") visible += event.text;
		else if (event.type === "thinkingStart") starts++;
		else if (event.type === "thinkingEnd") ends++;
	}
	return { thinking, visible, starts, ends };
}

const text = "partial";

describe("a healed thinking section the stream ends inside closes once", () => {
	for (const dialect of DIALECTS) {
		const rendered = getDialectDefinition(dialect).renderThinking(text);
		const opener = rendered.slice(0, rendered.indexOf(text));
		const closer = rendered.slice(rendered.indexOf(text) + text.length);
		const heldClose = closer.slice(0, -1);

		for (const [feeding, split] of [
			["whole", (input: string) => [input]],
			["one character at a time", (input: string) => [...input]],
		] as const) {
			it(`${dialect}: an opener with its text and no close, fed ${feeding}`, () => {
				const result = summary(heal(split(`${opener}${text}`)));
				expect(result.thinking.trim()).toBe(text);
				expect(result).toMatchObject({ visible: "", starts: 1, ends: 1 });
			});

			it(`${dialect}: an opener with its text and a partial close, fed ${feeding}`, () => {
				const result = summary(heal(split(`${opener}${text}${heldClose}`)));
				expect(result.thinking.trim()).toBe(`${text}${heldClose}`);
				expect(result).toMatchObject({ visible: "", starts: 1, ends: 1 });
			});
		}
	}

	it("closes a section the stream ends inside right after its opener", () => {
		expect(summary(heal(["visible <think>"]))).toEqual({ thinking: "", visible: "visible ", starts: 1, ends: 1 });
	});
});
