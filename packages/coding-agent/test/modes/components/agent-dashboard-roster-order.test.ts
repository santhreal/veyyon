/**
 * Live roster ordering and refresh: where a row sits, and when the card redraws.
 *
 * WHY ORDER IS A CONTRACT. Call signs are assigned FROM the roster order, so an
 * order that moves is a NAME that moves: the agent you were about to press Enter
 * on becomes a different agent under the cursor, and the one you were reading as
 * `Kestrel` is now `Otter`. The Agent Hub sorted by recency and had to freeze
 * that order on open to stay usable; the card sorts by spawn order instead,
 * which cannot move, because an agent's spawn time never changes. This suite
 * pins that: heartbeats, activity updates and new spawns must all leave the
 * existing rows exactly where they were.
 *
 * WHY REFRESH IS A CONTRACT. A subagent starting emits several registry events
 * in immediate succession. Repainting per event flickers the roster, so a burst
 * is coalesced into one repaint, and the rows that appear after it are the rows
 * the burst produced, not a stale snapshot.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, setSystemTime, test, vi } from "bun:test";
import { AgentDashboard } from "@veyyon/coding-agent/modes/components/agent-dashboard";
import { initTheme, theme } from "@veyyon/coding-agent/modes/theme/theme";
import { AgentRegistry, MAIN_AGENT_ID } from "@veyyon/coding-agent/registry/agent-registry";
import type { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import { visibleWidth } from "@veyyon/tui";
import { type StubbedStdoutGeometry, stubStdoutGeometry } from "../../helpers/stdout-geometry";

const ANSI_PATTERN = /\x1b\[[0-?]*[ -/]*[@-~]/g;

let geometry: StubbedStdoutGeometry;

beforeAll(async () => {
	await initTheme(false);
});

beforeEach(() => {
	AgentRegistry.resetGlobalForTests();
	geometry = stubStdoutGeometry({ columns: 120, rows: 40 });
});

afterEach(() => {
	vi.useRealTimers();
	setSystemTime();
	vi.restoreAllMocks();
	AgentRegistry.resetGlobalForTests();
	geometry.restore();
});

function registerSub(id: string, type: string): void {
	AgentRegistry.global().register({
		id,
		displayName: type,
		kind: "sub",
		parentId: MAIN_AGENT_ID,
		session: { subscribe: () => () => {} } as unknown as AgentSession,
		sessionFile: null,
		status: "running",
	});
}

/**
 * The text inside the ModalShell card's borders, with the nav cursor blanked.
 *
 * Blanking rather than stripping: the selected row carries the cursor glyph
 * where every other row carries a space of the same width, so replacing it with
 * a space is what makes the rows COLUMN-COMPARABLE while still being the real
 * rendered bytes.
 */
function cardRows(dashboard: AgentDashboard): string[] {
	const rows: string[] = [];
	for (const raw of dashboard.render(120)) {
		const inner = /│(.*)│/.exec(raw.replace(ANSI_PATTERN, ""))?.[1];
		if (inner !== undefined) rows.push(inner.replaceAll(theme.nav.cursor, " ".repeat(theme.nav.cursor.length)));
	}
	return rows;
}

/**
 * The agent TYPES the card renders, top to bottom.
 *
 * A roster row reads `<cursor> <glyph> <call sign>  <type>  <status>  …`. The
 * TYPE is what identifies WHICH agent a row is here: call signs are positional
 * by design, assigned from the very order under test, so asserting on them would
 * make every ordering test trivially true. Chrome rows tokenize to text that is
 * never an agent type, so they cannot match.
 */
function renderedTypes(dashboard: AgentDashboard, types: readonly string[]): string[] {
	const found: string[] = [];
	for (const row of cardRows(dashboard)) {
		const type = row.trim().split(/\s+/)[2];
		if (type && types.includes(type)) found.push(type);
	}
	return found;
}

describe("Roster order", () => {
	/**
	 * Spawn order, oldest first, with the driving session pinned to the top. It is
	 * the one order that cannot change under a reader: an agent's `createdAt` is
	 * fixed at registration, while every recency-based order rewrites itself every
	 * time an agent breathes.
	 */
	test("lists the driving session first, then subagents oldest first", () => {
		vi.useFakeTimers();
		setSystemTime(1000);
		registerSub("A", "alpha");
		setSystemTime(2000);
		registerSub("B", "beta");
		setSystemTime(3000);
		registerSub("C", "gamma");
		setSystemTime(4000);
		AgentRegistry.global().register({
			id: MAIN_AGENT_ID,
			displayName: "main",
			kind: "main",
			session: null,
			status: "running",
		});
		const dashboard = new AgentDashboard({ terminalHeight: 40 });

		expect(renderedTypes(dashboard, ["alpha", "beta", "gamma"])).toEqual(["alpha", "beta", "gamma"]);
		expect(dashboard.render(120)[0]).toBeDefined();
		dashboard.dispose();
	});

	/**
	 * The regression the hub needed a frozen snapshot to avoid: an agent that
	 * reports activity must not jump. Here it cannot, because activity is not part
	 * of the order at all.
	 */
	test("leaves rows in place when an agent reports new activity", () => {
		vi.useFakeTimers();
		setSystemTime(1000);
		registerSub("A", "alpha");
		setSystemTime(2000);
		registerSub("B", "beta");
		setSystemTime(3000);
		registerSub("C", "gamma");
		const dashboard = new AgentDashboard({ terminalHeight: 40 });
		expect(renderedTypes(dashboard, ["alpha", "beta", "gamma"])).toEqual(["alpha", "beta", "gamma"]);

		setSystemTime(4000);
		AgentRegistry.global().setActivity("A", "still running");
		vi.advanceTimersByTime(200);

		expect(renderedTypes(dashboard, ["alpha", "beta", "gamma"])).toEqual(["alpha", "beta", "gamma"]);
		dashboard.dispose();
	});

	/** A new spawn appends at the end, after the coalescing window, rather than displacing anyone. */
	test("appends an agent that spawns while the card is open", () => {
		vi.useFakeTimers();
		setSystemTime(1000);
		registerSub("A", "alpha");
		setSystemTime(2000);
		registerSub("B", "beta");
		const dashboard = new AgentDashboard({ terminalHeight: 40 });

		setSystemTime(5000);
		registerSub("D", "delta");
		vi.advanceTimersByTime(200);

		expect(renderedTypes(dashboard, ["alpha", "beta", "delta"])).toEqual(["alpha", "beta", "delta"]);
		dashboard.dispose();
	});

	/**
	 * The cursor tracks the AGENT, not the row number. Without this, an agent
	 * spawning or parking while the operator's hand is on Enter moves a different
	 * agent under the cursor and opens the wrong one.
	 */
	test("keeps the cursor on the same agent when the roster changes underneath it", async () => {
		vi.useFakeTimers();
		setSystemTime(1000);
		registerSub("A", "alpha");
		setSystemTime(2000);
		registerSub("B", "beta");
		const opened: string[] = [];
		const dashboard = new AgentDashboard({
			terminalHeight: 40,
			focusAgent: async id => void opened.push(id),
		});

		dashboard.handleInput("j"); // cursor on B
		setSystemTime(3000);
		registerSub("C", "gamma");
		vi.advanceTimersByTime(200);
		dashboard.handleInput("\r");
		vi.useRealTimers();
		await Bun.sleep(0);

		expect(opened).toEqual(["B"]);
		dashboard.dispose();
	});
});

describe("Row rendering safety", () => {
	/**
	 * No row may exceed the card's width or carry a newline. A row that wraps
	 * pushes every row below it out of place and the card stops matching its own
	 * height budget; a raw newline in an agent-supplied description would do the
	 * same from data the operator does not control.
	 */
	test("truncates rows and strips newlines from agent-supplied text", () => {
		AgentRegistry.global().register({
			id: "RevAgentStream",
			displayName: "agent runtime and compaction reviewer",
			kind: "sub",
			parentId: MAIN_AGENT_ID,
			session: { subscribe: () => () => {} } as unknown as AgentSession,
			sessionFile: null,
			status: "running",
		});
		AgentRegistry.global().setActivity(
			"RevAgentStream",
			"Complete the assignment below, thoroughly:\n- check performance\n- check leaks",
		);
		const dashboard = new AgentDashboard({ terminalHeight: 40 });

		for (const line of dashboard.render(80)) {
			const plain = line.replace(ANSI_PATTERN, "");
			expect(plain.includes("\n")).toBe(false);
			expect(plain.includes("\r")).toBe(false);
			expect(visibleWidth(line)).toBeLessThanOrEqual(80);
		}
		dashboard.dispose();
	});

	/**
	 * The row Enter will open carries a CURSOR GLYPH, not only a selection tint.
	 *
	 * A background colour is the entire signal on a terminal that renders colour,
	 * and nothing at all on one that does not: under NO_COLOR, a dumb terminal or
	 * a piped capture, `theme.bg` returns the text unchanged, so a card that
	 * marked its selection with a tint alone left the operator unable to tell
	 * which agent they were about to open. Asserting on the glyph is also what
	 * keeps this test honest, since an assertion against `theme.bg(role, "")`
	 * compares against the empty string whenever colour is off and passes for any
	 * output whatsoever.
	 */
	test("marks the selected row with the nav cursor, which survives a colourless terminal", () => {
		registerSub("A", "alpha");
		registerSub("B", "beta");
		const dashboard = new AgentDashboard({ terminalHeight: 40 });

		const rowFor = (type: string) =>
			dashboard
				.render(120)
				.map(line => line.replace(ANSI_PATTERN, ""))
				.find(line => line.includes(type));

		expect(rowFor("alpha")).toContain(theme.nav.cursor);
		expect(rowFor("beta")).not.toContain(theme.nav.cursor);

		dashboard.handleInput("j");

		expect(rowFor("alpha")).not.toContain(theme.nav.cursor);
		expect(rowFor("beta")).toContain(theme.nav.cursor);
		dashboard.dispose();
	});

	/**
	 * The unselected rows reserve the cursor's slot rather than omitting it, so
	 * moving the cursor never shifts a row sideways under the reader's eye.
	 */
	test("keeps every row's columns fixed whether or not it is selected", () => {
		registerSub("A", "alpha");
		registerSub("B", "beta");
		const dashboard = new AgentDashboard({ terminalHeight: 40 });

		const columnOf = (type: string) => {
			const row = cardRows(dashboard).find(line => line.includes(type));
			if (!row) throw new Error(`no row for ${type}`);
			return row.indexOf(type);
		};

		// Row A is selected, row B is not.
		expect(columnOf("alpha")).toBe(columnOf("beta"));
		dashboard.dispose();
	});
});

describe("Refresh coalescing", () => {
	/**
	 * Three registrations in one tick are one repaint, not three, and the repaint
	 * carries all three rows. The timing is asserted on both sides of the window:
	 * nothing at 99ms proves the coalescing is real, and everything at 100ms
	 * proves it actually lands rather than being dropped.
	 */
	test("collects a synchronous registry burst into one repaint that shows every new row", () => {
		vi.useFakeTimers();
		const requestRender = vi.fn();
		const dashboard = new AgentDashboard({ terminalHeight: 40 });
		dashboard.onRequestRender = requestRender;

		registerSub("BurstA", "alpha");
		registerSub("BurstB", "beta");
		registerSub("BurstC", "gamma");

		expect(requestRender).not.toHaveBeenCalled();
		expect(renderedTypes(dashboard, ["alpha", "beta", "gamma"])).toEqual([]);

		vi.advanceTimersByTime(99);
		expect(requestRender).not.toHaveBeenCalled();

		vi.advanceTimersByTime(1);
		expect(requestRender).toHaveBeenCalledTimes(1);
		expect(renderedTypes(dashboard, ["alpha", "beta", "gamma"])).toEqual(["alpha", "beta", "gamma"]);
		dashboard.dispose();
	});

	/**
	 * A disposed card stops listening. The registry is process-global and outlives
	 * every card opened against it, so a card that kept its subscription would
	 * rebuild a layout nobody is looking at once per agent event for the rest of
	 * the session.
	 */
	test("stops refreshing once disposed", () => {
		vi.useFakeTimers();
		const requestRender = vi.fn();
		const dashboard = new AgentDashboard({ terminalHeight: 40 });
		dashboard.onRequestRender = requestRender;

		dashboard.dispose();
		registerSub("AfterDispose", "alpha");
		vi.advanceTimersByTime(1000);

		expect(requestRender).not.toHaveBeenCalled();
	});
});
