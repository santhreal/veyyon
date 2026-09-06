/**
 * Crossing a long roster, and reading it as a table.
 *
 * WHY PAGING. The card handled up, down, j and k, and nothing else. A fan-out of
 * sixty agents, or a stream of five hundred messages, could only be crossed one
 * row at a time, which is not a keyboard shortcut problem: it is the difference
 * between a list you can use and a list you scroll past. Page up and page down
 * come from the shared `tui.select.pageUp` / `pageDown` bindings, so they are the
 * same keys, and the same distance, as every other selector in the TUI.
 *
 * WHY COLUMNS. The call sign and type were padded to a column and the rest were
 * not, so `running` on one row and `idle` on the next pushed the model and the
 * activity three columns apart, and the age column vanished entirely on any row
 * whose agent had just acted (`formatAge` returns an empty string for an age of
 * zero, which it treats as UNKNOWN). A list whose columns wander is read as
 * noise. These tests assert the columns by INDEX in the rendered row, which is
 * the only way to catch a drift of one or two cells.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { IrcBus } from "@veyyon/coding-agent/irc/bus";
import { AgentDashboard } from "@veyyon/coding-agent/modes/components/agent-dashboard";
import { initTheme, theme } from "@veyyon/coding-agent/modes/theme/theme";
import type { AgentStatus } from "@veyyon/coding-agent/registry/agent-registry";
import { AgentRegistry, MAIN_AGENT_ID } from "@veyyon/coding-agent/registry/agent-registry";
import type { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import { type StubbedStdoutGeometry, stubStdoutGeometry } from "../../helpers/stdout-geometry";

const ANSI_PATTERN = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const WIDTH = 110;
const ROWS = 40;
const PAGE_DOWN = "\x1b[6~";
const PAGE_UP = "\x1b[5~";

let geometry: StubbedStdoutGeometry;

beforeEach(async () => {
	await initTheme(false);
	AgentRegistry.resetGlobalForTests();
	IrcBus.resetGlobalForTests();
	geometry = stubStdoutGeometry({ columns: WIDTH, rows: ROWS });
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

/** `count` subagents, spawned in order, all running. */
function registerRoster(count: number): void {
	AgentRegistry.global().register({
		id: MAIN_AGENT_ID,
		displayName: "Main Session",
		kind: "main",
		session: accepting(),
	});
	for (let index = 0; index < count; index++) {
		AgentRegistry.global().register({
			id: `sub-${String(index).padStart(3, "0")}`,
			displayName: `type-${String(index).padStart(3, "0")}`,
			kind: "sub",
			parentId: MAIN_AGENT_ID,
			session: accepting(),
			status: "running",
		});
	}
}

function frame(dashboard: AgentDashboard): string[] {
	return dashboard.render(WIDTH).map(line => line.replace(ANSI_PATTERN, ""));
}

/** The agent type on the row the cursor is on, which is what the cursor points at. */
function cursorType(dashboard: AgentDashboard): string {
	const row = frame(dashboard).find(line => line.includes(theme.nav.cursor));
	return row?.match(/type-\d{3}/)?.[0] ?? "";
}

/** How many roster rows are on screen, which is the distance a page should travel. */
function visibleRows(dashboard: AgentDashboard): number {
	return frame(dashboard).filter(line => /type-\d{3}/.test(line)).length;
}

/**
 * A card that has painted once, which is the only state a key ever reaches it in.
 *
 * The page distance is a bodyful of rows, and how tall the body is comes from the
 * ModalShell the last render planned. A card that has never rendered still holds
 * the constructor's placeholder budget, so keys delivered before the first paint
 * page by the wrong distance. The overlay paints on mount, so production never
 * does this; a test that skipped the render was measuring a state the component
 * is never in.
 */
function paintedCard(count: number): AgentDashboard {
	registerRoster(count);
	const dashboard = new AgentDashboard({ terminalHeight: ROWS });
	dashboard.render(WIDTH);
	return dashboard;
}

describe("Paging the roster", () => {
	/** A page moves by what is on screen, so the distance matches what you just read. */
	test("moves the cursor one screenful at a time", () => {
		const dashboard = paintedCard(60);
		// The driving session holds the first row, so a screenful of the roster is
		// one row fewer than a screenful of the body.
		const page = visibleRows(dashboard);

		dashboard.handleInput(PAGE_DOWN);

		expect(cursorType(dashboard)).toBe(`type-${String(page).padStart(3, "0")}`);
		dashboard.dispose();
	});

	/** Page up is its exact inverse, so the pair is a way back as well as forward. */
	test("returns to where it started when paged back", () => {
		const dashboard = paintedCard(60);
		dashboard.handleInput(PAGE_DOWN);
		dashboard.handleInput(PAGE_DOWN);
		const landed = cursorType(dashboard);

		dashboard.handleInput(PAGE_UP);
		dashboard.handleInput(PAGE_DOWN);

		expect(cursorType(dashboard)).toBe(landed);
		dashboard.dispose();
	});

	/** Paging past the end stops on the last agent rather than running off it. */
	test("clamps at the bottom of the roster", () => {
		const dashboard = paintedCard(30);

		for (let press = 0; press < 20; press++) dashboard.handleInput(PAGE_DOWN);

		expect(cursorType(dashboard)).toBe("type-029");
		dashboard.dispose();
	});

	/** And paging past the top stops on the driving session, the first row. */
	test("clamps at the top of the roster", () => {
		const dashboard = paintedCard(30);
		for (let press = 0; press < 5; press++) dashboard.handleInput(PAGE_DOWN);

		for (let press = 0; press < 20; press++) dashboard.handleInput(PAGE_UP);

		const cursorRow = frame(dashboard).find(line => line.includes(theme.nav.cursor));
		expect(cursorRow).toContain("Main Session");
		dashboard.dispose();
	});

	/** An empty roster has nothing to page, and must not throw reading row -1. */
	test("does nothing on an empty roster", () => {
		const dashboard = new AgentDashboard({ terminalHeight: ROWS });

		dashboard.handleInput(PAGE_DOWN);
		dashboard.handleInput(PAGE_UP);

		expect(frame(dashboard).join("\n")).toContain("Nothing running.");
		dashboard.dispose();
	});
});

describe("Paging the Comms stream", () => {
	/** The same keys scroll the stream, because the same gesture should do the same thing. */
	test("scrolls back a screenful and returns to the tail", async () => {
		registerRoster(2);
		for (let index = 0; index < 120; index++) {
			await IrcBus.global().send({ from: "sub-000", to: "sub-001", body: `message number ${index}` });
		}
		const dashboard = new AgentDashboard({ terminalHeight: ROWS, expandKeys: ["ctrl+o"] });
		dashboard.handleInput("\x1b[C");
		const tail = frame(dashboard).filter(line => line.includes("message number"));

		dashboard.handleInput(PAGE_UP);
		const paged = frame(dashboard).filter(line => line.includes("message number"));
		dashboard.handleInput(PAGE_DOWN);

		expect(paged[0]).not.toBe(tail[0]);
		expect(frame(dashboard).filter(line => line.includes("message number"))[0]).toBe(tail[0]);
		dashboard.dispose();
	});
});

describe("Roster columns", () => {
	/** Statuses of different lengths, and ages that do and do not exist. */
	function registerMixed(): void {
		AgentRegistry.global().register({
			id: MAIN_AGENT_ID,
			displayName: "Main Session",
			kind: "main",
			session: accepting(),
		});
		const now = Date.now();
		const specs: Array<[string, string, AgentStatus, number]> = [
			["a", "scout", "running", 0],
			["b", "reviewer", "idle", 8 * 60_000],
			["c", "librarian", "parked", 95 * 60_000],
			["d", "designer", "aborted", 45_000],
		];
		for (const [id, type, status, idleMs] of specs) {
			AgentRegistry.global().register({
				id,
				displayName: type,
				kind: "sub",
				parentId: MAIN_AGENT_ID,
				session: accepting(),
				status,
				model: "anthropic/claude-sonnet-5",
			});
			const ref = AgentRegistry.global().get(id);
			if (ref) ref.lastActivity = now - idleMs;
		}
	}

	/** Every roster row, as plain text. */
	function rosterRows(dashboard: AgentDashboard): string[] {
		return frame(dashboard).filter(line => /\b(running|idle|parked|aborted)\b/.test(line));
	}

	/**
	 * The model starts at ONE column on every row. It used to follow the status
	 * word directly, so `running` and `idle` put it three columns apart and the
	 * eye had to re-find it on every line.
	 */
	test("starts the model badge at the same column on every row", () => {
		registerMixed();
		const dashboard = new AgentDashboard({ terminalHeight: ROWS, showModelBadge: true });

		const columns = new Set(
			rosterRows(dashboard)
				.map(row => row.indexOf("claude-sonnet-5"))
				.filter(at => at >= 0),
		);

		expect(columns.size).toBe(1);
		dashboard.dispose();
	});

	/** The status word starts at one column too, which is what makes it scannable. */
	test("starts the status word at the same column on every row", () => {
		registerMixed();
		const dashboard = new AgentDashboard({ terminalHeight: ROWS, showModelBadge: true });

		const columns = new Set(rosterRows(dashboard).map(row => row.search(/\b(running|idle|parked|aborted)\b/)));

		expect(columns.size).toBe(1);
		dashboard.dispose();
	});

	/**
	 * An agent that acted THIS SECOND still shows an age. `formatAge` reads 0 as
	 * unknown and returns nothing, so the busiest row in the roster went blank
	 * while a row idle for forty seconds read "just now", and everything after the
	 * missing column slid left.
	 */
	test("shows an age for an agent that just acted", () => {
		registerMixed();
		const dashboard = new AgentDashboard({ terminalHeight: ROWS, showModelBadge: true });

		const rows = rosterRows(dashboard);

		expect(rows.every(row => /just now|\d+[smhd] ago/.test(row))).toBeTrue();
		dashboard.dispose();
	});

	/** Ages of different widths do not shift the model column either. */
	test("pads the age column so a longer age does not push the row", () => {
		registerMixed();
		const dashboard = new AgentDashboard({ terminalHeight: ROWS, showModelBadge: true });
		const rows = rosterRows(dashboard);

		const withMinutes = rows.find(row => row.includes("8m ago"));
		const withHours = rows.find(row => row.includes("1h ago"));

		expect(withMinutes?.indexOf("claude-sonnet-5")).toBe(withHours?.indexOf("claude-sonnet-5"));
		dashboard.dispose();
	});

	/** The columns are measured over the WHOLE roster, so scrolling never shifts them. */
	test("keeps the columns still while the roster scrolls", () => {
		const dashboard = paintedCard(60);
		const before = frame(dashboard)
			.find(line => /type-\d{3}/.test(line))
			?.indexOf("running");

		dashboard.handleInput(PAGE_DOWN);

		expect(
			frame(dashboard)
				.find(line => /type-\d{3}/.test(line))
				?.indexOf("running"),
		).toBe(before);
		dashboard.dispose();
	});
});

describe("A column never takes the whole row", () => {
	/** One agent with a name long enough to swallow the row, and three normal ones. */
	function registerWithOneLongType(): void {
		AgentRegistry.global().register({
			id: MAIN_AGENT_ID,
			displayName: "Main Session",
			kind: "main",
			session: accepting(),
		});
		for (const [id, type] of [
			["a", "a-very-long-agent-type-name-someone-wrote"],
			["b", "reviewer"],
			["c", "scout"],
		] as const) {
			AgentRegistry.global().register({
				id,
				displayName: type,
				kind: "sub",
				parentId: MAIN_AGENT_ID,
				session: accepting(),
				status: "running",
				model: "anthropic/claude-sonnet-5",
			});
		}
	}

	/**
	 * The regression. Columns are padded to the WIDEST value in the roster, so a
	 * single agent spawned as `a-very-long-agent-type-name-someone-wrote` padded
	 * the type column to forty cells on every row. On a narrow card that left
	 * nothing for the status, the model or the activity: every row rendered as a
	 * name and an ellipsis, and the roster stopped answering the question it
	 * exists for.
	 */
	test("truncates one long agent type rather than charging every row for it", () => {
		registerWithOneLongType();
		const dashboard = new AgentDashboard({ terminalHeight: ROWS, showModelBadge: true });

		const rows = frame(dashboard).filter(line => /\brunning\b/.test(line));

		expect(rows).toHaveLength(4);
		expect(rows.every(row => row.includes("running"))).toBeTrue();
		dashboard.dispose();
	});

	/** The long name is still recognisable, just cut: it is truncated, not dropped. */
	test("keeps the start of a truncated agent type", () => {
		registerWithOneLongType();
		const dashboard = new AgentDashboard({ terminalHeight: ROWS });

		expect(frame(dashboard).join("\n")).toContain("a-very-long");
		dashboard.dispose();
	});

	/** No column may exceed a quarter of the row, whatever the roster contains. */
	test("holds the cap as the card narrows", () => {
		registerWithOneLongType();
		const dashboard = new AgentDashboard({ terminalHeight: ROWS });

		for (const width of [110, 90, 70, 56]) {
			const rows = dashboard.render(width).map(line => line.replace(ANSI_PATTERN, ""));
			const row = rows.find(line => line.includes("a-very-long"));
			// The status still makes it onto the row at every width, which it cannot
			// do if one column has taken the space.
			expect(row).toContain("running");
		}
		dashboard.dispose();
	});
});

describe("The model badge under pressure", () => {
	function registerOne(): void {
		AgentRegistry.global().register({
			id: MAIN_AGENT_ID,
			displayName: "Main Session",
			kind: "main",
			session: accepting(),
		});
		AgentRegistry.global().register({
			id: "a",
			displayName: "reviewer",
			kind: "sub",
			parentId: MAIN_AGENT_ID,
			session: accepting(),
			status: "idle",
			model: "anthropic/claude-sonnet-5",
		});
	}

	/** Given room, the badge is whole. */
	test("shows the whole model id on a wide card", () => {
		registerOne();
		const dashboard = new AgentDashboard({ terminalHeight: ROWS, showModelBadge: true });

		expect(frame(dashboard).join("\n")).toContain("claude-sonnet-5");
		dashboard.dispose();
	});

	/**
	 * Squeezed, it is cut but still readable. `claude-son…` tells you which model
	 * is burning tokens; the row-level truncation used to leave `clau…`, which
	 * costs the same columns and answers nothing.
	 */
	test("truncates to something a reader can still recognise", () => {
		registerOne();
		const dashboard = new AgentDashboard({ terminalHeight: ROWS, showModelBadge: true });

		const row = dashboard
			.render(70)
			.map(line => line.replace(ANSI_PATTERN, ""))
			.find(line => line.includes("reviewer"));

		expect(row).toContain("claude-son");
		dashboard.dispose();
	});

	/** Below what a reader could use, it is dropped rather than stubbed. */
	test("drops the badge when too little of it would survive", () => {
		registerOne();
		const dashboard = new AgentDashboard({ terminalHeight: ROWS, showModelBadge: true });

		const row = dashboard
			.render(58)
			.map(line => line.replace(ANSI_PATTERN, ""))
			.find(line => line.includes("reviewer"));

		expect(row).not.toContain("claude");
		expect(row).toContain("idle");
		dashboard.dispose();
	});
});
