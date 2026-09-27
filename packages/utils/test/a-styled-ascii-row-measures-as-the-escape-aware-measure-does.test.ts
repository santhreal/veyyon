/**
 * WHY: `visibleWidth` counts a row of printable ASCII, tabs and SGR sequences in its own scan instead
 * of handing it to `Bun.stringWidth` with the escape corrections; a styled row of prose or highlighted
 * code is only these, and the scan measures one in a fifth of the time. A scan that miscounts an SGR
 * sequence's length, a tab, or the text after a sequence, or that takes an escape it cannot measure
 * for SGR, pads every styled row to the wrong width.
 *
 * The class this closes: any string on which the scan's answer differs from the escape-aware measure.
 * The oracle is the same function forced onto that measure: a leading `é` (one cell, not ASCII) ends
 * the scan before it starts, so `visibleWidth("é" + text) - 1` is the measure of `text` without the
 * scan. It leads rather than trails because an unterminated sequence at the end of `text` would take a
 * trailing character into itself. Every CSI parameter byte and final byte is swept one at a time, and
 * random rows mix text, tabs, SGR sequences of every shape a theme writes, and the escapes the scan
 * must refuse.
 *
 * The gap: the oracle is Bun's measure with this module's corrections, not a terminal; where those
 * disagree with the native wrapper, `visible-width-escape-families.test.ts` pins it.
 */
import { describe, expect, it } from "bun:test";
import { DEFAULT_TAB_WIDTH } from "@veyyon/utils/tab-width";
import { visibleWidth } from "@veyyon/utils/width";

function measured(text: string): number {
	return visibleWidth(`é${text}`) - 1;
}

const PIECES = [
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

function* randomRows(count: number, seed: number): Generator<string> {
	let state = seed >>> 0;
	const next = (bound: number): number => {
		state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
		return (state >>> 8) % bound;
	};
	for (let i = 0; i < count; i++) {
		let row = "";
		const length = 1 + next(24);
		for (let j = 0; j < length; j++) row += PIECES[next(PIECES.length)]!;
		yield row;
	}
}

function firstMismatch(rows: Iterable<string>): { row: string; scan: number; measure: number } | undefined {
	for (const row of rows) {
		const scan = visibleWidth(row);
		const measure = measured(row);
		if (scan !== measure) return { row: JSON.stringify(row), scan, measure };
	}
	return undefined;
}

describe("a styled ASCII row", () => {
	it("measures an SGR sequence of every parameter byte as the escape-aware measure does", () => {
		const rows: string[] = [];
		for (let param = 0x20; param <= 0x3f; param++) {
			const byte = String.fromCharCode(param);
			rows.push(`ab\x1b[${byte}mcd`, `ab\x1b[1${byte}2mcd`, `\x1b[${byte}${byte}m`);
		}
		expect(firstMismatch(rows)).toBeUndefined();
	});

	it("measures a CSI sequence of every final byte as the escape-aware measure does", () => {
		const rows: string[] = [];
		for (let final = 0x40; final <= 0x7e; final++) {
			const byte = String.fromCharCode(final);
			rows.push(`ab\x1b[31${byte}cd`, `\x1b[${byte}x`, `x\x1b[0;1${byte}`);
		}
		expect(firstMismatch(rows)).toBeUndefined();
	});

	it("measures random rows of text, tabs, SGR sequences and other escapes as the escape-aware measure does", () => {
		expect(firstMismatch(randomRows(20000, 0x51de))).toBeUndefined();
	});

	it("counts text and tabs and nothing of the sequences", () => {
		expect(visibleWidth("\x1b[38;2;10;200;30mab\x1b[39m\tc\x1b[m")).toBe(2 + DEFAULT_TAB_WIDTH + 1);
	});
});
