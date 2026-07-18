/**
 * Symbol presets are glyph maps, not word maps. The unicode preset shipped
 * literal placeholder words ("warn", "note", "ok") that leaked straight into
 * the UI — the resume dialog rendered "warn interrupted", tool headers "note".
 * Consumers compose `${symbol} <their own label>`, so a value that is itself a
 * bare word doubles the text. ASCII is exempt: its whole point is short ASCII
 * mnemonics ("[!]", "+f", "PR").
 */
import { describe, expect, it } from "bun:test";
import { NERD_SYMBOLS, UNICODE_SYMBOLS } from "../../../src/modes/theme/symbols";

describe("symbol presets carry glyphs, not leaked placeholder words", () => {
	for (const [preset, map] of [
		["unicode", UNICODE_SYMBOLS],
		["nerd", NERD_SYMBOLS],
	] as const) {
		it(`${preset} preset has no bare multi-letter word values`, () => {
			const words = Object.entries(map)
				.filter(([, v]) => /^[a-zA-Z]{2,}$/.test(v))
				.map(([k, v]) => `${k}=${JSON.stringify(v)}`);
			expect(words).toEqual([]);
		});
	}
});
