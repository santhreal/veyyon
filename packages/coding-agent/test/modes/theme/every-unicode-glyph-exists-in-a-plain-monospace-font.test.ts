/**
 * Every glyph in the `unicode` symbol preset exists in a plain monospace font.
 *
 * WHY THIS SUITE EXISTS. The `unicode` preset is what a user sees when they have
 * no Nerd Font installed, which is the default state of a fresh machine. So each
 * of its glyphs has to be one a plain terminal can actually draw, and six of them
 * were not. `⟳` (U+27F3) is absent from DejaVu Sans Mono, still the most widely
 * shipped monospace face there is, and it was `status.running`: every busy row in
 * the Agent Control Center drew a tofu box where the status mark belongs. `⤵` and
 * `⤴` (U+2935/U+2934) were the token in/out icons in the status line, on screen
 * the whole time, and exist in none of the three fonts measured. `⧉` (U+29C9),
 * `⎇` (U+2387) and `⦸` (U+29B8) were missing from one or two.
 *
 * None of that is visible in a test that asserts strings, and none of it is
 * visible in a terminal that happens to have a Nerd Font installed, which is
 * every developer terminal that has ever been set up on purpose. It is visible in
 * a rendered image on a machine with stock fonts, which is how it was found.
 *
 * HOW THE LIST BELOW WAS MEASURED, so it can be re-measured rather than trusted.
 * Each font's `cmap` was read with fontTools and intersected with the codepoints
 * the preset uses:
 *
 *     python3 -c 'from fontTools.ttLib import TTFont; \
 *       print(sorted(TTFont("/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf").getBestCmap()))'
 *
 * The bar is DejaVu Sans Mono AND FreeMono. Noto Sans Mono is deliberately not
 * the bar: its repertoire stops at Latin, Greek and Cyrillic, so it lacks even ✓
 * and ✗ and relies on fontconfig falling back to Noto Sans Symbols. Holding the
 * preset to Noto's own cmap would mean giving up the check mark, which would make
 * the product worse to satisfy a gate.
 *
 * WHAT THE TEST CAN AND CANNOT DO. It cannot read fonts: CI has no guaranteed
 * font set, and a gate that silently finds no fonts and passes is worse than no
 * gate. So the measurement is checked IN, one row per codepoint, and the rule is
 * that the preset may not use a codepoint absent from the list. Adding a glyph
 * fails until somebody measures it and adds a row, which is the point: the cost
 * of the check is paid once, by the person choosing the glyph, instead of by a
 * user staring at a box.
 */

import { describe, expect, it } from "bun:test";
import { ASCII_SYMBOLS, NERD_SYMBOLS, UNICODE_SYMBOLS } from "@veyyon/coding-agent/modes/theme/symbols";

/**
 * Codepoints verified present in DejaVu Sans Mono 2.37 and FreeMono 20120503 on
 * 2026-07-27. Sorted, one row per codepoint, with the keys that use it.
 */
const VERIFIED_IN_PLAIN_MONOSPACE: readonly number[] = [
	0x0020, //    sep.dot, sep.pipe, sep.slash, sep.space
	0x0021, // !  icon.warning, status.warning
	0x002a, // *  icon.extensionSkill
	0x002f, // /  sep.slash
	0x003c, // <  sep.asciiRight, sep.powerlineThinRight
	0x003e, // >  sep.asciiLeft, sep.powerlineThinLeft, tool.bash
	0x003f, // ?  tool.ask
	0x004e, // N  tool.browser
	0x0052, // R  tool.memory
	0x0061, // a  thinking.max
	0x0064, // d  thinking.medium
	0x0065, // e  thinking.medium
	0x0067, // g  thinking.high, thinking.xhigh
	0x0068, // h  thinking.high, thinking.xhigh
	0x0069, // i  status.info, thinking.high, thinking.minimal, thinking.xhigh
	0x006c, // l  thinking.low
	0x006d, // m  thinking.max, thinking.medium, thinking.minimal
	0x006e, // n  thinking.minimal
	0x006f, // o  thinking.low
	0x0077, // w  thinking.low
	0x0078, // x  thinking.max, thinking.xhigh
	0x00b6, // ¶  icon.extensionPrompt
	0x00b7, // ·  sep.dot
	0x2014, // —  format.dash
	0x2016, // ‖  icon.pause
	0x2022, // •  format.bullet, md.bullet
	0x203a, // ›  nav.cursor, nav.selected
	0x2191, // ↑  icon.output
	0x2193, // ↓  icon.input
	0x21b6, // ↶  icon.rewind
	0x21bb, // ↻  icon.loop
	0x21c4, // ⇄  tool.ssh
	0x21f6, // ⇶  tool.task
	0x220e, // ∎  status.aborted
	0x221e, // ∞  icon.auto
	0x2297, // ⊗  status.disabled
	0x2298, // ⊘  icon.cacheMiss
	0x22ef, // ⋯  status.pending
	0x2315, // ⌕  icon.search, tool.webSearch
	0x2318, // ⌘  icon.extensionSlashCommand, lang.default
	0x2500, // ─  boxRound.horizontal, boxSharp.horizontal, md.hrChar, tree.branch, tree.horizontal, tree.last
	0x2502, // │  boxRound.vertical, boxSharp.vertical, sep.pipe, tree.vertical
	0x2506, // ┆  sep.powerlineThin
	0x250c, // ┌  boxSharp.topLeft
	0x2510, // ┐  boxSharp.topRight
	0x2514, // └  boxSharp.bottomLeft, tree.hook, tree.last
	0x2518, // ┘  boxSharp.bottomRight
	0x251c, // ├  boxSharp.teeRight, tree.branch
	0x2524, // ┤  boxSharp.teeLeft
	0x252c, // ┬  boxSharp.teeDown
	0x2534, // ┴  boxSharp.teeUp
	0x253c, // ┼  boxSharp.cross
	0x256d, // ╭  boxRound.topLeft
	0x256e, // ╮  boxRound.topRight
	0x256f, // ╯  boxRound.bottomRight
	0x2570, // ╰  boxRound.bottomLeft
	0x258c, // ▌  sep.block
	0x258e, // ▎  advisor.rail
	0x258f, // ▏  md.quoteBorder
	0x2595, // ▕  sep.powerline
	0x25a0, // ■  checkbox.checked, md.colorSwatch
	0x25a1, // □  checkbox.unchecked, radio.unselected
	0x25a3, // ▣  radio.selected
	0x25a4, // ▤  icon.file
	0x25aa, // ▪  status.done, status.enabled
	0x25ab, // ▫  icon.scratchFolder, status.shadowed
	0x25b6, // ▶  sep.powerlineLeft, tool.eval
	0x25b8, // ▸  nav.expand, nav.next
	0x25be, // ▾  nav.collapse
	0x25c0, // ◀  sep.powerlineRight
	0x25c2, // ◂  nav.prev
	0x25c8, // ◈  tool.gh
	0x25c9, // ◉  tool.review
	0x25ce, // ◎  tool.goal
	0x25cf, // ●  status.active
	0x25d0, // ◐  status.running, thinking.autoPending
	0x25e6, // ◦  status.connecting
	0x25eb, // ◫  icon.worktree
	0x2709, // ✉  icon.unread
	0x270e, // ✎  tool.edit
	0x2713, // ✓  status.success, tool.resolve
	0x2717, // ✗  status.error
	0x2750, // ❐  tool.write
	0x27e6, // ⟦  format.bracketLeft
	0x27e7, // ⟧  format.bracketRight
	0x27e8, // ⟨  lang.xml
	0x27e9, // ⟩  lang.xml
	0x27f5, // ⟵  nav.back
];

/** Every codepoint a preset actually renders, with the key that renders it. */
function codepointsOf(preset: Record<string, string>): Array<{ key: string; codepoint: number; glyph: string }> {
	const found: Array<{ key: string; codepoint: number; glyph: string }> = [];
	for (const [key, value] of Object.entries(preset)) {
		for (const glyph of value) {
			found.push({ key, glyph, codepoint: glyph.codePointAt(0) as number });
		}
	}
	return found;
}

/** `U+27F3`, the spelling every message here uses so a failure is greppable. */
function hex(codepoint: number): string {
	return `U+${codepoint.toString(16).toUpperCase().padStart(4, "0")}`;
}

const VERIFIED = new Set(VERIFIED_IN_PLAIN_MONOSPACE);

describe("every glyph in the unicode preset exists in a plain monospace font", () => {
	/**
	 * The scan reads the real preset. A preset that failed to import, or an empty
	 * one, would satisfy the rule below while checking nothing.
	 */
	it("reads a preset with a substantial number of glyphs", () => {
		const used = codepointsOf(UNICODE_SYMBOLS);

		expect(Object.keys(UNICODE_SYMBOLS).length).toBeGreaterThan(150);
		expect(used.length).toBeGreaterThan(100);
		expect(used.some(entry => entry.key === "status.running")).toBe(true);
	});

	/**
	 * The rule. A failure names the glyph, the key and the codepoint, because the
	 * fix is a choice: pick a glyph from a range the fonts cover, or measure the
	 * one you want and add its row.
	 */
	it("uses no codepoint outside the verified list", () => {
		const offenders = codepointsOf(UNICODE_SYMBOLS)
			.filter(entry => !VERIFIED.has(entry.codepoint))
			.map(entry => `${entry.key} = ${entry.glyph} (${hex(entry.codepoint)})`);

		expect(
			offenders,
			"a glyph here has not been checked against DejaVu Sans Mono and FreeMono. Measure it and add its row, or pick one already on the list.",
		).toEqual([]);
	});

	/**
	 * And the six that were replaced stay replaced.
	 *
	 * The rule above would pass if `⟳` came back under a DIFFERENT key, because it
	 * only asks whether each codepoint is listed. This asks the other question:
	 * these six specific codepoints are known-bad and may not appear anywhere in
	 * the preset again.
	 */
	it.each([
		[0x27f3, "⟳", "status.running, absent from DejaVu Sans Mono"],
		[0x29c9, "⧉", "icon.worktree, absent from DejaVu Sans Mono"],
		[0x2387, "⎇", "tool.gh, absent from DejaVu Sans Mono"],
		[0x29b8, "⦸", "status.disabled, absent from DejaVu Sans Mono"],
		[0x2935, "⤵", "icon.input, absent from every font measured"],
		[0x2934, "⤴", "icon.output, absent from every font measured"],
	])("does not use %s again", (codepoint, glyph, why) => {
		const users = codepointsOf(UNICODE_SYMBOLS)
			.filter(entry => entry.codepoint === codepoint)
			.map(entry => entry.key);

		expect(users, `${glyph} ${hex(codepoint as number)} was removed because it was ${why}`).toEqual([]);
	});

	/**
	 * The verified list is a measurement of THIS preset, not a general allowlist,
	 * so a row nothing uses is a row nobody re-measured when the glyph changed.
	 */
	it("lists no codepoint the preset has stopped using", () => {
		const used = new Set(codepointsOf(UNICODE_SYMBOLS).map(entry => entry.codepoint));
		const stale = VERIFIED_IN_PLAIN_MONOSPACE.filter(codepoint => !used.has(codepoint)).map(hex);

		expect(stale, "delete the row, or restore the glyph that used it").toEqual([]);
	});
});

describe("the other two presets are held to their own contracts, not this one", () => {
	/**
	 * The `nerd` preset is Private Use Area on purpose: those codepoints exist in
	 * no plain font and are supposed to be selected only when the user has told
	 * the theme they have a patched one. Holding it to the list above would be
	 * wrong, and this states that rather than leaving it unsaid.
	 */
	it("the nerd preset uses private-use codepoints the plain fonts cannot have", () => {
		const privateUse = codepointsOf(NERD_SYMBOLS).filter(
			entry => entry.codepoint >= 0xe000 && entry.codepoint <= 0xf8ff,
		);

		expect(privateUse.length).toBeGreaterThan(50);
	});

	/**
	 * And the `ascii` preset is the real floor: a terminal with no Unicode at all.
	 * Every one of its glyphs is a codepoint below 128, which is a contract no
	 * font can break.
	 */
	it("the ascii preset stays inside ASCII", () => {
		const offenders = codepointsOf(ASCII_SYMBOLS)
			.filter(entry => entry.codepoint > 0x7f)
			.map(entry => `${entry.key} = ${entry.glyph} (${hex(entry.codepoint)})`);

		expect(offenders).toEqual([]);
	});
});
