/**
 * The selection highlight on a Live roster row, at the byte level.
 *
 * WHY THIS SUITE EXISTS. The highlight used to be wrapped around the row's TEXT,
 * so the tint stopped wherever that row's content happened to end: a band that
 * covered `Kestrel  reviewer  running` and then died two thirds of the way
 * across the card. A ragged right edge does not read as a selection. It reads as
 * a rendering fault, and it moves from row to row as you navigate, because every
 * agent's line is a different length. The fill now runs to the pane's right edge.
 *
 * These tests force colour ON (`setAnsiPolicy("full")`). The bug is invisible
 * without it: `theme.bg` returns its text unchanged when colour is off, so a
 * suite that renders with the default policy asserts against a row where the
 * highlight never existed either way. The cursor glyph is what carries the
 * selection on those terminals, and `agent-dashboard-live-view.test.ts` covers
 * it there.
 *
 * They also pin the gutter rule. `ScrollView` truncates every line it is given to
 * its content width, and a truncation that lands inside a fill drops the escape
 * that CLOSES the fill, which paints the scrollbar and everything past it in the
 * selection colour. That is why the row asks the view how wide it may draw
 * instead of assuming the full width.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { AgentDashboard } from "@veyyon/coding-agent/modes/components/agent-dashboard";
import { initTheme, theme } from "@veyyon/coding-agent/modes/theme/theme";
import { AgentRegistry, MAIN_AGENT_ID } from "@veyyon/coding-agent/registry/agent-registry";
import { getAnsiPolicy, setAnsiPolicy } from "@veyyon/tui";
import { type StubbedStdoutGeometry, stubStdoutGeometry } from "../../helpers/stdout-geometry";

const ANSI_PATTERN = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const BG_CLOSE = "\x1b[49m";
const WIDTH = 100;
/**
 * Columns the modal shell keeps between the pane and its right border.
 *
 * The fill stops at the pane's edge, not the card's, so a few columns of card
 * padding follow it. The number is small and fixed; what this guards against is
 * the OLD behaviour, where the unfilled tail was as wide as whatever the row did
 * not say (fifty columns and more on a short row).
 */
const MAX_CARD_PADDING = 4;

let geometry: StubbedStdoutGeometry;
let policy: ReturnType<typeof getAnsiPolicy>;

beforeEach(async () => {
	await initTheme(false);
	policy = getAnsiPolicy();
	setAnsiPolicy("full");
	AgentRegistry.resetGlobalForTests();
	geometry = stubStdoutGeometry({ columns: WIDTH, rows: 40 });
});

afterEach(() => {
	setAnsiPolicy(policy);
	AgentRegistry.resetGlobalForTests();
	geometry.restore();
});

function registerSub(id: string, type: string): void {
	AgentRegistry.global().register({
		id,
		displayName: type,
		kind: "sub",
		parentId: MAIN_AGENT_ID,
		session: null,
		status: "running",
	});
}

/** The escape that OPENS the selection background, whatever the active theme uses. */
function bgOpen(): string {
	return theme.bg("selectedBg", "").replace(BG_CLOSE, "");
}

interface Highlight {
	/** Visible text the fill covers, padding included. */
	span: string;
	/** Visible text between the end of the fill and the card's right border. */
	tail: string;
}

/** The highlighted region of the row containing `needle`, or undefined if it has none. */
function highlightOf(dashboard: AgentDashboard, needle: string): Highlight | undefined {
	const line = dashboard.render(WIDTH).find(row => row.replace(ANSI_PATTERN, "").includes(needle));
	if (!line) throw new Error(`no rendered row contains ${JSON.stringify(needle)}`);
	const start = line.indexOf(bgOpen());
	if (start < 0) return undefined;
	const end = line.indexOf(BG_CLOSE, start);
	if (end < 0) throw new Error("the selection background was opened and never closed");
	const strip = (text: string) => text.replace(ANSI_PATTERN, "");
	const rest = strip(line.slice(end + BG_CLOSE.length));
	return {
		span: strip(line.slice(start + bgOpen().length, end)),
		tail: rest.slice(0, rest.lastIndexOf("│")),
	};
}

describe("The selected row's fill", () => {
	/**
	 * The band runs past the text. This is the regression: a highlight sized to the
	 * content ended mid-row, and the eye reads that ragged edge as the end of
	 * something rather than as the row you are on.
	 */
	test("pads the highlight beyond the end of the row's text", () => {
		registerSub("0-Sub", "reviewer");
		const dashboard = new AgentDashboard({ terminalHeight: 40 });

		const highlight = highlightOf(dashboard, "reviewer");

		expect(highlight?.span.trimEnd().length).toBeLessThan(highlight?.span.length ?? 0);
		dashboard.dispose();
	});

	/**
	 * And it runs all the way to the pane's edge: only the card's own padding
	 * separates the fill from the border. An assertion on "some padding" would pass
	 * on a row filled by a single trailing space, which is the bug with a fig leaf.
	 */
	test("fills to the right edge of the pane", () => {
		registerSub("0-Sub", "reviewer");
		const dashboard = new AgentDashboard({ terminalHeight: 40 });

		const highlight = highlightOf(dashboard, "reviewer");

		expect(highlight?.tail.trim()).toBe("");
		expect(highlight?.tail.length).toBeLessThanOrEqual(MAX_CARD_PADDING);
		dashboard.dispose();
	});

	/**
	 * Every row is the same width, so moving the cursor does not change the band's
	 * shape. The two agents have deliberately different content lengths: `scout`
	 * with no activity is a short row, and the one with an activity string fills
	 * most of the width, which is exactly the pair that used to give two bands of
	 * different lengths.
	 */
	test("gives each row the same fill width as the cursor moves", () => {
		registerSub("0-Sub", "reviewer");
		registerSub("1-Sub", "scout");
		AgentRegistry.global().setActivity(
			"1-Sub",
			"reading packages/coding-agent/src/modes/components/agent-dashboard.ts",
		);
		const dashboard = new AgentDashboard({ terminalHeight: 40 });
		const first = highlightOf(dashboard, "reviewer")?.span.length;

		dashboard.handleInput("\x1b[B"); // down: select the second row

		expect(highlightOf(dashboard, "scout")?.span.length).toBe(first);
		dashboard.dispose();
	});

	/**
	 * Exactly one ROW is filled. The active view tab uses the same background, and
	 * it should: one visual language for "this is the thing you are on". What must
	 * not happen is a second filled row, which is what a stale selection index or a
	 * fill leaking past its line would look like.
	 */
	test("highlights one row and no other", () => {
		registerSub("0-Sub", "reviewer");
		registerSub("1-Sub", "scout");
		const dashboard = new AgentDashboard({ terminalHeight: 40 });

		const filledRows = dashboard
			.render(WIDTH)
			.filter(line => line.includes(bgOpen()))
			.map(line => line.replace(ANSI_PATTERN, ""));

		expect(filledRows.filter(line => line.includes("Kestrel") || line.includes("Otter"))).toHaveLength(1);
		expect(filledRows.filter(line => line.includes("Live ("))).toHaveLength(1);
		dashboard.dispose();
	});

	/** An unselected row carries no fill at all, so the band cannot be mistaken for a rule. */
	test("leaves the other rows unfilled", () => {
		registerSub("0-Sub", "reviewer");
		registerSub("1-Sub", "scout");
		const dashboard = new AgentDashboard({ terminalHeight: 40 });

		expect(highlightOf(dashboard, "scout")).toBeUndefined();
		dashboard.dispose();
	});
});

describe("The fill and the scrollbar gutter", () => {
	/** A roster taller than the card, so the view reserves its two columns. */
	function overflowingCard(): AgentDashboard {
		for (let index = 0; index < 60; index++) registerSub(`${index}-Sub`, `agent-${index}`);
		return new AgentDashboard({ terminalHeight: 40 });
	}

	/**
	 * The fill stops before the gutter. Padding the row to the FULL width instead
	 * pushed it into the two columns the scrollbar owns, and `ScrollView` truncated
	 * the line to make room, cutting the escape that closes the background: the
	 * bar, and every cell after it, came out painted in the selection colour with
	 * nothing to turn it off.
	 */
	test("closes the background before the scrollbar", () => {
		const dashboard = overflowingCard();

		const highlight = highlightOf(dashboard, "agent-0");

		expect(highlight?.span).not.toContain("█");
		expect(highlight?.span).not.toContain("│");
		dashboard.dispose();
	});

	/** And the bar is still drawn: the row gave the gutter back rather than eating it. */
	test("leaves the scrollbar visible on the selected row", () => {
		const dashboard = overflowingCard();

		const highlight = highlightOf(dashboard, "agent-0");

		expect(highlight?.tail).toContain("█");
		dashboard.dispose();
	});
});
