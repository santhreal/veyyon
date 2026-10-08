/**
 * WHY: `visibleWidth` counts a row of printable ASCII, one-cell units past ASCII (a gutter bar, box
 * drawing, an ellipsis, an arrow, Latin-1), tabs and SGR sequences in its own scan instead of handing
 * it to `Bun.stringWidth` with the escape corrections; a styled row of prose, highlighted code or
 * transcript chrome is only these, and the scan measures one in a third of the time. A scan that
 * miscounts an SGR sequence's length, a tab, or the text after a sequence, that takes an escape it
 * cannot measure for SGR, or that counts a unit as one cell where the measure scores it otherwise,
 * alone or beside a neighbour, pads every such row to the wrong width.
 *
 * The class this closes: any string on which the scan's answer differs from the escape-aware measure.
 * The oracle is the same function forced onto that measure: a leading `漢` (two cells, never one) ends
 * the scan before it starts, and an `a` between it and the row keeps the row's first unit from joining
 * the leader's cluster, so `visibleWidth("漢a" + text) - 2` is the measure of `"a" + text` without the
 * scan. Every BMP code unit is swept alone, styled and doubled; every CSI parameter byte and final byte
 * is swept one at a time; random rows mix text, tabs, SGR sequences of every shape a theme writes,
 * one-cell symbols, the units that join a cluster (marks, joiners, selectors, prepends, jamo), wide and
 * astral characters, random BMP units, and the escapes the scan must refuse. The Compatibility Jamo,
 * whose width follows a setting, is measured under each setting in turn.
 *
 * The gap: the oracle is Bun's measure with this module's corrections, not a terminal; where those
 * disagree with the native wrapper, `visible-width-escape-families.test.ts` pins it. A pair of
 * distinct units the measure scores together other than the sum of their cells alone is caught only
 * when the random rows place them together.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { DEFAULT_TAB_WIDTH } from "@veyyon/utils/tab-width";
import {
	type HangulCompatibilityJamoWidth,
	resetHangulCompatibilityJamoWidthForTests,
	setHangulCompatibilityJamoWidth,
	visibleWidth,
} from "@veyyon/utils/width";

function scanned(text: string): number {
	return visibleWidth(`a${text}`);
}

function measured(text: string): number {
	return visibleWidth(`漢a${text}`) - 2;
}

const ASCII_PIECES = [
	"a",
	"Hello",
	" ",
	"    ",
	"\t",
	"~",
	"{}",
	"m",
	"5m",
	"\x1b[m",
	"\x1b[0m",
	"\x1b[1m",
	"\x1b[22m",
	"\x1b[1;31m",
	"\x1b[38;5;214m",
	"\x1b[38;2;10;200;30m",
	"\x1b[48;2;1;2;3m",
	"\x1b[38:2::255:0:0m",
	"\x1b[4:3m",
	"\x1b[39m",
	"\x1b[49m",
	"\x1b[2K",
	"\x1b[?25l",
	"\x1b[31",
	"\x1b[",
	"\x1b",
	"\x1b(B",
	"\x1b]8;;https://example.com\x1b\\",
	"\x1b]8;;\x07",
	"\x1b[<m",
];

/** One-cell units a transcript draws: gutters, box drawing, punctuation, arrows, Latin-1, braille, a private-use icon. */
const SYMBOL_PIECES = ["▏", "…", "›", "│", "─", "╰", "✎", "⌕", "▪", "▸", "•", "→", "é", "\u00a0", "⠋", "\uf07b"];

/** Units that join a neighbour's cluster, measure other than one cell, or change width with a setting. */
const JOINING_PIECES = [
	"\u0301",
	"\u200d",
	"\ufe0f",
	"\ufe0e",
	"\u20e3",
	"\u0488",
	"\u00ad",
	"\u200b",
	"\u1100",
	"\u1161",
	"\u11a8",
	"\u3131",
	"\u3164",
	"\u0e33",
	"\u0600",
	"\u0d4e",
	"漢",
	"😂",
	"\ud83c\udde6\ud83c\uddfa",
	"\u2764",
	"\u25aa\ufe0f",
	"#\ufe0f\u20e3",
	"\ud83d",
	"\ud83c\udffb",
	"\u{f0068}",
	"\u{1d400}",
];

const PIECES = [...ASCII_PIECES, ...SYMBOL_PIECES, ...JOINING_PIECES];

function* randomRows(count: number, seed: number, pieces: readonly string[]): Generator<string> {
	let state = seed >>> 0;
	const next = (bound: number): number => {
		state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
		return (state >>> 8) % bound;
	};
	for (let i = 0; i < count; i++) {
		let row = "";
		const length = 1 + next(24);
		for (let j = 0; j < length; j++) {
			row += next(8) === 0 ? String.fromCharCode(next(0x10000)) : pieces[next(pieces.length)]!;
		}
		yield row;
	}
}

function firstMismatch(rows: Iterable<string>): { row: string; scan: number; measure: number } | undefined {
	for (const row of rows) {
		const scan = scanned(row);
		const measure = measured(row);
		if (scan !== measure) return { row: JSON.stringify(row), scan, measure };
	}
	return undefined;
}

afterEach(() => {
	resetHangulCompatibilityJamoWidthForTests();
});

describe("a styled row", () => {
	// First, so a scan that remembered a jamo's width under one setting is read under the next.
	it("holding a Compatibility Jamo measures under each width setting as the escape-aware measure does", () => {
		const settings: HangulCompatibilityJamoWidth[] = [1, 2, "unicode", 1, "platform", 2];
		const rows = ["\u3131", "b\u3131c", "\x1b[1m\u314f\x1b[m\u3164▏", "\u3131\u3131…"];
		const results = settings.map(setting => {
			setHangulCompatibilityJamoWidth(setting);
			return { setting, mismatch: firstMismatch(rows), width: scanned("\u3131") - 1 };
		});
		expect(results).toEqual([
			{ setting: 1, mismatch: undefined, width: 1 },
			{ setting: 2, mismatch: undefined, width: 2 },
			{ setting: "unicode", mismatch: undefined, width: 2 },
			{ setting: 1, mismatch: undefined, width: 1 },
			{ setting: "platform", mismatch: undefined, width: measured("\u3131") - 1 },
			{ setting: 2, mismatch: undefined, width: 2 },
		]);
	});

	it("measures every BMP code unit alone, styled and doubled as the escape-aware measure does", () => {
		const mismatches: string[] = [];
		for (let code = 0; code <= 0xffff; code++) {
			const unit = String.fromCharCode(code);
			const mismatch = firstMismatch([`x${unit}y`, `\x1b[1m${unit}\x1b[m`, unit + unit]);
			if (mismatch)
				mismatches.push(`U+${code.toString(16)} ${mismatch.row}: ${mismatch.scan} vs ${mismatch.measure}`);
		}
		expect(mismatches).toEqual([]);
	});

	it("measures an SGR sequence of every parameter byte as the escape-aware measure does", () => {
		const rows: string[] = [];
		for (let param = 0x20; param <= 0x3f; param++) {
			const byte = String.fromCharCode(param);
			rows.push(`ab\x1b[${byte}mcd`, `ab\x1b[1${byte}2mcd`, `\x1b[${byte}${byte}m`, `▏\x1b[${byte}m…`);
		}
		expect(firstMismatch(rows)).toBeUndefined();
	});

	it("measures a CSI sequence of every final byte as the escape-aware measure does", () => {
		const rows: string[] = [];
		for (let final = 0x40; final <= 0x7e; final++) {
			const byte = String.fromCharCode(final);
			rows.push(`ab\x1b[31${byte}cd`, `\x1b[${byte}x`, `x\x1b[0;1${byte}`, `│\x1b[2${byte}│`);
		}
		expect(firstMismatch(rows)).toBeUndefined();
	});

	it("measures random rows of ASCII text, tabs, SGR sequences and other escapes as the escape-aware measure does", () => {
		expect(firstMismatch(randomRows(20000, 0x51de, ASCII_PIECES))).toBeUndefined();
	});

	it("measures random rows mixing one-cell symbols with the units that join a cluster as the escape-aware measure does", () => {
		expect(firstMismatch(randomRows(40000, 0x7a11, PIECES))).toBeUndefined();
	});

	it("counts text, symbols and tabs and nothing of the sequences", () => {
		expect(visibleWidth("\x1b[38;2;10;200;30m▏ ab\x1b[39m\tc…\x1b[m")).toBe(4 + DEFAULT_TAB_WIDTH + 2);
	});
});
