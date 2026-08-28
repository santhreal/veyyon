/**
 * A picker that owns the whole screen draws the whole screen, and floats its card in it.
 *
 * WHAT WAS WRONG. `/resume` mounts `SessionSelectorComponent` as a fullscreen overlay
 * (`anchor: "top-left"`, `maxHeight: "100%"`), so the rows the component returns ARE the
 * screen. It returned `min(termHeight, body + chrome + 2 * vMargin)` rows instead, meaning
 * to shrink the CARD to its content. Two things followed. The frame stopped covering the
 * screen, so every row of slack landed under the card. And the margin it had budgeted for
 * centring was inside that shrunken area, so once the card hit the height floor in
 * `computeModalDims` it filled the area exactly and took a top pad of zero. On a 39-row
 * terminal a three-row list drew a 26-row card flush against the top edge with 13 blank
 * rows below it.
 *
 * It was monotone in list length — the shorter the list, the further up the card — which is
 * why it read as intermittent. A folder with one session, which is the state `/new` leaves
 * behind, was the worst case, and `/resume` right after `/new` hit it every time.
 *
 * THE CLASS this closes: a card that sizes itself by shrinking the AREA rather than by
 * telling the shell how tall its body is. `renderModalShell` already takes
 * `preferredBodyRows` and does both halves — shrink the card, re-centre it in the full area
 * — and nine other cards here use it. The sweep below drives the real component over the
 * whole (terminal height x session count) space rather than the reported one, so any return
 * to area-shrinking goes red at every size at once, not just at the size someone reported.
 *
 * It also pins the second half, which the first fix for this got wrong: the body of a
 * SCROLLING list is not constant (a titled session is four rows, an untitled one three), so
 * sizing the card to the instantaneous body resized it under the pointer as the wheel
 * turned. The card is sized to a per-width high-water mark instead, and the scroll sweep
 * asserts the card and its footer hold still.
 *
 * WHAT IT DOES NOT CATCH. Only this picker is driven. Every other fullscreen card is
 * reached through a constructor this suite would have to fake, so a NEW card that shrinks
 * its own area is not red here — the shell-level case below covers the mechanism they all
 * share, not their call sites. Nothing here reads pixels: it asserts rows, so a defect that
 * needs a real terminal to show (a wrong SGR fill in an otherwise correctly placed row) is
 * outside it.
 *
 * And one branch is not gated: the high-water mark resets when the content width changes,
 * and deleting that reset leaves every case here green. Every row this list draws truncates
 * to the content width rather than wrapping, so the body is the same height at 40 columns
 * as at 200 and a mark carried across widths is never wrong. The reset stays because the
 * shared spelling in `ModalSelectList` needs it and the cost is a comparison; the tripwire
 * below asserts the width-invariance the branch depends on, so a row that starts wrapping
 * turns it red instead of quietly making dead code load-bearing.
 */
import { beforeAll, describe, expect, it } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { MODAL_SIZING_LARGE, renderModalShell, sizingForArea } from "@veyyon/coding-agent/modes/components/modal-shell";
import { SessionSelectorComponent } from "@veyyon/coding-agent/modes/components/session-selector";
import { initTheme } from "@veyyon/coding-agent/modes/theme/theme";
import type { SessionInfo } from "@veyyon/coding-agent/session/session-listing";

beforeAll(async () => {
	await initTheme();
});

function plain(line: string): string {
	return stripVTControlCharacters(line);
}

/**
 * Titled sessions first, untitled after — a titled row is four lines tall and an
 * untitled one three, so a scrolled window is a DIFFERENT height from the first
 * one. Alternating them instead keeps every window the same height and hides
 * exactly the defect the scroll sweep is here to catch.
 */
function makeSessions(count: number): SessionInfo[] {
	return Array.from({ length: count }, (_, i) => ({
		path: `/work/s${i}.jsonl`,
		id: `s${i}`,
		cwd: "/work",
		title: i < count / 2 ? `Titled ${i}` : undefined,
		created: new Date("2024-01-01T00:00:00Z"),
		modified: new Date("2024-01-02T00:00:00Z"),
		messageCount: 1,
		size: 1024,
		firstMessage: `body for s${i}`,
		allMessagesText: `body for s${i}`,
	}));
}

function makeSelector(sessionCount: number, rows: number): SessionSelectorComponent {
	return new SessionSelectorComponent(
		makeSessions(sessionCount),
		() => {},
		() => {},
		() => {},
		{ getTerminalRows: () => rows, fillHeight: true },
	);
}

interface Placement {
	rows: number;
	above: number;
	below: number;
	cardHeight: number;
}

function placement(lines: readonly string[]): Placement {
	const first = lines.findIndex(line => plain(line).trim() !== "");
	const last = lines.findLastIndex(line => plain(line).trim() !== "");
	// An all-blank frame has no card; report it as such rather than as a card of
	// negative height, so the assertions below fail on it instead of passing.
	if (first === -1) return { rows: lines.length, above: lines.length, below: 0, cardHeight: 0 };
	return { rows: lines.length, above: first, below: lines.length - 1 - last, cardHeight: last - first + 1 };
}

function footerChipRow(lines: readonly string[]): number {
	return lines.findIndex(line => /esc close/i.test(plain(line)));
}

/** SGR wheel notch: button 64 = up, 65 = down. */
function wheel(direction: "up" | "down"): string {
	return `\x1b[<${direction === "down" ? 65 : 64};1;1M`;
}

// The space the defect lived in. Heights span a short split pane to a tall
// window; counts span the one-session folder `/new` leaves through a list far
// longer than any card can show.
const TERMINAL_ROWS = [20, 24, 28, 32, 39, 44, 50, 60];
const SESSION_COUNTS = [1, 2, 3, 5, 8, 13, 21, 40];
const WIDTH = 120;

describe("a fullscreen picker owns every row of the screen", () => {
	it("returns exactly the terminal's rows at every height and list length", () => {
		const wrong: string[] = [];
		for (const rows of TERMINAL_ROWS) {
			for (const count of SESSION_COUNTS) {
				const lines = makeSelector(count, rows).render(WIDTH);
				if (lines.length !== rows) wrong.push(`${count} sessions at ${rows} rows -> ${lines.length} rows`);
			}
		}
		expect(wrong).toEqual([]);
	});

	it("floats the card instead of pinning it to the top edge", () => {
		const pinned: string[] = [];
		for (const rows of TERMINAL_ROWS) {
			for (const count of SESSION_COUNTS) {
				const p = placement(makeSelector(count, rows).render(WIDTH));
				// Slack is split evenly, give or take the odd row. Zero slack is
				// fine — a card that fills the screen has nowhere to float — but
				// slack that is all on one side is the defect.
				if (p.above + p.below > 1 && Math.abs(p.above - p.below) > 1) {
					pinned.push(`${count} sessions at ${rows} rows -> ${p.above} above, ${p.below} below`);
				}
			}
		}
		expect(pinned).toEqual([]);
	});

	it("never draws a card taller than the screen", () => {
		const overflow: string[] = [];
		for (const rows of TERMINAL_ROWS) {
			for (const count of SESSION_COUNTS) {
				const p = placement(makeSelector(count, rows).render(WIDTH));
				if (p.cardHeight > rows || p.cardHeight === 0) {
					overflow.push(`${count} sessions at ${rows} rows -> card ${p.cardHeight}`);
				}
			}
		}
		expect(overflow).toEqual([]);
	});

	it("grows the card with the list and shrinks the pad, never the reverse", () => {
		// The defect's signature was monotone: a shorter list sat further up. The
		// direction is what is pinned, not the values, so the card may plateau at
		// the height the screen allows.
		const inversions: string[] = [];
		for (const rows of TERMINAL_ROWS) {
			let previousHeight = 0;
			for (const count of SESSION_COUNTS) {
				const p = placement(makeSelector(count, rows).render(WIDTH));
				if (p.cardHeight < previousHeight) {
					inversions.push(`${rows} rows: ${count} sessions shrank the card to ${p.cardHeight}`);
				}
				previousHeight = p.cardHeight;
			}
		}
		expect(inversions).toEqual([]);
	});
});

describe("the card holds still while the list scrolls under it", () => {
	it("keeps the card height and the footer row fixed across a full scroll", () => {
		const moved: string[] = [];
		// Swept, because a list long enough to saturate the card cannot show this
		// defect at all: the card is already as tall as the screen allows and the
		// clamp hides the breathing. The short counts are the ones that catch it.
		for (const rows of [28, 40, 50]) {
			for (const count of [6, 10, 14, 20]) {
				const selector = makeSelector(count, rows);
				const first = selector.render(WIDTH);
				const baseline = placement(first);
				const baselineFooter = footerChipRow(first);
				expect(baselineFooter).toBeGreaterThan(0);

				// Past the end of the list on purpose: the window clamps, and the
				// rows it clamps to are a different mix of titled and untitled.
				for (let notch = 1; notch <= count + 10; notch++) {
					selector.handleInput(wheel("down"));
					const lines = selector.render(WIDTH);
					const p = placement(lines);
					if (p.cardHeight !== baseline.cardHeight) {
						moved.push(`${count}@${rows} notch ${notch}: card ${baseline.cardHeight} -> ${p.cardHeight}`);
					}
					if (footerChipRow(lines) !== baselineFooter) {
						moved.push(`${count}@${rows} notch ${notch}: footer ${baselineFooter} -> ${footerChipRow(lines)}`);
					}
				}
			}
		}
		expect(moved).toEqual([]);
	});

	it("settles: repeated renders at one width stop changing the card", () => {
		// The high-water mark only ever rises, so it has to reach a fixed point or
		// the card creeps a row per paint. A test that only reads the final height
		// cannot see a creep, so this asserts the sequence is constant after the
		// first paint AND bounded by the screen.
		const selector = makeSelector(12, 40);
		const heights = Array.from({ length: 8 }, () => placement(selector.render(WIDTH)).cardHeight);
		expect(new Set(heights).size).toBe(1);
		expect(heights[0]).toBeLessThanOrEqual(40);
	});

	it("has a width-invariant body, which is what makes the per-width reset unreachable", () => {
		// A TRIPWIRE, not a proof. The card carries a high-water mark keyed on
		// content width, because a mark carried across widths sizes the card for a
		// body that no longer exists once rows re-lay-out. Every row in THIS list
		// truncates to the content width and none wraps, so the body is the same
		// height at 40 columns as at 200 and the reset branch cannot be reached:
		// mutating it away leaves the suite green, and that is recorded in the
		// header as a known hole rather than hidden behind a test that cannot fail.
		//
		// The moment a row wraps — a two-line preview, a wrapped title — the mark
		// becomes load-bearing and this goes red, which is the notice to go and
		// gate the reset directly.
		const heights = [40, 60, 90, 120, 200].map(width => placement(makeSelector(8, 40).render(width)).cardHeight);
		expect(new Set(heights).size).toBe(1);
	});
});

describe("the shell shrinks a card and re-centres it in the whole area", () => {
	it("fills the area and floats the card for every body size it is given", () => {
		// The mechanism every fullscreen card shares. A caller hands the shell the
		// WHOLE area and its natural body height; the shell owes it a frame the
		// size of the area with the card floated inside.
		const sizing = sizingForArea(MODAL_SIZING_LARGE, 40, false);
		const wrong: string[] = [];
		for (let bodyRows = 1; bodyRows <= 40; bodyRows++) {
			const body = Array.from({ length: bodyRows }, (_, i) => `row ${i}`);
			const shell = renderModalShell({
				title: "Resume Session",
				sizing,
				areaWidth: WIDTH,
				areaHeight: 40,
				body,
				preferredBodyRows: bodyRows,
				shortcuts: [{ label: "esc close", clickable: true, id: "close" }],
				hoveredShortcutId: null,
				showClose: true,
			});
			if (shell.lines.length !== 40) wrong.push(`body ${bodyRows} -> ${shell.lines.length} rows`);
			const p = placement(shell.lines);
			if (p.above + p.below > 1 && Math.abs(p.above - p.below) > 1) {
				wrong.push(`body ${bodyRows} -> ${p.above} above, ${p.below} below`);
			}
		}
		expect(wrong).toEqual([]);
	});
});
