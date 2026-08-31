/**
 * WHY: a card that splits into a column and a pane sized the COLUMN from its own
 * names and handed the pane the remainder. On a wide terminal that is invisible;
 * on a narrow one both halves starve at once — the model hub spent 26 columns on
 * `Recently used` beside model ids cut to `anthropic/claude-…`, and the account
 * manager spent 20 on provider names beside a pane whose first sentence took
 * three rows and pushed the accounts it applies to under the fold.
 *
 * THE CLASS, not the incident: any floating card in {@link OVERLAY_SPECS} that
 * draws an interior hairline is measured here, at every width down to the
 * narrowest the shell will draw. A card either gives the column away until the
 * pane clears {@link MIN_SPLIT_PANE_COLS}, or it draws no hairline at all and
 * shows one pane. Nothing in between is a layout a user can read.
 *
 * The sweep reads the roster at run time, so a new card enters it by existing —
 * `a-card-first-frame-is-settled.test.ts` holds the roll-call that makes an
 * unlisted card red — and the pinned set below turns red when a card starts or
 * stops splitting, so that is a decision somebody records rather than a drift.
 *
 * WHAT IT DOES NOT CATCH: the floor is a column count, not legibility. A pane
 * wide enough to pass here can still wrap a sentence badly, and a column that
 * yields can still cut a name; the per-card suites own those. It also measures
 * the frame the card draws unprompted, plus whatever `reachKeys` opens, so a
 * pane reachable only through a deeper state is not swept.
 */

import { beforeAll, describe, expect, test } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { initTheme } from "@veyyon/coding-agent/modes/theme/theme";
import { CURSOR_MARKER } from "@veyyon/tui";
import { OVERLAY_SPECS, type RenderableOverlay } from "./overlay-specs";

/**
 * A frame row as a column index reads it.
 *
 * `stripVTControlCharacters` leaves {@link CURSOR_MARKER} in place — it is an APC
 * sequence, not a CSI one — so a card with a focused search band carried seven
 * invisible characters on that row. Every bar to their right read seven columns
 * too far, the frame's rightmost bar came from that row, and the pane it implied
 * was eight columns wider than the one drawn: the sweep measured a card that
 * yields nothing as comfortable.
 */
function columns(line: string): string {
	return stripVTControlCharacters(line).replaceAll(CURSOR_MARKER, "");
}

/**
 * Columns a pane needs before the hairline beside it is worth drawing.
 *
 * Below thirty a pane holds a name and an ellipsis: the model rows, account rows
 * and settings rows every split card draws carry a glyph, a label and a trailing
 * value, and the narrowest of them wants more than this. It is a floor for the
 * whole class, not any card's own answer — each of those is larger.
 */
const MIN_SPLIT_PANE_COLS = 30;

/**
 * Widths the sweep measures: EVERY column count from the narrowest the shell
 * draws to a wide terminal, not a handful of samples.
 *
 * A ladder of round numbers has holes exactly where a yield is decided. An even
 * split that never hands its pane a floor starves it only between 57 and 59
 * content columns, which a ladder of 48, 56, 64 steps straight over, and the
 * mutation that removes the floor stays green. Every width is a few hundred
 * renders and closes that resolution hole for every card at once.
 */
const NARROWEST_CARD_COLS = 40;
const WIDEST_CARD_COLS = 200;
const WIDTHS = Array.from(
	{ length: WIDEST_CARD_COLS - NARROWEST_CARD_COLS + 1 },
	(_, index) => NARROWEST_CARD_COLS + index,
);

/** Cards that draw an interior hairline at 200 columns. A change here is a decision, not a drift. */
const SPLIT_CARDS = [
	"AccountManagerComponent",
	"AdvisorConfigOverlayComponent",
	"AskDialogComponent",
	"ExtensionDashboard",
	"ModelHubComponent",
	"PlanReviewOverlay",
	"SettingsSelectorComponent",
];

interface SplitGeometry {
	/** Column of the hairline between the column and the pane. */
	hairline: number;
	/** Cells the pane holds to the right of the hairline, card border excluded. */
	paneCols: number;
}

/**
 * The split geometry of a rendered card, read off the frame.
 *
 * A split row carries the card's two edges plus the hairline between the panes,
 * and a pane that scrolls adds a scrollbar of its own in `│`. The scrollbar is
 * identified by the `█` thumb that shares its column and dropped; a row left
 * with one interior bar states the split, and a row left with several carries a
 * vertical inside its content and says nothing about it.
 *
 * Each row is measured against ITS OWN right edge and the rows vote, rather than
 * a hairline from one row being measured against the widest bar in the frame.
 * A single stray row then cannot widen the pane the sweep believes it saw.
 */
function splitGeometry(frame: readonly string[]): SplitGeometry | undefined {
	const plain = frame.map(line => columns(line));
	const columnsOf = (glyph: string): readonly number[][] =>
		plain.map(line => [...line].flatMap((ch, index) => (ch === glyph ? [index] : [])));
	const scrollbars = new Set(columnsOf("█").flat());
	const seen = new Map<string, number>();
	for (const bars of columnsOf("│")) {
		if (bars.length < 3) continue;
		const interior = bars.slice(1, -1).filter(column => !scrollbars.has(column));
		if (interior.length !== 1) continue;
		const hairline = interior[0] ?? 0;
		// The row reads `│ column │ pane │`, one space either side of every bar, so
		// the pane holds the cells from two past the hairline to two before the
		// border.
		const paneCols = (bars[bars.length - 1] ?? 0) - hairline - 3;
		const key = `${hairline}:${paneCols}`;
		seen.set(key, (seen.get(key) ?? 0) + 1);
	}
	const winner = [...seen].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0];
	if (winner === undefined) return undefined;
	const [hairline = 0, paneCols = 0] = winner.split(":").map(Number);
	return { hairline, paneCols };
}

async function open(spec: (typeof OVERLAY_SPECS)[number]): Promise<RenderableOverlay> {
	const card = await spec.create();
	for (const keys of spec.reachKeys ?? []) {
		if ("handleInput" in card && typeof card.handleInput === "function") card.handleInput(keys);
	}
	return card;
}

describe("a split card yields its column before it starves its pane", () => {
	beforeAll(async () => {
		await initTheme();
	});

	test("no card draws a hairline with a pane too narrow to read", async () => {
		const starved: string[] = [];
		for (const spec of OVERLAY_SPECS) {
			const card = await open(spec);
			const widths: number[] = [];
			let narrowestPane = Number.POSITIVE_INFINITY;
			try {
				for (const width of WIDTHS) {
					const geometry = splitGeometry(card.render(width));
					if (geometry === undefined) continue;
					if (geometry.paneCols >= MIN_SPLIT_PANE_COLS) continue;
					widths.push(width);
					narrowestPane = Math.min(narrowestPane, geometry.paneCols);
				}
			} finally {
				card.dispose?.();
			}
			// One line per card, not per width: the range and the worst pane in it
			// say where the card broke without burying it in 160 near-copies.
			if (widths.length > 0) {
				const from = widths[0];
				const to = widths[widths.length - 1];
				starved.push(`${spec.name} starved at ${from}..${to} cols: pane ${narrowestPane} cols`);
			}
		}
		expect(starved).toEqual([]);
	});

	test("the sweep is measuring cards that actually split", async () => {
		const split: string[] = [];
		for (const spec of OVERLAY_SPECS) {
			const card = await open(spec);
			try {
				if (splitGeometry(card.render(200)) !== undefined) split.push(spec.name);
			} finally {
				card.dispose?.();
			}
		}
		expect(split.sort()).toEqual(SPLIT_CARDS);
	});
});
