/**
 * A stopped interactive mode runs no more anchored frames.
 *
 * WHY THIS SUITE EXISTS. The anchored HUD (the todo board and the subagent lane block) steps on
 * one `setInterval`, and that interval was `unref()`ed, which was mistaken for cleanup. `unref`
 * only says the timer will not hold the process open; it goes on firing for as long as the loop
 * runs. Nothing disarmed it on teardown, so a mode that had been stopped kept stepping, kept
 * rendering, and kept reading the settings singleton — inside one `bun test` process that is a
 * mode from a finished FILE painting into the next one, and the symptom was
 * `Settings not initialized. Call Settings.init() first.` thrown from `#renderSubagentList` and
 * attributed to whichever unrelated suite happened to be running when the frame landed.
 *
 * THE CLASS THIS CLOSES is "a chrome animation outlives the surface it animates". Two ways in,
 * and both are asserted: teardown must disarm a running frame, and a torn-down mode must refuse
 * to arm a new one — an arm site runs on every board write, so disarming alone would be undone by
 * the next event to reach a dead mode.
 *
 * WHAT IT DOES NOT CATCH. The other timers `#freezeFrameProduction` owns (loading, mic, clock,
 * todo auto-clear, observer sync, goal continuation). Each of those was already cancelled there;
 * this suite is about the one that was not, and about the property that makes the omission
 * observable rather than about the list.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@veyyon/agent-core";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@veyyon/coding-agent/config/settings";
import { InteractiveMode } from "@veyyon/coding-agent/modes/interactive-mode";
import { initTheme, stopThemeWatcher } from "@veyyon/coding-agent/modes/theme/theme";
import { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import { AuthStorage } from "@veyyon/coding-agent/session/auth-storage";
import { SessionManager } from "@veyyon/coding-agent/session/session-manager";
import { TODO_STRIKE_TOTAL_FRAMES, type TodoPhase } from "@veyyon/coding-agent/tools/todo";
import { RAIL_IDLE_STEP_MS, RAIL_SETTLE_FRAMES } from "@veyyon/coding-agent/tui/rail-motion";
import { TempDir } from "@veyyon/utils";

/** One phase, one task, at the status the arm needs. A completion is what makes a frame owed. */
const board = (status: "in_progress" | "completed"): TodoPhase[] => [
	{ name: "Lane", tasks: [{ content: "the one task", status }] },
];

/** Frames are counted in units of the module's own period, so a changed period stays swept. */
const FRAMES = 4;

beforeAll(async () => {
	await initTheme();
});

afterAll(() => {
	stopThemeWatcher();
});

describe("a stopped interactive mode", () => {
	let tempDir: TempDir | undefined;
	let authStorage: AuthStorage | undefined;
	let session: AgentSession | undefined;
	let mode: InteractiveMode | undefined;

	beforeEach(async () => {
		resetSettingsForTest();
		tempDir = TempDir.createSync("@pi-anchored-motion-teardown-");
		// Transitions ON: this suite is about the motion frame, and with them off it never arms.
		const overrides = { "display.transitions": "on" };
		await Settings.init({ inMemory: true, cwd: tempDir.path(), overrides });
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.json"));
		const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 in the registry");
		session = new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } }),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			settings: Settings.isolated(overrides),
			modelRegistry,
		});
		mode = new InteractiveMode(session, "test");
	});

	afterEach(async () => {
		vi.useRealTimers();
		mode?.stop();
		mode = undefined;
		await session?.dispose();
		session = undefined;
		authStorage?.close();
		authStorage = undefined;
		tempDir?.removeSync();
		tempDir = undefined;
		vi.restoreAllMocks();
		resetSettingsForTest();
	});

	/**
	 * Arms the frame through the public board write that a closing task arrives on, and returns the
	 * spy that counts frames. Asserts the arm worked, because every claim below is "and then it
	 * stopped" — which a frame that never started would satisfy for the wrong reason.
	 */
	const armMotion = (): ReturnType<typeof vi.fn> => {
		const target = mode;
		if (!target) throw new Error("Expected a booted mode");
		const requestRender = vi.spyOn(target.ui, "requestRender").mockImplementation(() => {});
		vi.useFakeTimers();
		target.setTodos(board("in_progress"));
		target.setTodos(board("completed"));
		requestRender.mockClear();
		vi.advanceTimersByTime(RAIL_IDLE_STEP_MS * FRAMES);
		expect(requestRender.mock.calls.length, "the anchored frame never armed").toBeGreaterThan(0);
		return requestRender;
	};

	it("disarms the anchored frame that was running when it stopped", () => {
		const requestRender = armMotion();

		mode?.stop();
		requestRender.mockClear();
		vi.advanceTimersByTime(RAIL_IDLE_STEP_MS * FRAMES * 10);

		expect(requestRender.mock.calls.length, "frames kept running after stop()").toBe(0);
	});

	/**
	 * Every board write re-runs the arm site, so a mode that is gone must refuse rather than
	 * re-arm. Without the refusal the disarm above is undone by the next event to reach it.
	 */
	it("refuses to arm a new frame after it has stopped", () => {
		const requestRender = armMotion();
		mode?.stop();

		mode?.setTodos(board("in_progress"));
		mode?.setTodos(board("completed"));
		// A board write renders once by itself; only what the interval drives counts as a frame.
		requestRender.mockClear();
		vi.advanceTimersByTime(RAIL_IDLE_STEP_MS * FRAMES * 10);

		expect(requestRender.mock.calls.length, "a stopped mode armed a new frame").toBe(0);
	});

	/**
	 * The disarm a LIVE mode performs when its sweeps finish is the same code path, and it must
	 * leave the mode able to arm again. Clearing the interval while keeping its handle stops every
	 * later frame for the rest of the session, which no assertion about a STOPPED mode can see:
	 * both look like silence.
	 */
	it("arms again after a quiet stretch disarmed it", () => {
		const requestRender = armMotion();

		// Long enough for the completion sweep to expire, which is what makes a frame stop being
		// owed. The bound is the module's own envelope plus slack, not a guessed duration.
		vi.advanceTimersByTime(RAIL_IDLE_STEP_MS * (TODO_STRIKE_TOTAL_FRAMES + RAIL_SETTLE_FRAMES + 8));
		requestRender.mockClear();
		vi.advanceTimersByTime(RAIL_IDLE_STEP_MS * FRAMES);
		expect(requestRender.mock.calls.length, "the frame never went quiet on its own").toBe(0);

		mode?.setTodos(board("in_progress"));
		mode?.setTodos(board("completed"));
		requestRender.mockClear();
		vi.advanceTimersByTime(RAIL_IDLE_STEP_MS * FRAMES);

		expect(requestRender.mock.calls.length, "a disarmed mode could not arm again").toBeGreaterThan(0);
	});
});
