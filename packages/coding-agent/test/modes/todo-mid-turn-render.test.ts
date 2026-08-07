/**
 * A `todo` result produced in the middle of a turn must be on the operator's
 * screen before the turn ends, on both surfaces that carry it: the anchored
 * Todos HUD above the composer, and the transcript card for the call.
 *
 * This is a regression guard, not a reproduction. It was written while chasing
 * a report that the board only appears at the end of a turn, and it did NOT
 * reproduce that: the paint path was found to be correct and four candidate
 * mechanisms were ruled out for the main-agent path (result produced only at
 * turn end, render produced but never flushed, a memo key that does not move
 * with todo state, and a repaint coalesced into turn completion). The board
 * looks frozen in real sessions because it is written rarely, not because the
 * writes go unpainted. This file exists so that stays true.
 *
 * It asserts the bytes a real `TUI` writes to a real VT, driven through the
 * real `EventController` with the event order a streaming turn actually
 * produces (`message_start` → `message_update` → `message_end` →
 * `tool_execution_start` → `tool_execution_end`), a transcript deep enough that
 * rows have committed to native scrollback, and a burst of streamed deltas
 * after the todo result — each of which schedules a component-scoped frame that
 * reuses every other root child's previous rows. Component-scoped frames are
 * the mechanism that could swallow an anchored-container change, so the burst
 * is part of the contract, not scenery.
 *
 * Asserting `mode.todoContainer.render(...)` alone would not defend this: the
 * container can hold correct rows that no frame ever paints.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@veyyon/agent-core";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@veyyon/coding-agent/config/settings";
import { InteractiveMode } from "@veyyon/coding-agent/modes/interactive-mode";
import { initTheme, stopThemeWatcher } from "@veyyon/coding-agent/modes/theme/theme";
import { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import { AuthStorage } from "@veyyon/coding-agent/session/auth-storage";
import { SessionManager } from "@veyyon/coding-agent/session/session-manager";
import { TUI } from "@veyyon/tui";
import { TempDir } from "@veyyon/utils";
import { VirtualTerminal } from "../../../tui/test/virtual-terminal";

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

describe("a mid-turn todo result reaches the screen before the turn ends", () => {
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
		tempDir = TempDir.createSync("@pi-todo-midturn-");
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
		terminal = new VirtualTerminal(100, 24);
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

	it("paints the updated board on the HUD and the transcript card with the turn still running", async () => {
		const controller = mode.eventController;
		const viewport = () => Bun.stripANSI(terminal.getViewport().join("\n"));

		await controller.handleEvent({ type: "agent_start" } as never);

		// Deep enough that rows have committed to native scrollback: the HUD
		// update has to survive a frame whose transcript prefix is immutable.
		for (let i = 0; i < 60; i++) {
			await controller.handleEvent({
				type: "tool_execution_start",
				toolCallId: `fill-${i}`,
				toolName: "bash",
				args: { command: `echo filler-${i}` },
			} as never);
			await controller.handleEvent({
				type: "tool_execution_end",
				toolCallId: `fill-${i}`,
				toolName: "bash",
				result: { content: [{ type: "text", text: `filler-${i}` }] },
				isError: false,
			} as never);
		}
		await terminal.waitForRender();

		const todoCall = (id: string, args: Record<string, unknown>) =>
			assistant([{ type: "toolCall", id, name: "todo", arguments: args }]);

		await controller.handleEvent({ type: "message_start", message: assistant([]) } as never);
		await controller.handleEvent({
			type: "message_update",
			message: todoCall("t1", { op: "start", task: "alpha task" }),
			assistantMessageEvent: { type: "text_delta", delta: "" },
		} as never);
		await controller.handleEvent({
			type: "message_end",
			message: todoCall("t1", { op: "start", task: "alpha task" }),
		} as never);
		await controller.handleEvent({
			type: "tool_execution_start",
			toolCallId: "t1",
			toolName: "todo",
			args: { op: "start", task: "alpha task" },
		} as never);
		await controller.handleEvent({
			type: "tool_execution_end",
			toolCallId: "t1",
			toolName: "todo",
			result: todoResult([
				["alpha task", "in_progress"],
				["beta task", "pending"],
			]),
			isError: false,
		} as never);
		await terminal.waitForRender();

		const first = viewport();
		expect(first).toContain("Phase One · 0/2");
		expect(first).toContain("alpha task");
		expect(first).toContain("beta task");

		// Real work runs between the two board updates.
		await controller.handleEvent({
			type: "tool_execution_start",
			toolCallId: "t2",
			toolName: "bash",
			args: { command: "echo hi" },
		} as never);
		await controller.handleEvent({
			type: "tool_execution_end",
			toolCallId: "t2",
			toolName: "bash",
			result: { content: [{ type: "text", text: "hi" }] },
			isError: false,
		} as never);

		await controller.handleEvent({ type: "message_start", message: assistant([]) } as never);
		await controller.handleEvent({
			type: "message_update",
			message: todoCall("t3", { op: "done", task: "alpha task" }),
			assistantMessageEvent: { type: "text_delta", delta: "" },
		} as never);
		await controller.handleEvent({
			type: "message_end",
			message: todoCall("t3", { op: "done", task: "alpha task" }),
		} as never);
		await controller.handleEvent({
			type: "tool_execution_start",
			toolCallId: "t3",
			toolName: "todo",
			args: { op: "done", task: "alpha task" },
		} as never);
		await controller.handleEvent({
			type: "tool_execution_end",
			toolCallId: "t3",
			toolName: "todo",
			result: todoResult([
				["alpha task", "completed"],
				["beta task", "in_progress"],
			]),
			isError: false,
		} as never);

		// The deltas a provider keeps sending after the tool result. Each one
		// schedules a component-scoped frame that reuses the anchored HUD's
		// previous rows, so the board update must not be lost behind them.
		for (let i = 0; i < 40; i++) {
			await controller.handleEvent({
				type: "message_update",
				message: assistant([{ type: "text", text: `writing ${i}` }]),
				assistantMessageEvent: { type: "text_delta", delta: "x" },
			} as never);
		}
		await terminal.waitForRender();

		// Still mid-turn: no agent_end has been delivered.
		const second = viewport();
		// HUD: the progress counter advanced and the finished task left the
		// collapsed open-task list.
		expect(second).toContain("Phase One · 1/2");
		// Transcript card: the completed task carries the checked marker.
		expect(second).toContain("■ alpha task");
		expect(second).toContain("beta task");
	});
});
