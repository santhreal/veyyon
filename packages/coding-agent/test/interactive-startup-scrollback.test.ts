import { afterEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@veyyon/agent-core";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@veyyon/coding-agent/config/settings";
import { InteractiveMode } from "@veyyon/coding-agent/modes/interactive-mode";
import {
	enableAutoTheme,
	getCurrentThemeName,
	initTheme,
	onTerminalAppearanceChange,
	previewTheme,
	setTheme,
	stopThemeWatcher,
	theme,
} from "@veyyon/coding-agent/modes/theme/theme";
import { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import { AuthStorage } from "@veyyon/coding-agent/session/auth-storage";
import { SessionManager } from "@veyyon/coding-agent/session/session-manager";
import { TUI, type TUIStartOptions } from "@veyyon/tui";
import { TempDir } from "@veyyon/utils";
import { VirtualTerminal } from "../../tui/test/virtual-terminal";

/**
 * ED 3 (`\x1b[3J`) erases the terminal's *saved* lines. It is not scoped to
 * anything veyyon drew and it cannot be undone: it takes the shell history and
 * command output the operator had before launch.
 *
 * These tests lock out the two unconditional wipes an interactive launch used
 * to perform. First, `main.ts` passed a hardcoded
 * `clearInitialTerminalHistory: true` into `mode.init`, which became
 * `ui.start({ clearScrollback: true })`. Second, once the terminal answered the
 * OSC 11 background query, the resolved auto theme fired a non-ephemeral theme
 * change whose handler forced `requestRender(true, { clearScrollback: true })`.
 * Either one destroyed the operator's scrollback on a plain launch, and no
 * setting could stop either.
 */
describe("InteractiveMode startup scrollback", () => {
	let tempDir: TempDir | undefined;
	let authStorage: AuthStorage | undefined;
	let session: AgentSession | undefined;
	let mode: InteractiveMode | undefined;

	interface StartedMode {
		mode: InteractiveMode;
		terminal: VirtualTerminal;
		/** Every byte the TUI wrote to the terminal, including the first paint. */
		writes: string[];
		/** Options `ui.start` was actually called with. */
		startOptions: TUIStartOptions | undefined;
	}

	/**
	 * Drives the real startup path: real `Settings`, real `InteractiveMode.init`,
	 * real `TUI.start`, against a virtual terminal whose writes are recorded from
	 * before the first paint.
	 */
	async function startInteractiveMode(
		overrides: Record<string, boolean>,
		options: { autoTheme?: boolean } = {},
	): Promise<StartedMode> {
		resetSettingsForTest();
		tempDir = TempDir.createSync("@pi-startup-scrollback-");
		await Settings.init({ inMemory: true, cwd: tempDir.path(), overrides: { "startup.quiet": true } });
		await initTheme();
		await setTheme("dark");
		// Auto theme is what a launch on a terminal that answers OSC 11 ends up in:
		// the resolved variant only becomes known once the background report lands,
		// which is after the first frame is already on screen.
		if (options.autoTheme) enableAutoTheme();

		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		const modelRegistry = new ModelRegistry(authStorage);
		const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 to exist in registry");

		session = new AgentSession({
			agent: new Agent({
				initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			}),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			settings: Settings.isolated({ "startup.quiet": true, ...overrides }),
			modelRegistry,
		});

		const createdMode = new InteractiveMode(session, "test");
		mode = createdMode;
		const createdTerminal = new VirtualTerminal(100, 20);
		createdMode.ui = new TUI(createdTerminal);

		const writes: string[] = [];
		const realWrite = createdTerminal.write.bind(createdTerminal);
		vi.spyOn(createdTerminal, "write").mockImplementation(data => {
			writes.push(data);
			realWrite(data);
		});
		let startOptions: TUIStartOptions | undefined;
		const realStart = createdMode.ui.start.bind(createdMode.ui);
		vi.spyOn(createdMode.ui, "start").mockImplementation(options => {
			startOptions = options;
			realStart(options);
		});
		vi.spyOn(createdMode.statusLine, "watchBranch").mockImplementation(() => {});

		await createdMode.init({ suppressWelcomeIntro: true });
		await createdTerminal.waitForRender();

		return { mode: createdMode, terminal: createdTerminal, writes, startOptions };
	}

	afterEach(async () => {
		mode?.stop();
		await session?.dispose();
		authStorage?.close();
		tempDir?.removeSync();
		mode = undefined;
		session = undefined;
		authStorage = undefined;
		tempDir = undefined;
		vi.restoreAllMocks();
		resetSettingsForTest();
		stopThemeWatcher();
		await setTheme("dark");
	});

	/**
	 * The defect itself: a default launch wiped the operator's saved scrollback.
	 * Asserted on the bytes the terminal received, not on a flag.
	 */
	it("never erases saved scrollback on a default launch", async () => {
		const started = await startInteractiveMode({});

		expect(started.writes.join("")).not.toContain("\x1b[3J");
	});

	/**
	 * The default launch still hands the operator a clean viewport, so nothing
	 * about dropping ED 3 makes the welcome frame append over the previous run:
	 * the first paint erases the screen with ED 2 and homes the cursor.
	 */
	it("still clears the viewport with ED 2 on a default launch", async () => {
		const started = await startInteractiveMode({});

		expect(started.writes.join("")).toContain("\x1b[2J\x1b[H");
	});

	/**
	 * The knob has to be real in the destructive direction too, otherwise the
	 * setting is a lie in the defaults table rather than a fix.
	 */
	it("erases saved scrollback on launch when the operator opts in", async () => {
		const started = await startInteractiveMode({ "startup.clearScrollback": true });

		expect(started.writes.join("")).toContain("\x1b[H\x1b[3J");
	});

	/**
	 * Binding proof: the value on the real `Settings` object is what reaches
	 * `ui.start`, so the setting is not decorative.
	 */
	it("passes the configured setting through to ui.start when off", async () => {
		const started = await startInteractiveMode({});

		expect(started.mode.settings.get("startup.clearScrollback")).toBe(false);
		expect(started.startOptions).toEqual({ clearScrollback: false });
	});

	/** Binding proof for the other value. */
	it("passes the configured setting through to ui.start when on", async () => {
		const started = await startInteractiveMode({ "startup.clearScrollback": true });

		expect(started.mode.settings.get("startup.clearScrollback")).toBe(true);
		expect(started.startOptions).toEqual({ clearScrollback: true });
	});

	/**
	 * `/clear` is an explicit request to replace the transcript, so it must keep
	 * emitting ED 3 even while the startup default no longer does. Disarming it
	 * would be the opposite defect.
	 */
	it("still erases scrollback for /clear when the startup setting is off", async () => {
		const started = await startInteractiveMode({});
		started.writes.length = 0;

		await started.mode.handleClearCommand();
		await started.terminal.waitForRender();

		expect(started.writes.join("")).toContain("\x1b[3J");
	});

	/**
	 * The second, later wipe on the same launch. A terminal that answers the OSC
	 * 11 background query reports its appearance after the first frame is already
	 * painted; that report resolves the auto theme, and the resulting
	 * non-ephemeral theme change used to hit
	 * `requestRender(true, { clearScrollback: true })` unconditionally. So a
	 * default launch still emitted ED 3 once, after startup, and erased the
	 * operator's pre-launch history while having no committed rows of its own to
	 * recolor.
	 */
	it("never erases saved scrollback when the terminal background report resolves the theme", async () => {
		const started = await startInteractiveMode({}, { autoTheme: true });
		const darkGround = theme.getGroundHex();

		onTerminalAppearanceChange("light");
		await started.terminal.waitForRender();

		// The swap really resolved, so the byte assertion below is not vacuous and
		// the repaint that the swap owes the operator still happened. Confirmed
		// before the second settle because the swap loads the theme off a promise
		// the caller never sees, and its render is scheduled only once that lands.
		expect(getCurrentThemeName()).toBe("light");
		expect(theme.getGroundHex()).not.toBe(darkGround);
		await started.terminal.waitForRender();

		expect(started.writes.join("")).not.toContain("\x1b[3J");
	});

	/**
	 * A mid-session preview is a hover, not a commit, so it must stay a live
	 * repaint and never touch saved history.
	 */
	it("never erases saved scrollback for a mid-session ephemeral theme preview", async () => {
		const started = await startInteractiveMode({});
		started.writes.length = 0;

		await previewTheme("light");
		await started.terminal.waitForRender();

		expect(started.writes.join("")).not.toContain("\x1b[3J");
	});
});
