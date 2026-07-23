/**
 * Symbol presets are glyph maps, not word maps. The unicode preset shipped
 * literal placeholder words ("warn", "note", "ok") that leaked straight into
 * the UI — the resume dialog rendered "warn interrupted", tool headers "note".
 * Consumers compose `${symbol} <their own label>`, so a value that is itself a
 * bare word doubles the text. ASCII is exempt: its whole point is short ASCII
 * mnemonics ("[!]", "+f", "PR").
 *
 * The thinking-level scale is a DELIBERATE exception: its gauge-bar glyphs
 * (▁▂▃…) were retired because they rendered as stray solid rectangles beside the
 * word and read as artifacts, not a scale. The levels now ARE their short text
 * labels ("min"/"low"/"med"/"high"/"xhigh"/"max") — see symbols.ts. Those keys
 * are exempted so this guard still catches ACCIDENTAL word leaks without
 * flagging the intended labels.
 */
import { describe, expect, it } from "bun:test";
import { NERD_SYMBOLS, UNICODE_SYMBOLS } from "../../../src/modes/theme/symbols";

// Symbols whose value is intentionally a short word, not a glyph.
const INTENTIONAL_WORD_KEYS = new Set([
	"thinking.minimal",
	"thinking.low",
	"thinking.medium",
	"thinking.high",
	"thinking.xhigh",
	"thinking.max",
]);

describe("symbol presets carry glyphs, not leaked placeholder words", () => {
	for (const [preset, map] of [
		["unicode", UNICODE_SYMBOLS],
		["nerd", NERD_SYMBOLS],
	] as const) {
		it(`${preset} preset has no bare multi-letter word values`, () => {
			const words = Object.entries(map)
				.filter(([k, v]) => !INTENTIONAL_WORD_KEYS.has(k) && /^[a-zA-Z]{2,}$/.test(v))
				.map(([k, v]) => `${k}=${JSON.stringify(v)}`);
			expect(words).toEqual([]);
		});
	}
});

describe("unicode preset width contract — no ambiguous or emoji-width glyphs", () => {
	/**
	 * The bug this locks out: ⓘ (U+24D8, East-Asian-ambiguous) and ⏳/⏹
	 * (emoji-presentation) render TWO cells wide in many terminal fonts while
	 * the TUI counts one, so the glyph swallowed its following space and
	 * overlapped the label ("ⓘwaiting on 1 job", live report 2026-07-22).
	 * Every unicode-preset symbol must avoid the codepoint ranges where that
	 * mismatch is known to occur:
	 *  - U+2460–U+24FF enclosed alphanumerics (ⓘ, ①…)
	 *  - U+231A/U+231B and U+23E9–U+23FA (watch/hourglass/media keys with
	 *    default emoji presentation: ⏳ ⏹ ⏸ …)
	 *  - U+FE0F variation selector (forces emoji presentation)
	 *  - all emoji planes above U+1F000
	 *  - U+25CC DOTTED CIRCLE (not a width bug but the combining-mark
	 *    placeholder glyph — it reads as a rendering artifact; user report
	 *    2026-07-22, "stray ◌ in the footline")
	 */
	it("keeps every unicode symbol out of the known double-width ranges", () => {
		const banned = /[①-⓿⌚⌛⏩-⏺️]|◌|[\u{1F000}-\u{1FAFF}]/u;
		for (const [key, value] of Object.entries(UNICODE_SYMBOLS)) {
			expect(banned.test(value), `${key} = ${JSON.stringify(value)}`).toBe(false);
		}
	});

	/** The three repaired glyphs, byte-locked so a helpful "restore the nicer
	 * icon" edit cannot silently reintroduce the overlap. */
	it("pins the narrow-safe status replacements", () => {
		expect(UNICODE_SYMBOLS["status.info"]).toBe("i");
		expect(UNICODE_SYMBOLS["status.pending"]).toBe("⋯");
		expect(UNICODE_SYMBOLS["status.aborted"]).toBe("∎");
	});
});
