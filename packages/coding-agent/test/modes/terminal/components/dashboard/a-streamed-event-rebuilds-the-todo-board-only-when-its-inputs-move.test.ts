/**
 * A streamed event rebuilds the anchored todo board only when an input the board
 * reads has moved.
 *
 * WHAT THIS CLOSES. Every streamed event of a turn (each `message_update` delta,
 * each tool start and end) reaches `ensureLoadingAnimation`, which rebuilt the
 * board unconditionally: the tree, the rail sweep and a new mounted `Text` the
 * frame then wrapped again, once per event. A 400,000-character answer under a
 * live board spent about 0.4 s more CPU than with the rebuild skipped, drawing
 * identical rows thousands of times between two steps of the anchored clock.
 *
 * The observable is the component mounted for the board: a rebuild mounts a new
 * one, and an event that leaves the same one mounted cost the frame nothing.
 *
 * THE CLASS. The board reads two kinds of input. A todo write, an agent change,
 * the expand toggle and the anchored clock each rebuild the board themselves.
 * The motion decision, the mount size and the theme move under it with no event
 * of their own, and the streamed-event path is what picks them up. The suite
 * holds both halves: a burst of deltas with nothing moved rebuilds nothing while
 * the clock still steps the board, and moving any one input of the second kind
 * rebuilds the board once by the next event and not again after it. Each source
 * of the motion decision (`isStreaming`, `isCompacting`, `hasPostPromptWork`,
 * `display.transitions`) moves separately, so a source dropped from the
 * comparison goes red.
 *
 * WHAT IT DOES NOT CATCH. A new input `#buildTodoBoard` starts reading without
 * recording it: the suite cannot enumerate what a function reads. A field added
 * to `TodoBoardMotion` is compared without an edit, so that variant is covered.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@veyyon/agent-core";
import { AuthStorage } from "@veyyon/ai/auth-storage";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { resetSettingsForTest, Settings, settings } from "@veyyon/coding-agent/config/settings";
import { RAIL_IDLE_STEP_MS } from "@veyyon/coding-agent/modes/terminal/draw/rail-motion";
import { InteractiveMode } from "@veyyon/coding-agent/modes/terminal/interactive-mode";
import { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import {
	getThemeByName,
	initTheme,
	setThemeInstance,
	stopThemeWatcher,
	type Theme,
	theme,
} from "@veyyon/coding-agent/theme/theme";
import type { TodoPhase } from "@veyyon/coding-agent/tools/agent/todo";
import { SessionManager } from "@veyyon/kernel/session/session-manager";
import { TUI } from "@veyyon/tui";
import { TempDir } from "@veyyon/utils";
import { VirtualTerminal } from "../../../../../../../hosts/terminal/engine/test/virtual-terminal";

const COLUMNS = 100;
const ROWS = 24;

const plan: TodoPhase[] = [
	{
		name: "Layout",
		tasks: [
			{ content: "Measure columns", status: "completed" },
			{ content: "Cache widths", status: "in_progress" },
			{ content: "Wrap rows", status: "pending" },
		],
	},
	{ name: "Render", tasks: [{ content: "Keep stable prefix", status: "pending" }] },
];

function assistant(content: unknown[]) {
	return {
		role: "assistant",
		content,
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		stopReason: "stop",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		timestamp: 0,
	};
}

/** The component mounted for the board. A rebuild mounts a new one, which the next frame wraps again. */
function mountedBoard(mode: InteractiveMode) {
	return mode.todoContainer.children[0];
}

/** The session state the board's motion decision reads, driven by the test. */
interface SessionMotion {
	streaming: boolean;
	compacting: boolean;
	postPromptWork: boolean;
}

interface EdgeContext {
	motion: SessionMotion;
	terminal: VirtualTerminal;
}

/**
 * Every input that reaches the board with no board event of its own. A new
 * entry is a decision about how that input is moved; the sweep below runs each.
 */
const UNEVENTED_INPUTS: Record<string, (ctx: EdgeContext) => Promise<void> | void> = {
	"the agent starts streaming": ctx => {
		ctx.motion.streaming = true;
	},
	"compaction starts": ctx => {
		ctx.motion.compacting = true;
	},
	"post-prompt work starts": ctx => {
		ctx.motion.postPromptWork = true;
	},
	"transitions turn off": () => {
		settings.set("display.transitions", "off");
	},
	"the terminal narrows": ctx => {
		ctx.terminal.resize(COLUMNS - 17, ROWS);
	},
	"the terminal grows taller": ctx => {
		// A third of the viewport is the row budget: 24 rows give 8, 36 give 12.
		ctx.terminal.resize(COLUMNS, ROWS + 12);
	},
	"the theme is swapped": async () => {
		// Every load builds a new instance, so this is a swap even when `dark` is already active.
		const fresh = await getThemeByName("dark");
		if (!fresh) throw new Error("expected the shipped dark theme to load");
		setThemeInstance(fresh);
	},
};

describe("a streamed event rebuilds the todo board only when its inputs move", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession;
	let mode: InteractiveMode;
	let terminal: VirtualTerminal;
	let motion: SessionMotion;
	let originalTheme: Theme;

	beforeAll(async () => {
		await initTheme();
		originalTheme = theme;
	});

	beforeEach(async () => {
		resetSettingsForTest();
		tempDir = TempDir.createSync("@veyyon-todo-board-inputs-");
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
		// `spyOn` cannot stub an accessor. These own properties shadow the
		// session's getters for this instance only.
		const state: SessionMotion = { streaming: false, compacting: false, postPromptWork: false };
		motion = state;
		Object.defineProperty(session, "isStreaming", { get: () => state.streaming, configurable: true });
		Object.defineProperty(session, "isCompacting", { get: () => state.compacting, configurable: true });
		Object.defineProperty(session, "hasPostPromptWork", { get: () => state.postPromptWork, configurable: true });
		mode = new InteractiveMode(session, "test");
		terminal = new VirtualTerminal(COLUMNS, ROWS);
		mode.ui = new TUI(terminal);
		vi.spyOn(mode.statusLine, "watchGitState").mockImplementation(() => {});
		await mode.init();
		await terminal.waitForRender();
		// The anchored clock and the loader run on intervals; only the test steps them.
		vi.useFakeTimers();
		vi.spyOn(mode.ui, "requestRender").mockImplementation(() => {});
	});

	afterEach(async () => {
		mode?.stop();
		vi.useRealTimers();
		await session?.dispose();
		authStorage?.close();
		tempDir?.removeSync();
		vi.restoreAllMocks();
		if (theme !== originalTheme) setThemeInstance(originalTheme);
		resetSettingsForTest();
		stopThemeWatcher();
	});

	it("leaves an unchanged board alone across a burst of deltas while the clock still steps it", async () => {
		mode.setTodos(plan);
		motion.streaming = true;
		const controller = mode.eventController;
		await controller.handleEvent({ type: "agent_start" } as never);
		await controller.handleEvent({ type: "message_start", message: assistant([]) } as never);

		const mounted = mountedBoard(mode);
		let text = "";
		for (let i = 0; i < 200; i++) {
			const delta = `word${i} `;
			text += delta;
			await controller.handleEvent({
				type: "message_update",
				message: assistant([{ type: "text", text }]),
				assistantMessageEvent: { type: "text_delta", delta },
			} as never);
		}
		expect(mountedBoard(mode)).toBe(mounted);
		expect(Bun.stripANSI(mode.todoContainer.render(COLUMNS).join("\n"))).toContain("Cache widths");

		vi.advanceTimersByTime(RAIL_IDLE_STEP_MS);
		expect(mountedBoard(mode)).not.toBe(mounted);
	});

	for (const [name, move] of Object.entries(UNEVENTED_INPUTS)) {
		it(`rebuilds the board once when ${name}, and not again after`, async () => {
			mode.setTodos(plan);
			mode.ensureLoadingAnimation();
			const settled = mountedBoard(mode);
			expect(settled).toBeDefined();

			mode.ensureLoadingAnimation();
			expect(mountedBoard(mode)).toBe(settled);

			await move({ motion, terminal });
			mode.ensureLoadingAnimation();
			const rebuilt = mountedBoard(mode);
			expect(rebuilt).not.toBe(settled);

			mode.ensureLoadingAnimation();
			expect(mountedBoard(mode)).toBe(rebuilt);
		});
	}
});
