import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@veyyon/agent-core";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@veyyon/coding-agent/config/settings";
import { InteractiveMode } from "@veyyon/coding-agent/modes/interactive-mode";
import { initTheme } from "@veyyon/coding-agent/modes/theme/theme";
import type { SubmittedUserInput } from "@veyyon/coding-agent/modes/types";
import { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import { AuthStorage } from "@veyyon/coding-agent/session/auth-storage";
import { SessionManager } from "@veyyon/coding-agent/session/session-manager";
import { TempDir } from "@veyyon/utils";

/**
 * `/profile switch <name>` respawns the CLI on the same tty. Between the parent
 * restoring the terminal and the child resuming stdin nothing reads fd 0, so
 * the kernel queues whatever arrives and hands the whole backlog to the child
 * as its first input event. Verified against a real pty: a write made while no
 * reader is attached is delivered in full the instant the late reader resumes.
 *
 * The contract this file defends is the child's, at both ends of the boundary:
 * the backlog delivered as startup installs the reader must never reach the
 * composer or submit a turn, and a keystroke arriving once the prompt is live
 * must still be accepted.
 */

/** Real leaked text from the report; prose rather than a slash command, so a
 *  submission goes through the ordinary user-message path. */
const LEAKED = "Tip: Please use nerdfont for the best symbol rendering.";

function nextLoopTurn(): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	setImmediate(resolve);
	return promise;
}

describe("a relaunched session ignores bytes left in the tty", () => {
	let authStorage: AuthStorage;
	let mode: InteractiveMode;
	let session: AgentSession;
	let tempDir: TempDir;
	let submitted: SubmittedUserInput[];
	/** The TUI's real input entry point — the function `ProcessTerminal.start()`
	 *  hands every stdin chunk to. Driving it drives the production pipeline. */
	let deliverToStdinReader: ((data: string) => void) | undefined;

	beforeAll(() => {
		initTheme();
	});

	beforeEach(async () => {
		vi.spyOn(process.stdout, "write").mockReturnValue(true);
		vi.spyOn(process.stdin, "resume").mockReturnValue(process.stdin);
		vi.spyOn(process.stdin, "pause").mockReturnValue(process.stdin);
		vi.spyOn(process.stdin, "setEncoding").mockReturnValue(process.stdin);
		if (typeof process.stdin.setRawMode === "function") {
			vi.spyOn(process.stdin, "setRawMode").mockReturnValue(process.stdin);
		}

		resetSettingsForTest();
		submitted = [];
		deliverToStdinReader = undefined;
		tempDir = TempDir.createSync("@pi-relaunch-tty-backlog-");
		await Settings.init({ inMemory: true, cwd: tempDir.path() });
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		const modelRegistry = new ModelRegistry(authStorage);
		const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 to exist in registry");

		session = new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } }),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			settings: Settings.isolated(),
			modelRegistry,
		});
		mode = new InteractiveMode(session, "test");
		// Installed before `init()`: the leaked backlog is delivered during
		// startup, so a callback attached afterwards would miss the very
		// submission this test exists to catch.
		mode.onInputCallback = input => {
			submitted.push(input);
		};
		vi.spyOn(mode.statusLine, "watchBranch").mockImplementation(() => {});
		vi.spyOn(mode, "ensureLoadingAnimation").mockImplementation(() => {});

		const terminal = mode.ui.terminal;
		const realStart = terminal.start.bind(terminal);
		vi.spyOn(terminal, "start").mockImplementation((onInput, onResize) => {
			deliverToStdinReader = onInput;
			realStart(onInput, onResize);
			// Stand in for the kernel: `start()` resumes stdin, and the queued
			// backlog arrives as the first readable event of the turn that
			// follows. Scheduled from inside `start()`, so it lands ahead of
			// anything startup schedules after `start()` returns — exactly the
			// ordering a real tty produces, where the poll phase runs first.
			setImmediate(() => onInput(LEAKED));
			setImmediate(() => onInput("\r"));
		});
		await mode.init({ suppressWelcomeIntro: true });
		await nextLoopTurn();
	});

	afterEach(async () => {
		mode?.stop();
		vi.restoreAllMocks();
		await session?.dispose();
		authStorage?.close();
		tempDir?.removeSync();
		resetSettingsForTest();
	});

	it("submits nothing from the backlog the previous process left behind", () => {
		expect(submitted).toEqual([]);
		expect(mode.editor.getText()).toBe("");
	});

	it("still accepts what the operator types once the prompt is live", async () => {
		deliverToStdinReader?.("ship it");
		expect(mode.editor.getText()).toBe("ship it");

		deliverToStdinReader?.("\r");
		await nextLoopTurn();

		expect(submitted.map(input => input.text)).toEqual(["ship it"]);
	});
});
