import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ThinkingLevel } from "@veyyon/agent-core";
import { AuthStorage, Effort, type Model } from "@veyyon/ai";
import { buildModel } from "@veyyon/catalog/build";
import { getBundledModel } from "@veyyon/catalog/models";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { Settings } from "@veyyon/coding-agent/config/settings";
import type { CustomTool } from "@veyyon/coding-agent/extensibility/custom-tools/types";
import { createAgentSession } from "@veyyon/coding-agent/sdk";
import { SessionManager } from "@veyyon/coding-agent/session/session-manager";
import { TOOL_DISCOVERY_AUTO_THRESHOLD } from "@veyyon/coding-agent/tool-discovery/mode";
import { removeSyncWithRetries, Snowflake } from "@veyyon/utils";
import { type } from "arktype";

function createMcpCustomTool(name: string, serverName: string, mcpToolName: string): CustomTool {
	return {
		name,
		label: `${serverName}/${mcpToolName}`,
		description: `Tool ${mcpToolName} from ${serverName}`,
		mcpServerName: serverName,
		mcpToolName,
		parameters: type({ query: "string" }),
		async execute() {
			return { content: [{ type: "text", text: `${name} executed` }] };
		},
	} as CustomTool;
}

function createReasoningModel(): Model<"openai-responses"> {
	return buildModel({
		id: "mock-reasoning",
		name: "mock-reasoning",
		api: "openai-responses",
		provider: "openai",
		baseUrl: "https://example.invalid",
		reasoning: true,
		thinking: { mode: "effort", efforts: [Effort.Medium, Effort.High] },
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 8192,
		maxTokens: 2048,
	});
}

const oldSessionMtime = new Date("2000-01-01T00:00:00.000Z");

describe("createAgentSession MCP discovery prompt gating", () => {
	let tempDir: string;
	let registryDir: string;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;

	// Immutable across tests: ModelRegistry's constructor eagerly loads the bundled
	// model catalog (~120ms). The tests pass models explicitly and never mutate the
	// registry (refreshInBackground is skipped when modelRegistry is supplied, and
	// extension source sync is empty under disableExtensionDiscovery), so build it once.
	beforeAll(async () => {
		registryDir = path.join(os.tmpdir(), `pi-sdk-mcp-discovery-registry-${Snowflake.next()}`);
		fs.mkdirSync(registryDir, { recursive: true });
		authStorage = await AuthStorage.create(path.join(registryDir, "auth.db"));
		modelRegistry = new ModelRegistry(authStorage);
	});

	afterAll(() => {
		authStorage.close();
		if (registryDir && fs.existsSync(registryDir)) {
			removeSyncWithRetries(registryDir);
		}
	});

	beforeEach(() => {
		tempDir = path.join(os.tmpdir(), `pi-sdk-mcp-discovery-${Snowflake.next()}`);
		fs.mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		if (tempDir && fs.existsSync(tempDir)) {
			removeSyncWithRetries(tempDir);
		}
	});

	it("does not advertise MCP discovery when search_tool_bm25 is not active", async () => {
		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			modelRegistry,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "mcp.discoveryMode": true }),
			model: getBundledModel("openai", "gpt-4o-mini"),
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			toolNames: ["read"],
			customTools: [createMcpCustomTool("mcp__github_create_issue", "github", "create_issue")],
		});

		expect(session.systemPrompt.join("\n")).not.toContain("### MCP tool discovery");
		expect(session.systemPrompt.join("\n")).not.toContain(
			"call `search_tool_bm25` before concluding no such tool exists",
		);
	});

	it("default auto discovery hides MCP tools once the total tool set is too large", async () => {
		const mcpTools = Array.from({ length: TOOL_DISCOVERY_AUTO_THRESHOLD + 1 }, (_, index) =>
			createMcpCustomTool(`mcp__auto_tool_${index}`, "auto", `tool_${index}`),
		);
		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			modelRegistry,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({}),
			model: getBundledModel("openai", "gpt-4o-mini"),
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			customTools: mcpTools,
		});

		const activeNames = session.getActiveToolNames();
		expect(session.isToolDiscoveryEnabled()).toBe(true);
		expect(activeNames).toContain("search_tool_bm25");
		expect(activeNames).not.toContain("mcp__auto_tool_0");
		expect(session.getDiscoverableTools({ source: "mcp" })).toHaveLength(TOOL_DISCOVERY_AUTO_THRESHOLD + 1);
	});

	/**
	 * The other side of the threshold from the case above: a catalog that stays
	 * under it buys no discovery turn at all. `auto` resolves to `mcp-only` only
	 * once the tool count exceeds `TOOL_DISCOVERY_AUTO_THRESHOLD`
	 * (`resolveToolDiscoveryMode`), so one MCP tool leaves the session exactly as
	 * it would be with no MCP at all: every built-in directly callable, the MCP
	 * tool directly callable beside them, and no `search_tool_bm25` spending
	 * tokens to index 21 tools the model can already see.
	 *
	 * This replaces assertions that had it backwards — that default `auto` strips
	 * built-in schemas for any catalog size. Nothing implements that: `auto` is
	 * gated on the count, and the mode it escalates to is `mcp-only`, which hides
	 * MCP tools rather than built-ins.
	 */
	it("leaves a small MCP catalog and every built-in directly callable, with no discovery turn", async () => {
		const mcpTool = createMcpCustomTool("mcp__small_echo", "small", "echo");
		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			modelRegistry,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({}),
			model: getBundledModel("openai", "gpt-4o-mini"),
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			customTools: [mcpTool],
		});

		const activeNames = session.getActiveToolNames();
		expect(session.isToolDiscoveryEnabled()).toBe(false);
		expect(activeNames).not.toContain("search_tool_bm25");
		expect(activeNames).toContain("mcp__small_echo");
		// The built-ins this session is entitled to are all directly callable. `browser` is NOT
		// one of them and never was: `browser.enabled` defaults off, so quoting it here measured
		// its own switch instead of discovery. The second session below is the control that
		// separates the two, and these names are the ones the permission table admits with the
		// default settings this session was built with.
		for (const name of ["read", "bash", "edit", "grep", "glob", "task", "todo", "web_search"]) {
			expect(activeNames, `${name} is entitled and must be directly callable`).toContain(name);
		}
		expect(activeNames).not.toContain("browser");
		expect(session.getDiscoverableTools({ source: "builtin" })).toEqual([]);
		expect(session.getDiscoverableTools({ source: "mcp" })).toEqual([]);
		await session.dispose();

		// Same catalog, `browser.enabled` on: the tool appears and discovery still stays off. So
		// the absence above is owned by the setting, and no built-in is being withheld for a
		// discovery turn that this session does not have.
		const { session: withBrowser } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			modelRegistry,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "browser.enabled": true }),
			model: getBundledModel("openai", "gpt-4o-mini"),
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			customTools: [mcpTool],
		});
		expect(withBrowser.getActiveToolNames()).toContain("browser");
		expect(withBrowser.isToolDiscoveryEnabled()).toBe(false);
		await withBrowser.dispose();
	});

	it("advertises discovery guidance for builtin-only tools.discoveryMode all sessions", async () => {
		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			modelRegistry,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "tools.discoveryMode": "all" }),
			model: getBundledModel("openai", "gpt-4o-mini"),
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
		});

		const prompt = session.systemPrompt.join("\n");
		const searchTool = session.agent.state.tools.find(tool => tool.name === "search_tool_bm25");
		expect(session.getActiveToolNames()).not.toContain("search");
		expect(prompt).toContain("call `search_tool_bm25` before concluding no such tool exists");
		expect(searchTool?.description).toContain("Total discoverable tools available:");
	});

	/**
	 * Opens a discovery-all session at one delegation strength and reports both halves of the
	 * question, because they have to agree: whether `task` is in the request, and whether the prompt
	 * tells the model to delegate. A prompt that teaches delegation to a session with no task tool
	 * asks for a call that cannot be made, and a task tool the prompt never mentions is a tool slot
	 * paid for and hidden. Under `tools.discoveryMode: all` the two are decided in the same place,
	 * `filterInitialToolsForDiscoveryAll` and the `forceActive` set feeding it, so they are asserted
	 * together rather than in two tests that could pass while disagreeing.
	 */
	async function delegationUnderDiscoveryAll(
		delegation: "allowed" | "preferred" | "required",
	): Promise<{ tools: string[]; teachesDelegation: boolean }> {
		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			modelRegistry,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "tools.discoveryMode": "all", "subagent.delegation": delegation }),
			model: getBundledModel("openai", "gpt-4o-mini"),
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
		});
		try {
			return {
				tools: session.getActiveToolNames(),
				teachesDelegation: session.systemPrompt.join("\n").includes("## Delegation gates:"),
			};
		} finally {
			await session.dispose();
		}
	}

	it("exposes task under tools.discoveryMode all when delegation is preferred", async () => {
		const { tools, teachesDelegation } = await delegationUnderDiscoveryAll("preferred");

		expect(tools).toContain("task");
		expect(teachesDelegation).toBe(true);
	});

	/**
	 * `required` is the strength that cannot survive a hidden task tool: it tells the model to
	 * delegate, so a request without the tool makes the instruction unfollowable.
	 */
	it("exposes task under tools.discoveryMode all when delegation is required", async () => {
		const { tools, teachesDelegation } = await delegationUnderDiscoveryAll("required");

		expect(tools).toContain("task");
		expect(teachesDelegation).toBe(true);
	});

	/**
	 * `allowed` is the floor: delegation is offered, never asked for. Under discovery-all that makes
	 * `task` an ordinary non-essential discoverable built-in, hidden from the initial request and
	 * reachable through `search_tool_bm25`, and the prompt drops the delegation gates with it.
	 *
	 * This test USED to omit the setting and rely on the default being `allowed`. The default is
	 * `preferred` (`settings-domains/subagents.ts`), so it was silently a duplicate of the preferred
	 * case and failed for the right reason: `task` was correctly present. The strength is named
	 * explicitly here, which is the only way this test exercises the floor at all, and it stays
	 * correct if the default moves again.
	 */
	it("hides task under tools.discoveryMode all when delegation is merely allowed", async () => {
		const { tools, teachesDelegation } = await delegationUnderDiscoveryAll("allowed");

		expect(tools).not.toContain("task");
		expect(teachesDelegation).toBe(false);
	});

	/**
	 * The floor still keeps the essential built-ins, so the assertion above is about `task` and not
	 * about discovery-all having emptied the request.
	 */
	it("keeps the essential built-ins active at the delegation floor under discovery-all", async () => {
		const { tools } = await delegationUnderDiscoveryAll("allowed");

		expect(tools).toEqual(expect.arrayContaining(["read", "bash", "edit", "write", "search_tool_bm25"]));
	});

	it("preserves explicitly requested MCP tools in discovery mode", async () => {
		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			modelRegistry,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "mcp.discoveryMode": true }),
			model: getBundledModel("openai", "gpt-4o-mini"),
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			toolNames: ["read", "mcp__github_create_issue", "search_tool_bm25"],
			customTools: [
				createMcpCustomTool("mcp__github_create_issue", "github", "create_issue"),
				createMcpCustomTool("mcp__slack_post_message", "slack", "post_message"),
			],
		});

		expect(session.getActiveToolNames()).toContain("mcp__github_create_issue");
		expect(session.getSelectedMCPToolNames()).toEqual(["mcp__github_create_issue"]);
		expect(session.systemPrompt.join("\n")).not.toContain("mcp__github_create_issue");

		await session.activateDiscoveredMCPTools(["mcp__slack_post_message"]);

		expect(session.getActiveToolNames()).toEqual(
			expect.arrayContaining(["read", "search_tool_bm25", "mcp__github_create_issue", "mcp__slack_post_message"]),
		);
		expect(session.getSelectedMCPToolNames()).toEqual(["mcp__github_create_issue", "mcp__slack_post_message"]);
	});

	it("keeps configured discovery default servers visible in discovery mode", async () => {
		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			modelRegistry,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({
				"mcp.discoveryMode": true,
				"mcp.discoveryDefaultServers": ["github", "missing"],
			}),
			model: getBundledModel("openai", "gpt-4o-mini"),
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			toolNames: ["read", "search_tool_bm25"],
			customTools: [
				createMcpCustomTool("mcp__github_create_issue", "github", "create_issue"),
				createMcpCustomTool("mcp__slack_post_message", "slack", "post_message"),
			],
		});
		try {
			expect(session.getSelectedMCPToolNames()).toEqual(["mcp__github_create_issue"]);
			expect(session.getActiveToolNames()).toEqual(
				expect.arrayContaining(["read", "search_tool_bm25", "mcp__github_create_issue"]),
			);
			expect(session.getActiveToolNames()).not.toContain("mcp__slack_post_message");
		} finally {
			await session.dispose();
		}
	});

	it("builds search_tool_bm25 descriptions from the loaded MCP catalog", async () => {
		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			modelRegistry,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "mcp.discoveryMode": true }),
			model: getBundledModel("openai", "gpt-4o-mini"),
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			toolNames: ["read", "search_tool_bm25"],
			customTools: [createMcpCustomTool("mcp__github_create_issue", "github", "create_issue")],
		});

		const searchTool = session.agent.state.tools.find(tool => tool.name === "search_tool_bm25");
		expect(searchTool?.description).toContain("Total discoverable tools available: 1.");
		expect(searchTool?.description).toContain("Discoverable MCP servers in this session: github (1 tool).");
	});

	it("prunes deactivated builtin discoveries so they can be rediscovered", async () => {
		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			modelRegistry,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "tools.discoveryMode": "all" }),
			model: getBundledModel("openai", "gpt-4o-mini"),
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
		});

		expect(await session.activateDiscoveredTools(["grep"])).toEqual(["grep"]);
		expect(session.getSelectedDiscoveredToolNames()).toContain("grep");

		await session.setActiveToolsByName(["read", "search_tool_bm25"]);

		expect(session.getActiveToolNames()).not.toContain("grep");
		expect(session.getSelectedDiscoveredToolNames()).not.toContain("grep");
		expect(await session.activateDiscoveredTools(["grep"])).toEqual(["grep"]);
		expect(session.getActiveToolNames()).toContain("grep");
	});
	it("restores explicit MCP, thinking, and service-tier entries when resuming without rewriting the session file", async () => {
		const firstManager = SessionManager.create(tempDir, tempDir);
		const { session: firstSession } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			modelRegistry,
			sessionManager: firstManager,
			settings: Settings.isolated({
				"mcp.discoveryMode": true,
				defaultThinkingLevel: "high",
				"tier.openai": "priority",
			}),
			model: createReasoningModel(),
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			toolNames: ["read", "search_tool_bm25"],
			customTools: [
				createMcpCustomTool("mcp__github_create_issue", "github", "create_issue"),
				createMcpCustomTool("mcp__slack_post_message", "slack", "post_message"),
			],
		});
		await firstSession.activateDiscoveredMCPTools(["mcp__slack_post_message"]);
		firstSession.sessionManager.appendThinkingLevelChange(ThinkingLevel.Off);
		firstSession.sessionManager.appendServiceTierChange({ openai: "priority" });
		expect(firstSession.sessionManager.buildSessionContext().thinkingLevel).toBe(ThinkingLevel.Off);
		expect(firstSession.getSelectedMCPToolNames()).toEqual(["mcp__slack_post_message"]);
		const sessionFile = firstSession.sessionFile;
		expect(sessionFile).toBeDefined();
		await firstSession.sessionManager.rewriteEntries();
		fs.utimesSync(sessionFile!, oldSessionMtime, oldSessionMtime);
		const persistedBeforeResume = fs.readFileSync(sessionFile!, "utf8");
		const persistedMtimeBeforeResume = fs.statSync(sessionFile!).mtimeMs;
		await firstSession.dispose();
		const resumedManager = await SessionManager.open(sessionFile!, tempDir);
		const { session: resumedSession } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			modelRegistry,
			sessionManager: resumedManager,
			settings: Settings.isolated({
				"mcp.discoveryMode": true,
				defaultThinkingLevel: "high",
				"tier.openai": "none",
			}),
			model: createReasoningModel(),
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			toolNames: ["read", "search_tool_bm25"],
			customTools: [
				createMcpCustomTool("mcp__github_create_issue", "github", "create_issue"),
				createMcpCustomTool("mcp__slack_post_message", "slack", "post_message"),
			],
		});
		try {
			expect(resumedSession.thinkingLevel).toBe(ThinkingLevel.Off);
			expect(resumedSession.serviceTierByFamily).toEqual({ openai: "priority" });
			expect(resumedSession.getSelectedMCPToolNames()).toEqual(["mcp__slack_post_message"]);
			expect(resumedSession.getActiveToolNames()).toEqual(
				expect.arrayContaining(["read", "search_tool_bm25", "mcp__slack_post_message"]),
			);
			expect(resumedSession.systemPrompt.join("\n")).not.toContain("mcp__slack_post_message");
			expect(fs.readFileSync(sessionFile!, "utf8")).toBe(persistedBeforeResume);
			expect(fs.statSync(sessionFile!).mtimeMs).toBe(persistedMtimeBeforeResume);
		} finally {
			await resumedSession.dispose();
		}
	});

	it("restores fallback MCP, thinking, and service-tier state in memory without rewriting the session file", async () => {
		const sessionManager = SessionManager.create(tempDir, tempDir);
		sessionManager.appendMessage({
			role: "user",
			content: "resume me",
			timestamp: Date.now(),
		});
		const sessionFile = sessionManager.getSessionFile();
		expect(sessionFile).toBeDefined();
		await sessionManager.rewriteEntries();
		fs.utimesSync(sessionFile!, oldSessionMtime, oldSessionMtime);
		const persistedBeforeResume = fs.readFileSync(sessionFile!, "utf8");
		const persistedMtimeBeforeResume = fs.statSync(sessionFile!).mtimeMs;
		const resumedManager = await SessionManager.open(sessionFile!, tempDir);
		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			modelRegistry,
			sessionManager: resumedManager,
			settings: Settings.isolated({
				"mcp.discoveryMode": true,
				"mcp.discoveryDefaultServers": ["github"],
				defaultThinkingLevel: "high",
				"tier.openai": "priority",
			}),
			model: createReasoningModel(),
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			toolNames: ["read", "search_tool_bm25"],
			customTools: [
				createMcpCustomTool("mcp__github_create_issue", "github", "create_issue"),
				createMcpCustomTool("mcp__slack_post_message", "slack", "post_message"),
			],
		});
		try {
			expect(session.thinkingLevel).toBe(ThinkingLevel.High);
			expect(session.serviceTierByFamily).toEqual({ openai: "priority" });
			expect(session.getSelectedMCPToolNames()).toEqual(["mcp__github_create_issue"]);
			expect(session.getActiveToolNames()).toEqual(
				expect.arrayContaining(["read", "search_tool_bm25", "mcp__github_create_issue"]),
			);
			expect(session.sessionManager.buildSessionContext().hasPersistedMCPToolSelection).toBe(false);
			expect(fs.readFileSync(sessionFile!, "utf8")).toBe(persistedBeforeResume);
			expect(fs.statSync(sessionFile!).mtimeMs).toBe(persistedMtimeBeforeResume);
		} finally {
			await session.dispose();
		}
	});

	it("keeps a cleared MCP selection empty when resuming with explicitly requested MCP tools", async () => {
		const firstManager = SessionManager.create(tempDir, tempDir);
		const { session: firstSession } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			modelRegistry,
			sessionManager: firstManager,
			settings: Settings.isolated({ "mcp.discoveryMode": true }),
			model: getBundledModel("openai", "gpt-4o-mini"),
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			toolNames: ["read", "search_tool_bm25", "mcp__github_create_issue"],
			customTools: [
				createMcpCustomTool("mcp__github_create_issue", "github", "create_issue"),
				createMcpCustomTool("mcp__slack_post_message", "slack", "post_message"),
			],
		});
		await firstSession.setActiveToolsByName(["read", "search_tool_bm25"]);
		expect(firstSession.getSelectedMCPToolNames()).toEqual([]);
		const sessionFile = firstSession.sessionFile;
		expect(sessionFile).toBeDefined();
		await firstSession.sessionManager.rewriteEntries();
		await firstSession.dispose();

		const resumedManager = await SessionManager.open(sessionFile!, tempDir);
		const { session: resumedSession } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			modelRegistry,
			sessionManager: resumedManager,
			settings: Settings.isolated({ "mcp.discoveryMode": true }),
			model: getBundledModel("openai", "gpt-4o-mini"),
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			toolNames: ["read", "search_tool_bm25", "mcp__github_create_issue"],
			customTools: [
				createMcpCustomTool("mcp__github_create_issue", "github", "create_issue"),
				createMcpCustomTool("mcp__slack_post_message", "slack", "post_message"),
			],
		});
		try {
			expect(resumedSession.getSelectedMCPToolNames()).toEqual([]);
			expect(resumedSession.getActiveToolNames()).toEqual(expect.arrayContaining(["read", "search_tool_bm25"]));
			expect(resumedSession.getActiveToolNames()).not.toContain("mcp__github_create_issue");
		} finally {
			await resumedSession.dispose();
		}
	});
});
