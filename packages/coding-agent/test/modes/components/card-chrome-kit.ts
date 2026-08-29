/**
 * Reading a rendered card's chrome back out of its bytes: what is painted on the rules, and which
 * paint each one carries.
 *
 * ONE WALKER FOR EVERY CLAIM ABOUT A RULE. Two suites ask about the same glyphs — one that no rule
 * inside a card is painted in the brand accent, one that every rule is the card's own hairline — and
 * a substring search answers both wrongly. A card's title row is `corner, tick, rule, title, rule,
 * corner`, so "the accent appears on this line" is true of every card in the product while nothing
 * is wrong, and "the hairline appears on this line" is true while a second rule beside it is not.
 * The paint on a glyph is the SGR state at that glyph, which only a walk can tell you.
 *
 * WHAT COUNTS AS A RULE. Box-drawing only (U+2500 block): the sharp and rounded sets, heavy, double,
 * and the dashed and dotted runs, whether or not a card draws that variant today — a rule someone
 * draws in an omitted variant is the same defect wearing a different codepoint. The eighth blocks
 * (`▏▎▍…`) are deliberately NOT here: they are the sub-cell bar and the software cursor
 * (`tui/sub-cell-bar.ts`, `tui/components/editor.ts`), so a card that draws one is drawing content,
 * and a suite that read them as joinery would report the editor's own cursor.
 */

import { TERMINAL } from "@veyyon/tui";
import { emberTick } from "../../../src/modes/components/composer-chrome";

/** Every glyph a card draws structure with. */
export const BOX_RULE_GLYPHS = "─│┌┐└┘├┤┬┴┼╭╮╰╯━┃┏┓┗┛┣┫┳┻╋═║╔╗╚╝╠╣╦╩╬┄┅┆┇┈┉┊┋╌╍╎╏";

/** A rule glyph and the foreground SGR open that was in effect on it; `""` when it was unpainted. */
export interface RulePaint {
	open: string;
	glyph: string;
}

/** The SGR a paint opens with, e.g. `\x1b[38;2;240;134;46m`, read off a painted sample. */
export function openOf(painted: string, payload = "x"): string {
	const end = painted.lastIndexOf(payload);
	return end === -1 ? "" : painted.slice(0, end);
}

/**
 * Every rule glyph in a line, in order, each with the foreground open that covers it.
 *
 * Only FOREGROUND state is tracked, because that is what a rule's colour is: a background is a
 * band, which the sibling first-frame suite owns. A reset (`39`, `0`, bare `m`) clears it, and any
 * other `38;` open replaces it, which is how a title's own colour ends the frame's.
 */
export function rulePaints(line: string): RulePaint[] {
	const sgr = /\x1b\[[0-9;:]*m/g;
	const found: RulePaint[] = [];
	let index = 0;
	let open = "";
	const scan = (text: string): void => {
		for (const glyph of text) if (BOX_RULE_GLYPHS.includes(glyph)) found.push({ open, glyph });
	};
	for (let match = sgr.exec(line); match !== null; match = sgr.exec(line)) {
		scan(line.slice(index, match.index));
		index = match.index + match[0].length;
		const seq = match[0];
		if (seq === "\x1b[39m" || seq === "\x1b[0m" || seq === "\x1b[m") open = "";
		else if (seq.startsWith("\x1b[38;") || seq.startsWith("\x1b[3") || seq.startsWith("\x1b[9")) open = seq;
	}
	scan(line.slice(index));
	return found;
}

/** The rule glyphs a line paints under one specific open, as a string. */
export function glyphsUnderOpen(line: string, open: string): string {
	return rulePaints(line)
		.filter(paint => paint.open === open)
		.map(paint => paint.glyph)
		.join("");
}

/**
 * The one accent-painted rule that is not a defect: the horizon tick a card's title row carries
 * right after its corner, two cells of the website's progress-sun motif, shared with the composer.
 *
 * Its bytes come from `emberTick` at the live truecolor flag, and only the FIRST occurrence in a row
 * is removed — without truecolor the tick degrades to plain accent-painted rule, indistinguishable
 * from a rule someone paints beside it, so exempting every match would blind a sweep to a second
 * one. A card row carries at most one tick, which the planted-tick arms pin.
 */
export function withoutBrandTick(line: string): string {
	for (const cells of [3, 2]) {
		const tick = emberTick(TERMINAL.trueColor, cells);
		const at = line.indexOf(tick);
		if (at !== -1) return line.slice(0, at) + line.slice(at + tick.length);
	}
	return line;
}
