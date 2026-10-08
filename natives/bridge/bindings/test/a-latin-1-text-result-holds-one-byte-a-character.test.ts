/**
 * A native text result whose characters all fit in Latin-1 is held at one byte a character.
 *
 * WHY: JavaScriptCore keeps a string created from UTF-16 at two bytes a character whatever it holds,
 * and every string a renderer builds from one (a padded row, a styled row, a frame line) inherits that
 * width. The rows the addon returned were all created that way, so every wrapped, truncated, sliced
 * or overlay-split row a transcript kept held twice the memory its text needed.
 *
 * The suite drives each entry point that returns built text and reads the representation JSC reports
 * for the result. A result with a character past U+00FF is the control: it must stay two bytes a
 * character, which proves the probe separates the encodings. Each result is also compared with the
 * text it must hold, so narrowing can never change a character. It does not see an entry point added
 * outside this list that builds its string some other way.
 */

import { jscDescribe } from "bun:jsc";
import { describe, expect, it } from "bun:test";
import { Ellipsis, extractSegments, sliceWithWidth, truncateToWidth, wrapTextWithAnsi } from "../native/index.js";

const TAB = 4;
const WIDTH = 40;

/** Bytes a character JSC stores `text` at. */
function bytesPerCharacter(text: string): 1 | 2 {
	return jscDescribe(text).includes("8Bit:(1)") ? 1 : 2;
}

/** Rows of at most `width` single-cell characters, broken after the last space that fits. */
function greedyRows(text: string, width: number): string[] {
	const rows: string[] = [];
	let rest = text;
	while (rest.length > 0) {
		const cut = rest.length > width ? rest.lastIndexOf(" ", width) + 1 : rest.length;
		rows.push(rest.slice(0, cut).trimEnd());
		rest = rest.slice(cut);
	}
	return rows;
}

const ENTRY_POINTS: Record<string, { produce: (text: string) => string[]; expected: (text: string) => string[] }> = {
	wrapTextWithAnsi: {
		produce: text => wrapTextWithAnsi(text, WIDTH, TAB),
		expected: text => greedyRows(text, WIDTH),
	},
	truncateToWidth: {
		produce: text => [truncateToWidth(text, WIDTH, Ellipsis.Omit, false, TAB)],
		expected: text => [text.slice(0, WIDTH)],
	},
	sliceWithWidth: {
		produce: text => [sliceWithWidth(text, 3, WIDTH, false, TAB).text],
		expected: text => [text.slice(3, 3 + WIDTH)],
	},
	extractSegments: {
		produce: text => {
			const segments = extractSegments(text, WIDTH, WIDTH + 5, WIDTH, false, TAB);
			return [segments.before, segments.after];
		},
		expected: text => [text.slice(0, WIDTH), text.slice(WIDTH + 5, 2 * WIDTH + 5)],
	},
};

/** Every printable Latin-1 character that draws one cell, as prose words. */
const LATIN = (() => {
	let words = "";
	for (let code = 0x21; code <= 0xff; code++) {
		if (code >= 0x7f && code <= 0xa0) continue;
		if (code === 0xad) continue;
		words += String.fromCharCode(code);
		if (code % 7 === 0) words += " ";
	}
	return `${words} caf\u00e9 \u00ff`;
})();
const WIDE = "\u6f22\u5b57 ".repeat(30);

describe("a native text result", () => {
	for (const [name, entry] of Object.entries(ENTRY_POINTS)) {
		it(`from ${name} keeps every Latin-1 character and holds it at one byte`, () => {
			const results = entry.produce(LATIN);
			expect(results).toEqual(entry.expected(LATIN));
			expect(results.map(bytesPerCharacter)).toEqual(results.map(() => 1));
		});
	}

	it("holding a character past U+00FF stays two bytes a character", () => {
		const rows = wrapTextWithAnsi(WIDE, WIDTH, TAB);
		expect(rows.join(" ")).toBe(WIDE.trimEnd());
		expect(rows.map(bytesPerCharacter)).toEqual(rows.map(() => 2));
	});
});
