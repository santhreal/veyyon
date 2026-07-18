import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@veyyon/agent-core";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@veyyon/coding-agent/config/settings";
import { LSP_STARTUP_EVENT_CHANNEL, type LspStartupEvent } from "@veyyon/coding-agent/lsp/startup-events";
import { InteractiveMode } from "@veyyon/coding-agent/modes/interactive-mode";
import { initTheme, theme } from "@veyyon/coding-agent/modes/theme/theme";
import { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import { AuthStorage } from "@veyyon/coding-agent/session/auth-storage";
import { SessionManager } from "@veyyon/coding-agent/session/session-manager";
import { lookupBuiltinSlashCommand } from "@veyyon/coding-agent/slash-commands/builtin-registry";
import type { LspStartupServerInfo } from "@veyyon/coding-agent/tools";
import { EventBus } from "@veyyon/coding-agent/utils/event-bus";
import { TempDir } from "@veyyon/utils";

describe("InteractiveMode LSP startup welcome banner", () => {
	let authStorage: AuthStorage;
	let eventBus: EventBus;
	let lspServers: LspStartupServerInfo[];
	let mode: InteractiveMode;
	let session: AgentSession;
	let tempDir: TempDir;

	beforeAll(() => {
		initTheme();
	});

	beforeEach(async () => {
		// Prevent ProcessTerminal.start() from sending escape queries to the real
		// terminal (OSC 11, DA1, kitty protocol, cell-size).  The test only reads
		// rendered output via mode.ui.render(), so real terminal I/O is unnecessary.
		vi.spyOn(process.stdout, "write").mockReturnValue(true);
		vi.spyOn(process.stdin, "resume").mockReturnValue(process.stdin);
		vi.spyOn(process.stdin, "pause").mockReturnValue(process.stdin);
		vi.spyOn(process.stdin, "setEncoding").mockReturnValue(process.stdin);
		if (typeof process.stdin.setRawMode === "function") {
			vi.spyOn(process.stdin, "setRawMode").mockReturnValue(process.stdin);
		}

		resetSettingsForTest();
		tempDir = TempDir.createSync("@pi-interactive-mode-lsp-startup-");
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
		eventBus = new EventBus();
		lspServers = [
			{
				name: "rust-analyzer",
				status: "connecting",
				fileTypes: [".rs"],
			},
		];
		mode = new InteractiveMode(session, "test", () => {}, lspServers, undefined, eventBus);
		// This test exercises the LSP startup banner, not git branch watching.
		// Starting a real fs.watch on the repo HEAD in a parallel Bun worker is
		// enough to trigger a Bun SIGTRAP in unrelated workers during the
		// 4-worker suite reproducer, so keep the watcher out of this contract.
		vi.spyOn(mode.statusLine, "watchBranch").mockImplementation(() => {});
	});

	afterEach(async () => {
		mode?.stop();
		vi.restoreAllMocks();
		await session?.dispose();
		authStorage?.close();
		tempDir?.removeSync();
		resetSettingsForTest();
	});

	it("reflects startup warmup completion in the /lsp status surface", async () => {
		await mode.init();

		// The welcome hero no longer paints LSP status; /lsp is the surface.
		const lspCommand = lookupBuiltinSlashCommand("lsp");
		if (!lspCommand?.handleTui) throw new Error("Expected a /lsp builtin with a TUI handler");
		const outputs: string[] = [];
		const runtime = {
			ctx: {
				...mode,
				lspServers: mode.lspServers,
				editor: { setText: () => {} },
				showStatus: (text: string) => {
					outputs.push(text);
				},
			},
		} as unknown as Parameters<NonNullable<typeof lspCommand.handleTui>>[1];
		const runLsp = async () => {
			await lspCommand.handleTui?.(
				{ name: "lsp", args: "" } as Parameters<NonNullable<typeof lspCommand.handleTui>>[0],
				runtime,
			);
			return Bun.stripANSI(outputs[outputs.length - 1] ?? "");
		};

		expect(await runLsp()).toContain(theme.status.pending);

		const requestRenderSpy = vi.spyOn(mode.ui, "requestRender");
		const showStatusSpy = vi.spyOn(mode, "showStatus");
		requestRenderSpy.mockClear();
		showStatusSpy.mockClear();

		lspServers[0].status = "ready";
		const event: LspStartupEvent = {
			type: "completed",
			servers: [
				{
					name: "rust-analyzer",
					status: "ready",
					fileTypes: [".rs"],
				},
			],
		};

		eventBus.emit(LSP_STARTUP_EVENT_CHANNEL, event);

		expect(requestRenderSpy).toHaveBeenCalled();
		expect(showStatusSpy).not.toHaveBeenCalled();
		const after = await runLsp();
		expect(after).toContain("rust-analyzer");
		expect(after).toContain(theme.status.enabled);
		expect(after).not.toContain(theme.status.pending);
	});

	it("does not render LSP startup warnings when startup.quiet is enabled", () => {
		session.settings.set("startup.quiet", true);
		const showWarningSpy = vi.spyOn(mode, "showWarning").mockImplementation(() => {});

		eventBus.emit(LSP_STARTUP_EVENT_CHANNEL, {
			type: "failed",
			error: "rust-analyzer timed out",
		} satisfies LspStartupEvent);

		expect(showWarningSpy).not.toHaveBeenCalled();
	});
});
