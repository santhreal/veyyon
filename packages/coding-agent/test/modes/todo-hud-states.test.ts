/**
 * The collapsed Todos HUD has to answer two questions at a glance: what is
 * left, and what has been done. It only answered the first.
 *
 * Finished tasks were filtered out of the collapsed board entirely, so a stage
 * that had just closed three tasks looked identical to one that had done
 * nothing. That is most of why the board reads as stalled (the paint path was
 * separately proved correct in `todo-mid-turn-render.test.ts`; the board is
 * written rarely, not painted late). And in-progress drew the pending box in a
 * different colour, which is no distinction at all for a reader who cannot
 * separate the two hues, in a low-contrast theme, or in any capture that drops
 * SGR.
 *
 * Both are asserted against the cells a real `TUI` painted into a real Ghostty
 * VT. `VirtualTerminal#getViewport` reconstructs each row from its codepoints
 * and carries no SGR at all, so every assertion below is by construction a
 * monochrome one: a state that survives it is distinguished by its glyph, not
 * by its colour. Asserting `mode.todoContainer.render(...)` would not defend
 * this — the container can hold correct rows no frame ever paints.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@veyyon/agent-core";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@veyyon/coding-agent/config/settings";
import { InteractiveMode } from "@veyyon/coding-agent/modes/interactive-mode";
import { ASCII_SYMBOLS, NERD_SYMBOLS, UNICODE_SYMBOLS } from "@veyyon/coding-agent/modes/theme/symbols";
import { initTheme, stopThemeWatcher } from "@veyyon/coding-agent/modes/theme/theme";
import { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import { AuthStorage } from "@veyyon/coding-agent/session/auth-storage";
import { SessionManager } from "@veyyon/coding-agent/session/session-manager";
import { TUI } from "@veyyon/tui";
import { TempDir } from "@veyyon/utils";
import { VirtualTerminal } from "../../../tui/test/virtual-terminal";

const COLUMNS = 100;

/** Glyph column of a HUD task row: `Text` left pad (1) + the phase shift (1) + the phase
 *  connector (3) + the task connector (3). Pinned because the width budget is derived from it. */
const TASK_GLYPH_COLUMN = 8;

function todoResult(statuses: Array<[string, string]>) {
	return {
		content: [{ type: "text", text: "board" }],
		details: {
			op: "done",
			storage: "memory",
			phases: [{ name: "Phase One", tasks: statuses.map(([content, status]) => ({ content, status })) }],
		},
	} as never;
}

function assistant(content: unknown[]) {
	return {
		role: "assistant",
		content,
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		stopReason: "toolUse",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		timestamp: Date.now(),
	};
}

describe("the collapsed Todos HUD distinguishes every task state without colour", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession;
	let mode: InteractiveMode;
	let terminal: VirtualTerminal;

	beforeAll(async () => {
		await initTheme();
	});

	beforeEach(async () => {
		resetSettingsForTest();
		tempDir = TempDir.createSync("@pi-todo-hud-");
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
		stopThemeWatcher();
	});

	/**
	 * The anchored HUD block only: its own `Todos` header down to the blank row
	 * that ends the block. A todo tool result also paints a transcript card that
	 * lists every task, so a whole-viewport search cannot tell "the board kept
	 * this row" from "the card mentioned it". Rows are taken verbatim, including
	 * any the terminal wrapped, because a wrap is exactly what the width budget
	 * has to rule out.
	 */
	const hudRows = (): string[] => {
		const rows = terminal.getViewport();
		const header = rows.findLastIndex(row => /^\s*Todos(\s|$)/.test(row.trimEnd()));
		expect(header).toBeGreaterThanOrEqual(0);
		const block: string[] = [];
		for (let i = header + 1; i < rows.length; i++) {
			const row = rows[i]!.trimEnd();
			if (row === "") {
				if (block.length > 0) break;
				continue;
			}
			block.push(row);
		}
		return block;
	};

	const board = (tasks: Array<[string, string]>) => {
		mode.setTodos([{ name: "Phase One", tasks: tasks.map(([content, status]) => ({ content, status })) }] as never);
	};

	it("keeps finished tasks on the board when a mid-turn result closes one", async () => {
		const controller = mode.eventController;
		const call = (id: string, args: Record<string, unknown>) =>
			assistant([{ type: "toolCall", id, name: "todo", arguments: args }]);

		await controller.handleEvent({ type: "agent_start" } as never);
		await controller.handleEvent({ type: "message_start", message: assistant([]) } as never);
		await controller.handleEvent({
			type: "message_end",
			message: call("t1", { op: "done", task: "wire the parser" }),
		} as never);
		await controller.handleEvent({
			type: "tool_execution_start",
			toolCallId: "t1",
			toolName: "todo",
			args: { op: "done", task: "wire the parser" },
		} as never);
		await controller.handleEvent({
			type: "tool_execution_end",
			toolCallId: "t1",
			toolName: "todo",
			result: todoResult([
				["wire the parser", "completed"],
				["backfill the tests", "in_progress"],
				["update the docs", "pending"],
			]),
			isError: false,
		} as never);
		await terminal.waitForRender();

		// The whole point: the closed task is still on the board, showing what
		// moved, rather than leaving only the two rows that have not.
		expect(hudRows()).toEqual([
			"  └─ Phase One · 1/3",
			"     ├─ ■ wire the parser",
			"     ├─ ◧ backfill the tests",
			"     └─ □ update the docs",
		]);
	});

	it("gives in-progress a glyph of its own, so it survives a colourless capture", async () => {
		board([
			["scan the tree", "in_progress"],
			["write the guard", "pending"],
		]);
		await terminal.waitForRender();

		const rows = hudRows();
		const running = rows.find(row => row.includes("scan the tree"))!;
		const waiting = rows.find(row => row.includes("write the guard"))!;
		// Colour is gone by construction (cell readback carries no SGR), so if
		// these two glyphs were equal the states would be indistinguishable.
		expect(running[TASK_GLYPH_COLUMN]).toBe("◧");
		expect(waiting[TASK_GLYPH_COLUMN]).toBe("□");
		expect(running[TASK_GLYPH_COLUMN]).not.toBe(waiting[TASK_GLYPH_COLUMN]);
	});

	it("bounds the finished rows so a long-running stage cannot grow the block", async () => {
		board([
			["first done", "completed"],
			["second done", "completed"],
			["third done", "completed"],
			["fourth done", "completed"],
			["still going", "in_progress"],
			["not started", "pending"],
		]);
		await terminal.waitForRender();

		// Two most recent finished tasks, then the open work. The stage header's
		// `4/6` implies the two that are not listed.
		expect(hudRows()).toEqual([
			"  └─ Phase One · 4/6",
			"     ├─ ■ third done",
			"     ├─ ■ fourth done",
			"     ├─ ◧ still going",
			"     └─ □ not started",
		]);
	});

	it("truncates a task to the terminal width instead of wrapping the anchored block", async () => {
		const long = `start ${"pad ".repeat(80)}end`;
		board([
			[long, "completed"],
			["next up", "in_progress"],
		]);
		await terminal.waitForRender();

		const rows = hudRows();
		// One row, not a wrapped stack: the anchored block is rebuilt in place
		// every frame, so a wrapping row grows the region under the transcript.
		expect(rows.filter(row => row.includes("pad"))).toHaveLength(1);
		expect(rows).toHaveLength(3);
		const wide = rows.find(row => row.includes("pad"))!;
		expect(wide.length).toBeLessThan(COLUMNS);
		expect(wide).toContain("start pad");
		expect(wide).not.toContain("end");
	});
});

describe("every symbol preset carries a third checkbox state", () => {
	// A preset that only defined two states would render `undefined` for the
	// third. `SymbolMap` is total so the compiler catches an omission, but it
	// cannot catch a preset that reuses the pending glyph and quietly puts the
	// distinction back on colour alone.
	for (const [name, preset] of [
		["unicode", UNICODE_SYMBOLS],
		["nerd", NERD_SYMBOLS],
		["ascii", ASCII_SYMBOLS],
	] as const) {
		it(`${name} draws in-progress differently from pending and done`, () => {
			const progress = preset["checkbox.progress"];
			expect(progress).toBeTruthy();
			expect(progress).not.toBe(preset["checkbox.unchecked"]);
			expect(progress).not.toBe(preset["checkbox.checked"]);
			// Same cell count as its siblings, or the content column shifts when a
			// task starts.
			expect(progress.length).toBe(preset["checkbox.unchecked"].length);
		});
	}
});
