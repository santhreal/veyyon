/**
 * Pointing at the Agent Control Center: clicking a roster row, and clicking a
 * view tab.
 *
 * WHY. The card was keyboard-only inside its own borders: every gesture that did
 * anything with a mouse belonged to the shell around it (the close glyph, a
 * footer chip, a click outside to dismiss). A row you can see, that is drawn
 * with a cursor on it, and that does nothing when you click it reads as a broken
 * control rather than as a keyboard-only one.
 *
 * A row click OPENS the agent rather than only selecting it. The row's one
 * action is "open this agent", so a click that merely moved the cursor would ask
 * for a second gesture to do what the first already said, and opening is
 * reversible: Esc in the agent's session returns you to your own.
 *
 * The geometry is the part that rots. Row and column positions come from the
 * ModalShell the card just rendered, so these tests drive the REAL render and
 * then click at coordinates derived from it, rather than asserting against
 * numbers copied out of a layout that will move.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { AgentDashboard } from "@veyyon/coding-agent/modes/components/agent-dashboard";
import { initTheme, theme } from "@veyyon/coding-agent/modes/theme/theme";
import { AgentRegistry, MAIN_AGENT_ID } from "@veyyon/coding-agent/registry/agent-registry";
import type { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import { type StubbedStdoutGeometry, stubStdoutGeometry } from "../../helpers/stdout-geometry";

const ANSI_PATTERN = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const WIDTH = 120;

let geometry: StubbedStdoutGeometry;

beforeAll(async () => {
	await initTheme(false);
});

beforeEach(() => {
	AgentRegistry.resetGlobalForTests();
	geometry = stubStdoutGeometry({ columns: WIDTH, rows: 40 });
});

afterEach(() => {
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

/** An SGR left button press at a 0-based screen cell (the reports are 1-based). */
function leftClick(row: number, col: number): string {
	return `\x1b[<0;${col + 1};${row + 1}M`;
}

/** An SGR wheel report: button 64 is wheel-up, 65 is wheel-down. */
function wheel(direction: "up" | "down", row = 10, col = 20): string {
	return `\x1b[<${direction === "up" ? 64 : 65};${col + 1};${row + 1}M`;
}

/** The 0-based screen row of the rendered line containing `needle`. */
function rowOf(dashboard: AgentDashboard, needle: string): number {
	const index = dashboard.render(WIDTH).findIndex(line => line.replace(ANSI_PATTERN, "").includes(needle));
	if (index < 0) throw new Error(`no rendered row contains ${JSON.stringify(needle)}`);
	return index;
}

/** The 0-based screen column of `needle` within its rendered line. */
function colOf(dashboard: AgentDashboard, needle: string): number {
	const line = dashboard
		.render(WIDTH)
		.map(raw => raw.replace(ANSI_PATTERN, ""))
		.find(text => text.includes(needle));
	if (!line) throw new Error(`no rendered row contains ${JSON.stringify(needle)}`);
	return line.indexOf(needle);
}

describe("Clicking a roster row", () => {
	/** The gesture: click the agent, land in its session. */
	test("opens the agent whose row was clicked", async () => {
		registerSub("0-Sub", "reviewer");
		registerSub("1-Sub", "scout");
		const opened: string[] = [];
		const focused = Promise.withResolvers<void>();
		const dashboard = new AgentDashboard({
			terminalHeight: 40,
			focusAgent: async id => {
				opened.push(id);
				focused.resolve();
			},
		});

		dashboard.handleInput(leftClick(rowOf(dashboard, "scout"), 20));
		await focused.promise;

		expect(opened).toEqual(["1-Sub"]);
		dashboard.dispose();
	});

	/** It moves the cursor too, so the keyboard picks up where the mouse left off. */
	test("leaves the cursor on the row that was clicked", () => {
		registerSub("0-Sub", "reviewer");
		registerSub("1-Sub", "scout");
		const dashboard = new AgentDashboard({ terminalHeight: 40 });

		dashboard.handleInput(leftClick(rowOf(dashboard, "scout"), 20));

		const cursorRow = dashboard
			.render(WIDTH)
			.map(line => line.replace(ANSI_PATTERN, ""))
			.find(line => line.includes(theme.nav.cursor));
		expect(cursorRow).toContain("scout");
		dashboard.dispose();
	});

	/**
	 * A click on a blank row below the last agent does nothing. The pane is as
	 * tall as the card, so most of it is empty on a small roster, and an
	 * out-of-range index would either open the wrong agent or read `undefined.id`.
	 */
	test("ignores a click on the empty space under the last agent", () => {
		registerSub("0-Sub", "reviewer");
		const opened: string[] = [];
		const dashboard = new AgentDashboard({
			terminalHeight: 40,
			focusAgent: async id => void opened.push(id),
		});

		dashboard.handleInput(leftClick(rowOf(dashboard, "reviewer") + 5, 20));

		expect(opened).toEqual([]);
		dashboard.dispose();
	});

	/** And a click on the chrome above the roster is not a row click either. */
	test("ignores a click on the title row", () => {
		registerSub("0-Sub", "reviewer");
		const opened: string[] = [];
		const dashboard = new AgentDashboard({
			terminalHeight: 40,
			focusAgent: async id => void opened.push(id),
		});

		dashboard.handleInput(leftClick(rowOf(dashboard, "Agent Control Center"), 30));

		expect(opened).toEqual([]);
		dashboard.dispose();
	});

	/** Rows are not clickable from the Comms view, where the same rows are messages. */
	test("does not open an agent when the click lands in the Comms stream", () => {
		registerSub("0-Sub", "reviewer");
		const opened: string[] = [];
		const dashboard = new AgentDashboard({
			terminalHeight: 40,
			focusAgent: async id => void opened.push(id),
		});
		const rosterRow = rowOf(dashboard, "reviewer");

		dashboard.handleInput("\x1b[C"); // right arrow: Live -> Comms
		dashboard.handleInput(leftClick(rosterRow, 20));

		expect(opened).toEqual([]);
		dashboard.dispose();
	});
});

describe("Clicking a view tab", () => {
	/** The strip says what is behind each view, so it is the thing a pointer aims at. */
	test("switches to the view whose tab was clicked", () => {
		registerSub("0-Sub", "reviewer");
		const dashboard = new AgentDashboard({ terminalHeight: 40 });
		const stripRow = rowOf(dashboard, "Live (1)");

		dashboard.handleInput(leftClick(stripRow, colOf(dashboard, "Comms (0)")));

		expect(dashboard.render(WIDTH).join("\n").replace(ANSI_PATTERN, "")).toContain("No agent traffic yet.");
		dashboard.dispose();
	});

	/** Clicking the tab you are already on is a no-op, not a toggle to the other one. */
	test("stays put when the active tab is clicked", () => {
		registerSub("0-Sub", "reviewer");
		const dashboard = new AgentDashboard({ terminalHeight: 40 });
		const stripRow = rowOf(dashboard, "Live (1)");

		dashboard.handleInput(leftClick(stripRow, colOf(dashboard, "Live (1)")));

		const shown = dashboard.render(WIDTH).join("\n").replace(ANSI_PATTERN, "");
		expect(shown).toContain("reviewer");
		expect(shown).not.toContain("No agent traffic yet.");
		dashboard.dispose();
	});

	/** A click on the strip past the last tab changes nothing. */
	test("ignores a click on the empty part of the strip", () => {
		registerSub("0-Sub", "reviewer");
		const dashboard = new AgentDashboard({ terminalHeight: 40 });
		const stripRow = rowOf(dashboard, "Live (1)");

		dashboard.handleInput(leftClick(stripRow, WIDTH - 12));

		expect(dashboard.render(WIDTH).join("\n").replace(ANSI_PATTERN, "")).toContain("reviewer");
		dashboard.dispose();
	});
});

describe("Chrome clicks still belong to the shell", () => {
	/** Clicking outside the card dismisses it; the card must not swallow that. */
	test("closes when the click lands outside the card", () => {
		registerSub("0-Sub", "reviewer");
		let closed = 0;
		const dashboard = new AgentDashboard({ terminalHeight: 40 });
		dashboard.onClose = () => {
			closed++;
		};
		dashboard.render(WIDTH);

		dashboard.handleInput(leftClick(0, 0));

		expect(closed).toBe(1);
		dashboard.dispose();
	});
});

describe("The scroll wheel", () => {
	/**
	 * The wheel moves whatever the arrow keys move. Before this the card decoded a
	 * wheel report, matched it against no chrome, and consumed it anyway, so the
	 * scroll neither reached the card nor fell through to anything else: a long
	 * roster could only be moved by keyboard, and the wheel felt broken rather
	 * than unsupported.
	 */
	test("moves the roster cursor down and back up on Live", () => {
		registerSub("0-Sub", "reviewer");
		registerSub("1-Sub", "scout");
		const dashboard = new AgentDashboard({ terminalHeight: 40 });
		const cursorRow = () =>
			dashboard
				.render(WIDTH)
				.map(line => line.replace(ANSI_PATTERN, ""))
				.find(line => line.includes(theme.nav.cursor));

		dashboard.handleInput(wheel("down"));
		expect(cursorRow()).toContain("scout");

		dashboard.handleInput(wheel("up"));
		expect(cursorRow()).toContain("reviewer");
		dashboard.dispose();
	});

	/** A wheel report is never read as a click, so scrolling cannot open an agent. */
	test("does not open an agent", () => {
		registerSub("0-Sub", "reviewer");
		registerSub("1-Sub", "scout");
		const opened: string[] = [];
		const dashboard = new AgentDashboard({
			terminalHeight: 40,
			focusAgent: async id => void opened.push(id),
		});

		dashboard.handleInput(wheel("down"));
		dashboard.handleInput(wheel("up"));

		expect(opened).toEqual([]);
		dashboard.dispose();
	});

	/** And it never closes the card, which a click at the same coordinates outside would. */
	test("does not close the card, wherever the pointer is", () => {
		registerSub("0-Sub", "reviewer");
		let closed = 0;
		const dashboard = new AgentDashboard({ terminalHeight: 40 });
		dashboard.onClose = () => {
			closed++;
		};
		dashboard.render(WIDTH);

		dashboard.handleInput(wheel("down", 0, 0));

		expect(closed).toBe(0);
		dashboard.dispose();
	});
});
