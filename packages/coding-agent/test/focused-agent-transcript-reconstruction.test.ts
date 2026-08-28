/**
 * WHY: Focusing a parked subagent attaches its durable transcript and reconstructs
 * all conversation history, tool calls, and tool execution results. When durable state
 * is unrevivable (missing file, deleted cwd, corrupted JSONL), focusing must fail cleanly
 * without corrupting or orphaning the driving session view.
 *
 * Closes the class of:
 * - Transcript component loss on parked subagent revival
 * - Unhandled crashes / orphaned views when revived session directory or file is missing/corrupted
 * - Spurious auto-unfocus on parked state vs true termination
 */
import "./helpers/tool-views-preload";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Agent } from "@veyyon/agent-core";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@veyyon/coding-agent/config/settings";
import { InteractiveMode } from "@veyyon/coding-agent/modes/interactive-mode";
import { initTheme, setTheme, stopThemeWatcher } from "@veyyon/coding-agent/modes/theme/theme";
import { AgentLifecycleManager } from "@veyyon/coding-agent/registry/agent-lifecycle";
import { AgentRegistry, MAIN_AGENT_ID } from "@veyyon/coding-agent/registry/agent-registry";
import { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import { AuthStorage } from "@veyyon/coding-agent/session/auth-storage";
import { SessionManager } from "@veyyon/coding-agent/session/session-manager";
import { createPersistedSubagentReviverFactory } from "@veyyon/coding-agent/task/persisted-revive";
import { EventBus } from "@veyyon/coding-agent/utils/event-bus";
import { TUI } from "@veyyon/tui";
import { VirtualTerminal } from "@veyyon/render-oracle";

const WIDTH = 120;
const TEST_PARENT = path.resolve(import.meta.dirname, "../../../.internal/focused-agent-transcript");
let testRoot = "";

describe("focused agent transcript reconstruction", () => {
	let tempDir: string | undefined;
	let subagentDir: string | undefined;
	let authStorage: AuthStorage | undefined;
	let mainSession: AgentSession | undefined;
	let mode: InteractiveMode | undefined;
	let terminal: VirtualTerminal | undefined;
	let eventBus: EventBus | undefined;

	beforeAll(async () => {
		await fs.mkdir(TEST_PARENT, { recursive: true });
		testRoot = await fs.mkdtemp(path.join(TEST_PARENT, "run-"));
		await initTheme();
		await setTheme("dark");
	});

	beforeEach(async () => {
		resetSettingsForTest();
		AgentRegistry.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();
		tempDir = await fs.mkdtemp(path.join(testRoot, "main-"));
		subagentDir = await fs.mkdtemp(path.join(testRoot, "sub-"));
		await Settings.init({ inMemory: true, cwd: tempDir, overrides: { "startup.quiet": true } });

		authStorage = await AuthStorage.create(path.join(tempDir, "testauth.db"));
		const modelRegistry = new ModelRegistry(authStorage);
		const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 to exist in registry");

		mainSession = new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: ["Main"], tools: [], messages: [] } }),
			sessionManager: SessionManager.create(tempDir, tempDir),
			settings: Settings.isolated({ "startup.quiet": true }),
			modelRegistry,
		});

		eventBus = new EventBus();
		mode = new InteractiveMode(mainSession, "test", undefined, undefined, undefined, eventBus);
		terminal = new VirtualTerminal(WIDTH, 40);
		mode.ui = new TUI(terminal);
		vi.spyOn(mode.statusLine, "watchBranch").mockImplementation(() => {});
		await mode.init();
		await terminal.waitForRender();
	});

	afterEach(async () => {
		mode?.stop();
		await mainSession?.dispose();
		authStorage?.close();
		if (tempDir) await fs.rm(tempDir, { recursive: true, force: true });
		if (subagentDir) await fs.rm(subagentDir, { recursive: true, force: true });
		mode = undefined;
		mainSession = undefined;
		terminal = undefined;
		eventBus = undefined;
		vi.restoreAllMocks();
		resetSettingsForTest();
		AgentRegistry.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();
	});

	afterAll(async () => {
		stopThemeWatcher();
		await fs.rm(testRoot, { recursive: true, force: true });
	});

	it("reconstructs assistant tool calls and results when focusing a parked subagent with durable session file", async () => {
		if (!mode || !terminal || !mainSession || !subagentDir) throw new Error("not booted");

		// Synthetic durable session: enough history to prove every visible role is rebuilt.
		const sessionFilePath = path.join(subagentDir, "Worker.jsonl");
		const sessionLines = [
			JSON.stringify({
				type: "session",
				version: 3,
				id: "focused-transcript-fixture",
				timestamp: "2026-01-01T00:00:00.000Z",
				cwd: subagentDir,
			}),
			JSON.stringify({
				type: "model_change",
				id: "model",
				parentId: null,
				timestamp: "2026-01-01T00:00:00.001Z",
				model: "anthropic/claude-sonnet-4-5",
			}),
			JSON.stringify({
				type: "thinking_level_change",
				id: "thinking",
				parentId: "model",
				timestamp: "2026-01-01T00:00:00.002Z",
				thinkingLevel: "low",
				configured: null,
			}),
			JSON.stringify({
				type: "session_init",
				id: "init",
				parentId: "thinking",
				timestamp: "2026-01-01T00:00:00.003Z",
				systemPrompt: "Synthetic subagent fixture",
				tools: ["read"],
			}),
			JSON.stringify({
				type: "message",
				id: "user",
				parentId: "init",
				timestamp: "2026-01-01T00:00:00.004Z",
				message: {
					role: "user",
					content: [{ type: "text", text: "Inspect fixture.ts" }],
					attribution: "agent",
					timestamp: 4,
				},
			}),
			JSON.stringify({
				type: "message",
				id: "assistant-tool",
				parentId: "user",
				timestamp: "2026-01-01T00:00:00.005Z",
				message: {
					role: "assistant",
					content: [
						{
							type: "toolCall",
							id: "call-read",
							name: "read",
							arguments: { path: "fixture.ts", i: "Read fixture" },
						},
					],
					api: "anthropic",
					provider: "anthropic",
					model: "claude-sonnet-4-5",
					usage: {
						input: 1,
						output: 1,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 2,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
				},
			}),
			JSON.stringify({
				type: "custom",
				customType: "tool_execution_start",
				data: {
					toolCallId: "call-read",
					toolName: "read",
					startedAt: "2026-01-01T00:00:00.006Z",
					args: { path: "fixture.ts" },
					intent: "Read fixture",
				},
				id: "tool-start",
				parentId: "assistant-tool",
				timestamp: "2026-01-01T00:00:00.006Z",
			}),
			JSON.stringify({
				type: "message",
				id: "tool-result",
				parentId: "tool-start",
				timestamp: "2026-01-01T00:00:00.007Z",
				message: {
					role: "toolResult",
					toolCallId: "call-read",
					toolName: "read",
					content: [{ type: "text", text: "export const fixture = 1;" }],
					details: { displayContent: { text: "export const fixture = 1;", startLine: 1, lineNumbers: [1] } },
					isError: false,
					timestamp: 7,
				},
			}),
			JSON.stringify({
				type: "message",
				id: "assistant-final",
				parentId: "tool-result",
				timestamp: "2026-01-01T00:00:00.008Z",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "Fixture inspected." }],
					api: "anthropic",
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
				},
			}),
		];
		await fs.writeFile(sessionFilePath, `${sessionLines.join("\n")}\n`, "utf-8");

		// Register the subagent as parked with sessionFile in AgentRegistry
		const registry = AgentRegistry.global();
		registry.register({
			id: "Worker",
			displayName: "Worker",
			kind: "sub",
			parentId: MAIN_AGENT_ID,
			session: null,
			sessionFile: sessionFilePath,
			status: "parked",
		});

		// Install persisted reviver factory like in main.ts
		const settings = Settings.isolated({ "startup.quiet": true });
		AgentLifecycleManager.global().setPersistedSubagentReviverFactory(
			createPersistedSubagentReviverFactory({
				session: mainSession,
				authStorage: authStorage!,
				modelRegistry: mainSession.modelRegistry,
				settings,
				enableLsp: false,
			}),
			60_000,
		);

		// Focus the agent
		await mode.focusAgentSession("Worker");
		await terminal.waitForRender();

		// Verify the transcript contains all user, assistant, and tool components
		const children = mode.chatContainer.children;
		const userComponents = children.filter(c => c.constructor.name === "UserMessageComponent");
		const assistantComponents = children.filter(c => c.constructor.name === "AssistantMessageComponent");
		const toolComponents = children.filter(
			c => c.constructor.name === "ToolExecutionComponent" || c.constructor.name === "ReadToolGroupComponent",
		);

		expect(userComponents.length).toBe(1);
		expect(assistantComponents.length).toBe(2);
		expect(toolComponents.length).toBe(1);

		// Verify parking the agent does not eject the focused view
		registry.setStatus("Worker", "parked");
		for (let i = 0; i < 5; i++) await Promise.resolve();
		expect(mode.focusedAgentId).toBe("Worker");
	});

	it("refuses to focus a parked subagent whose session file does not exist, keeping main view intact", async () => {
		if (!mode || !terminal || !mainSession || !subagentDir) throw new Error("not booted");

		const missingFilePath = path.join(subagentDir, "NonExistent.jsonl");
		const registry = AgentRegistry.global();
		registry.register({
			id: "MissingAgent",
			displayName: "MissingAgent",
			kind: "sub",
			parentId: MAIN_AGENT_ID,
			session: null,
			sessionFile: missingFilePath,
			status: "parked",
		});

		const settings = Settings.isolated({ "startup.quiet": true });
		AgentLifecycleManager.global().setPersistedSubagentReviverFactory(
			createPersistedSubagentReviverFactory({
				session: mainSession,
				authStorage: authStorage!,
				modelRegistry: mainSession.modelRegistry,
				settings,
				enableLsp: false,
			}),
			60_000,
		);

		await expect(mode.focusAgentSession("MissingAgent")).rejects.toThrow();
		expect(mode.focusedAgentId).toBeUndefined();
		expect(mode.viewSession).toBe(mainSession);
	});

	it("refuses to focus a parked subagent whose recorded working directory was deleted", async () => {
		if (!mode || !terminal || !mainSession || !subagentDir) throw new Error("not booted");

		const deletedSubDir = path.join(subagentDir, "deleted-worktree");
		await fs.mkdir(deletedSubDir, { recursive: true });
		const sessionFilePath = path.join(deletedSubDir, "DeletedCwdAgent.jsonl");
		const sessionLines = [
			JSON.stringify({
				type: "session",
				version: 3,
				id: "deleted-cwd-fixture",
				timestamp: "2026-01-01T00:00:00.000Z",
				cwd: deletedSubDir,
			}),
			JSON.stringify({
				type: "session_init",
				id: "init",
				parentId: null,
				timestamp: "2026-01-01T00:00:00.001Z",
				systemPrompt: "Synthetic fixture",
				tools: ["read"],
			}),
		];
		await fs.writeFile(sessionFilePath, `${sessionLines.join("\n")}\n`, "utf-8");

		// Delete the working directory
		await fs.rm(deletedSubDir, { recursive: true, force: true });

		const registry = AgentRegistry.global();
		registry.register({
			id: "DeletedCwdAgent",
			displayName: "DeletedCwdAgent",
			kind: "sub",
			parentId: MAIN_AGENT_ID,
			session: null,
			sessionFile: sessionFilePath,
			status: "parked",
		});

		const settings = Settings.isolated({ "startup.quiet": true });
		AgentLifecycleManager.global().setPersistedSubagentReviverFactory(
			createPersistedSubagentReviverFactory({
				session: mainSession,
				authStorage: authStorage!,
				modelRegistry: mainSession.modelRegistry,
				settings,
				enableLsp: false,
			}),
			60_000,
		);

		await expect(mode.focusAgentSession("DeletedCwdAgent")).rejects.toThrow();
		expect(mode.focusedAgentId).toBeUndefined();
		expect(mode.viewSession).toBe(mainSession);
	});

	it("refuses to focus a parked subagent with corrupted or truncated JSONL", async () => {
		if (!mode || !terminal || !mainSession || !subagentDir) throw new Error("not booted");

		const corruptFilePath = path.join(subagentDir, "Corrupt.jsonl");
		// Corrupted file missing session_init contract
		await fs.writeFile(
			corruptFilePath,
			`{"type":"session","version":3,"cwd":"${subagentDir}"}\n{"bad_json\n`,
			"utf-8",
		);

		const registry = AgentRegistry.global();
		registry.register({
			id: "CorruptAgent",
			displayName: "CorruptAgent",
			kind: "sub",
			parentId: MAIN_AGENT_ID,
			session: null,
			sessionFile: corruptFilePath,
			status: "parked",
		});

		const settings = Settings.isolated({ "startup.quiet": true });
		AgentLifecycleManager.global().setPersistedSubagentReviverFactory(
			createPersistedSubagentReviverFactory({
				session: mainSession,
				authStorage: authStorage!,
				modelRegistry: mainSession.modelRegistry,
				settings,
				enableLsp: false,
			}),
			60_000,
		);
		await expect(mode.focusAgentSession("CorruptAgent")).rejects.toThrow();
		expect(mode.focusedAgentId).toBeUndefined();
		expect(mode.viewSession).toBe(mainSession);
	});

	it("refuses to focus an agent belonging to a different conversation scope on the real interactive mode path", async () => {
		if (!mode || !terminal || !mainSession || !subagentDir) throw new Error("not booted");

		const registry = AgentRegistry.global();
		const mainScope = mainSession.sessionManager.getSessionId();
		registry.register({
			id: MAIN_AGENT_ID,
			displayName: "Main",
			kind: "main",
			session: mainSession,
			scope: mainScope,
		});

		// Register an agent belonging to another conversation
		registry.register({
			id: "ForeignMain",
			displayName: "ForeignMain",
			kind: "main",
			session: null,
			scope: "foreign-session-scope",
		});
		registry.register({
			id: "ForeignWorker",
			displayName: "ForeignWorker",
			kind: "sub",
			parentId: "ForeignMain",
			session: null,
			sessionFile: path.join(subagentDir, "foreign.jsonl"),
			status: "parked",
			scope: "foreign-session-scope",
		});

		await expect(mode.focusAgentSession("ForeignWorker")).rejects.toThrow(/different conversation/);
		expect(mode.focusedAgentId).toBeUndefined();
		expect(mode.viewSession).toBe(mainSession);
	});

	it("auto-unfocuses the real interactive mode to main session when the focused agent is removed from registry", async () => {
		if (!mode || !terminal || !mainSession || !subagentDir) throw new Error("not booted");

		// Create and register a live subagent session
		const subagentSession = new AgentSession({
			agent: new Agent({
				initialState: {
					model: mainSession.modelRegistry.find("anthropic", "claude-sonnet-4-5")!,
					systemPrompt: ["Sub"],
					tools: [],
					messages: [],
				},
			}),
			sessionManager: SessionManager.create(subagentDir, subagentDir),
			settings: Settings.isolated({ "startup.quiet": true }),
			modelRegistry: mainSession.modelRegistry,
		});

		const registry = AgentRegistry.global();
		registry.register({
			id: "LiveWorker",
			displayName: "LiveWorker",
			kind: "sub",
			parentId: MAIN_AGENT_ID,
			session: subagentSession,
			status: "running",
		});

		await mode.focusAgentSession("LiveWorker");
		expect(mode.focusedAgentId).toBe("LiveWorker");
		expect(mode.viewSession).toBe(subagentSession);

		// Remove the agent from registry (simulating close budget expiry or hard release)
		registry.unregister("LiveWorker");

		// Settle registry event and unfocus chain
		for (let i = 0; i < 5; i++) await Promise.resolve();
		await terminal.waitForRender();

		expect(mode.focusedAgentId).toBeUndefined();
		expect(mode.viewSession).toBe(mainSession);

		await subagentSession.dispose();
	});
});
