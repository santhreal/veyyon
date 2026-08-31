/**
 * WHY:
 * The model hub sized its scope column from its own scope names — 18 to 26
 * columns, whichever the longest name wanted — and handed the model rows
 * whatever was left, floored at one column. So a narrow card showed a full-width
 * `Recently used` beside model rows cut to `anthropic/claude-…`, and there was
 * no width at which it stopped: the column took its share first and the rows
 * paid for it.
 *
 * The class this suite closes, for a card that splits itself in two:
 *   - the chrome yields before the content does, down to a floor;
 *   - when even the floor cannot buy a readable pane, one pane holds the frame
 *     and the other is reached with the same arrow keys;
 *   - a stacked pane says which scope it belongs to, since the column that used
 *     to say so is off screen;
 *   - and the pointer answers where the frame ACTUALLY drew each pane, not where
 *     the natural widths would have put it.
 *
 * What it does not catch: the roles and locked-provider panes report no width
 * demand yet, so the yield is measured only where the rows are a browser list;
 * and how the rows look inside the pane is the select list's own contract.
 */

import { afterEach, beforeAll, describe, expect, test, vi } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import type { Model } from "@veyyon/ai";
import { buildModel } from "@veyyon/catalog/build";
import type { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { ModelHubComponent, resetProviderAutoRefreshGuard } from "@veyyon/coding-agent/modes/components/model-hub";
import { getThemeByName, setThemeInstance } from "@veyyon/coding-agent/modes/theme/theme";
import type { TUI } from "@veyyon/tui";

const RIGHT = "\x1b[C";
const LEFT = "\x1b[D";
const DOWN = "\x1b[B";

function makeModel(provider: string, id: string): Model {
	return buildModel({
		id,
		name: id,
		api: "ollama-chat",
		provider,
		baseUrl: "https://example.com",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 1024,
	});
}

function makeRegistry(models: Model[]): ModelRegistry {
	return {
		refresh: async () => {},
		refreshProvider: async () => {},
		getError: () => undefined,
		getAvailable: () => models,
		getAll: () => models,
		getDiscoverableProviders: () => [],
		getProviderDiscoveryState: () => undefined,
		authStorage: { hasAuth: () => false },
	} as unknown as ModelRegistry;
}

const openHubs: ModelHubComponent[] = [];

function createHub(models: Model[]): ModelHubComponent {
	const ui = { requestRender: vi.fn(), terminal: { rows: 40 } } as unknown as TUI;
	const hub = new ModelHubComponent(
		ui,
		Settings.isolated({}),
		makeRegistry(models),
		models.map(model => ({ model })),
		{
			onAssign: vi.fn(),
			onUnassign: vi.fn(),
			onLoginRequest: vi.fn(),
			onFallbackChainChange: vi.fn(),
			onCancel: vi.fn(),
		},
	);
	openHubs.push(hub);
	return hub;
}

interface SplitGeometry {
	/** Columns the scope column holds, or `undefined` when one pane holds the frame. */
	sidebarCols: number | undefined;
	/** Widest interior content row, card frame excluded. */
	contentCols: number;
}

/**
 * The split geometry of a rendered card, read off the frame rather than
 * recomputed: a split row carries three verticals (the card's two edges and the
 * hairline between the panes) and a stacked row carries two.
 *
 * Restating the arithmetic here would pin the guess instead of the frame, which
 * is the mistake the component itself used to make.
 */
function splitGeometry(frame: readonly string[]): SplitGeometry {
	const rows = frame
		.map(line => stripVTControlCharacters(line))
		.map(line => ({ line, bars: [...line].flatMap((ch, index) => (ch === "│" ? [index] : [])) }))
		.filter(row => row.bars.length >= 2);
	if (rows.length === 0) throw new Error("no card rows in the rendered frame");
	const left = Math.min(...rows.map(row => row.bars[0] ?? 0));
	const right = Math.max(...rows.map(row => row.bars[row.bars.length - 1] ?? 0));
	const split = rows.find(row => row.bars.length === 3);
	return {
		sidebarCols: split === undefined ? undefined : (split.bars[1] ?? 0) - left - 2,
		contentCols: right - left - 3,
	};
}

function frameText(frame: readonly string[]): string {
	return stripVTControlCharacters(frame.join("\n")).replace(/\s+/g, " ").trim();
}

/** The card's title row: the first row carrying the card's name. */
function titleRow(frame: readonly string[]): string {
	const row = frame.map(line => stripVTControlCharacters(line)).find(line => line.includes("Models"));
	if (row === undefined) throw new Error("no title row in the rendered frame");
	return row;
}

/**
 * Everything below the title row: the pane that is on screen, without the
 * breadcrumb the title carries. A stacked card names the scope in its title, so
 * a whole-frame match cannot say which pane drew the name.
 */
function bodyText(frame: readonly string[]): string {
	const rows = frame.map(line => stripVTControlCharacters(line));
	const title = rows.findIndex(line => line.includes("Models"));
	return frameText(rows.slice(title + 1));
}

/** Scope names long enough that the column wants its full width. */
const WIDE_SCOPE_MODELS = [
	makeModel("anthropic-enterprise", "claude-opus-4-5-20260101-preview"),
	makeModel("openrouter-community", "meta-llama/llama-4-scout-instruct-fp8"),
	makeModel("openrouter-community", "meta-llama/llama-4-maverick-instruct"),
];

describe("a model hub pane is never starved by its scope column", () => {
	beforeAll(async () => {
		const theme = await getThemeByName("dark");
		if (!theme) throw new Error("Failed to load the dark theme");
		setThemeInstance(theme);
	});

	afterEach(() => {
		resetProviderAutoRefreshGuard();
		for (const hub of openHubs.splice(0)) hub.dispose();
	});

	test("gives the scope column's surplus to the rows before the rows are cut", () => {
		const hub = createHub(WIDE_SCOPE_MODELS);

		const wide = splitGeometry(hub.render(240));
		const tight = splitGeometry(hub.render(96));

		// Both widths still draw two panes: this is the yield, not the stack.
		expect(wide.sidebarCols).toBeDefined();
		expect(tight.sidebarCols).toBeDefined();
		if (wide.sidebarCols === undefined || tight.sidebarCols === undefined) return;

		// A card with room to spare seats the column at the width its own names
		// want; a card without takes the difference out of the column and not out
		// of a model id.
		expect(tight.sidebarCols).toBeLessThan(wide.sidebarCols);
		// And it stops at a floor rather than collapsing: a scope column too narrow
		// to name a scope is not worth the hairline beside it.
		expect(tight.sidebarCols).toBeGreaterThanOrEqual(12);
	});

	test("shows one pane at a time when two will not fit, and says which scope it is showing", () => {
		const hub = createHub(WIDE_SCOPE_MODELS);

		const narrow = hub.render(56);
		// One pane: no interior hairline anywhere in the card.
		expect(splitGeometry(narrow).sidebarCols).toBeUndefined();
		// The scopes hold the frame first, so the title is the card's own name and
		// the pane is not on screen at all: the status row that names the scope's
		// models is the row only the pane draws.
		expect(titleRow(narrow)).toContain("Models");
		expect(titleRow(narrow)).not.toContain("›");
		expect(bodyText(narrow)).toContain("All models");
		expect(bodyText(narrow)).not.toContain("All available models");

		// `→` is the key that already moved to the rows; it now swaps which pane
		// holds the frame, and the title carries the scope the column used to say.
		hub.handleInput(RIGHT);
		const rows = hub.render(56);
		expect(splitGeometry(rows).sidebarCols).toBeUndefined();
		expect(titleRow(rows)).toContain("Models ›");
		expect(bodyText(rows)).toContain("All available models");
		expect(bodyText(rows)).not.toContain("All models");

		// And `←` brings the scopes back, so neither pane is reachable only by luck.
		hub.handleInput(LEFT);
		expect(bodyText(hub.render(56))).toContain("All models");
		expect(bodyText(hub.render(56))).not.toContain("All available models");
		expect(titleRow(hub.render(56))).not.toContain("›");
	});

	test("keeps a wide card's split, so the stack is a narrow-card answer only", () => {
		const hub = createHub(WIDE_SCOPE_MODELS);
		const geometry = splitGeometry(hub.render(240));

		expect(geometry.sidebarCols).toBeDefined();
		expect(geometry.contentCols).toBeGreaterThan(60);
	});

	test("answers a click anywhere on a stacked scope row, not only inside the old column", () => {
		const hub = createHub([makeModel("provider-alpha", "alpha-model"), makeModel("provider-bravo", "bravo-model")]);

		// The columns the split card gives the scopes, measured off a wide frame
		// rather than restated from the source, so the click below is provably
		// past where that column ended.
		const splitCols = splitGeometry(hub.render(120)).sidebarCols ?? 0;

		const stripped = hub.render(56).map(line => stripVTControlCharacters(line));
		const row = stripped.findIndex(line => line.includes("provider-bravo"));
		expect(row).toBeGreaterThanOrEqual(0);
		// The row's rightmost glyph is its match count, out at the far end of a
		// column that now spans the card. A pointer answering the natural widths
		// would send this click to a pane that is not on screen.
		const target = (stripped[row] ?? "").replace(/[\s│]+$/u, "").length - 1;
		expect(target).toBeGreaterThan(splitCols);

		// A left-button SGR press, whose coordinates are 1-based.
		hub.handleInput(`\x1b[<0;${target + 1};${row + 1}M`);

		// The marker sits on the row that was clicked, and not on the scope the
		// card opened with.
		const clicked = hub.render(56).map(line => stripVTControlCharacters(line));
		expect(clicked[row]).toContain("›");
		expect(titleRow(clicked)).not.toContain("›");
		// The click landed on the scope, so the rows that follow are that scope's.
		hub.handleInput(RIGHT);
		expect(titleRow(hub.render(56))).toContain("provider-bravo");
	});

	test("still moves the scope with the keys while the card is stacked", () => {
		const hub = createHub([makeModel("provider-alpha", "alpha-model"), makeModel("provider-bravo", "bravo-model")]);

		hub.render(56);
		hub.handleInput(DOWN);
		const moved = frameText(hub.render(56));

		// The stack changes which pane is on screen, never which keys reach it.
		expect(moved).toContain("provider-");
	});
});
