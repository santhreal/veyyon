/**
 * Claude Code Provider
 *
 * Loads configuration from .claude directories.
 * Priority: 80 (tool-specific, below builtin but above shared standards)
 */
import * as path from "node:path";
import { tryParseJson } from "@veyyon/utils";
// The slot leaf, not the 95-module store: this file reads settings, it does not fill them.
import { settings } from "../config/settings-instance";
import { type ContextFile, contextFileCapability } from "./capability/context-file";
import { type ExtensionModule, extensionModuleCapability } from "./capability/extension-module";
import { readFile } from "./capability/fs";
import { type Hook, hookCapability } from "./capability/hook";
import { type MCPServer, mcpCapability } from "./capability/mcp";
import { type DiscoveredSkill, skillCapability } from "./capability/skill";
import { type SlashCommand, slashCommandCapability } from "./capability/slash-command";
import { type DiscoveredCustomTool, toolCapability } from "./capability/tool";
import type { LoadContext, LoadResult } from "./capability/types";
import { expandEnvVarsDeep, warnUnresolved } from "./env-expansion";
import {
	buildExtensionModuleItems,
	calculateDepth,
	createSourceMeta,
	discoverExtensionModulePaths,
	readContextFile,
	registerProviderCapabilities,
	scanCustomToolsFromDir,
	scanMarkdownCommands,
	scanSkillsFromDir,
	scanSubdirectoryHooks,
} from "./helpers";

const PROVIDER_ID = "claude";
const DISPLAY_NAME = "Claude Code";
const PRIORITY = 80;
const CONFIG_DIR = ".claude";

/**
 * Get user-level .claude path.
 */
function getUserClaude(ctx: LoadContext): string {
	return path.join(ctx.home, CONFIG_DIR);
}

/**
 * Get project-level `.claude` path (cwd only).
 *
 * The ONLY thing this still resolves is `CLAUDE.md`, which is a context file:
 * prose the model reads. Every other `.claude` surface a repository once
 * supplied — hooks, tools, commands, skills, extensions, MCP servers and
 * settings — is gone, because a checked-out working tree does not configure the
 * agent.
 */
function getProjectClaude(ctx: LoadContext): string {
	return path.join(ctx.cwd, CONFIG_DIR);
}

// =============================================================================
// MCP Servers
// =============================================================================

async function loadMCPServers(ctx: LoadContext): Promise<LoadResult<MCPServer>> {
	const items: MCPServer[] = [];
	const warnings: string[] = [];

	const userBase = getUserClaude(ctx);
	const userClaudeJson = path.join(ctx.home, ".claude.json");
	const userMcpJson = path.join(userBase, "mcp.json");

	const allPaths = [
		{ path: userClaudeJson, level: "user" as const },
		{ path: userMcpJson, level: "user" as const },
	];
	const contents = await Promise.all(allPaths.map(({ path }) => readFile(path)));

	const parseMcpServers = (content: string | null, path: string, level: "user" | "project"): MCPServer[] => {
		if (!content) return [];
		const json = tryParseJson<{ mcpServers?: Record<string, unknown> }>(content);
		if (!json?.mcpServers) return [];

		const mcpServers = expandEnvVarsDeep(json.mcpServers, warnUnresolved(warnings, path));
		return Object.entries(mcpServers).map(([name, config]) => {
			const serverConfig = config as Record<string, unknown>;
			return {
				name,
				timeout: typeof serverConfig.timeout === "number" ? serverConfig.timeout : undefined,
				command: serverConfig.command as string | undefined,
				args: serverConfig.args as string[] | undefined,
				env: serverConfig.env as Record<string, string> | undefined,
				url: serverConfig.url as string | undefined,
				headers: serverConfig.headers as Record<string, string> | undefined,
				transport: serverConfig.type as "stdio" | "sse" | "http" | undefined,
				_source: createSourceMeta(PROVIDER_ID, path, level),
			};
		});
	};

	for (let i = 0; i < allPaths.length; i++) {
		const servers = parseMcpServers(contents[i], allPaths[i].path, allPaths[i].level);
		if (servers.length > 0) {
			items.push(...servers);
			break;
		}
	}

	return { items, warnings };
}

// =============================================================================
// Context Files (CLAUDE.md)
// =============================================================================

/**
 * Load CLAUDE.md context files.
 *
 * Scopes: a home-level layer emitted as `level: "user"` (`~/.claude/CLAUDE.md`)
 * and PROJECT (`<cwd>/.claude/CLAUDE.md`).
 *
 * GLOBAL and PROFILE scope do not apply. Claude Code has no profile concept, so
 * there is no per-profile location to read, and veyyon's own global layer
 * (`<globalConfigRoot>/AGENTS.md`) belongs to the native provider. The home-level
 * file shares the capability's single home slot with the active profile's
 * AGENTS.md and loses to it on priority (native 100 against this provider's 80),
 * so it only applies when the profile has no instructions of its own and the
 * user opted into `discovery.importForeignConfig`.
 *
 * The project scope is cwd-only, not a walk-up: this feeds the onboarding import
 * scan, which is about the checkout the user is standing in.
 */
async function loadContextFiles(ctx: LoadContext): Promise<LoadResult<ContextFile>> {
	const items: ContextFile[] = [];
	const warnings: string[] = [];

	const userBase = getUserClaude(ctx);
	const userClaudeMd = path.join(userBase, "CLAUDE.md");

	const user = await readContextFile(userClaudeMd);
	if (user.warning) warnings.push(user.warning);
	if (user.content !== null) {
		items.push({
			path: userClaudeMd,
			content: user.content,
			level: "user",
			_source: createSourceMeta(PROVIDER_ID, userClaudeMd, "user"),
		});
	}

	const projectBase = getProjectClaude(ctx);
	const projectClaudeMd = path.join(projectBase, "CLAUDE.md");
	const project = await readContextFile(projectClaudeMd);
	if (project.warning) warnings.push(project.warning);
	if (project.content !== null) {
		const depth = calculateDepth(ctx.cwd, path.dirname(projectBase), path.sep);
		items.push({
			path: projectClaudeMd,
			content: project.content,
			level: "project",
			depth,
			_source: createSourceMeta(PROVIDER_ID, projectClaudeMd, "project"),
		});
	}

	return { items, warnings };
}

// =============================================================================
// Skills
// =============================================================================

async function loadSkills(ctx: LoadContext): Promise<LoadResult<DiscoveredSkill>> {
	const userSkillsDir = path.join(getUserClaude(ctx), "skills");
	return await scanSkillsFromDir({ dir: userSkillsDir, providerId: PROVIDER_ID, level: "user" });
}

// =============================================================================
// Extension Modules
// =============================================================================

async function loadExtensionModules(ctx: LoadContext): Promise<LoadResult<ExtensionModule>> {
	const userExtensionsDir = path.join(getUserClaude(ctx), "extensions");
	const userPaths = await discoverExtensionModulePaths(userExtensionsDir);
	return { items: buildExtensionModuleItems(PROVIDER_ID, userPaths, []), warnings: [] };
}

// =============================================================================
// Slash Commands
// =============================================================================

/**
 * Whether Claude user commands (`~/.claude/commands/`) load.
 *
 * Falls back to true (current behavior) when settings are not initialized,
 * e.g. inside discovery unit tests that run without Settings.init().
 *
 * There is no project counterpart. A repo's `.claude/commands/` is repo-authored
 * content and is not loaded at all, so a toggle for it would gate a branch that
 * does not exist. One did: `commands.enableClaudeProject` was read here, returned,
 * and dropped by the only caller, which destructures `enableUser` alone.
 */
function claudeUserCommandsEnabled(): boolean {
	try {
		return settings.get("commands.enableClaudeUser") ?? true;
	} catch {
		return true;
	}
}

function getClaudeRelativeCommandName(commandsDir: string, filePath: string): string {
	return path.relative(commandsDir, filePath).replace(/\.md$/, "");
}

function addClaudeCommandNamespaceAliases(commands: SlashCommand[], commandsDir: string): SlashCommand[] {
	const rootCommands: SlashCommand[] = [];
	const nestedCommands: SlashCommand[] = [];
	const aliases: SlashCommand[] = [];

	for (const command of commands) {
		const relativeName = getClaudeRelativeCommandName(commandsDir, command.path);
		if (!/[\\/]/.test(relativeName)) {
			rootCommands.push(command);
			continue;
		}

		nestedCommands.push(command);
		aliases.push({ ...command, name: relativeName.replace(/[\\/]+/g, ":") });
	}

	return nestedCommands.length === 0 ? commands : rootCommands.concat(nestedCommands, aliases);
}

async function loadSlashCommands(ctx: LoadContext): Promise<LoadResult<SlashCommand>> {
	const items: SlashCommand[] = [];
	const warnings: string[] = [];
	const enableUser = claudeUserCommandsEnabled();

	if (enableUser) {
		const userCommandsDir = path.join(getUserClaude(ctx), "commands");
		const userResult = await scanMarkdownCommands(userCommandsDir, PROVIDER_ID, "user", { recursive: true });
		items.push(...addClaudeCommandNamespaceAliases(userResult.items, userCommandsDir));
		if (userResult.warnings) warnings.push(...userResult.warnings);
	}

	return { items, warnings };
}

// =============================================================================
// Hooks
// =============================================================================

async function loadHooks(ctx: LoadContext): Promise<LoadResult<Hook>> {
	return await scanSubdirectoryHooks(path.join(getUserClaude(ctx), "hooks"), PROVIDER_ID, "user");
}

// =============================================================================
// Custom Tools
// =============================================================================

async function loadTools(ctx: LoadContext): Promise<LoadResult<DiscoveredCustomTool>> {
	return await scanCustomToolsFromDir(path.join(getUserClaude(ctx), "tools"), PROVIDER_ID, "user");
}

// =============================================================================
// Provider Registration
// =============================================================================

registerProviderCapabilities({ id: PROVIDER_ID, displayName: DISPLAY_NAME, priority: PRIORITY }, [
	{
		capabilityId: mcpCapability.id,
		description: "Load MCP servers from .claude.json and .claude/mcp.json",
		load: loadMCPServers,
	},
	{
		capabilityId: contextFileCapability.id,
		description: "Load CLAUDE.md files from .claude/ directories",
		load: loadContextFiles,
	},
	{
		capabilityId: skillCapability.id,
		description: "Load skills from .claude/skills/*/SKILL.md",
		load: loadSkills,
	},
	{
		capabilityId: extensionModuleCapability.id,
		description: "Load extension modules from .claude/extensions",
		load: loadExtensionModules,
	},
	{
		capabilityId: slashCommandCapability.id,
		description: "Load slash commands from .claude/commands/*.md",
		load: loadSlashCommands,
	},
	{
		capabilityId: hookCapability.id,
		description: "Load hooks from .claude/hooks/pre/ and .claude/hooks/post/",
		load: loadHooks,
	},
	{
		capabilityId: toolCapability.id,
		description: "Load custom tools from .claude/tools/",
		load: loadTools,
	},
]);
