import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getBundledModel } from "@veyyon/catalog/models";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { Settings } from "@veyyon/coding-agent/config/settings";
import type { SettingPath } from "@veyyon/coding-agent/config/settings-schema";
import { type CreateAgentSessionOptions, createAgentSession, type ExtensionFactory } from "@veyyon/coding-agent/sdk";
import { SessionManager } from "@veyyon/coding-agent/session/session-manager";
import { removeSyncWithRetries, Snowflake } from "@veyyon/utils";
import { type } from "arktype";
import { isolatedAuthStorage } from "../helpers/isolated-auth-storage";

/**
 * Shared fixture for the tool-loading differential suite.
 *
 * The suite's whole value is that it drives the REAL `createAgentSession` boot path — the
 * same one the CLI uses — and freezes the ordered active tool list plus the discoverable
 * index it produces. Anything host-dependent in that outcome would make the frozen literals
 * a machine-specific accident, so this fixture pins every input that a developer's box could
 * otherwise vary (see `BASE_SETTINGS` and {@link HOST_DEPENDENT_TOOL_NAMES}).
 */

/**
 * Settings pinned on every matrix case so the frozen outcomes describe the CODE, not the box
 * the suite runs on.
 *
 * - `github.enabled` is already false by default, but `GithubTool.createIf` additionally
 *   probes for the `gh` CLI; pinning the setting keeps the tool absent either way.
 * - `generate_image.enabled` defaults TRUE and builds its tools from the live model registry,
 *   so leaving it on would make the outcome depend on which models happen to be cached.
 * - `speechgen`, `exa` and `checkpoint`/`inspect_image` are pinned to their off state so a
 *   future default flip is caught here as an explicit edit rather than a silent diff.
 */
export const BASE_SETTINGS = {
	"github.enabled": false,
	"generate_image.enabled": false,
	"speechgen.enabled": false,
	"exa.enabled": false,
	"checkpoint.enabled": false,
	"inspect_image.enabled": false,
	"memory.backend": "off",
	"autolearn.enabled": false,
	"argot.enabled": false,
} as const satisfies Partial<Record<SettingPath, unknown>>;

/**
 * Tools whose EXISTENCE is decided by probing the host, not by settings.
 *
 * `ssh` is built by `loadSshTool`, which returns null unless the machine has at least one
 * configured SSH host. A developer with `~/.ssh/config` entries would see it in every list and
 * a CI box would not. It is dropped from the captured outcome rather than pinned because there
 * is no setting that turns it off — see `local://tool-load-map.md` §6.
 */
export const HOST_DEPENDENT_TOOL_NAMES: Record<string, true> = { ssh: true };

/** The resolved outcome of one boot: what the model will actually be offered, and what it can find. */
export interface ToolLoadOutcome {
	/** Exact ordered active tool names, host-dependent entries removed. */
	active: string[];
	/** Discoverable-index contents as `source:name`, in the order the session returns them. */
	discoverable: string[];
}

export interface ToolLoadCase {
	name: string;
	settings?: Record<string, unknown>;
	toolNames?: string[];
	/** MCP-tool-selection entry appended to the session branch before boot (the "restored" input). */
	restoredSelection?: string[];
	extensions?: ExtensionFactory[];
}

/** An extension that registers `count` inert tools, used to push a session past the auto threshold. */
export function bulkToolExtension(count: number, prefix: string): ExtensionFactory {
	return pi => {
		for (let index = 0; index < count; index++) {
			pi.registerTool({
				name: `${prefix}_${index}`,
				label: `Bulk ${index}`,
				description: `Inert bulk tool ${index}.`,
				parameters: type({}),
				async execute() {
					return { content: [{ type: "text", text: "bulk" }] };
				},
			});
		}
	};
}

export class ToolLoadRunner {
	#tempDirs: string[] = [];
	#registryDir = "";
	#modelRegistry: ModelRegistry | undefined;

	async setup(): Promise<void> {
		this.#registryDir = path.join(os.tmpdir(), `pi-tool-loading-diff-auth-${Snowflake.next()}`);
		fs.mkdirSync(this.#registryDir, { recursive: true });
		this.#modelRegistry = new ModelRegistry(await isolatedAuthStorage(this.#registryDir));
	}

	teardown(): void {
		for (const dir of this.#tempDirs.splice(0)) removeSyncWithRetries(dir);
		if (this.#registryDir) removeSyncWithRetries(this.#registryDir);
		this.#registryDir = "";
	}

	#makeTempDir(): string {
		const tempDir = path.join(os.tmpdir(), `pi-tool-loading-diff-${Snowflake.next()}`);
		this.#tempDirs.push(tempDir);
		fs.mkdirSync(tempDir, { recursive: true });
		return tempDir;
	}

	async run(testCase: ToolLoadCase): Promise<ToolLoadOutcome> {
		const modelRegistry = this.#modelRegistry;
		if (!modelRegistry) throw new Error("ToolLoadRunner.setup() was not awaited");
		const tempDir = this.#makeTempDir();
		const sessionManager = SessionManager.inMemory();
		if (testCase.restoredSelection) {
			sessionManager.appendMCPToolSelection(testCase.restoredSelection);
		}
		const options: CreateAgentSessionOptions = {
			cwd: tempDir,
			agentDir: tempDir,
			modelRegistry,
			sessionManager,
			settings: Settings.isolated({ ...BASE_SETTINGS, ...testCase.settings }),
			model: getBundledModel("openai", "gpt-4o-mini"),
			disableExtensionDiscovery: true,
			extensions: testCase.extensions,
			toolNames: testCase.toolNames,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			rules: [],
			workspaceTree: { rootPath: tempDir, rendered: "", truncated: false, totalLines: 0, agentsMdFiles: [] },
		};
		const { session } = await createAgentSession(options);
		try {
			return {
				active: session.getActiveToolNames().filter(name => !HOST_DEPENDENT_TOOL_NAMES[name]),
				discoverable: session
					.getDiscoverableTools()
					.filter(tool => !HOST_DEPENDENT_TOOL_NAMES[tool.name])
					.map(tool => `${tool.source}:${tool.name}`),
			};
		} finally {
			await session.dispose();
		}
	}
}

/**
 * The matrix. Every cell names one input the loading rules read; together they cover
 * `tools.discoveryMode` (all four values), `tools.essentialOverride` (empty and not),
 * a per-tool enable flag, an `eval` backend toggle, a harness-profile tool allowlist, an
 * explicit `toolNames` request, a restored selection, a `forceActive` trigger, and tool
 * counts on both sides of the 40-tool auto threshold.
 *
 * Cells are earned, not guessed: each one was added because a deliberate mutation of the
 * rule it covers survived the suite. Adding a rule to `tools/loading/policy.ts` without a
 * cell here means the rule is unprotected.
 */
export const TOOL_LOAD_CASES: readonly ToolLoadCase[] = [
	{ name: "discovery-auto-under-threshold" },
	{ name: "discovery-off", settings: { "tools.discoveryMode": "off" } },
	{ name: "discovery-mcp-only", settings: { "tools.discoveryMode": "mcp-only" } },
	{ name: "discovery-all", settings: { "tools.discoveryMode": "all" } },
	{
		name: "discovery-all-essential-override",
		settings: { "tools.discoveryMode": "all", "tools.essentialOverride": ["read", "grep"] },
	},
	{ name: "browser-disabled", settings: { "browser.enabled": false } },
	{
		name: "browser-disabled-discovery-all",
		settings: { "tools.discoveryMode": "all", "browser.enabled": false },
	},
	{ name: "explicit-tool-names", toolNames: ["read", "grep", "glob"] },
	{
		name: "explicit-tool-names-discovery-all",
		settings: { "tools.discoveryMode": "all" },
		toolNames: ["read", "grep", "glob"],
	},
	// Both default-true backends off; `eval.rb` / `eval.jl` default false, so no backend is
	// allowed and the tool must not exist. Covers `resolveEvalToolAvailability`.
	{ name: "eval-backends-disabled", settings: { "eval.py": false, "eval.js": false } },
	// Harness profile allowlist keyed to the fixture model. Covers the pipeline's final stage.
	{
		name: "harness-profile-tool-allowlist",
		settings: { "harness.profiles": { "openai/gpt-4o-mini": { tools: ["read", "grep", "todo"] } } },
	},
	{
		name: "restored-selection-discovery-all",
		settings: { "tools.discoveryMode": "all" },
		restoredSelection: ["browser", "todo"],
	},
	{
		name: "force-active-todo-discovery-all",
		settings: { "tools.discoveryMode": "all", "todo.eager": "always" },
	},
	{
		name: "delegation-off-discovery-all",
		settings: { "tools.discoveryMode": "all", "subagent.delegation": "off" },
	},
	// 17 and 18 straddle the boundary exactly: the fixture registry holds 23 non-`search_tool_bm25`
	// tools, so 23+17 = 40 is NOT "> TOOL_DISCOVERY_AUTO_THRESHOLD" and 23+18 = 41 is. The count was
	// 24 while `browser` shipped on by default; the straddle is arithmetic on the active tool count,
	// so a tool leaving the default set moves it and both counts step up to keep the boundary here.
	{ name: "auto-at-threshold", extensions: [bulkToolExtension(17, "bulk")] },
	{ name: "auto-over-threshold", extensions: [bulkToolExtension(18, "bulk")] },
];
