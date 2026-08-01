/**
 * The Live view of the Agent Control Center: who is running, what kind of agent
 * each one is, and what happens when you open one.
 *
 * WHY THESE TESTS. Two things about this view were wrong in ways no type check
 * could see. The agent TYPE -- the definition a row was spawned from -- was
 * rendered only when the agent had no activity to report, which is exactly when
 * nobody is looking at the row, so a roster of `Kestrel`/`Otter`/`Juniper` never
 * said which one was the reviewer. And Enter opened a read-only pane inside the
 * card: you could watch an agent ask a question and had no way to answer it.
 * Enter now hands the main view to that agent's live session.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { AgentDashboard } from "@veyyon/coding-agent/modes/components/agent-dashboard";
import { initTheme, theme } from "@veyyon/coding-agent/modes/theme/theme";
import { AgentRegistry, MAIN_AGENT_ID } from "@veyyon/coding-agent/registry/agent-registry";
import { getAnsiPolicy, setAnsiPolicy } from "@veyyon/tui";
import { type StubbedStdoutGeometry, stubStdoutGeometry } from "../../helpers/stdout-geometry";

const ANSI_PATTERN = /\x1b\[[0-?]*[ -/]*[@-~]/g;

/**
 * Register a subagent the way the task executor does: `displayName` is the
 * agent definition's name (`task/executor.ts` passes `agent.name`), which is
 * what the roster shows as the agent type.
 */
function registerSub(id: string, type: string, activity?: string): void {
	const registry = AgentRegistry.global();
	registry.register({ id, displayName: type, kind: "sub", session: null, status: "running" });
	if (activity) registry.setActivity(id, activity);
}

let geo: StubbedStdoutGeometry;

beforeEach(async () => {
	await initTheme(false);
	AgentRegistry.resetGlobalForTests();
	geo = stubStdoutGeometry({ columns: 120, rows: 40 });
});

afterEach(() => {
	AgentRegistry.resetGlobalForTests();
	geo.restore();
});

function frameOf(dashboard: AgentDashboard): string {
	return dashboard.render(120).join("\n").replace(ANSI_PATTERN, "");
}

describe("Live roster", () => {
	/**
	 * The call sign is memorable but arbitrary: `Kestrel` says nothing about
	 * whether the thing burning tokens over there is a reviewer or a scout. The
	 * type sits next to it, on every row, including the rows that are busy enough
	 * to report activity -- which used to be exactly the rows that hid it.
	 */
	test("shows each agent's type next to its call sign, even while it reports activity", () => {
		registerSub("0-Sub", "reviewer", "reading diff of agent-dashboard.ts");
		registerSub("1-Sub", "scout", "grepping for callers");
		const dashboard = new AgentDashboard({ terminalHeight: 40 });

		const shown = frameOf(dashboard);

		expect(shown).toContain("reviewer");
		expect(shown).toContain("scout");
		expect(shown).toContain("reading diff of agent-dashboard.ts");
		dashboard.dispose();
	});

	/**
	 * The driving session has no agent definition behind it and registers as
	 * `main`, which under the call sign `Main` would print the same word twice.
	 */
	test("does not print the driving session's type twice", () => {
		AgentRegistry.global().register({
			id: MAIN_AGENT_ID,
			displayName: "main",
			kind: "main",
			session: null,
			status: "running",
		});
		const dashboard = new AgentDashboard({ terminalHeight: 40 });

		const shown = frameOf(dashboard);

		expect(shown).toContain("Main");
		expect(shown).not.toContain("Main  main");
		dashboard.dispose();
	});

	/**
	 * Ages are seconds, and the unit is stated once.
	 *
	 * `formatAge` takes SECONDS and appends " ago" itself; the roster once handed
	 * it MILLISECONDS, so a four-second-old agent rendered as "1h ago" and a
	 * two-minute-old one as "1d ago", while the code typechecked and every
	 * existing test passed, because nothing asserted the text.
	 */
	test("renders ages in real units, once", () => {
		const registry = AgentRegistry.global();
		registry.register({ id: MAIN_AGENT_ID, displayName: "main", kind: "main", session: null, status: "running" });
		const ref = registry.get(MAIN_AGENT_ID);
		if (!ref) throw new Error("registration did not take");
		ref.lastActivity = Date.now() - 3 * 60_000;
		const dashboard = new AgentDashboard({ terminalHeight: 40 });

		const shown = frameOf(dashboard);

		expect(shown).toContain("3m ago");
		expect(shown).not.toContain("ago ago");
		dashboard.dispose();
	});

	/** With nothing registered the view says so, and says what will fill it. */
	test("states the empty case instead of rendering a blank pane", () => {
		const dashboard = new AgentDashboard({ terminalHeight: 40 });

		const shown = frameOf(dashboard);

		expect(shown).toContain("Nothing running.");
		expect(shown).toContain("Enter opens one in the main view");
		dashboard.dispose();
	});
});

describe("Opening an agent", () => {
	/**
	 * THE POINT OF THE VIEW. Enter asks the show site to focus that agent's live
	 * session, which retargets the transcript, the editor and the status line at
	 * it (SessionFocusController) so the operator can read it AND reply. The card
	 * used to open an in-card pane instead, which could show a question and could
	 * not carry an answer.
	 */
	test("Enter opens the selected agent's session, by id", async () => {
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

		dashboard.handleInput("\r");
		await focused.promise;

		expect(opened).toEqual(["0-Sub"]);
		dashboard.dispose();
	});

	/** And it follows the cursor rather than always opening the first row. */
	test("Enter opens whichever agent the cursor is on", async () => {
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

		dashboard.handleInput("j");
		dashboard.handleInput("\r");
		await focused.promise;

		expect(opened).toEqual(["1-Sub"]);
		dashboard.dispose();
	});

	/**
	 * Handing the main view over is what closes the card: the operator asked to go
	 * somewhere, and a card left on top of the session they were sent to would
	 * have to be dismissed by hand before they could type to the agent they just
	 * opened.
	 */
	test("closes the card once the hand-over lands", async () => {
		registerSub("0-Sub", "reviewer");
		const closed = Promise.withResolvers<void>();
		const dashboard = new AgentDashboard({ terminalHeight: 40, focusAgent: async () => {} });
		dashboard.onClose = () => closed.resolve();

		dashboard.handleInput("\r");
		await closed.promise;

		dashboard.dispose();
	});

	/**
	 * A hand-over that fails keeps the card open with the reason on it. Closing on
	 * failure would drop the operator back into a session that did not change,
	 * with nothing said about why the agent never opened.
	 */
	test("keeps the card open and states the reason when the hand-over is refused", async () => {
		registerSub("0-Sub", "reviewer");
		const message = 'Agent "0-Sub" is aborted and cannot be revived';
		let closeCalls = 0;
		const rendered = Promise.withResolvers<void>();
		const dashboard = new AgentDashboard({
			terminalHeight: 40,
			focusAgent: () => Promise.reject(new Error(message)),
		});
		dashboard.onClose = () => {
			closeCalls++;
		};
		dashboard.onRequestRender = () => rendered.resolve();

		dashboard.handleInput("\r");
		await rendered.promise;

		expect(closeCalls).toBe(0);
		expect(frameOf(dashboard)).toContain(message);
		dashboard.dispose();
	});

	/** Enter on an empty roster is a no-op, not a crash on `undefined.id`. */
	test("Enter does nothing when there is no agent to open", () => {
		const opened: string[] = [];
		const dashboard = new AgentDashboard({ terminalHeight: 40, focusAgent: async id => void opened.push(id) });

		dashboard.handleInput("\r");

		expect(opened).toEqual([]);
		dashboard.dispose();
	});
});

describe("Card chrome", () => {
	/**
	 * Two tabs, and the third is gone for good. The configuration list duplicated
	 * the Subagents settings table, so the same two facts had two homes that had
	 * to be kept in step; `/settings` owns it now.
	 */
	test("offers Live and Comms, and no configuration tab", () => {
		registerSub("0-Sub", "reviewer");
		const dashboard = new AgentDashboard({ terminalHeight: 40 });

		const shown = frameOf(dashboard);

		expect(shown).toContain("Live (1)");
		expect(shown).toContain("Comms (0)");
		expect(shown).not.toContain("Agents (");
		expect(shown).not.toContain("space toggle");
		expect(shown).not.toContain("new agent");
		dashboard.dispose();
	});

	/**
	 * An empty roster offers no key that does nothing.
	 *
	 * Navigate, open and terminate all act on a selected row, and with no rows there is
	 * no row to act on. The empty state already says what will appear here, so
	 * three dead keys under it read as a broken panel rather than an idle one. The
	 * two chips that still work stay, which is what makes this a dropped chip
	 * rather than a missing footer.
	 */
	test("offers only the keys that work when the roster is empty", () => {
		const dashboard = new AgentDashboard({ terminalHeight: 40 });

		const shown = frameOf(dashboard);

		expect(shown).toContain("Nothing running.");
		expect(shown).not.toContain("x terminate");
		expect(shown).not.toContain("enter open agent");
		expect(shown).not.toContain("up/down navigate");
		expect(shown).toContain("left/right view");
		expect(shown).toContain("esc close");
		dashboard.dispose();
	});

	/** And every one of them comes back with a row to act on. */
	test("offers the roster keys again once an agent exists", () => {
		registerSub("0-Sub", "reviewer");
		const dashboard = new AgentDashboard({ terminalHeight: 40 });

		const shown = frameOf(dashboard);

		expect(shown).toContain("up/down navigate");
		expect(shown).toContain("enter open agent");
		expect(shown).toContain("x terminate");
		dashboard.dispose();
	});

	/**
	 * A roster that does not fit takes the whole viewport, and never one row more.
	 *
	 * This is the invariant that must not move. A card taller than the terminal
	 * pushes its own top into scrollback, so the title and the tab strip scroll
	 * away and the footer lands where the composer was.
	 */
	test("takes exactly the viewport when the roster does not fit", () => {
		geo.setRows(30);
		for (let index = 0; index < 40; index++) registerSub(`${index}-Sub`, "reviewer");
		const dashboard = new AgentDashboard({ terminalHeight: 30 });

		const lines = dashboard.render(100);

		expect(lines.length).toBe(30);
		const plain = lines.map(line => line.replace(ANSI_PATTERN, "")).join("\n");
		expect(plain).toContain("Agent Control Center");
		expect(plain).toContain("esc close");
		dashboard.dispose();
	});

	/** And it re-fits on resize rather than keeping the height it was built at. */
	test("re-fits the body when the terminal height shrinks", () => {
		geo.setRows(30);
		for (let index = 0; index < 40; index++) registerSub(`${index}-Sub`, "reviewer");
		const dashboard = new AgentDashboard({ terminalHeight: 30 });
		expect(dashboard.render(100).length).toBe(30);

		geo.setRows(18);
		const shrunk = dashboard.render(100);

		expect(shrunk.length).toBe(18);
		expect(shrunk.map(line => line.replace(ANSI_PATTERN, "")).join("\n")).toContain("esc close");
		dashboard.dispose();
	});

	/**
	 * A SMALL roster hugs its content instead of framing empty rows.
	 *
	 * The card used to take the whole terminal unconditionally. A run with four
	 * agents drew four roster rows and then about twenty rows of empty card under
	 * them, bordered and titled as though something were there, over a transcript
	 * the operator wanted to see. Judged on rendered images at four, twelve and
	 * forty agents (`docs/internal/testing.md`, "Judging how a surface LOOKS"),
	 * not from the row count alone.
	 */
	test("hugs a small roster rather than framing empty rows", () => {
		geo.setRows(40);
		for (let index = 0; index < 4; index++) registerSub(`${index}-Sub`, "reviewer");
		const dashboard = new AgentDashboard({ terminalHeight: 40 });

		const lines = dashboard.render(100);

		expect(lines.length).toBeLessThan(20);
		const plain = lines.map(line => line.replace(ANSI_PATTERN, "")).join("\n");
		expect(plain).toContain("Live (4)");
		expect(plain).toContain("esc close");
		dashboard.dispose();
	});

	/**
	 * The floor. Without one the card would resize on every spawn, and a panel
	 * that changes height while you read it is worse than a little empty space, so
	 * one agent and four agents draw the same card.
	 */
	test("draws the same card for one agent as for four", () => {
		geo.setRows(40);
		registerSub("0-Sub", "reviewer");
		const one = new AgentDashboard({ terminalHeight: 40 }).render(100).length;
		AgentRegistry.resetGlobalForTests();
		for (let index = 0; index < 4; index++) registerSub(`${index}-Sub`, "reviewer");
		const four = new AgentDashboard({ terminalHeight: 40 });

		expect(four.render(100).length).toBe(one);
		four.dispose();
	});

	/**
	 * And it grows once the roster passes the floor, so the extra rows are used
	 * rather than scrolled past on a terminal with room to spare.
	 */
	test("grows past the floor before it stops growing", () => {
		geo.setRows(40);
		for (let index = 0; index < 4; index++) registerSub(`${index}-Sub`, "reviewer");
		const small = new AgentDashboard({ terminalHeight: 40 }).render(100).length;
		for (let index = 4; index < 16; index++) registerSub(`${index}-Sub`, "reviewer");
		const larger = new AgentDashboard({ terminalHeight: 40 });

		const grown = larger.render(100).length;

		expect(grown).toBeGreaterThan(small);
		expect(grown).toBeLessThanOrEqual(40);
		larger.dispose();
	});
});

/**
 * The card has to stay readable on a terminal that renders no colour: NO_COLOR,
 * a dumb terminal, a piped capture, or an operator's screenshot pipeline.
 *
 * Every signal the card carries had exactly one encoding, and for two of them
 * that encoding was a background tint. `theme.bg` returns its text unchanged
 * when colour is off, so on those terminals the selected roster row and the
 * active view tab were both indistinguishable from every other row and tab: you
 * could not tell which agent Enter would open, or which view you were looking
 * at. Both now carry a cursor glyph. Bold remains a secondary cue where the
 * terminal permits attributes.
 */
describe("Readable without colour", () => {
	/** The selected row is marked by a glyph, which no colour setting can erase. */
	test("marks the selected roster row with a glyph, not a tint alone", () => {
		registerSub("0-Sub", "reviewer");
		registerSub("1-Sub", "scout");
		const dashboard = new AgentDashboard({ terminalHeight: 40 });

		const rows = frameOf(dashboard).split("\n");
		const reviewer = rows.find(line => line.includes("reviewer"));
		const scout = rows.find(line => line.includes("scout"));

		expect(reviewer).toContain(theme.nav.cursor);
		expect(scout).not.toContain(theme.nav.cursor);
		dashboard.dispose();
	});

	/**
	 * Brackets mark the active tab even when a dumb terminal suppresses every
	 * SGR sequence. Inactive tabs reserve the same width.
	 */
	test("marks the active view tab with brackets when ANSI is unavailable", () => {
		const previousPolicy = getAnsiPolicy();
		setAnsiPolicy("plain");
		registerSub("0-Sub", "reviewer");
		const dashboard = new AgentDashboard({ terminalHeight: 40 });

		try {
			const strip = dashboard.render(120).find(line => line.includes("Live (1)"));

			expect(strip).toBeDefined();
			expect(strip).toContain("[Live (1)]");
			expect(strip).not.toContain("\x1b[");
		} finally {
			dashboard.dispose();
			setAnsiPolicy(previousPolicy);
		}
	});
});
