import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { stripVTControlCharacters } from "node:util";
import { Agent } from "@veyyon/agent-core";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@veyyon/coding-agent/config/settings";
import { InteractiveMode } from "@veyyon/coding-agent/modes/interactive-mode";
import { initTheme } from "@veyyon/coding-agent/modes/theme/theme";
import { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import { AuthStorage } from "@veyyon/coding-agent/session/auth-storage";
import { SessionManager } from "@veyyon/coding-agent/session/session-manager";
import { EventBus } from "@veyyon/coding-agent/utils/event-bus";
import { TempDir } from "@veyyon/utils";

describe("InteractiveMode welcome dismissal (UI-10)", () => {
	let authStorage: AuthStorage;
	let mode: InteractiveMode;
	let session: AgentSession;
	let tempDir: TempDir;
	let savedGeometry: Record<"columns" | "rows", PropertyDescriptor | undefined>;

	beforeAll(() => {
		initTheme();
	});

	beforeEach(async () => {
		// Prevent ProcessTerminal.start() from touching the real terminal; the
		// test only reads rendered output via mode.ui.render().
		vi.spyOn(process.stdout, "write").mockReturnValue(true);
		// Pin the terminal geometry the fill math reads (bun:test's spyOn lacks
		// the getter overload, so defineProperty + descriptor restore in afterEach).
		savedGeometry = {
			columns: Object.getOwnPropertyDescriptor(process.stdout, "columns"),
			rows: Object.getOwnPropertyDescriptor(process.stdout, "rows"),
		};
		Object.defineProperty(process.stdout, "columns", { value: 100, configurable: true });
		Object.defineProperty(process.stdout, "rows", { value: 40, configurable: true });
		vi.spyOn(process.stdin, "resume").mockReturnValue(process.stdin);
		vi.spyOn(process.stdin, "pause").mockReturnValue(process.stdin);
		vi.spyOn(process.stdin, "setEncoding").mockReturnValue(process.stdin);
		if (typeof process.stdin.setRawMode === "function") {
			vi.spyOn(process.stdin, "setRawMode").mockReturnValue(process.stdin);
		}

		resetSettingsForTest();
		tempDir = TempDir.createSync("@pi-interactive-mode-welcome-dismiss-");
		await Settings.init({ inMemory: true, cwd: tempDir.path() });
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		const modelRegistry = new ModelRegistry(authStorage);
		const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!model) {
			throw new Error("Expected claude-sonnet-4-5 to exist in registry");
		}

		session = new AgentSession({
			agent: new Agent({
				initialState: {
					model,
					systemPrompt: ["Test"],
					tools: [],
					messages: [],
				},
			}),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			settings: Settings.isolated(),
			modelRegistry,
		});
		mode = new InteractiveMode(session, "test", () => {}, [], undefined, new EventBus());
		vi.spyOn(mode.statusLine, "watchBranch").mockImplementation(() => {});
	});

	afterEach(async () => {
		for (const key of ["columns", "rows"] as const) {
			const descriptor = savedGeometry[key];
			if (descriptor) Object.defineProperty(process.stdout, key, descriptor);
			else delete (process.stdout as unknown as Record<string, unknown>)[key];
		}
		mode?.stop();
		vi.restoreAllMocks();
		await session?.dispose();
		authStorage?.close();
		tempDir?.removeSync();
		resetSettingsForTest();
	});

	function frame(): string {
		return mode.ui
			.render(100)
			.map(line => stripVTControlCharacters(line))
			.join("\n");
	}

	it("centres the sunrise vertically (UI-2): real top margin above the sun", async () => {
		await mode.init({ suppressWelcomeIntro: true });
		const lines = frame().split("\n");
		const sunTop = lines.findIndex(line => /[░▒▓]/.test(line));
		// 40 mocked terminal rows leave generous slack around the sunrise header;
		// 2/5 of it sits above the sun, so the hero cannot hug the top edge.
		expect(sunTop).toBeGreaterThanOrEqual(4);
	});

	it("clears the sunrise on the first real keystroke and keeps it gone", async () => {
		await mode.init({ suppressWelcomeIntro: true });
		// The wordmark is letterspaced text in the terminal's own font.
		expect(frame()).toContain("v e y y o n");

		mode.editor.handleInput("h");
		expect(frame()).not.toContain("v e y y o n");

		// Emptying the draft does not resurrect the sunrise; dismissal is one-way.
		mode.editor.setText("");
		expect(frame()).not.toContain("v e y y o n");

		// Idempotent: a second dismissal on an already-clean screen is a no-op.
		mode.dismissWelcome();
		expect(frame()).not.toContain("v e y y o n");
	});
});
