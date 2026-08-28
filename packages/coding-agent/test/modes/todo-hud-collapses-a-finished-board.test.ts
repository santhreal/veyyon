/**
 * WHY. A finished todo board used to be drawn TWICE on one screen. The anchored
 * HUD above the composer collapsed it to `▪ Todo list done · 6 tasks`, and the
 * transcript card for the write that closed the list had already printed the
 * same sentence from the same owner a few rows above. Before that collapse
 * existed the HUD was worse still: it redrew every phase and every
 * struck-through task for the rest of the session.
 *
 * So the HUD now draws NOTHING for a finished board. It is an anchored region
 * for work in flight; a finished plan is history, the card is where history
 * lives, and the region being gone is how the HUD says there is nothing open.
 *
 * THE CLASS. Not "the reported board clears". The decision has one owner,
 * `isTodoListDone` in `@veyyon/wire`, and this suite compares the HUD's rendered
 * bytes against that owner over the FULL cross product of statuses across one
 * and two phases, with the status vocabulary enumerated at run time
 * (`TODO_STATUSES`) so a fifth status enters the sweep without anyone
 * remembering to add it. Two further properties are pinned because both have
 * been broken here: the clear must be DERIVED, not a mode the widget can be left
 * in (appending open work reopens the board on the next frame, and the expand
 * toggle cannot reveal a finished one — a control proves the toggle still moves
 * an open board, so "cleared" is never confused with "toggle broken"); and the
 * summary must still exist EXACTLY ONCE on the screen, on the card, so this is a
 * deduplication test and not a deletion. The HUD reads phases straight off a
 * session file, so a status it does not recognise must read as OPEN — clearing
 * on an unread status would hide live work behind an empty region.
 *
 * WHAT IT DOES NOT CATCH. The card's own collapse (owned by
 * `test/tools/todo-done-collapse.test.ts`) and the HTML export's (owned by
 * `packages/tool-render/test/todo-done-collapse.test.ts`). It also does not
 * defend the open board's glyphs or width budget, which are
 * `todo-hud-states.test.ts`, nor the card's row colours, which are
 * `test/tools/todo.test.ts`.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@veyyon/agent-core";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@veyyon/coding-agent/config/settings";
import { InteractiveMode } from "@veyyon/coding-agent/modes/terminal/interactive-mode";
import { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import { AuthStorage } from "@veyyon/coding-agent/session/auth-storage";
import { SessionManager } from "@veyyon/coding-agent/session/session-manager";
import { initTheme, stopThemeWatcher, theme } from "@veyyon/coding-agent/theme/theme";
import { type TodoPhase, todoToolRenderer } from "@veyyon/coding-agent/tools/todo";
import { type AnsiPolicy, getAnsiPolicy, setAnsiPolicy, TUI } from "@veyyon/tui";
import { TempDir } from "@veyyon/utils";
import { isTodoListDone, TODO_DONE_SUMMARY, TODO_STATUSES, type TodoStatus } from "@veyyon/wire";
import { VirtualTerminal } from "../../../tui/test/virtual-terminal";

const COLUMNS = 100;

/** One phase per array of statuses, task content naming its own status. */
function board(...statusesPerPhase: string[][]): TodoPhase[] {
	return statusesPerPhase.map((statuses, phaseIndex) => ({
		name: `Phase ${phaseIndex + 1}`,
		tasks: statuses.map((status, index) => ({
			content: `p${phaseIndex}-task-${index}-${status}`,
			status: status as TodoStatus,
		})),
	}));
}

/**
 * The exact bytes a finished board must produce, success SGR included, built
 * from the theme accessors rather than a literal escape so a re-themed success
 * colour stays the contract.
 */
function doneLine(tasks: number): string {
	const plural = tasks === 1 ? "task" : "tasks";
	return theme.fg("success", `${theme.checkbox.checked} ${TODO_DONE_SUMMARY} · ${tasks} ${plural}`);
}

// The colour is half the report, and a piped `bun test` resolves the ANSI policy
// to `plain`, which turns every `theme.fg` into the identity and would make the
// byte comparisons below pass while proving nothing. Restored after the file.
let previousAnsiPolicy: AnsiPolicy = "plain";

beforeAll(async () => {
	previousAnsiPolicy = getAnsiPolicy();
	setAnsiPolicy("full");
	await initTheme();
});

afterAll(() => {
	setAnsiPolicy(previousAnsiPolicy);
	stopThemeWatcher();
});

describe("the anchored todo HUD clears a finished board", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession;
	let mode: InteractiveMode;

	async function boot(overrides: Record<string, unknown> = {}): Promise<void> {
		resetSettingsForTest();
		tempDir = TempDir.createSync("@pi-todo-hud-done-");
		// Motion off. A plan that closes while its rows are on screen plays a bounded
		// exit sweep before the region empties, so with transitions on every arm here
		// would be asserting the first frame of an animation rather than whether the
		// board is drawn at all. The sweep and its termination are owned by
		// `todo-mid-turn-render.test.ts`; this file owns the verdict.
		const boardSettings = { "display.transitions": "off", ...overrides };
		await Settings.init({ inMemory: true, cwd: tempDir.path(), overrides: boardSettings });
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		const modelRegistry = new ModelRegistry(authStorage);
		const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 to exist in registry");
		session = new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } }),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			settings: Settings.isolated(boardSettings),
			modelRegistry,
		});
		mode = new InteractiveMode(session, "test");
	}

	beforeEach(async () => {
		await boot();
	});

	afterEach(async () => {
		mode?.stop();
		await session?.dispose();
		authStorage?.close();
		tempDir?.removeSync();
		vi.useRealTimers();
		vi.restoreAllMocks();
		resetSettingsForTest();
	});

	/**
	 * The HUD block's own lines, right padding off, blank spacer rows dropped.
	 * The anchored block indents every row by one column (the `Text`'s left pad),
	 * which is why a comparison against the card's rows has to add it back.
	 */
	const hudLines = (): string[] =>
		mode.todoContainer
			.render(COLUMNS)
			.flatMap(line => line.split("\n"))
			.map(line => line.trimEnd())
			.filter(line => line.trim() !== "");

	/** The transcript card's own rows for `phases`, right padding off. */
	const cardRows = (phases: TodoPhase[]): string[] =>
		todoToolRenderer
			.renderResult(
				{ content: [{ type: "text", text: "board" }], details: { phases, storage: "memory" } },
				{ expanded: false, isPartial: false },
				theme,
			)
			.render(COLUMNS)
			.map(line => line.trimEnd())
			.filter(line => line.trim() !== "");

	const show = (phases: TodoPhase[]): void => {
		mode.setTodos(phases);
	};

	/**
	 * The headline contract: no rows at all, and specifically not the summary the
	 * card is about to draw. One line IS the defect, so this is `toEqual([])`.
	 */
	it("draws no rows at all", async () => {
		show(board(["completed", "completed", "abandoned"]));

		expect(hudLines()).toEqual([]);
		expect(mode.todoContainer.render(COLUMNS)).toHaveLength(0);
		const rendered = Bun.stripANSI(hudLines().join("\n"));
		expect(rendered).not.toContain(TODO_DONE_SUMMARY);
		expect(rendered).not.toContain("p0-task-0-completed");
		expect(rendered).not.toContain("Phase 1");
		// The block's own header is gone too: a finished board is not "Todos · 1/1".
		expect(rendered).not.toContain("Todos");
	});

	/**
	 * Guard against every assertion in this file passing in a run with no colour
	 * at all, which would make `theme.fg` the identity function and the byte
	 * comparisons vacuous. Asserted on an OPEN board, since the finished one now
	 * has no bytes to carry a colour.
	 */
	it("renders an open board in colour", async () => {
		show(board(["in_progress"]));

		const line = hudLines()[0]!;
		expect(line).not.toBe(Bun.stripANSI(line));
		expect(line).toContain(theme.fg("accent", "\u0000").split("\u0000")[0]!);
	});

	/**
	 * Derived, not a mode: the clear is a function of the board in hand, so open
	 * work put back on it reopens the list on the very next render with no flag to
	 * reset.
	 */
	it("reopens the full board when open work is appended", async () => {
		show(board(["completed", "completed"]));
		expect(hudLines()).toEqual([]);

		show(board(["completed", "completed", "pending"]));

		const rendered = Bun.stripANSI(hudLines().join("\n"));
		expect(rendered).not.toContain(TODO_DONE_SUMMARY);
		expect(rendered).toContain("p0-task-2-pending");
		expect(hudLines().length).toBeGreaterThan(1);

		// And closing that task clears it again, without any intermediate state.
		show(board(["completed", "completed", "completed"]));
		expect(hudLines()).toEqual([]);
	});

	/**
	 * Both states of the toggle, because a clear that only holds in one of them is
	 * the defect with a keybinding in front of it. The control at the end proves
	 * the toggle still moves an OPEN board, so this test cannot pass because the
	 * toggle stopped working.
	 */
	it("cannot be reopened by the expand toggle", async () => {
		show(board(["completed"], ["abandoned", "completed"]));
		expect(mode.todoExpanded).toBe(false);
		expect(hudLines()).toEqual([]);

		mode.toggleTodoExpansion();

		expect(mode.todoExpanded).toBe(true);
		expect(hudLines()).toEqual([]);

		// Control: an open board is not indifferent to the toggle. One phase with
		// more open tasks than the collapsed preview keeps, because seven phases of
		// one task each render the same rows either way once the anchored budget has
		// trimmed them — a control that cannot move is not a control.
		show([
			{
				name: "Long phase",
				tasks: Array.from({ length: 12 }, (_, index) => ({
					content: `open-${index}`,
					status: "pending" as TodoStatus,
				})),
			},
		]);
		// Measured while the toggle is still ON, from the line above.
		const expandedRows = hudLines().length;
		mode.toggleTodoExpansion();
		expect(mode.todoExpanded).toBe(false);
		expect(hudLines().length).not.toBe(expandedRows);
	});

	/** Terminality is the owner's call, not the word "completed". */
	it("treats an abandoned-only board as finished", async () => {
		show(board(["abandoned", "abandoned"]));

		expect(hudLines()).toEqual([]);
	});

	/** Nothing was finished, so there is nothing to collapse and no block at all. */
	it("does not claim an empty board is done", async () => {
		show([]);
		expect(mode.todoContainer.render(COLUMNS)).toHaveLength(0);

		show([{ name: "Phase 1", tasks: [] }]);
		expect(mode.todoContainer.render(COLUMNS)).toHaveLength(0);

		show([
			{ name: "Phase 1", tasks: [] },
			{ name: "Phase 2", tasks: [] },
		]);
		expect(mode.todoContainer.render(COLUMNS)).toHaveLength(0);
	});

	/**
	 * The count is the tasks on the board, summed across phases, not the phases.
	 * Read off the CARD, which is the surface that still carries the summary.
	 */
	it("counts tasks across phases on the card", async () => {
		expect(Bun.stripANSI(cardRows(board(["completed"]))[0]!)).toContain("· 1 task");
		expect(Bun.stripANSI(cardRows(board(["completed"], ["completed", "abandoned"]))[0]!)).toContain("· 3 tasks");
	});

	/**
	 * The HUD is handed phases read off a session file, where a status is just a
	 * string. An unknown one must read as OPEN: collapsing it would hide live
	 * work behind a line claiming the plan is finished. `toString` is in the list
	 * because a prototype-chain lookup returned a truthy function for it once.
	 */
	it("reads a status it does not recognise as open", async () => {
		for (const foreign of ["sleeping", "toString", "constructor", "", "COMPLETED"]) {
			show(board(["completed", foreign]));

			const rendered = Bun.stripANSI(hudLines().join("\n"));
			expect(rendered).not.toContain(TODO_DONE_SUMMARY);
			expect(rendered).toContain(`p0-task-1-${foreign}`);
		}
	});

	/**
	 * The sweep. Every mixture of every status, one and two phases, compared
	 * board by board against the owner rather than against a list of cases
	 * someone had in mind. The verdict is read off the rendered bytes, so a HUD
	 * that clears AND keeps drawing rows fails here too.
	 */
	it("matches the owner's verdict on every mixture of statuses", async () => {
		const seen = new Set<string>();
		let checked = 0;
		for (const a of TODO_STATUSES) {
			for (const b of TODO_STATUSES) {
				seen.add(a);
				seen.add(b);
				const layouts: TodoPhase[][] = [board([a, b]), board([a], [b]), board([b, a]), board([b], [a])];
				for (const phases of layouts) {
					show(phases);
					const expected = isTodoListDone(phases);
					const lines = hudLines();
					if (expected) {
						expect(lines).toEqual([]);
						// The summary did not vanish from the product: it moved to the one
						// surface that keeps it. A clear that also emptied the card would
						// pass a HUD-only assertion.
						expect(Bun.stripANSI(cardRows(phases).join("\n"))).toContain(TODO_DONE_SUMMARY);
					} else {
						const rendered = Bun.stripANSI(lines.join("\n"));
						expect(rendered).not.toContain(TODO_DONE_SUMMARY);
						expect(lines.length).toBeGreaterThan(1);
					}
					checked++;
				}
			}
		}
		// The vocabulary is enumerated at run time, so a new status is swept
		// without anyone editing this file.
		expect(seen).toEqual(new Set(TODO_STATUSES));
		expect(checked).toBe(TODO_STATUSES.length * TODO_STATUSES.length * 4);
	});

	/**
	 * The point of the whole change: the sentence exists EXACTLY ONCE on a screen
	 * that holds both surfaces. The card draws it, byte for byte from the owner,
	 * and the HUD anchored under it draws nothing. Asserted together, because a
	 * deletion from either side alone would satisfy half of it.
	 */
	it("draws the finished line once, on the card", async () => {
		const phases = board(["completed", "abandoned"]);
		show(phases);

		expect(cardRows(phases)).toEqual([doneLine(2).trimEnd()]);
		expect(hudLines()).toEqual([]);
	});

	/**
	 * The collapse is a render decision and the auto-clear is a state decision;
	 * one must not swallow the other. With the delay configured to zero the
	 * closed tasks leave the board entirely, so there is no block at all rather
	 * than a permanent "Todo list done" line.
	 */
	it("still lets a configured auto-clear empty the board", async () => {
		mode?.stop();
		await session?.dispose();
		authStorage?.close();
		tempDir?.removeSync();
		await boot({ "tasks.todoClearDelay": 0 });

		show(board(["completed", "abandoned"]));

		expect(mode.todoContainer.render(COLUMNS)).toHaveLength(0);
		expect(mode.todoPhases).toEqual([]);
	});
});

/**
 * The paint half. The container can hold — or drop — rows that no frame ever
 * repaints, so the headline case is asserted against the cells a real `TUI`
 * painted into a real VT. `getViewport` carries no SGR, which makes this a
 * monochrome read.
 */
describe("the collapsed board reaches the screen", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession;
	let mode: InteractiveMode;
	let terminal: VirtualTerminal;

	beforeEach(async () => {
		resetSettingsForTest();
		tempDir = TempDir.createSync("@pi-todo-hud-done-paint-");
		await Settings.init({ inMemory: true, cwd: tempDir.path(), overrides: { "display.transitions": "off" } });
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		const modelRegistry = new ModelRegistry(authStorage);
		const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 to exist in registry");
		session = new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } }),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			settings: Settings.isolated({ "startup.quiet": true, "display.transitions": "off" }),
			modelRegistry,
		});
		mode = new InteractiveMode(session, "test");
		terminal = new VirtualTerminal(COLUMNS, 24);
		mode.ui = new TUI(terminal);
		vi.spyOn(mode.statusLine, "watchBranch").mockImplementation(() => {});
		await mode.init();
		await terminal.waitForRender();
	});

	afterEach(async () => {
		mode?.stop();
		await session?.dispose();
		authStorage?.close();
		tempDir?.removeSync();
		vi.restoreAllMocks();
		resetSettingsForTest();
	});

	it("erases the painted rows when the last task closes", async () => {
		mode.setTodos(board(["completed", "completed", "in_progress"]));
		await terminal.waitForRender();
		expect(terminal.getViewport().some(row => row.includes("p0-task-2-in_progress"))).toBe(true);

		mode.setTodos(board(["completed", "completed", "completed"]));
		await terminal.waitForRender();

		const rows = terminal.getViewport().map(row => row.trimEnd());
		// The rows are gone from the FRAME, not merely from the container. An
		// anchored live region that stops emitting rows while the painted ones stay
		// on screen is the stale-row class, and a container-level assertion cannot
		// see it.
		expect(rows.some(row => row.includes("p0-task-2-in_progress"))).toBe(false);
		expect(rows.some(row => row.includes("p0-task-0-completed"))).toBe(false);
		expect(rows.some(row => row.includes(TODO_DONE_SUMMARY))).toBe(false);
		expect(rows.some(row => /^\s*Todos(\s|$)/.test(row))).toBe(false);
	});

	it("paints the whole board again once open work returns", async () => {
		mode.setTodos(board(["completed", "completed"]));
		await terminal.waitForRender();
		expect(terminal.getViewport().some(row => /^\s*Todos(\s|$)/.test(row.trimEnd()))).toBe(false);

		mode.setTodos(board(["completed", "completed", "in_progress"]));
		await terminal.waitForRender();

		const rows = terminal.getViewport().map(row => row.trimEnd());
		expect(rows.some(row => row.includes(TODO_DONE_SUMMARY))).toBe(false);
		expect(rows.some(row => row.includes("p0-task-2-in_progress"))).toBe(true);
	});
});
