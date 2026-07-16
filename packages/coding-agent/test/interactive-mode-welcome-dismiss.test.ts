import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { stripVTControlCharacters } from "node:util";
import { Agent } from "@veyyon/pi-agent-core";
import { ModelRegistry } from "@veyyon/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@veyyon/pi-coding-agent/config/settings";
import { InteractiveMode } from "@veyyon/pi-coding-agent/modes/interactive-mode";
import { initTheme } from "@veyyon/pi-coding-agent/modes/theme/theme";
import { AgentSession } from "@veyyon/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@veyyon/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@veyyon/pi-coding-agent/session/session-manager";
import { EventBus } from "@veyyon/pi-coding-agent/utils/event-bus";
import { TempDir } from "@veyyon/pi-utils";

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

	it("centres the welcome card vertically (UI-2): real top margin above the hero", async () => {
		await mode.init();
		const lines = frame().split("\n");
		const cardTop = lines.findIndex(line => line.includes("┌"));
		// 40 mocked terminal rows and an ~8-row card leave ~26 rows of slack;
		// 2/5 of it sits above the card, so the hero cannot hug the top edge.
		expect(cardTop).toBeGreaterThanOrEqual(5);
	});

	it("clears the welcome card on the first real keystroke and keeps it gone", async () => {
		await mode.init();
		expect(frame()).toContain("veyyon vtest");

		mode.editor.handleInput("h");
		expect(frame()).not.toContain("veyyon vtest");

		// Emptying the draft does not resurrect the card; dismissal is one-way.
		mode.editor.setText("");
		expect(frame()).not.toContain("veyyon vtest");

		// Idempotent: a second dismissal on an already-clean screen is a no-op.
		mode.dismissWelcome();
		expect(frame()).not.toContain("veyyon vtest");
	});
});
