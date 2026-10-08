/**
 * WHY: Gemini's Python keyword arguments and Gemma's `key:value` pairs are split into arguments by
 * one bracket-depth walk (`dialect/bracket-walk.ts`), each dialect passing its literal syntax as a
 * span skipper. A separator or bracket inside a string literal, a comment, or a nested bracket that
 * the walk counted would cut one argument into two, or join two into one, and the call would run with
 * arguments the model never wrote.
 *
 * The class closed: for every skipper the dialects use, a split reassembles to its input, each cut
 * falls on a separator at depth 0 outside every skipped span, and the cut set is exactly those
 * separators. The skippers are reached through the dialects that use them, so a dialect that moves
 * onto the walk with its own skipper is covered by the parse round trip at the end.
 *
 * Not caught: a skipper that misreads its own literal syntax in a way this corpus never writes.
 */
import { describe, expect, it } from "bun:test";
import { createInbandScanner, getDialectDefinition, type InbandScanEvent } from "@veyyon/ai/dialect";
import { matchClose, type SpanSkipper, splitTopLevel, topLevelIndexOf } from "@veyyon/ai/dialect/bracket-walk";

/** A skipper for `"…"` strings with no escapes: enough syntax to put separators and brackets out of reach. */
const skipQuoted: SpanSkipper = (text, i) => {
	if (text[i] !== '"') return -1;
	const close = text.indexOf('"', i + 1);
	return close === -1 ? text.length : close + 1;
};
const skipNothing: SpanSkipper = () => -1;

/** The depth-0, outside-every-span separator indices, computed independently of the walk. */
function referenceCuts(text: string, sep: string): number[] {
	const cuts: number[] = [];
	let depth = 0;
	let inString = false;
	for (let i = 0; i < text.length; i++) {
		const ch = text[i]!;
		if (inString) {
			if (ch === '"') inString = false;
			continue;
		}
		if (ch === '"') inString = true;
		else if ("([{".includes(ch)) depth++;
		else if (")]}".includes(ch)) depth--;
		else if (depth === 0 && ch === sep) cuts.push(i);
	}
	return cuts;
}

let seed = 17;
function rand(): number {
	seed = (seed * 1103515245 + 12345) & 0x7fffffff;
	return seed / 0x7fffffff;
}

describe("a call-argument split never breaks inside a literal or a nested bracket", () => {
	it("cuts at exactly the depth-0 separators outside every literal, and reassembles to its input", () => {
		const alphabet = ['"', ",", "(", ")", "[", "]", "{", "}", "a", " ", ":"];
		for (let n = 0; n < 3000; n++) {
			let text = "";
			const len = Math.floor(rand() * 24);
			for (let i = 0; i < len; i++) text += alphabet[Math.floor(rand() * alphabet.length)];
			const parts = splitTopLevel(text, ",", skipQuoted);
			expect(parts.join(",")).toBe(text);
			const cuts: number[] = [];
			let at = -1;
			for (const part of parts.slice(0, -1)) {
				at += part.length + 1;
				cuts.push(at);
			}
			expect(cuts).toEqual(referenceCuts(text, ","));
			expect(topLevelIndexOf(text, ",", skipQuoted)).toBe(cuts[0] ?? -1);
		}
	});

	it("does not split on a separator inside a literal or a nested bracket of any kind", () => {
		expect(splitTopLevel('a="x,y", b=f(1, 2), c=[3, {d: 4, e: 5}], g=7', ",", skipQuoted)).toEqual([
			'a="x,y"',
			" b=f(1, 2)",
			" c=[3, {d: 4, e: 5}]",
			" g=7",
		]);
	});

	it("stops splitting once a stray closer drives the depth below zero", () => {
		expect(splitTopLevel("a, b), c, d", ",", skipNothing)).toEqual(["a", " b), c, d"]);
	});

	it("searches from the given offset, at depth zero there", () => {
		expect(topLevelIndexOf("a:b(c:d):e", ":", skipNothing, 2)).toBe(8);
		expect(topLevelIndexOf("a:b", ":", skipNothing, 2)).toBe(-1);
	});

	it("matches only its own bracket pair, ignoring brackets inside a literal", () => {
		const text = 'f(a, ")", [b], g(c))';
		expect(matchClose(text, 1, "(", ")", skipQuoted)).toBe(text.length - 1);
		// Without the skipper the quoted `)` balances the call early.
		expect(matchClose(text, 1, "(", ")", skipNothing)).toBe(6);
		// A different bracket kind does not count toward the depth.
		expect(matchClose("{a:[}]}", 0, "{", "}", skipNothing)).toBe(4);
	});

	it("returns -1 when the text ends before the bracket closes", () => {
		expect(matchClose('f(a, "b)', 1, "(", ")", skipQuoted)).toBe(-1);
		expect(matchClose("f((a)", 1, "(", ")", skipNothing)).toBe(-1);
	});

	it("parses every argument a dialect on the walk renders back to the value it rendered", () => {
		const args = {
			pattern: 'a "quoted", (paren) [b] {c} : = #hash',
			paths: ["a,b", "c:d", "(e)"],
			nested: { k: "v,w", list: [1, 2.5, -3] },
			flag: true,
			none: null,
		};
		for (const dialect of ["gemini", "gemma"] as const) {
			const definition = getDialectDefinition(dialect);
			const call = { type: "toolCall" as const, id: "call_1", name: "search", arguments: args };
			const rendered = definition.renderAssistantToolCalls([call]);
			const scanner = createInbandScanner(dialect);
			const events: InbandScanEvent[] = [...scanner.feed(rendered), ...scanner.flush()];
			const ends = events.filter(e => e.type === "toolEnd");
			expect(ends.map(e => ({ name: e.name, arguments: e.arguments }))).toEqual([
				{ name: "search", arguments: args },
			]);
		}
	});
});
