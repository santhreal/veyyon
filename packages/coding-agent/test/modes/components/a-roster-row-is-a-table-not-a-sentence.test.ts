/**
 * WHY: a roster row was a sentence. It read `cursor glyph sign type status age
 * model parent activity badges`, joined with two spaces and cut to fit, and every
 * part after the first variable-width one sat wherever the parts before it had
 * ended. So the status glyph moved sideways as one agent's call sign grew, the
 * model appeared at a different cell on every row when a reader wants to compare
 * models DOWN the list, the unread badge was pushed off the end by a long
 * activity line, and the terminate chip reserved two cells on every row at the
 * card's natural width — which is exactly the width where the model column lives
 * or dies.
 *
 * The class this closes is that a roster is a TABLE: every fixed part starts at
 * one column for the whole list, the flexible part is what is left between the
 * fixed head and the right-flushed tail, and a decision to drop a column is made
 * once for the list rather than per row. Every assertion here is on cell indexes
 * in plain text, so none of them can be satisfied by paint.
 *
 * The variant space is taken from source at run time: `AGENT_STATUSES` for the
 * rows and `AGENT_DISPLAY_STATES` for the glyphs, so a new status turns this
 * suite red until someone decides what its glyph and its width are.
 *
 * What it does not catch: whether the column ORDER is the right order, or whether
 * a dropped model column should have been dropped rather than shortened. Those
 * are the layout's choices; this file checks that whatever it chose, it chose once
 * for every row.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { IrcBus } from "@veyyon/coding-agent/irc/bus";
import { AgentDashboard } from "@veyyon/coding-agent/modes/components/agent-dashboard";
import {
	AGENT_DISPLAY_STATES,
	agentDisplayState,
	agentStatusGlyph,
} from "@veyyon/coding-agent/modes/components/agent-status-display";
import { initTheme } from "@veyyon/coding-agent/modes/theme/theme";
import {
	AGENT_STATUSES,
	AgentRegistry,
	type AgentStatus,
	MAIN_AGENT_ID,
} from "@veyyon/coding-agent/registry/agent-registry";
import type { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import { visibleWidth } from "@veyyon/tui/utils";
import { type StubbedStdoutGeometry, stubStdoutGeometry } from "../../helpers/stdout-geometry";

const ANSI_PATTERN = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const ROWS = 40;
/** Wide enough that every column survives, so a drift shows as a drift. */
const WIDE = 120;

let geometry: StubbedStdoutGeometry;

beforeEach(async () => {
	await initTheme(false);
	AgentRegistry.resetGlobalForTests();
	IrcBus.resetGlobalForTests();
	geometry = stubStdoutGeometry({ columns: WIDE, rows: ROWS });
});

afterEach(() => {
	AgentRegistry.resetGlobalForTests();
	IrcBus.resetGlobalForTests();
	geometry.restore();
});

function accepting(): AgentSession {
	return {
		deliverIrcMessage: async () => "injected",
		emitIrcRelayObservation: () => {},
		subscribe: () => () => {},
	} as unknown as AgentSession;
}

/**
 * One subagent per status the registry declares, with type names and models of
 * deliberately different lengths: a column that is not padded lines up by luck
 * when every row's content is the same size.
 */
function registerEveryStatus(): void {
	AgentRegistry.global().register({
		id: MAIN_AGENT_ID,
		displayName: "Main Session",
		kind: "main",
		session: accepting(),
	});
	const types = ["x", "reviewer", "a-considerably-longer-type", "qa"];
	const models = ["anthropic/claude-sonnet-5", "openai/gpt-5", "anthropic/claude-haiku-4", "openai/o3"];
	AGENT_STATUSES.forEach((status, index) => {
		AgentRegistry.global().register({
			id: `sub-${index}`,
			displayName: types[index % types.length] ?? "sub",
			kind: "sub",
			parentId: MAIN_AGENT_ID,
			session: accepting(),
			status,
			model: models[index % models.length],
		});
	});
}

function rows(dashboard: AgentDashboard, width = WIDE): string[] {
	const lines = dashboard.render(width).map(line => line.replace(ANSI_PATTERN, ""));
	const strip = lines.findIndex(line => line.includes("Live (") && line.includes("Comms ("));
	// Only rows that carry an agent: the frame, the strip and the footer are not
	// table rows and have no columns to line up.
	// Any DISPLAYED state, not only the raw statuses: a row whose word is derived
	// (`waiting` from `idle`) is a row of the table, and filtering it out is how a
	// column measured on the raw status escapes notice.
	return lines.slice(strip + 1).filter(line => AGENT_DISPLAY_STATES.some(state => line.includes(state)));
}

/** Where `token` starts in each row that carries it. A table has one answer. */
function columnOf(lines: string[], token: string): number[] {
	return lines.filter(line => line.includes(token)).map(line => line.indexOf(token));
}

describe("a roster row is a table, not a sentence", () => {
	test("puts every status glyph in a column of one width", () => {
		// Derived from source: a new display state joins the sweep by existing, and
		// a glyph wider than its siblings shifts every column after it on that row
		// alone — the drift this file exists to catch.
		const widths = new Set(AGENT_DISPLAY_STATES.map(state => visibleWidth(agentStatusGlyph(state))));
		expect([...widths]).toEqual([1]);
		// And no state is missing a glyph, which would collapse the column on the
		// rows in that state.
		const blank = AGENT_DISPLAY_STATES.filter(state => agentStatusGlyph(state).trim() === "");
		expect(blank).toEqual([]);
	});

	test("starts each fixed column at one cell for the whole list", () => {
		registerEveryStatus();
		const dashboard = new AgentDashboard({ terminalHeight: ROWS, showModelBadge: true });
		const lines = rows(dashboard);

		expect(lines.length).toBeGreaterThan(2);
		// The status word, the age and the model are each at one column across every
		// row, whatever the call sign and the type before them cost.
		for (const token of ["claude-sonnet-5", "gpt-5"]) {
			const cols = columnOf(lines, token);
			if (cols.length === 0) continue;
			expect(new Set(cols).size).toBe(1);
		}
		// Two rows whose types differ in length by 24 cells still agree on where the
		// status column begins, which is the whole claim of a padded column.
		const statusCols = AGENT_STATUSES.flatMap(status => columnOf(lines, status));
		expect(statusCols.length).toBeGreaterThan(1);
		expect(new Set(statusCols).size).toBe(1);
		dashboard.dispose();
	});

	test("pads the status column to the widest DISPLAYED word, not the raw status", () => {
		// Derived from source: the raw statuses whose DISPLAYED word is wider than
		// themselves (`waiting` from `idle` and `parked`), and the roster of raw
		// statuses narrow enough that none of them reaches that width on its own.
		// The roster matters as much as the waiting row: with a `running` or
		// `aborted` row present the raw column is already as wide as `waiting`, the
		// drift cancels, and a column measured on `agent.status` looks correct. So
		// this is built out of the narrow statuses only, main included, which is the
		// one roster shape where the measurement is visible.
		const derivedFor = (status: AgentStatus): string => agentDisplayState({ status, waitingOnPeer: true });
		const widening = AGENT_STATUSES.filter(status => derivedFor(status).length > status.length);
		expect(widening.length).toBeGreaterThan(0);
		const derivedWidth = Math.max(...widening.map(status => derivedFor(status).length));
		const narrow = AGENT_STATUSES.filter(status => status.length < derivedWidth);
		expect(narrow.length).toBeGreaterThan(1);

		AgentRegistry.global().register({
			id: MAIN_AGENT_ID,
			displayName: "Main Session",
			kind: "main",
			// Not the `running` default: the driving row is measured with the rest,
			// and a seven-cell word on it hides what this test is looking for.
			status: narrow[0],
			session: accepting(),
		});
		narrow.forEach((status, index) => {
			AgentRegistry.global().register({
				id: `narrow-${index}`,
				displayName: index === 0 ? "x" : "a-considerably-longer-type",
				kind: "sub",
				parentId: MAIN_AGENT_ID,
				session: accepting(),
				status,
				model: "anthropic/claude-sonnet-5",
			});
		});
		const raw = widening[0] ?? "idle";
		AgentRegistry.global().register({
			id: "peer-waiter",
			displayName: "waiter",
			kind: "sub",
			parentId: MAIN_AGENT_ID,
			session: accepting(),
			status: raw,
			model: "anthropic/claude-sonnet-5",
		});
		AgentRegistry.global().setWaitingOnPeer("peer-waiter", true);
		const dashboard = new AgentDashboard({ terminalHeight: ROWS, showModelBadge: true });
		const lines = rows(dashboard);

		// The derived row is on screen, so the assertion below has something to
		// disagree about.
		expect(lines.filter(line => line.includes(derivedFor(raw))).length).toBe(1);
		// The model column begins one gap after the status column. It is at one cell
		// on the derived row and on every row measured from a raw word.
		const cols = columnOf(lines, "claude-sonnet-5");
		expect(cols.length).toBe(narrow.length + 1);
		expect(new Set(cols).size).toBe(1);
		dashboard.dispose();
	});

	test("flushes the badge strip to the row's edge, on every row that has one", () => {
		registerEveryStatus();
		AgentRegistry.global().register({
			id: "advisor-1",
			displayName: "advisor",
			kind: "advisor",
			parentId: MAIN_AGENT_ID,
			session: accepting(),
			status: "idle",
		});
		const dashboard = new AgentDashboard({ terminalHeight: ROWS, showModelBadge: true });
		const lines = dashboard.render(WIDE).map(line => line.replace(ANSI_PATTERN, ""));
		const badge = lines.find(line => line.includes("read-only"));
		expect(badge).toBeDefined();

		// The strip ENDS the row: what is to its right is the card's own frame, not
		// content. Measured from the badge's last cell to the last content cell.
		const line = badge ?? "";
		const after = line.slice(line.indexOf("read-only") + "read-only".length);
		expect(after.replace(/[\s│┃|]/g, "")).toBe("");
		dashboard.dispose();
	});

	test("does not let a long activity push the badge off the end", () => {
		registerEveryStatus();
		AgentRegistry.global().register({
			id: "advisor-1",
			displayName: "advisor",
			kind: "advisor",
			parentId: MAIN_AGENT_ID,
			session: accepting(),
			status: "running",
		});
		// The gist is prose and degrades by the cell; the badge is a fact and does
		// not. The tail is measured out of the row BEFORE the middle is filled, so
		// the row that has the most to say is exactly the row that used to lose it.
		AgentRegistry.global().setActivity("advisor-1", "reading ".repeat(60));
		const dashboard = new AgentDashboard({ terminalHeight: ROWS, showModelBadge: true });
		const line = dashboard
			.render(WIDE)
			.map(l => l.replace(ANSI_PATTERN, ""))
			.find(l => l.includes("read-only"));

		expect(line).toBeDefined();
		// It survives AND it still ends the row.
		const after = (line ?? "").slice((line ?? "").indexOf("read-only") + "read-only".length);
		expect(after.replace(/[\s│┃|]/g, "")).toBe("");
		dashboard.dispose();
	});

	test("keeps the model column list-wide as the card narrows, or drops it whole", () => {
		registerEveryStatus();
		const dashboard = new AgentDashboard({ terminalHeight: ROWS, showModelBadge: true });

		for (const width of [120, 100, 88, 76, 70, 64, 58]) {
			// Only the rows of agents that HAVE a model: the driving session has none,
			// so counting its row would make every width a mixed result.
			const lines = rows(dashboard, width).filter(line => !line.includes("Main Session"));
			// A model is shown on every one of them or on none: a per-row decision is
			// the ragged tail the column exists to remove.
			const shown = lines.filter(line => /claude|gpt|o3/.test(line)).length;
			expect(shown === 0 || shown === lines.length).toBe(true);
		}
		dashboard.dispose();
	});

	test("draws the terminate chip over the badge column instead of reserving cells", () => {
		registerEveryStatus();
		const dashboard = new AgentDashboard({ terminalHeight: ROWS, showModelBadge: true });
		const before = rows(dashboard, 88);

		// The pointer arrives on a row. Nothing about the table may move: a chip
		// with cells of its own costs every row two columns at the width where the
		// model column is decided.
		// A motion report, which is how the pointer reaches the card in production.
		dashboard.handleInput("\x1b[<35;6;8M");
		const after = rows(dashboard, 88);

		expect(after.length).toBe(before.length);
		const statusCols = AGENT_STATUSES.flatMap(status => columnOf(after, status));
		expect(new Set(statusCols).size).toBe(1);
		expect(new Set(columnOf(before, "claude-sonnet-5"))).toEqual(new Set(columnOf(after, "claude-sonnet-5")));
		dashboard.dispose();
	});
});
