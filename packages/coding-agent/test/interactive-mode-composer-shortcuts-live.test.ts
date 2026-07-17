import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@veyyon/pi-agent-core";
import { ModelRegistry } from "@veyyon/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@veyyon/pi-coding-agent/config/settings";
import { InteractiveMode } from "@veyyon/pi-coding-agent/modes/interactive-mode";
import { initTheme } from "@veyyon/pi-coding-agent/modes/theme/theme";
import { AgentSession } from "@veyyon/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@veyyon/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@veyyon/pi-coding-agent/session/session-manager";
import { TempDir } from "@veyyon/pi-utils";

/**
 * Live-refresh contract for the composer's contextual shortcut bar: chips must
 * flip on draft/busy/queue transitions, not only at construction/init time
 * (mirrors interactive-mode-loop.test.ts's technique of overriding the
 * session's read-only getters to drive state without a real model call).
 */
function renderChips(mode: InteractiveMode): string {
	return Bun.stripANSI(mode.composerShortcuts.render(120).join("\n"));
}

describe("InteractiveMode composer shortcuts live refresh", () => {
	let authStorage: AuthStorage;
	let mode: InteractiveMode;
	let session: AgentSession;
	let tempDir: TempDir;

	beforeAll(() => {
		initTheme();
	});

	beforeEach(async () => {
		// Keep ProcessTerminal.start() from probing the real terminal during init().
		vi.spyOn(process.stdout, "write").mockReturnValue(true);
		vi.spyOn(process.stdin, "resume").mockReturnValue(process.stdin);
		vi.spyOn(process.stdin, "pause").mockReturnValue(process.stdin);
		vi.spyOn(process.stdin, "setEncoding").mockReturnValue(process.stdin);
		if (typeof process.stdin.setRawMode === "function") {
			vi.spyOn(process.stdin, "setRawMode").mockReturnValue(process.stdin);
		}

		resetSettingsForTest();
		tempDir = TempDir.createSync("@pi-composer-shortcuts-live-");
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
		vi.spyOn(mode.statusLine, "watchBranch").mockImplementation(() => {});
		vi.spyOn(mode, "ensureLoadingAnimation").mockImplementation(() => {});
		await mode.init({ suppressWelcomeIntro: true });
	});

	afterEach(async () => {
		mode?.stop();
		vi.restoreAllMocks();
		await session?.dispose();
		authStorage?.close();
		tempDir?.removeSync();
		resetSettingsForTest();
	});

	it("stays quiet at idle — no chrome rows, with or without a draft", () => {
		// The quiet composer: send/commands are discoverable in /help, so the bar
		// renders nothing until there is a live action (interrupt, dequeue).
		expect(renderChips(mode)).toBe("");

		mode.editor.setText("hello there");
		expect(renderChips(mode)).toBe("");

		mode.editor.setText("");
		expect(renderChips(mode)).toBe("");
	});

	it("swaps to the interrupt chip on agent_start and back on agent_end, driven by session.isStreaming", async () => {
		expect(renderChips(mode)).not.toContain("interrupt");

		let streaming = true;
		Object.defineProperty(session, "isStreaming", { configurable: true, get: () => streaming });
		await mode.eventController.handleEvent({ type: "agent_start" });
		expect(renderChips(mode)).toContain("interrupt");
		expect(renderChips(mode)).not.toContain("commands");

		streaming = false;
		await mode.eventController.handleEvent({ type: "agent_end", messages: [] });
		// Back to rest: the interrupt chip dissolves and the bar is quiet again.
		expect(renderChips(mode)).toBe("");
	});

	it("swaps to the interrupt chip while auto-compaction is running, driven by session.isCompacting", async () => {
		expect(renderChips(mode)).not.toContain("interrupt");

		let compacting = true;
		Object.defineProperty(session, "isCompacting", { configurable: true, get: () => compacting });
		await mode.eventController.handleEvent({
			type: "auto_compaction_start",
			reason: "threshold",
			action: "context-full",
		});
		expect(renderChips(mode)).toContain("interrupt");

		compacting = false;
		await mode.eventController.handleEvent({
			type: "auto_compaction_end",
			action: "context-full",
			result: undefined,
			aborted: false,
			willRetry: false,
			skipped: true,
		});
		expect(renderChips(mode)).not.toContain("interrupt");
	});

	it("adds the dequeue chip when the queue goes nonzero and removes it once drained", () => {
		expect(renderChips(mode)).not.toContain("dequeue");

		let queuedCount = 1;
		Object.defineProperty(session, "queuedMessageCount", { configurable: true, get: () => queuedCount });
		mode.updatePendingMessagesDisplay();
		expect(renderChips(mode)).toContain("dequeue");

		queuedCount = 0;
		mode.updatePendingMessagesDisplay();
		expect(renderChips(mode)).not.toContain("dequeue");
	});
});
