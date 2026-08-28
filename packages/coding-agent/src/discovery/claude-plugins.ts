/** Claude Code Marketplace Plugin Provider Loads configuration from ~/.claude/plugins/cache/ based on installed_plugins.json registry. */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { errorMessage, getAgentDir, isEnoent, isRecord, logger } from "@veyyon/utils";
import { registerProvider } from "../capability";
import { readFile } from "../capability/fs";
import { type Hook, hookCapability } from "../capability/hook";
import { type MCPServer, mcpCapability } from "../capability/mcp";
import { type DiscoveredSkill, skillCapability } from "../capability/skill";
import { type SlashCommand, slashCommandCapability } from "../capability/slash-command";
import { type DiscoveredCustomTool, toolCapability } from "../capability/tool";
import type { LoadContext, LoadResult } from "../capability/types";
import { expandEnvVarsDeep, unresolvedRefusedDownstream, warnUnresolved } from "./env-expansion";
import {
	type ClaudePluginRoot,
	createSourceMeta,
	listClaudePluginRoots,
	loadFilesFromDir,
	pluginsRootFor,
	scanSkillsFromDir,
} from "./helpers";

import { resolvePluginStdioPaths, substitutePluginRoot } from "./substitute-plugin-root";

const PROVIDER_ID = "claude-plugins";
const DISPLAY_NAME = "Claude Code Marketplace";
const PRIORITY = 70; // Below claude.ts (80) so user .claude/ overrides win

interface ClaudePluginManifest {
	skills?: string | string[];
	"slash-commands"?: string | string[];
	commands?: string | string[];
}

interface ResolvedPluginDir {
	dirs: string[];
	warnings: string[];
}

async function readPluginManifest(root: ClaudePluginRoot, warnings?: string[]): Promise<ClaudePluginManifest | null> {
	const manifestPath = path.join(root.path, ".claude-plugin", "plugin.json");
	const raw = await readFile(manifestPath);
	if (raw === null) return null; // manifest absent — plugin uses default dirs

	try {
		const parsed = JSON.parse(raw);
		if (!isRecord(parsed)) {
			// The file exists and parses but is not a JSON object (array, string,
			// number, null). Silently falling back to defaults would hide the
			// author's misconfiguration, so surface it (Law 10).
			const message = `[claude-plugins] Ignoring non-object plugin manifest ${manifestPath}`;
			warnings?.push(message);
			logger.warn(message);
			return null;
		}
		return parsed as ClaudePluginManifest;
	} catch (err) {
		// Malformed JSON in a manifest the author DID write is a real error, not
		// the benign "no manifest" case. Surface it instead of silently loading
		// the plugin from default dirs as if it had no manifest.
		const message = `[claude-plugins] Invalid JSON in ${manifestPath}: ${errorMessage(err)}`;
		warnings?.push(message);
		logger.warn(message);
		return null;
	}
}

async function skillsManifestReplacesFallback(root: ClaudePluginRoot, warnings?: string[]): Promise<boolean> {
	const marketplacePath = path.join(root.path, "marketplace.json");
	const raw = await readFile(marketplacePath);
	if (raw === null) return false; // marketplace manifest absent — keep the default skills dir

	try {
		const parsed: unknown = JSON.parse(raw);
		if (!isRecord(parsed)) return false;
		const plugins = parsed.plugins;
		return (
			Array.isArray(plugins) &&
			plugins.some(entry => isRecord(entry) && entry.name === root.plugin && entry.source === "./")
		);
	} catch (err) {
		// A malformed marketplace.json silently defaulted to "does not replace",
		// so a plugin author's intended skills layout was ignored with no signal.
		const message = `[claude-plugins] Invalid JSON in ${marketplacePath}: ${errorMessage(err)}`;
		warnings?.push(message);
		logger.warn(message);
		return false;
	}
}

function isWithinPluginRoot(rootPath: string, targetPath: string): boolean {
	const relative = path.relative(rootPath, targetPath);
	return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/** Resolve a manifest-declared directory field to absolute paths within the plugin root. */
async function resolvePluginDir(
	root: ClaudePluginRoot,
	manifestKeys: ReadonlyArray<keyof ClaudePluginManifest>,
	fallback: string,
	includeFallback: boolean,
): Promise<ResolvedPluginDir> {
	const warnings: string[] = [];
	const manifest = await readPluginManifest(root, warnings);
	const fallbackDir = path.join(root.path, fallback);

	let configured: string[] | undefined;
	let matchedKey: keyof ClaudePluginManifest | undefined;
	for (const key of manifestKeys) {
		const val = manifest?.[key];
		const candidates: string[] = [];
		if (typeof val === "string") {
			const trimmed = val.trim();
			if (trimmed) candidates.push(trimmed);
		} else if (Array.isArray(val)) {
			for (const entry of val) {
				if (typeof entry !== "string") continue;
				const trimmed = entry.trim();
				if (trimmed) candidates.push(trimmed);
			}
		}
		if (candidates.length > 0) {
			configured = candidates;
			matchedKey = key;
			break;
		}
	}

	if (configured === undefined) {
		return { dirs: [fallbackDir], warnings };
	}

	// Dedup preserves order: default entry (when included) first, then declared entries in manifest order. Deduping the paths themselves means a plugin
	const seen = new Set<string>();
	const dirs: string[] = [];
	if (includeFallback) {
		seen.add(fallbackDir);
		dirs.push(fallbackDir);
	}
	for (const entry of configured) {
		const resolved = path.resolve(root.path, entry);
		if (!isWithinPluginRoot(root.path, resolved)) {
			warnings.push(
				`[claude-plugins] Ignoring ${String(matchedKey)} path outside plugin root for ${root.id}: ${entry}`,
			);
			continue;
		}
		if (seen.has(resolved)) continue;
		seen.add(resolved);
		dirs.push(resolved);
	}

	return { dirs, warnings };
}

async function loadSkills(ctx: LoadContext): Promise<LoadResult<DiscoveredSkill>> {
	const items: DiscoveredSkill[] = [];
	const warnings: string[] = [];
	const { roots, warnings: rootWarnings } = await listClaudePluginRoots(
		ctx.home,
		ctx.cwd,
		pluginsRootFor(ctx.agentDir ?? getAgentDir()),
		ctx.agentDir ?? getAgentDir(),
	);
	for (let wi = 0; wi < rootWarnings.length; wi++) warnings.push(rootWarnings[wi]!);
	const results = await Promise.all(
		roots.map(async root => {
			const resolveWarnings: string[] = [];
			const includeFallback = !(await skillsManifestReplacesFallback(root, resolveWarnings));
			const { dirs: skillsDirs, warnings: dirWarnings } = await resolvePluginDir(
				root,
				["skills"],
				"skills",
				includeFallback,
			);
			for (let wi = 0; wi < dirWarnings.length; wi++) resolveWarnings.push(dirWarnings[wi]!);
			const scanResults = await Promise.all(
				skillsDirs.map(dir =>
					scanSkillsFromDir({
						dir,
						providerId: PROVIDER_ID,
						level: root.scope,
						includeSelf: true,
					}),
				),
			);
			return { scanResults, resolveWarnings };
		}),
	);
	for (const { scanResults, resolveWarnings } of results) {
		for (let wi = 0; wi < resolveWarnings.length; wi++) warnings.push(resolveWarnings[wi]!);
		// Intentionally do NOT prefix skill names with `root.plugin`. The `plugin:name` format breaks skill:// URL parsing (colons are
		for (const result of scanResults) {
			for (let ii = 0; ii < result.items.length; ii++) items.push(result.items[ii]!);
			if (result.warnings) {
				for (let wi = 0; wi < result.warnings.length; wi++) warnings.push(result.warnings[wi]!);
			}
		}
	}
	return { items, warnings };
}

async function loadSlashCommands(ctx: LoadContext): Promise<LoadResult<SlashCommand>> {
	const items: SlashCommand[] = [];
	const warnings: string[] = [];

	const { roots, warnings: rootWarnings } = await listClaudePluginRoots(
		ctx.home,
		ctx.cwd,
		pluginsRootFor(ctx.agentDir ?? getAgentDir()),
		ctx.agentDir ?? getAgentDir(),
	);
	for (let wi = 0; wi < rootWarnings.length; wi++) warnings.push(rootWarnings[wi]!);

	const results = await Promise.all(
		roots.map(async root => {
			const { dirs: commandsDirs, warnings: resolveWarnings } = await resolvePluginDir(
				root,
				["commands", "slash-commands"],
				"commands",
				false,
			);
			const commandResults = await Promise.all(
				commandsDirs.map(async dir => {
					try {
						const stats = await fs.stat(dir);
						if (stats.isFile()) {
							if (path.extname(dir) !== ".md") return { items: [], warnings: [] };
							const content = await readFile(dir);
							if (content === null) return { items: [], warnings: [`Failed to read file: ${dir}`] };
							const cmdName = path.basename(dir).replace(/\.md$/, "");
							return {
								items: [
									{
										name: root.plugin ? `${root.plugin}:${cmdName}` : cmdName,
										path: dir,
										content,
										level: root.scope,
										_source: createSourceMeta(PROVIDER_ID, dir, root.scope),
									},
								],
								warnings: [],
							};
						}
					} catch (error) {
						// A missing entry is the normal case and still falls through to the directory loader below, which reports nothing for a missing dir.
						if (!isEnoent(error)) {
							return {
								items: [],
								warnings: [`Failed to read plugin commands path ${dir}: ${errorMessage(error)}`],
							};
						}
					}
					return loadFilesFromDir<SlashCommand>(dir, PROVIDER_ID, root.scope, {
						extensions: ["md"],
						transform: (name, content, filePath, source) => {
							const cmdName = name.replace(/\.md$/, "");
							return {
								name: root.plugin ? `${root.plugin}:${cmdName}` : cmdName,
								path: filePath,
								content,
								level: root.scope,
								_source: source,
							};
						},
					});
				}),
			);
			return { commandResults, resolveWarnings };
		}),
	);

	for (const { commandResults, resolveWarnings } of results) {
		for (let wi = 0; wi < resolveWarnings.length; wi++) warnings.push(resolveWarnings[wi]!);
		for (const commandResult of commandResults) {
			for (let ii = 0; ii < commandResult.items.length; ii++) items.push(commandResult.items[ii]!);
			if (commandResult.warnings) {
				for (let wi = 0; wi < commandResult.warnings.length; wi++) warnings.push(commandResult.warnings[wi]!);
			}
		}
	}

	return { items, warnings };
}

async function loadHooks(ctx: LoadContext): Promise<LoadResult<Hook>> {
	const items: Hook[] = [];
	const warnings: string[] = [];

	const { roots, warnings: rootWarnings } = await listClaudePluginRoots(
		ctx.home,
		ctx.cwd,
		pluginsRootFor(ctx.agentDir ?? getAgentDir()),
		ctx.agentDir ?? getAgentDir(),
	);
	for (let wi = 0; wi < rootWarnings.length; wi++) warnings.push(rootWarnings[wi]!);

	const hookTypes = ["pre", "post"] as const;

	const loadTasks: { root: ClaudePluginRoot; hookType: "pre" | "post" }[] = [];
	for (const root of roots) {
		for (const hookType of hookTypes) {
			loadTasks.push({ root, hookType });
		}
	}

	const results = await Promise.all(
		loadTasks.map(async ({ root, hookType }) => {
			const hooksDir = path.join(root.path, "hooks", hookType);
			return loadFilesFromDir<Hook>(hooksDir, PROVIDER_ID, root.scope, {
				transform: (name, _content, filePath, source) => {
					const toolName = name.replace(/\.(sh|bash|zsh|fish)$/, "");
					return {
						name,
						path: filePath,
						type: hookType,
						tool: toolName,
						level: root.scope,
						_source: source,
					};
				},
			});
		}),
	);

	for (const result of results) {
		for (let ii = 0; ii < result.items.length; ii++) items.push(result.items[ii]!);
		if (result.warnings) {
			for (let wi = 0; wi < result.warnings.length; wi++) warnings.push(result.warnings[wi]!);
		}
	}

	return { items, warnings };
}

async function loadTools(ctx: LoadContext): Promise<LoadResult<DiscoveredCustomTool>> {
	const items: DiscoveredCustomTool[] = [];
	const warnings: string[] = [];

	const { roots, warnings: rootWarnings } = await listClaudePluginRoots(
		ctx.home,
		ctx.cwd,
		pluginsRootFor(ctx.agentDir ?? getAgentDir()),
		ctx.agentDir ?? getAgentDir(),
	);
	for (let wi = 0; wi < rootWarnings.length; wi++) warnings.push(rootWarnings[wi]!);

	const results = await Promise.all(
		roots.map(async root => {
			const toolsDir = path.join(root.path, "tools");
			return loadFilesFromDir<DiscoveredCustomTool>(toolsDir, PROVIDER_ID, root.scope, {
				transform: (name, _content, filePath, source) => {
					const toolName = name.replace(/\.(ts|js|sh|bash|py)$/, "");
					return {
						name: toolName,
						path: filePath,
						description: `${toolName} custom tool`,
						level: root.scope,
						_source: source,
					};
				},
			});
		}),
	);

	for (const result of results) {
		for (let ii = 0; ii < result.items.length; ii++) items.push(result.items[ii]!);
		if (result.warnings) {
			for (let wi = 0; wi < result.warnings.length; wi++) warnings.push(result.warnings[wi]!);
		}
	}

	return { items, warnings };
}

async function loadMCPServers(ctx: LoadContext): Promise<LoadResult<MCPServer>> {
	const items: MCPServer[] = [];
	const warnings: string[] = [];

	const { roots, warnings: rootWarnings } = await listClaudePluginRoots(
		ctx.home,
		ctx.cwd,
		pluginsRootFor(ctx.agentDir ?? getAgentDir()),
		ctx.agentDir ?? getAgentDir(),
	);
	for (let wi = 0; wi < rootWarnings.length; wi++) warnings.push(rootWarnings[wi]!);

	for (const root of roots) {
		const mcpPath = path.join(root.path, ".mcp.json");
		const raw = await readFile(mcpPath);
		if (raw === null) continue; // file absent — skip silently

		let parsed: unknown;
		try {
			parsed = JSON.parse(raw);
		} catch {
			warnings.push(`[claude-plugins] Invalid JSON in ${mcpPath}`);
			logger.warn(`[claude-plugins] Invalid JSON in ${mcpPath}`);
			continue;
		}

		if (!isRecord(parsed)) continue;
		const obj = parsed as Record<string, unknown>;

		// Two shapes are supported: nested: { "mcpServers": { name: cfg, ... } } (Veyyon/Claude Code project shape)
		let servers: Record<string, unknown>;
		if (
			obj.mcpServers !== undefined &&
			obj.mcpServers !== null &&
			typeof obj.mcpServers === "object" &&
			!Array.isArray(obj.mcpServers)
		) {
			servers = obj.mcpServers as Record<string, unknown>;
		} else if (!("mcpServers" in obj)) {
			servers = obj;
		} else {
			continue;
		}

		for (const [serverName, serverCfg] of Object.entries(servers)) {
			if (!isRecord(serverCfg)) continue;
			const raw = serverCfg as {
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
				type?: string;
			};
			// Require either command (stdio) or url (HTTP/SSE) — Claude marketplace plugins
			// occasionally ship .mcp.json entries with neither, which would register a useless
			// server and surface as a connection error at runtime.
			if (typeof raw.command !== "string" && typeof raw.url !== "string") {
				warnings.push(`[claude-plugins] Skipping MCP server "${serverName}" in ${mcpPath}: missing command or url`);
				continue;
			}
			const namespacedName = root.plugin ? `${root.plugin}:${serverName}` : serverName;
			const substitutedCommand =
				raw.command !== undefined ? substitutePluginRoot(raw.command, root.path) : undefined;
			const substitutedCwd = raw.cwd !== undefined ? substitutePluginRoot(raw.cwd, root.path) : undefined;
			// Root relative command/cwd at the plugin's config directory, not the
			// session cwd (MCP stdio spawning resolves relative values there).
			const rooted = resolvePluginStdioPaths({ command: substitutedCommand, cwd: substitutedCwd }, root.path);
			const server: MCPServer = {
				name: namespacedName,
				...(raw.enabled !== undefined && { enabled: raw.enabled }),
				...(raw.timeout !== undefined && { timeout: raw.timeout }),
				...(rooted.command !== undefined && { command: rooted.command }),
				...(raw.args !== undefined && { args: substitutePluginRoot(raw.args, root.path) }),
				...(raw.env !== undefined && { env: substitutePluginRoot(raw.env, root.path) }),
				...(rooted.cwd !== undefined && { cwd: rooted.cwd }),
				...(raw.url !== undefined && { url: expandEnvVarsDeep(raw.url, warnUnresolved(warnings, mcpPath)) }),
				...(raw.headers !== undefined && {
					// A header value is credential material: the config-value grammar owns whether it
					// resolved, and the connect guard refuses an entry whose structural fields did not.
					headers: expandEnvVarsDeep(
						raw.headers,
						unresolvedRefusedDownstream("the MCP connect guard refuses an unresolved structural field"),
					),
				}),
				...(raw.auth !== undefined && { auth: raw.auth }),
				...(raw.oauth !== undefined && { oauth: raw.oauth }),
				...(raw.type !== undefined && { transport: raw.type as MCPServer["transport"] }),
				_source: createSourceMeta(PROVIDER_ID, mcpPath, root.scope),
			};
			items.push(server);
		}
	}

	return { items, warnings };
}

registerProvider<DiscoveredSkill>(skillCapability.id, {
	id: PROVIDER_ID,
	displayName: DISPLAY_NAME,
	description: "Load skills from Claude Code marketplace plugins (~/.claude/plugins/cache/)",
	priority: PRIORITY,
	load: loadSkills,
});

registerProvider<SlashCommand>(slashCommandCapability.id, {
	id: PROVIDER_ID,
	displayName: DISPLAY_NAME,
	description: "Load slash commands from Claude Code marketplace plugins",
	priority: PRIORITY,
	load: loadSlashCommands,
});

registerProvider<Hook>(hookCapability.id, {
	id: PROVIDER_ID,
	displayName: DISPLAY_NAME,
	description: "Load hooks from Claude Code marketplace plugins",
	priority: PRIORITY,
	load: loadHooks,
});

registerProvider<DiscoveredCustomTool>(toolCapability.id, {
	id: PROVIDER_ID,
	displayName: DISPLAY_NAME,
	description: "Load custom tools from Claude Code marketplace plugins",
	priority: PRIORITY,
	load: loadTools,
});

registerProvider<MCPServer>(mcpCapability.id, {
	id: PROVIDER_ID,
	displayName: DISPLAY_NAME,
	description: "Load MCP servers from marketplace plugin .mcp.json files",
	priority: PRIORITY,
	load: loadMCPServers,
});
