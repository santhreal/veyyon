/**
 * WHY: the provider column sized itself from the longest provider name and the
 * pane took whatever was left. On a narrow card that pane wraps rather than cuts,
 * so the scope line — which states that these credentials are shared by every
 * profile — took three rows and pushed the accounts it applies to under the fold,
 * while thirty columns to its left held five short words.
 *
 * THE CLASS this closes is the card's own floor, not the shared one:
 * `a-split-card-yields-its-column-before-it-starves-its-pane.test.ts` holds every
 * split card to a pane of thirty columns, and a pane can clear thirty and still
 * wrap this card's sentences. The column here keeps its natural width only while
 * the pane holds forty, yields down to twenty to keep it there, and the card
 * shows one pane at a time when even that cannot be bought. Every width from the
 * narrowest the shell draws upward is measured, so the yield cannot be correct at
 * a handful of round numbers and wrong between them, and 80 columns is pinned on
 * its own, since that is the width the floor was first set too high for.
 *
 * The inventory below names providers at the maximum column width, because a
 * short name makes the yield unobservable: the column asks for less than the pane
 * would have given back, and a build that never yields looks identical.
 *
 * WHAT IT DOES NOT CATCH: legibility. A forty-column pane can still wrap a
 * long account name badly, and a twenty-column provider list still truncates
 * `Anthropic (subscription)`. It also measures the frame at rest — no search
 * band open, no add-account flow — so a pane reachable only through those states
 * is not swept here.
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { AccountManagerComponent } from "@veyyon/coding-agent/modes/components/account-manager";
import { initTheme } from "@veyyon/coding-agent/modes/theme/theme";
import type { AccountInventory } from "@veyyon/coding-agent/session/account-inventory";
import { CURSOR_MARKER } from "@veyyon/tui";

/** The card's own floor for the pane, mirrored from `MIN_BODY_WIDTH`. */
const MIN_BODY_WIDTH = 40;
/** The narrowest provider column the card will draw, mirrored from `SIDEBAR_MIN_WIDTH`. */
const SIDEBAR_MIN_WIDTH = 20;
/** The widest, mirrored from `SIDEBAR_MAX_WIDTH`. */
const SIDEBAR_MAX_WIDTH = 30;
/** Columns the ` │ ` hairline takes, mirrored from `PANE_SEP_COLS`. */
const PANE_SEP_COLS = 3;

beforeAll(async () => {
	await initTheme();
});

/** Two providers whose names alone would take the column's maximum width. */
const INVENTORY: AccountInventory = {
	providers: [
		{
			provider: "anthropic",
			label: "Anthropic Subscription",
			rows: [
				{
					provider: "anthropic",
					providerLabel: "Anthropic Subscription",
					credentialId: 1,
					type: "oauth",
					origin: { kind: "oauth" },
					usage: [],
					activeForSession: true,
					activeIsPrediction: false,
					selectedForProvider: false,
					name: "work",
				},
			],
		},
		{
			provider: "openai",
			label: "OpenAI Platform Keys",
			rows: [
				{
					provider: "openai",
					providerLabel: "OpenAI Platform Keys",
					credentialId: 2,
					type: "api_key",
					origin: { kind: "config" },
					usage: [],
					activeForSession: false,
					activeIsPrediction: false,
					selectedForProvider: true,
					name: "personal",
				},
			],
		},
	],
	totalAccounts: 2,
	unhealthyCount: 0,
};

function frame(width: number): readonly string[] {
	const component = new AccountManagerComponent(
		INVENTORY,
		{
			onUseAccount: () => {},
			onRename: () => {},
			onRefresh: () => {},
			onLogout: () => {},
			onShowUsage: () => {},
			onAddAccount: () => {},
			onClearRateLimitBlock: () => {},
			onCancel: () => {},
		},
		{ terminalHeight: 40 },
	);
	return component.render(width);
}

interface Split {
	/** Cells the provider column holds, card border and its padding excluded. */
	columnCols: number;
	/** Cells the pane holds to the right of the hairline. */
	paneCols: number;
}

/**
 * The split the card drew, read off the frame.
 *
 * A split row carries the card's two edges and the hairline between the column
 * and the pane; the scrollbar shares its column with the `█` thumb and is
 * dropped, and a row with a vertical of its own inside the content says nothing
 * about the split. Rows vote, each measured against its own right edge, and
 * `CURSOR_MARKER` is an APC sequence `stripVTControlCharacters` leaves in place,
 * so it comes out before a column index is read off the row.
 */
function split(width: number): Split | undefined {
	const rows = frame(width).map(line => stripVTControlCharacters(line).replaceAll(CURSOR_MARKER, ""));
	const columnsOf = (glyph: string): readonly number[][] =>
		rows.map(line => [...line].flatMap((ch, index) => (ch === glyph ? [index] : [])));
	const scrollbars = new Set(columnsOf("█").flat());
	const seen = new Map<string, number>();
	for (const bars of columnsOf("│")) {
		if (bars.length < 3) continue;
		const interior = bars.slice(1, -1).filter(column => !scrollbars.has(column));
		if (interior.length !== 1) continue;
		const hairline = interior[0] ?? 0;
		// One space sits either side of every bar, so a pane's cells run from two
		// past its left bar to two before its right one.
		const key = `${hairline - (bars[0] ?? 0) - 3}:${(bars[bars.length - 1] ?? 0) - hairline - 3}`;
		seen.set(key, (seen.get(key) ?? 0) + 1);
	}
	const winner = [...seen].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0];
	if (winner === undefined) return undefined;
	const [columnCols = 0, paneCols = 0] = winner.split(":").map(Number);
	return { columnCols, paneCols };
}

/** Every width the shell draws a card at, from the narrowest upward. */
const WIDTHS = Array.from({ length: 161 }, (_, index) => 40 + index);

describe("the account manager column gives its surplus to its pane", () => {
	test("no width leaves the pane under the card's own floor", () => {
		const starved = WIDTHS.flatMap(width => {
			const geometry = split(width);
			if (geometry === undefined || geometry.paneCols >= MIN_BODY_WIDTH) return [];
			return [`${width} cols: pane ${geometry.paneCols}, column ${geometry.columnCols}`];
		});
		expect(starved).toEqual([]);
	});

	test("the column yields rather than the card refusing to split", () => {
		const yielded = WIDTHS.flatMap(width => {
			const geometry = split(width);
			if (geometry === undefined) return [];
			return [{ width, ...geometry }];
		});
		// A card that never yields would split only once its column had its full
		// natural width, so the narrowest split would already be comfortable.
		const narrowest = yielded[0];
		expect(narrowest).toBeDefined();
		expect(narrowest?.columnCols).toBe(SIDEBAR_MIN_WIDTH);
		// The narrowest split the card draws sits ON the pane's floor, give or take
		// the column the shell's own width steps in: the column is at its minimum
		// there, so nothing is left to hand over.
		expect(narrowest?.paneCols).toBeGreaterThanOrEqual(MIN_BODY_WIDTH);
		expect(narrowest?.paneCols).toBeLessThan(MIN_BODY_WIDTH + PANE_SEP_COLS);
		// The column never exceeds its maximum, however wide the card gets, and
		// never drops below its minimum while a hairline is drawn.
		const outOfRange = yielded.filter(
			row => row.columnCols < SIDEBAR_MIN_WIDTH || row.columnCols > SIDEBAR_MAX_WIDTH,
		);
		expect(outOfRange).toEqual([]);
		// It grows monotonically with the card: a wider card never gives the
		// column less than a narrower one did.
		const shrinking = yielded.flatMap((row, index) => {
			const previous = yielded[index - 1];
			return previous && row.columnCols < previous.columnCols ? [`${previous.width}->${row.width}`] : [];
		});
		expect(shrinking).toEqual([]);
	});

	test("an eighty-column terminal still draws both panes", () => {
		// The floor is a trade, and this is the side of it that a number chosen from
		// the wrap alone got wrong: 46 stacked the card at 80 columns, which is the
		// width every other surface here is measured at, and `/account` opened onto
		// a provider list with the accounts one keystroke away instead of beside it.
		const geometry = split(80);
		expect(geometry).toBeDefined();
		expect(geometry?.paneCols).toBeGreaterThanOrEqual(MIN_BODY_WIDTH);
		expect(frame(80).some(line => stripVTControlCharacters(line).includes("Accounts › "))).toBe(false);
	});

	test("below the floor the card shows one pane, not two starved ones", () => {
		const widest = WIDTHS.filter(width => split(width) === undefined).at(-1);
		expect(widest).toBeDefined();
		const stackedFrame = frame(widest ?? 40).map(line =>
			stripVTControlCharacters(line).replaceAll(CURSOR_MARKER, ""),
		);
		// The stacked card names the scope it is showing in its own title, since
		// the column that used to name it is not on screen.
		expect(stackedFrame.some(line => line.includes("Accounts › "))).toBe(true);
	});
});
