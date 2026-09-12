/**
 * An in-band scanner's output does not depend on where the provider split the stream.
 *
 * WHY THIS SUITE EXISTS. Every scanner holds back a suffix of outside text that could be the start
 * of an opener (`<tool_call`, "```thinking", `<|channel>thought`), so a tag split across two deltas
 * is still recognised. Four scanners stated that rule separately, in the same words, and a fifth
 * kept its own `findFirstTag`; `scanOutsideText` in `dialect/coercion.ts` is now the one statement.
 * A defect there, or a scanner that stops calling it, shows up as text leaking past an opener or a
 * tag emitted verbatim, and only at some chunk boundaries, which is why the sweep below feeds the
 * same reply whole, one character at a time and in three-byte pieces.
 *
 * CLASS CLOSED. Every dialect in `DIALECTS` (read from the catalog at run time, so a new dialect
 * arrives covered) yields the same visible text, the same thinking, the same tool calls and the
 * same event sequence at every chunking of a reply that carries all three.
 *
 * NOT CAUGHT. A hold that is too long (text delayed but still emitted) is invisible here; only the
 * final stream is compared. Timing of intermediate `text` events is asserted nowhere. A `toolStart`
 * name is compared as a prefix of its `toolEnd` name rather than exactly: hermes announces a call
 * as soon as a partial body yields a name, so per character it starts `r` and ends `read`, which
 * `inband-tool-lifecycle.test.ts` states as the contract.
 */
import { describe, expect, it } from "bun:test";
import type { Context, ToolCall } from "@veyyon/ai";
import { createInbandScanner, getDialectDefinition, type InbandScanEvent } from "@veyyon/ai/dialect";
import { DIALECTS } from "@veyyon/catalog/identity";

const TOOLS = [
	{
		name: "read",
		description: "Read a file",
		parameters: {
			type: "object",
			properties: { path: { type: "string" }, count: { type: "number" } },
			required: ["path"],
		},
	},
] as unknown as NonNullable<Context["tools"]>;

const CALL: ToolCall = {
	type: "toolCall",
	id: "functions.read:0",
	name: "read",
	arguments: { path: "src/a.ts", count: 2 },
};

function scan(dialect: (typeof DIALECTS)[number], pieces: readonly string[]): InbandScanEvent[] {
	const scanner = createInbandScanner(dialect, { tools: TOOLS, parseThinking: true });
	const events: InbandScanEvent[] = [];
	for (const piece of pieces) events.push(...scanner.feed(piece));
	events.push(...scanner.flush());
	return events;
}

function chunks(text: string, size: number): string[] {
	const out: string[] = [];
	for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
	return out;
}

/** The stream with adjacent text and thinking deltas joined, which is the only chunking-dependent shape. */
function coalesced(events: readonly InbandScanEvent[]): InbandScanEvent[] {
	const out: InbandScanEvent[] = [];
	for (const event of events) {
		const last = out[out.length - 1];
		if (event.type === "text" && last?.type === "text") {
			out[out.length - 1] = { type: "text", text: last.text + event.text };
			continue;
		}
		if (event.type === "thinkingDelta" && last?.type === "thinkingDelta") {
			out[out.length - 1] = { type: "thinkingDelta", delta: last.delta + event.delta };
			continue;
		}
		if (event.type === "toolArgDelta") continue;
		out.push(event);
	}
	return out;
}

/**
 * Tool-call ids are minted per scanner, so they are compared by position, not by value, and a
 * `toolStart` name is checked against its `toolEnd` separately (see the header).
 */
function comparable(events: readonly InbandScanEvent[]): unknown[] {
	return events.map(event => {
		if (event.type === "toolStart") return { type: event.type, id: "<id>" };
		return "id" in event ? { ...event, id: "<id>" } : event;
	});
}

function expectStartsPrefixTheirEnds(events: readonly InbandScanEvent[]): void {
	const ends = new Map<string, string>();
	for (const event of events) if (event.type === "toolEnd") ends.set(event.id, event.name);
	for (const event of events) {
		if (event.type !== "toolStart") continue;
		const end = ends.get(event.id);
		expect(end, `toolStart ${event.id} has no toolEnd`).toBeDefined();
		expect(end!.startsWith(event.name), `${event.name} is not a prefix of ${end}`).toBe(true);
	}
}

describe("a scanner emits the same events however the stream is chunked", () => {
	for (const dialect of DIALECTS) {
		it(`${dialect}: whole, per character and in three-byte pieces agree`, () => {
			const definition = getDialectDefinition(dialect);
			const reply = `Before ${definition.renderThinking("plan the read")}\nthen ${definition.renderAssistantToolCalls([CALL], { tools: TOOLS })} after`;

			const wholeEvents = coalesced(scan(dialect, [reply]));
			const perCharEvents = coalesced(scan(dialect, [...reply]));
			const tripleEvents = coalesced(scan(dialect, chunks(reply, 3)));

			const whole = comparable(wholeEvents);
			expect(comparable(perCharEvents)).toEqual(whole);
			expect(comparable(tripleEvents)).toEqual(whole);
			for (const events of [wholeEvents, perCharEvents, tripleEvents]) expectStartsPrefixTheirEnds(events);

			const ends = wholeEvents.filter((event): event is Extract<InbandScanEvent, { type: "toolEnd" }> => {
				return event.type === "toolEnd";
			});
			expect(ends.map(end => [end.name, end.arguments])).toEqual([["read", { path: "src/a.ts", count: 2 }]]);
			// Thinking is scanned too, so a chunk boundary inside the opener is what the sweep above tests.
			expect(wholeEvents.some(event => event.type === "thinkingEnd")).toBe(true);
		});
	}
});
