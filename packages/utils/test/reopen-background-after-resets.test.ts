/**
 * A painted background has to survive whatever the row it is behind decides to reset.
 *
 * Three surfaces paint a ground under content they do not control: the editor's quiet card, the
 * setup wizard's full-viewport canvas, and the coding agent's bordered output block. Content
 * arriving from a theme, a reverse-video cursor, or wrapped tool output ends its styling with a
 * reset, and a reset clears the background too, so from that point to the end of the line the
 * ground is gone and the row shows a hole. Each painter re-emits its background after every
 * reset to close that.
 *
 * ALL THREE WROTE THEIR OWN, AND ALL THREE WERE DIFFERENT. One handled `ESC [ 0 m` and
 * `ESC [ 49 m`, one handled only `ESC [ 0 m`, and one handled both but dropped the `ESC [ 49 m`
 * rather than keeping it. None handled `ESC [ m`, the parameterless reset, which means the same
 * hole for any content that spells its reset the short way. Each gap was a visible defect in one
 * surface and not the others, which is exactly what a reader cannot notice from inside any one
 * of them, so the operation has one owner now and this suite pins what it must cover.
 */

import { describe, expect, it } from "bun:test";
import { SGR_BG_RESET, SGR_RESET, SGR_RESET_SHORT } from "@veyyon/utils/ansi";
import { reopenBackgroundAfterResets } from "@veyyon/utils/sgr";

/** A 256-colour background, the shape every caller passes. */
const GROUND = "\x1b[48;5;236m";

describe("reopenBackgroundAfterResets", () => {
	/**
	 * The full reset, which every copy did handle. Kept so a regression in the common case is
	 * not masked by the harder ones passing.
	 */
	it("re-opens the ground after a full reset", () => {
		expect(reopenBackgroundAfterResets(`red${SGR_RESET}rest`, GROUND)).toBe(`red${SGR_RESET}${GROUND}rest`);
	});

	/**
	 * The parameterless reset, which NO copy handled.
	 *
	 * `ESC [ m` means exactly `ESC [ 0 m`: a terminal reads an omitted parameter as zero. Content
	 * that spells it this way punched a hole in all three grounds.
	 */
	it("re-opens the ground after the parameterless reset", () => {
		expect(reopenBackgroundAfterResets(`red${SGR_RESET_SHORT}rest`, GROUND)).toBe(
			`red${SGR_RESET_SHORT}${GROUND}rest`,
		);
	});

	/**
	 * The background reset, which one copy ignored entirely.
	 *
	 * `ESC [ 49 m` restores the DEFAULT background and leaves the foreground alone, so it is the
	 * targeted way to end a background run and the one most likely to appear in content that
	 * painted its own. The reset is kept rather than replaced: it makes no visible difference
	 * here, because the ground that follows overrides it, and one rule reads better than two.
	 */
	it("re-opens the ground after a background reset, keeping the reset", () => {
		expect(reopenBackgroundAfterResets(`x${SGR_BG_RESET}y`, GROUND)).toBe(`x${SGR_BG_RESET}${GROUND}y`);
	});

	/**
	 * Every reset in the row, not just the first, and all three kinds in one string.
	 *
	 * A row is not one styled span. A themed line can open and close several, and a `replace`
	 * without the global flag or a `indexOf`-based patch would fix the first hole and leave the
	 * rest, which looks correct in a single-span test.
	 */
	it("re-opens after every reset in the row", () => {
		const row = `a${SGR_RESET}b${SGR_BG_RESET}c${SGR_RESET_SHORT}d${SGR_RESET}e`;
		expect(reopenBackgroundAfterResets(row, GROUND)).toBe(
			`a${SGR_RESET}${GROUND}b${SGR_BG_RESET}${GROUND}c${SGR_RESET_SHORT}${GROUND}d${SGR_RESET}${GROUND}e`,
		);
	});

	/**
	 * Text with no reset is returned unchanged, byte for byte.
	 *
	 * The guard on the guard: a function that inserted the ground unconditionally, or that
	 * rewrote colour sequences it should not touch, would satisfy every assertion above.
	 */
	it("leaves a row with no reset alone", () => {
		const row = `${GROUND}\x1b[38;5;250mplain text`;
		expect(reopenBackgroundAfterResets(row, GROUND)).toBe(row);
		expect(reopenBackgroundAfterResets("", GROUND)).toBe("");
	});

	/**
	 * And it does not mistake a foreground reset for a background one.
	 *
	 * `ESC [ 39 m` restores the default FOREGROUND and leaves the background untouched, so
	 * re-emitting the ground after it would be pointless output on every styled span in the
	 * transcript. The distinction is the reason `SGR_FG_RESET` and `SGR_BG_RESET` are separate
	 * constants rather than one "reset colour".
	 */
	it("ignores a foreground reset, which does not clear the background", () => {
		const row = `red\x1b[39mrest`;
		expect(reopenBackgroundAfterResets(row, GROUND)).toBe(row);
	});

	/**
	 * A reset at the very end still gets the ground, which is what keeps a padded row solid.
	 *
	 * Callers pad to the full width AFTER this runs, so a trailing reset with no ground behind
	 * it leaves the padding cells unpainted and the ground stops short of the right edge.
	 */
	it("re-opens the ground after a trailing reset", () => {
		expect(reopenBackgroundAfterResets(`text${SGR_RESET}`, GROUND)).toBe(`text${SGR_RESET}${GROUND}`);
	});

	/**
	 * A background that is itself a reset (the transparent ground a theme with an empty colour
	 * resolves to) goes in once after each reset, and is not then read as a reset of its own.
	 *
	 * Three chained replacements inserted it after each `ESC [ 0 m`, then found that insertion as an
	 * `ESC [ 49 m` and inserted it again, so every reset carried a doubled ground.
	 */
	it("inserts a ground that is itself a reset once after each reset", () => {
		expect(reopenBackgroundAfterResets(`a${SGR_RESET}b${SGR_BG_RESET}c`, SGR_BG_RESET)).toBe(
			`a${SGR_RESET}${SGR_BG_RESET}b${SGR_BG_RESET}${SGR_BG_RESET}c`,
		);
	});

	/**
	 * Any row: the ground follows exactly the resets a left-to-right read of the row finds.
	 *
	 * The oracle is a global regular expression built from the three reset constants, a separate
	 * reading of the same rule; rows mix text, each reset, the near misses that share a reset's
	 * first bytes (`ESC [ 0`, `ESC [ 4`, `ESC [ 40 m`, `ESC [ 00 m`, a bare `ESC`), and other
	 * colour sequences, under a colour ground, a reset ground and an empty one.
	 */
	it("re-opens after exactly the resets a left-to-right read finds, in any row", () => {
		const resets = new RegExp(
			[SGR_RESET, SGR_RESET_SHORT, SGR_BG_RESET].map(reset => reset.replace("[", "\\[")).join("|"),
			"g",
		);
		const pieces = [
			"a",
			"text ",
			"m",
			"0m",
			"[m",
			SGR_RESET,
			SGR_RESET_SHORT,
			SGR_BG_RESET,
			"\x1b",
			"\x1b[",
			"\x1b[0",
			"\x1b[4",
			"\x1b[49",
			"\x1b[40m",
			"\x1b[00m",
			"\x1b[39m",
			"\x1b[38;5;250m",
			"\x1b]8;;x\x1b\\",
		];
		let state = 0x5eed;
		const next = (bound: number): number => {
			state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
			return (state >>> 8) % bound;
		};
		const mismatches: string[] = [];
		for (let i = 0; i < 20000; i++) {
			let row = "";
			for (let length = 1 + next(12); length > 0; length--) row += pieces[next(pieces.length)]!;
			for (const ground of [GROUND, SGR_BG_RESET, ""]) {
				const expected = row.replace(resets, reset => reset + ground);
				if (reopenBackgroundAfterResets(row, ground) !== expected) mismatches.push(JSON.stringify([row, ground]));
			}
		}
		expect(mismatches.slice(0, 5)).toEqual([]);
	});
});
