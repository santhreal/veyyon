// WHY THIS SUITE EXISTS (A-GREEDY-WRAP-CENTRED-ROW-BY-ROW-READS-AS-A-REMAINDER).
//
// A card's footer chips are wrapped, then each row is centred independently. Greedy wrapping fills
// the early rows to the brim and leaves whatever is left on the last row, so the account manager's
// ten chips came out 73, 57 and 27 cells wide inside a 100-cell terminal: three centred lines
// forming a pyramid, the last one reading as a leftover rather than as the rest of one control
// strip. The chips cannot be reordered, so the fix moves chips FORWARD onto later rows while the
// widest row keeps getting narrower.
//
// The row COUNT is the dangerous part. A card subtracts its footer band from its BODY, and the
// band's height comes from this same packing, so a layout producing one more row than the card was
// sized for draws a chip row over the last row of the list. Every assertion below that looks like
// bookkeeping is defending that.
//
// What it locks:
//
//   1. Every row fits the width it was laid out at. An overflowing row is truncated by the shell,
//      and a truncation inside a styled chip drops the escape that closes it.
//   2. Every chip appears exactly once, in the order given. Moving chips between rows is where a
//      chip gets duplicated, dropped or swapped with its neighbour.
//   3. The row count is the greedy minimum. Balancing may never spend a row.
//   4. The widest row is no wider than greedy's widest, and for the reported case it is strictly
//      narrower.
//   5. No row is a lone chip beneath a row that could have joined it (the pre-existing orphan rule
//      still holds, and the balance pass runs ahead of it without defeating it).
//
// The variant space is swept rather than described. The chip sets are the shapes a real footer
// takes, and `SELECT_LIST_SHORTCUTS` is pulled from the module so the product's own declared set is
// covered as it changes. Each set is laid out at EVERY width from the narrowest that holds its
// widest chip up past the whole strip, so every boundary between row counts is crossed. Widths and
// chip identity are read back from `ShortcutLayoutRow.chips`, so a set carrying keybindings is
// measured after resolution rather than from its declared label.
//
// WHAT IT DOES NOT CATCH: whether the balance is OPTIMAL. The arms hold the layout to a local
// optimum of the objective — no single forward move narrows the wider of two adjacent rows — which
// a globally worse layout can still satisfy. The orphan pass that borrows chips BACKWARD runs after
// the balance pass and is covered only through the swept widths, so a set whose shape is unlike the
// four below could still see it widen a row. Nothing here touches the centring, which is
// `renderModalShell`'s, nor the labels, which belong to the cards.

import { describe, expect, it } from "bun:test";
import {
	layoutShortcutRows,
	type ModalShortcut,
	SELECT_LIST_SHORTCUTS,
	type ShortcutLayoutRow,
} from "@veyyon/coding-agent/modes/components/modal-shell";
import { initTheme } from "@veyyon/coding-agent/modes/theme/theme";
import { visibleWidth } from "@veyyon/tui";

await initTheme(false);

function chips(...labels: string[]): ModalShortcut[] {
	return labels.map((label, index) => ({ id: `c${index}`, label }));
}

/**
 * The chip widths and the separator width, read back from a layout wide enough to hold the whole
 * strip on one row. Taking them from the layout rather than from the declared labels means a set
 * whose chips resolve live keybindings is measured at the width it actually renders at.
 */
function measure(shortcuts: readonly ModalShortcut[]): { widths: number[]; sepW: number } {
	const rows = layoutShortcutRows(shortcuts, 10_000);
	expect(rows.length, "the whole strip did not fit on one row at 10000 cells").toBe(1);
	const row = rows[0]!;
	const widths = row.chips.map(chip => chip.width);
	const sepW = row.chips.length > 1 ? row.chips[1]!.offset - (row.chips[0]!.offset + row.chips[0]!.width) : 0;
	return { widths, sepW };
}

/**
 * The greedy forward pack, as the specification of the row COUNT rather than a copy of the
 * implementation: chips in order, a new row opened only when the next does not fit. For a sequence
 * that may not be reordered this is provably minimal, which is why it is what the balanced layout
 * is held against.
 */
function greedyRows(widths: readonly number[], sepW: number, width: number): number[][] {
	const rows: number[][] = [];
	let current: number[] = [];
	let currentW = 0;
	for (const w of widths) {
		const extra = current.length === 0 ? w : sepW + w;
		if (current.length > 0 && currentW + extra > width) {
			rows.push(current);
			current = [w];
			currentW = w;
		} else {
			current.push(w);
			currentW += extra;
		}
	}
	if (current.length > 0) rows.push(current);
	return rows;
}

function sumRow(widths: readonly number[], sepW: number): number {
	return widths.reduce((w, chip, index) => w + chip + (index > 0 ? sepW : 0), 0);
}

function laidOutWidth(row: ShortcutLayoutRow): number {
	return visibleWidth(row.plain);
}

/**
 * Whether one more forward move would improve the layout: some row's last chip still fits on the
 * row below AND moving it makes the wider of the two rows narrower. This is the objective stated
 * over the OUTPUT, so any layout that satisfies it is balanced whatever algorithm produced it, and
 * greedy fails it for exactly the shapes that came out as pyramids.
 */
function forwardImprovable(rows: readonly number[][], sepW: number, width: number): boolean {
	for (let i = 0; i < rows.length - 1; i++) {
		const from = rows[i]!;
		const to = rows[i + 1]!;
		if (from.length < 2) continue;
		const chipW = from[from.length - 1]!;
		const fromWidth = sumRow(from, sepW);
		const toWidth = sumRow(to, sepW);
		const nextTo = to.length === 0 ? chipW : chipW + sepW + toWidth;
		if (nextTo > width) continue;
		if (Math.max(fromWidth - chipW - sepW, nextTo) < Math.max(fromWidth, toWidth)) return true;
	}
	return false;
}

/** The account manager's footer, the set that produced the reported pyramid. */
const ACCOUNTS_FOOTER = chips(
	"↑↓ move",
	"←→ pane",
	"enter switch Anthropic to this account",
	"n name",
	"r refresh this account",
	"u usage",
	"x logout",
	"a add",
	"ctrl+s search",
	"esc close",
);

const SETS: ReadonlyArray<{ name: string; shortcuts: readonly ModalShortcut[] }> = [
	{ name: "the select list's declared set", shortcuts: SELECT_LIST_SHORTCUTS },
	{ name: "three short chips", shortcuts: chips("esc close", "enter select", "tab next") },
	{
		name: "one long chip among short ones",
		shortcuts: chips("a", "bb", "enter switch this provider to the account under the cursor", "cc", "d"),
	},
	{ name: "the account manager's footer", shortcuts: ACCOUNTS_FOOTER },
];

describe("a card footer is one strip, not a pyramid", () => {
	it("sweeps footer sets that all carry chips", () => {
		expect(SETS.length).toBeGreaterThan(0);
		for (const set of SETS) {
			expect(set.shortcuts.length, `${set.name} declares no chips`).toBeGreaterThan(0);
		}
	});

	it("sweeps widths where greedy leaves an improvable strip, so the balance arms have teeth", () => {
		let improvable = 0;
		for (const set of SETS) {
			const { widths, sepW } = measure(set.shortcuts);
			const whole = sumRow(widths, sepW);
			for (let width = Math.max(...widths); width <= whole + 4; width++) {
				if (forwardImprovable(greedyRows(widths, sepW, width), sepW, width)) improvable++;
			}
		}
		expect(improvable, "greedy is already balanced everywhere swept").toBeGreaterThan(0);
	});

	for (const set of SETS) {
		describe(set.name, () => {
			const { widths, sepW } = measure(set.shortcuts);
			const whole = sumRow(widths, sepW);
			const widest = Math.max(...widths);
			const sweep: number[] = [];
			for (let width = widest; width <= whole + 4; width++) sweep.push(width);

			it("keeps every row inside the width, every chip once in order, and the greedy row count", () => {
				for (const width of sweep) {
					const rows = layoutShortcutRows(set.shortcuts, width);
					const flat: number[] = [];
					for (const row of rows) {
						expect(row.chips.length, `a row carries no chip at all at width ${width}`).toBeGreaterThan(0);
						expect(laidOutWidth(row), `a row overflows at width ${width}`).toBeLessThanOrEqual(width);
						expect(
							sumRow(
								row.chips.map(chip => chip.width),
								sepW,
							),
							`a row's chips do not account for its rendered width at ${width}`,
						).toBe(laidOutWidth(row));
						flat.push(...row.chips.map(chip => chip.width));
					}
					expect(flat, `a chip was dropped, duplicated or reordered at width ${width}`).toEqual(widths);
					expect(rows.length, `the row count moved at width ${width}`).toBe(
						greedyRows(widths, sepW, width).length,
					);
				}
			});

			it("never leaves a row wider than greedy's widest", () => {
				for (const width of sweep) {
					const rows = layoutShortcutRows(set.shortcuts, width);
					const laidOut = Math.max(...rows.map(laidOutWidth));
					const greedy = Math.max(...greedyRows(widths, sepW, width).map(row => sumRow(row, sepW)));
					expect(laidOut, `the widest row grew at width ${width}`).toBeLessThanOrEqual(greedy);
				}
			});

			it("leaves no forward move that would narrow the widest of two rows", () => {
				for (const width of sweep) {
					const rows = layoutShortcutRows(set.shortcuts, width).map(row => row.chips.map(chip => chip.width));
					expect(
						forwardImprovable(rows, sepW, width),
						`the strip is still improvable at width ${width}: ${rows.map(row => sumRow(row, sepW)).join("/")}`,
					).toBe(false);
				}
			});

			it("never strands a lone chip beneath a row that could have joined it", () => {
				for (const width of sweep) {
					const rows = layoutShortcutRows(set.shortcuts, width);
					for (let i = 1; i < rows.length; i++) {
						const lone = rows[i]!;
						if (lone.chips.length > 1) continue;
						const donor = rows[i - 1]!;
						if (donor.chips.length < 2) continue;
						const spare = donor.chips[donor.chips.length - 1]!.width;
						const joined = spare + sepW + laidOutWidth(lone);
						expect(
							joined,
							`a lone chip sits under a row that could have spared one at width ${width}`,
						).toBeGreaterThan(width);
					}
				}
			});
		});
	}

	// The backtest: the reported shape at the content widths it was reported at. 74 cells is the
	// account manager's footer column on a 100-column terminal, where greedy laid out 73, 57 and 27
	// and the 27 read as a leftover; 100 cells is that column on a 120-column terminal, where greedy
	// laid out 100 and 62.
	it("evens out the reported pyramid instead of leaving a 27-cell tail", () => {
		const { widths, sepW } = measure(ACCOUNTS_FOOTER);
		for (const width of [74, 100]) {
			const rows = layoutShortcutRows(ACCOUNTS_FOOTER, width).map(laidOutWidth);
			const greedy = greedyRows(widths, sepW, width).map(row => sumRow(row, sepW));
			expect(rows.length, `the row count moved at width ${width}`).toBe(greedy.length);
			expect(Math.max(...rows), `the strip did not get narrower at width ${width}`).toBeLessThan(
				Math.max(...greedy),
			);
			// The tail is no longer a remainder: it holds at least a third of the widest row.
			const last = rows[rows.length - 1] ?? 0;
			expect(last * 3, `the last row still reads as a remainder at width ${width}`).toBeGreaterThanOrEqual(
				Math.max(...rows),
			);
		}
	});
});
