/**
 * Veyyon extension-package sub-discovery provider.
 *
 * When a user configures an extension via `extensions:` (in settings) or
 * `--extension`/`-e` (on the CLI), the docs promise that the package's
 * sibling directories — `skills/`, `hooks/pre|post/`, `tools/`, `commands/`,
 * `rules/`, `prompts/`, and `.mcp.json` — are picked up by veyyon's standard
 * discovery surfaces. The native `veyyon` provider in `builtin.ts` only walks
 * `.veyyon/` and `~/.veyyon/profiles/default/agent/`, so without this provider those sub-trees are
 * silently ignored.
 *
 * Provider priority is set below the native `veyyon` provider (100) so an
 * extension package never shadows the user's own `.veyyon/` configuration on
 * dedup.
 *
 * @see ./veyyon-extension-roots.ts
 * @see ../../docs/internal/extension-loading.md
 */

import * as path from "node:path";
import { isRecord, logger, tryParseJson } from "@veyyon/utils";
import { registerProvider } from "./capability";
import { readFile } from "./capability/fs";
import { type Hook, hookCapability } from "./capability/hook";
import { type MCPServer, mcpCapability } from "./capability/mcp";
import { type Prompt, promptCapability } from "./capability/prompt";
import { type Rule, ruleCapability } from "./capability/rule";
import { type DiscoveredSkill, skillCapability } from "./capability/skill";
import { type SlashCommand, slashCommandCapability } from "./capability/slash-command";
import { type DiscoveredCustomTool, toolCapability } from "./capability/tool";
import type { LoadContext, LoadResult } from "./capability/types";
import {
	createSourceMeta,
	loadCommandDirs,
	loadCustomToolDirs,
	loadFilesFromDir,
	loadPromptDirs,
	loadRuleDirs,
	mergeLoadResults,
	type ScopedConfigDir,
	scanSkillsFromDir,
} from "./helpers";
import { resolvePluginStdioPaths } from "./substitute-plugin-root";
import { listVeyyonExtensionRoots, type VeyyonExtensionRoot } from "./veyyon-extension-roots";

// Provider id is persisted in user settings (`disabledProviders`).
export const PROVIDER_ID = "veyyon-plugins";
const DISPLAY_NAME = "Extension Packages";
const DESCRIPTION =
	"Sub-discovery (skills, hooks, tools, commands, rules, prompts, .mcp.json) inside extension packages";
const PRIORITY = 90;

// =============================================================================
// Skills
// =============================================================================

async function loadSkills(ctx: LoadContext): Promise<LoadResult<DiscoveredSkill>> {
	const roots = await listVeyyonExtensionRoots(ctx, { agentDir: ctx.agentDir });
	const results = await Promise.all(
		roots.map(root =>
			scanSkillsFromDir({
				dir: path.join(root.path, "skills"),
				providerId: PROVIDER_ID,
				level: root.level,
				requireDescription: true,
			}),
		),
	);
	return mergeLoadResults(results);
}

/** Every extension package root as a config directory at the root's own scope. */
async function extensionConfigDirs(ctx: LoadContext): Promise<ScopedConfigDir[]> {
	const roots = await listVeyyonExtensionRoots(ctx, { agentDir: ctx.agentDir });
	return roots.map(root => ({ dir: root.path, level: root.level }));
}

// =============================================================================
// Hooks
// =============================================================================

const HOOK_TYPES: ReadonlyArray<"pre" | "post"> = ["pre", "post"];

async function loadHooks(ctx: LoadContext): Promise<LoadResult<Hook>> {
	const roots = await listVeyyonExtensionRoots(ctx, { agentDir: ctx.agentDir });
	const tasks: Array<{ root: VeyyonExtensionRoot; hookType: "pre" | "post" }> = [];
	for (const root of roots) {
		for (const hookType of HOOK_TYPES) {
			tasks.push({ root, hookType });
		}
	}
	const results = await Promise.all(
		tasks.map(({ root, hookType }) =>
			loadFilesFromDir<Hook>(path.join(root.path, "hooks", hookType), PROVIDER_ID, root.level, {
				transform: (name, _content, filePath, source) => {
					const baseName = name.includes(".") ? name.slice(0, name.lastIndexOf(".")) : name;
					const tool = baseName === "*" ? "*" : baseName;
					return {
						name,
						path: filePath,
						type: hookType,
						tool,
						level: root.level,
						_source: source,
					};
				},
			}),
		),
	);
	return mergeLoadResults(results);
}

// =============================================================================
// MCP Servers
// =============================================================================

const MCP_FILENAMES = [".mcp.json", "mcp.json"] as const;

interface RawMcpServer {
	enabled?: boolean;
	timeout?: number;
	command?: string;
	args?: string[];
	env?: Record<string, string>;
	cwd?: string;
	url?: string;
	headers?: Record<string, string>;
	auth?: MCPServer["auth"];
	oauth?: MCPServer["oauth"];
	type?: MCPServer["transport"];
}

async function loadMCPServers(ctx: LoadContext): Promise<LoadResult<MCPServer>> {
	const roots = await listVeyyonExtensionRoots(ctx, { agentDir: ctx.agentDir });
	const items: MCPServer[] = [];
	const warnings: string[] = [];

	const tasks: Array<{ root: VeyyonExtensionRoot; mcpPath: string }> = [];
	for (const root of roots) {
		for (const filename of MCP_FILENAMES) {
			tasks.push({ root, mcpPath: path.join(root.path, filename) });
		}
	}
	const contents = await Promise.all(tasks.map(({ mcpPath }) => readFile(mcpPath)));

	for (let i = 0; i < tasks.length; i++) {
		const raw = contents[i];
		if (raw === null) continue;
		const { root, mcpPath } = tasks[i];

		const parsed = tryParseJson<{ mcpServers?: Record<string, unknown> }>(raw);
		if (!parsed) {
			warnings.push(`[veyyon-plugins] Invalid JSON in ${mcpPath}`);
			logger.warn(`[veyyon-plugins] Invalid JSON in ${mcpPath}`);
			continue;
		}
		const servers = parsed.mcpServers;
		if (!isRecord(servers)) continue;

		for (const [serverName, serverCfg] of Object.entries(servers)) {
			if (!isRecord(serverCfg)) continue;
			const cfg = serverCfg as RawMcpServer;
			if (typeof cfg.command !== "string" && typeof cfg.url !== "string") {
				warnings.push(`[veyyon-plugins] Skipping MCP server "${serverName}" in ${mcpPath}: missing command or url`);
				continue;
			}
			// Root relative command/cwd at the plugin's config directory, not the
			// session cwd (MCP stdio spawning resolves relative values there).
			const rooted = resolvePluginStdioPaths({ command: cfg.command, cwd: cfg.cwd }, root.path);
			items.push({
				name: serverName,
				...(cfg.enabled !== undefined && { enabled: cfg.enabled }),
				...(cfg.timeout !== undefined && { timeout: cfg.timeout }),
				...(rooted.command !== undefined && { command: rooted.command }),
				...(cfg.args !== undefined && { args: cfg.args }),
				...(cfg.env !== undefined && { env: cfg.env }),
				...(rooted.cwd !== undefined && { cwd: rooted.cwd }),
				...(cfg.url !== undefined && { url: cfg.url }),
				...(cfg.headers !== undefined && { headers: cfg.headers }),
				...(cfg.auth !== undefined && { auth: cfg.auth }),
				...(cfg.oauth !== undefined && { oauth: cfg.oauth }),
				...(cfg.type !== undefined && { transport: cfg.type }),
				_source: createSourceMeta(PROVIDER_ID, mcpPath, root.level),
			});
		}
	}

	return { items, warnings };
}

// =============================================================================
// Provider Registration
// =============================================================================

registerProvider<DiscoveredSkill>(skillCapability.id, {
	id: PROVIDER_ID,
	displayName: DISPLAY_NAME,
	description: DESCRIPTION,
	priority: PRIORITY,
	load: loadSkills,
});

registerProvider<SlashCommand>(slashCommandCapability.id, {
	id: PROVIDER_ID,
	displayName: DISPLAY_NAME,
	description: DESCRIPTION,
	priority: PRIORITY,
	load: async ctx => loadCommandDirs(await extensionConfigDirs(ctx), PROVIDER_ID),
});

registerProvider<Rule>(ruleCapability.id, {
	id: PROVIDER_ID,
	displayName: DISPLAY_NAME,
	description: DESCRIPTION,
	priority: PRIORITY,
	load: async ctx => loadRuleDirs(await extensionConfigDirs(ctx), PROVIDER_ID),
});

registerProvider<Prompt>(promptCapability.id, {
	id: PROVIDER_ID,
	displayName: DISPLAY_NAME,
	description: DESCRIPTION,
	priority: PRIORITY,
	load: async ctx => loadPromptDirs(await extensionConfigDirs(ctx), PROVIDER_ID),
});

registerProvider<Hook>(hookCapability.id, {
	id: PROVIDER_ID,
	displayName: DISPLAY_NAME,
	description: DESCRIPTION,
	priority: PRIORITY,
	load: loadHooks,
});

registerProvider<DiscoveredCustomTool>(toolCapability.id, {
	id: PROVIDER_ID,
	displayName: DISPLAY_NAME,
	description: DESCRIPTION,
	priority: PRIORITY,
	load: async ctx => loadCustomToolDirs(await extensionConfigDirs(ctx), PROVIDER_ID),
});

registerProvider<MCPServer>(mcpCapability.id, {
	id: PROVIDER_ID,
	displayName: DISPLAY_NAME,
	description: DESCRIPTION,
	priority: PRIORITY,
	load: loadMCPServers,
});
