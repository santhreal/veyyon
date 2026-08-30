/**
 * The one instrument that counts destructive paints, for every family that
 * measures them.
 *
 * WHY THIS IS ONE OWNER. Two escape sequences make a frame destructive, and a
 * scenario that wants to know whether the engine wrote one has to wrap
 * `term.write` and look, because neither is recoverable after the fact: ED2
 * (`\x1b[2J`) clears the viewport, and ED3 (`\x1b[3J`) erases the terminal's
 * SAVED lines, which is the operator's own shell history and is gone for good.
 * On an emulator without DEC 2026 synchronized output either one is a visible
 * flash.
 *
 * That wrapper had been written out by hand five times -- the paint-sim
 * harness, two rigs in one transcript suite, the virtualized-history suite, and
 * the chrome-height suite -- with three different spellings of the same
 * question. Two counted per WRITE (`data.includes(...)`), one counted per
 * OCCURRENCE, and one counted ED3 while its sibling four rows away counted
 * both. So a fix to the measurement reached one copy, and two suites measuring
 * the same defect were not comparable.
 *
 * WHY IT LIVES IN `hosts/terminal/engine/test/helpers`. The paint-sim harness imports
 * `@veyyon/coding-agent` and the coding-agent suites import
 * `../../../hosts/terminal/engine/test/...`, so the counter cannot live in either without a package
 * cycle. Both already reach into this directory for `settleFrames`; this is the
 * one place all three families can share.
 *
 * OCCURRENCES, NOT WRITES. A single write may carry more than one sequence, and
 * "how many did the engine emit" is the honest question -- a per-write count
 * silently merges two erases into one. Every existing assertion is against zero
 * or against "more than zero", where the two agree, so this is strictly more
 * precise and changes no verdict.
 *
 * WHAT IT DOES NOT DO. It counts bytes the engine WROTE; it says nothing about
 * whether the emulator tore while drawing them, which is the emulator's side of
 * the seam and is not measurable from these bytes.
 */
import type { VirtualTerminal } from "../virtual-terminal";

/** ED2: clears the viewport. Recoverable, still a flash. */
const ED2 = "\x1b[2J";
/** ED3: erases the terminal's saved lines. Not recoverable. */
const ED3 = "\x1b[3J";

export interface DestructivePaints {
	/** ED2 viewport clears written since the terminal was wrapped. */
	clears(): number;
	/** ED3 native-scrollback erases written since the terminal was wrapped. */
	erases(): number;
	/** Bytes written since the terminal was wrapped. */
	bytes(): number;
}

/** Count occurrences of `needle` in `haystack`. */
function occurrences(haystack: string, needle: string): number {
	return haystack.split(needle).length - 1;
}

/**
 * Wrap `term.write` and count what the engine emits through it. Install once
 * per terminal, before `tui.start()`, and read the counters at any point: a
 * scenario measuring a window takes a reading at each edge and subtracts.
 */
export function countDestructivePaints(term: VirtualTerminal): DestructivePaints {
	let clears = 0;
	let erases = 0;
	let bytes = 0;
	const write = term.write.bind(term);
	term.write = (data: string) => {
		clears += occurrences(data, ED2);
		erases += occurrences(data, ED3);
		bytes += data.length;
		write(data);
	};
	return {
		clears: () => clears,
		erases: () => erases,
		bytes: () => bytes,
	};
}
