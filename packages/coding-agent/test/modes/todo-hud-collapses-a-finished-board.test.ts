/**
 * WHY. A finished todo board collapses to one line on the transcript card and in
 * the HTML export, and the anchored HUD above the composer kept drawing the
 * whole plan: every phase, every struck-through task, for the rest of the
 * session. So the screen said "Todo list done" in the transcript and showed a
 * full board of finished work directly under it, which is the loudest block on
 * screen saying nothing at all.
 *
 * THE CLASS. Not "the reported board collapses". The decision has one owner,
 * `isTodoListDone` / `TODO_DONE_SUMMARY` in `@veyyon/wire`, and this suite
 * compares the HUD's rendered bytes against that owner over the FULL cross
 * product of statuses across one and two phases, with the status vocabulary
 * enumerated at run time (`TODO_STATUSES`) so a fifth status enters the sweep
 * without anyone remembering to add it. The collapse must also be DERIVED, not a
 * mode the widget can be left in: appending open work reopens the board on the
 * next frame, and the expand toggle cannot reveal a finished one (a control
 * proves the toggle still moves an open board, so "collapsed" is never confused
 * with "toggle broken"). The HUD reads phases straight off a session file, so a
 * status it does not recognise must read as OPEN — collapsing an unread status
 * would hide live work.
 *
 * WHAT IT DOES NOT CATCH. The card's own collapse (owned by
 * `test/tools/todo-done-collapse.test.ts`) and the HTML export's (owned by
 * `packages/tool-render/test/todo-done-collapse.test.ts`). This suite pins the
 * HUD, plus the one thing neither of those can see: that the two surfaces on one
 * screen produce the SAME line. It also does not defend the open board's glyphs
 * or width budget, which are `todo-hud-states.test.ts`.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@veyyon/agent-core";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@veyyon/coding-agent/config/settings";
import { InteractiveMode } from "@veyyon/coding-agent/modes/interactive-mode";
import { initTheme, stopThemeWatcher, theme } from "@veyyon/coding-agent/modes/theme/theme";
import { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import { AuthStorage } from "@veyyon/coding-agent/session/auth-storage";
import { SessionManager } from "@veyyon/coding-agent/session/session-manager";
import { type TodoPhase, todoToolRenderer } from "@veyyon/coding-agent/tools/todo";
import { type AnsiPolicy, getAnsiPolicy, setAnsiPolicy, TUI } from "@veyyon/tui";
import { TempDir } from "@veyyon/utils";
import { isTodoListDone, TODO_DONE_SUMMARY, TODO_STATUSES, type TodoStatus } from "@veyyon/wire";
import { VirtualTerminal } from "../../../tui/test/virtual-terminal";

const COLUMNS = 100;

/** The anchored block's left pad: every HUD row starts one column in. */
const HUD_INDENT = " ";

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

describe("the anchored todo HUD collapses a finished board", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession;
	let mode: InteractiveMode;

	async function boot(overrides: Record<string, unknown> = {}): Promise<void> {
		resetSettingsForTest();
		tempDir = TempDir.createSync("@pi-todo-hud-done-");
		await Settings.init({ inMemory: true, cwd: tempDir.path(), overrides });
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		const modelRegistry = new ModelRegistry(authStorage);
		const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 to exist in registry");
		session = new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } }),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			settings: Settings.isolated(overrides),
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
	 * which is why {@link doneRow} carries it and the transcript card does not.
	 */
	const hudLines = (): string[] =>
		mode.todoContainer
			.render(COLUMNS)
			.flatMap(line => line.split("\n"))
			.map(line => line.trimEnd())
			.filter(line => line.trim() !== "");

	/** The single row a finished board draws in the HUD, indent included. */
	const doneRow = (tasks: number): string => `${HUD_INDENT}${doneLine(tasks).trimEnd()}`;

	const show = (phases: TodoPhase[]): void => {
		mode.setTodos(phases);
	};

	/**
	 * The headline contract on exact bytes: one line, the success colour, and no
	 * task row anywhere. A second line IS the defect, so this is `toEqual` and
	 * not `toContain`.
	 */
	it("draws one success line and no task rows", async () => {
		show(board(["completed", "completed", "abandoned"]));

		expect(hudLines()).toEqual([doneRow(3)]);
		const rendered = Bun.stripANSI(hudLines().join("\n"));
		expect(rendered).toContain(TODO_DONE_SUMMARY);
		expect(rendered).not.toContain("p0-task-0-completed");
		expect(rendered).not.toContain("Phase 1");
		// The block's own header is gone too: a finished board is not "Todos · 1/1".
		expect(rendered).not.toContain("Todos");
	});

	/**
	 * Guard against the byte comparison above passing in a run with no colour at
	 * all, which would make every `theme.fg` the identity function.
	 */
	it("keeps the success colour on the collapsed line", async () => {
		show(board(["completed"]));

		const line = hudLines()[0]!;
		expect(line).not.toBe(Bun.stripANSI(line));
		expect(line).toContain(theme.fg("success", "\u0000").split("\u0000")[0]!);
	});

	/**
	 * Derived, not a mode: the collapse is a function of the board in hand, so
	 * open work put back on it reopens the list on the very next render with no
	 * flag to reset.
	 */
	it("reopens the full board when open work is appended", async () => {
		show(board(["completed", "completed"]));
		expect(hudLines()).toEqual([doneRow(2)]);

		show(board(["completed", "completed", "pending"]));

		const rendered = Bun.stripANSI(hudLines().join("\n"));
		expect(rendered).not.toContain(TODO_DONE_SUMMARY);
		expect(rendered).toContain("p0-task-2-pending");
		expect(hudLines().length).toBeGreaterThan(1);

		// And closing that task collapses it again, without any intermediate state.
		show(board(["completed", "completed", "completed"]));
		expect(hudLines()).toEqual([doneRow(3)]);
	});

	/**
	 * Both states of the toggle, because a collapse that only holds in one of
	 * them is the defect with a keybinding in front of it. The control at the end
	 * proves the toggle still moves an OPEN board, so this test cannot pass
	 * because the toggle stopped working.
	 */
	it("cannot be reopened by the expand toggle", async () => {
		show(board(["completed"], ["abandoned", "completed"]));
		expect(mode.todoExpanded).toBe(false);
		expect(hudLines()).toEqual([doneRow(3)]);

		mode.toggleTodoExpansion();

		expect(mode.todoExpanded).toBe(true);
		expect(hudLines()).toEqual([doneRow(3)]);

		// Control: an open board is not indifferent to the toggle.
		show(board(["pending"], ["pending"], ["pending"], ["pending"], ["pending"], ["pending"], ["pending"]));
		const expandedRows = hudLines().length;
		mode.toggleTodoExpansion();
		expect(mode.todoExpanded).toBe(false);
		expect(hudLines().length).not.toBe(expandedRows);
	});

	/** Terminality is the owner's call, not the word "completed". */
	it("treats an abandoned-only board as finished", async () => {
		show(board(["abandoned", "abandoned"]));

		expect(hudLines()).toEqual([doneRow(2)]);
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

	/** The count is the tasks on the board, summed across phases, not the phases. */
	it("counts tasks across phases", async () => {
		show(board(["completed"]));
		expect(Bun.stripANSI(hudLines()[0]!)).toContain("· 1 task");

		show(board(["completed"], ["completed", "abandoned"]));
		expect(Bun.stripANSI(hudLines()[0]!)).toContain("· 3 tasks");
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
	 * that collapses AND keeps drawing rows fails here too.
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
						expect(lines).toEqual([doneRow(2)]);
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
	 * The two surfaces are on ONE screen at the same moment, so they may not word
	 * it differently. Compared as bytes, with the HUD's left padding taken off:
	 * one owner names the line, and this is what proves both callers ask it.
	 */
	it("draws the same line the transcript card draws", async () => {
		const phases = board(["completed", "abandoned"]);
		show(phases);

		const card = todoToolRenderer
			.renderResult(
				{ content: [{ type: "text", text: "board" }], details: { phases, storage: "memory" } },
				{ expanded: false, isPartial: false },
				theme,
			)
			.render(COLUMNS)
			.map(line => line.trimEnd())
			.filter(line => line.trim() !== "");

		expect(card).toEqual([doneLine(2).trimEnd()]);
		expect(hudLines()).toEqual(card.map(line => `${HUD_INDENT}${line}`));
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
 * The paint half. The container can hold correct rows that no frame ever
 * paints, so the headline case is asserted against the cells a real `TUI`
 * painted into a real VT. `getViewport` carries no SGR, which makes this a
 * monochrome read: the collapsed line has to be legible by its glyph and words.
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
		await Settings.init({ inMemory: true, cwd: tempDir.path() });
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		const modelRegistry = new ModelRegistry(authStorage);
		const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 to exist in registry");
		session = new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } }),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			settings: Settings.isolated({ "startup.quiet": true }),
			modelRegistry,
		});
		mode = new InteractiveMode(session, "test");
		terminal = new VirtualTerminal(COLUMNS, 24);
		mode.ui = new TUI(terminal);
		vi.spyOn(mode.statusLine, "watchBranch").mockImplementation(() => {});
		await mode.init({ suppressWelcomeIntro: true });
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

	it("paints the finished line and no task row", async () => {
		mode.setTodos(board(["completed", "completed", "abandoned"]));
		await terminal.waitForRender();

		const rows = terminal.getViewport().map(row => row.trimEnd());
		const done = rows.filter(row => row.includes(TODO_DONE_SUMMARY));
		expect(done).toHaveLength(1);
		expect(done[0]!).toContain(`${theme.checkbox.checked} ${TODO_DONE_SUMMARY} · 3 tasks`);
		expect(rows.some(row => row.includes("p0-task-0-completed"))).toBe(false);
		expect(rows.some(row => /^\s*Todos(\s|$)/.test(row))).toBe(false);
	});

	it("paints the whole board again once open work returns", async () => {
		mode.setTodos(board(["completed", "completed"]));
		await terminal.waitForRender();
		expect(terminal.getViewport().some(row => row.includes(TODO_DONE_SUMMARY))).toBe(true);

		mode.setTodos(board(["completed", "completed", "in_progress"]));
		await terminal.waitForRender();

		const rows = terminal.getViewport().map(row => row.trimEnd());
		expect(rows.some(row => row.includes(TODO_DONE_SUMMARY))).toBe(false);
		expect(rows.some(row => row.includes("p0-task-2-in_progress"))).toBe(true);
	});
});
