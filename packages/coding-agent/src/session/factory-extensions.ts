/**
 * Discovery for everything a session loads from disk: extensions, skills, rules,
 * context files, prompt templates, slash commands, TypeScript commands and MCP
 * server definitions, plus the load-failure report the operator sees.
 */

import type { OperatorNotices } from "@veyyon/kernel/session/operator-notices";
import { getAgentDir, getProjectDir, logger } from "@veyyon/utils";
import type { ModelRegistry } from "../config/model-registry";
import { loadPromptTemplates as loadPromptTemplatesInternal, type PromptTemplate } from "../config/prompt-templates";
import type { Settings, SkillsSettings } from "../config/settings";
import { type CapabilityResult, loadCapability } from "../discovery/capability";
import { type Rule, ruleCapability } from "../discovery/capability/rule";
import {
	type CustomCommandsLoadResult,
	loadCustomCommands as loadCustomCommandsInternal,
} from "../extensibility/custom-commands";
import {
	discoverAndLoadExtensions,
	discoverExtensionPaths,
	type LoadExtensionsResult,
	loadExtensions,
} from "../extensibility/extensions";
import { loadSkills as loadSkillsInternal, type Skill, type SkillWarning } from "../extensibility/skills";
import { type FileSlashCommand, loadSlashCommands as loadSlashCommandsInternal } from "../extensibility/slash-commands";
import { discoverAndLoadMCPTools, type MCPToolsLoadResult } from "../mcp";
import { loadProjectContextFiles as loadContextFilesInternal } from "../system-prompt";
import type { ContextFileEntry, ToolSession } from "../tools";
import { EventBus } from "../utils/event-bus";
import type { CreateAgentSessionOptions } from "./factory-options";

/**
 * Discover extensions from cwd.
 */
export async function discoverExtensions(cwd?: string): Promise<LoadExtensionsResult> {
	const resolvedCwd = cwd ?? getProjectDir();

	return discoverAndLoadExtensions([], resolvedCwd);
}

/**
 * Path-only counterpart of {@link loadSessionExtensions}: the FS-heavy scan
 * without the per-session module load. Subagents reuse the parent's path list
 * (cached on {@link ToolSession.extensionPaths}) and rebuild Extension
 * instances themselves so each session's `ExtensionAPI` (cwd, eventBus,
 * runtime) is its own.
 *
 * `agentDir` names the profile whose hooks and extension modules load. Omitting
 * it resolves the process-booted profile, which is only correct when the caller
 * genuinely has no session profile to speak of.
 */
export async function discoverSessionExtensionPaths(
	options: Pick<CreateAgentSessionOptions, "disableExtensionDiscovery" | "additionalExtensionPaths">,
	cwd: string,
	settings: Settings,
	agentDir?: string,
): Promise<string[]> {
	if (options.disableExtensionDiscovery) {
		return options.additionalExtensionPaths ?? [];
	}
	const configuredPaths = [...(options.additionalExtensionPaths ?? []), ...(settings.get("extensions") ?? [])];
	const disabledExtensionIds = settings.get("disabledExtensions") ?? [];
	return discoverExtensionPaths(configuredPaths, cwd, disabledExtensionIds, agentDir);
}

/**
 * Load the discovered/configured extensions for a session — everything {@link
 * createAgentSession} would load except the inline factory extensions it appends
 * itself. Extracted so the CLI can resolve extension-registered flags (and thus
 * classify `@file` arguments extension-aware) *before* a session — and its
 * terminal breadcrumb — is created, then hand the result back through
 * {@link CreateAgentSessionOptions.preloadedExtensions} so the work is not
 * repeated. Keep this the single source of the discovery branch logic.
 */
export async function loadSessionExtensions(
	options: Pick<CreateAgentSessionOptions, "disableExtensionDiscovery" | "additionalExtensionPaths">,
	cwd: string,
	settings: Settings,
	eventBus: EventBus,
	agentDir?: string,
	adoptSpawnedPid?: (pid: number) => void,
	gateSpawn?: (what: string) => Promise<void>,
): Promise<LoadExtensionsResult> {
	const paths = await discoverSessionExtensionPaths(options, cwd, settings, agentDir);
	const result = await logger.time(
		"loadExtensions",
		loadExtensions,
		paths,
		cwd,
		eventBus,
		adoptSpawnedPid,
		{
			agentDir,
			configuredPaths: [...(options.additionalExtensionPaths ?? []), ...(settings.get("extensions") ?? [])],
		},
		gateSpawn,
	);
	reportExtensionLoadFailures(result);
	return result;
}

/**
 * Say out loud that an extension the user asked for is not running.
 *
 * `logger.error` alone was the whole report, and the default transport set is
 * `{ file: true }` with no console transport — see the header of
 * `session/operator-notices.ts`, which names this exact channel as the one that
 * reaches nobody. So an extension with a syntax error, a bad import, or a
 * throwing factory was dropped, the session started clean, and the operator's
 * only symptom was that its tools, commands and flags were absent with no
 * explanation. Skill-loading failures three hundred lines below already go to
 * the operator channel; this is the same failure of the same kind and now
 * reports the same way.
 *
 * The file log keeps the record either way: raising a notice adds reach and
 * never removes it.
 */
export function reportExtensionLoadFailures(result: LoadExtensionsResult, operatorNotices?: OperatorNotices): void {
	for (const { path, error } of result.errors) {
		logger.error("Failed to load extension", { path, error });
		operatorNotices?.error("extensions", `${path}: ${error}`);
	}
	// Withheld is not a failure and must not read as one, but it MUST be seen: project code the
	// operator has not approved is silently absent otherwise, and "my repo's extension does
	// nothing" would be indistinguishable from a broken extension. A warning names the file and
	// what would make it run.
	for (const { path, reason } of result.withheld) {
		logger.warn("Withheld project extension", { path, reason });
		operatorNotices?.warn("extensions", reason);
	}
}

/**
 * Load discovered/configured extensions and register their providers into
 * `modelRegistry`, then discover the dynamic provider catalogs. One-shot CLIs
 * (`veyyon bench`, dry-balance) build a bare {@link ModelRegistry} that only knows
 * built-in catalog providers; without this, providers contributed by an
 * extension (e.g. a custom OpenAI-compatible provider under
 * `~/.veyyon/profiles/<name>/agent/extensions/`) never reach model resolution. Mirrors the
 * session / `veyyon models` path: drain the queued provider registrations, then
 * `refreshRuntimeProviders` so dynamically-discovered models exist before
 * selectors are resolved.
 */
export async function loadCliExtensionProviders(
	modelRegistry: ModelRegistry,
	settings: Settings,
	cwd: string,
	options: Pick<CreateAgentSessionOptions, "disableExtensionDiscovery" | "additionalExtensionPaths"> = {},
): Promise<void> {
	const eventBus = new EventBus();
	// No agent dir: a one-shot CLI has no session profile, so the process-booted
	// one is the right and only answer here. Stated because the same omission at
	// the session call site was the defect.
	const extensionsResult = await loadSessionExtensions(options, cwd, settings, eventBus);
	const activeSources = extensionsResult.extensions.map(extension => extension.path);
	modelRegistry.syncExtensionSources(activeSources);
	for (const sourceId of new Set(activeSources)) {
		modelRegistry.clearSourceRegistrations(sourceId);
	}
	for (const { name, config, sourceId } of extensionsResult.runtime.pendingProviderRegistrations) {
		modelRegistry.registerProvider(name, config, sourceId);
	}
	extensionsResult.runtime.pendingProviderRegistrations = [];
	await modelRegistry.refreshRuntimeProviders();
}

/**
 * Discover the skills for a session: the authored `<agentDir>/skills`, the
 * auto-learn `<agentDir>/managed-skills`, and any skills shipped by plugin packages
 * configured for the session.
 *
 * `agentDir` defaults to {@link getAgentDir} exactly the way
 * {@link discoverPromptTemplates} does, and it is FORWARDED. It used to be accepted
 * and dropped, which pinned the skill set to whichever profile the process booted
 * with: an agent rooted in another agent dir silently got a stranger's skills, or
 * none. Do not reintroduce that by widening the signature without threading the
 * value. {@link loadSkillsInternal} forwards it as `LoadOptions.agentDir`, which lands
 * on the `LoadContext` all three profile-rooted skill providers read.
 */
export async function discoverSkills(
	cwd?: string,
	agentDir?: string,
	settings?: SkillsSettings,
): Promise<{ skills: Skill[]; warnings: SkillWarning[] }> {
	return await loadSkillsInternal({
		...settings,
		cwd: cwd ?? getProjectDir(),
		agentDir: agentDir ?? getAgentDir(),
	});
}

/**
 * Discover the rules for a session: the profile's `<agentDir>/RULES.md` and
 * `<agentDir>/rules/`, the bundled defaults, and every foreign-config and plugin
 * rule source. All of them are user-scope: a repository's own `.veyyon/rules/`
 * was dropped as a source, because a cloned repo cannot be a standing
 * instruction on every request.
 *
 * `agentDir` defaults to {@link getAgentDir} and is FORWARDED, exactly like
 * {@link discoverSkills} and {@link discoverContextFiles}. Rules were the one
 * discovered layer with no wrapper: both session call sites reached
 * `loadCapability` directly with `{ cwd }` and no agent dir, so a session rooted
 * in another profile got that profile's instructions and skills alongside the
 * BOOTED profile's rules. This wrapper exists so the default lives in one place
 * and cannot be forgotten at a call site again.
 */
export async function discoverRules(cwd?: string, agentDir?: string): Promise<CapabilityResult<Rule>> {
	return await loadCapability<Rule>(ruleCapability.id, {
		cwd: cwd ?? getProjectDir(),
		agentDir: agentDir ?? getAgentDir(),
	});
}

/**
 * Discover the context files (AGENTS.md / CLAUDE.md) for a session.
 *
 * Resolves all three scopes, in resolution order global (`<config root>/AGENTS.md`)
 * → profile (`agentDir`'s own instruction file) → project (the walk up from `cwd`).
 * The array is returned in AUTHORITY order, least authoritative first so the
 * strongest file holds the last and highest-recency slot: project (farther from
 * cwd first) → profile → global, which is last and therefore wins. See
 * {@link loadProjectContextFilesWithWarnings} for why those two axes differ.
 *
 * `agentDir` defaults to {@link getAgentDir} exactly the way
 * {@link discoverPromptTemplates} does, and it is FORWARDED. It used to be
 * accepted and dropped, which silently pinned the profile scope to whichever
 * profile the process booted with: an agent rooted in another agent dir got
 * someone else's profile file, or none. Do not reintroduce that by widening the
 * signature without threading the value.
 */
export async function discoverContextFiles(cwd?: string, agentDir?: string): Promise<ContextFileEntry[]> {
	return await loadContextFilesInternal({
		cwd: cwd ?? getProjectDir(),
		agentDir: agentDir ?? getAgentDir(),
	});
}

/**
 * Discover prompt templates from cwd and agentDir.
 */
export async function discoverPromptTemplates(cwd?: string, agentDir?: string): Promise<PromptTemplate[]> {
	return await loadPromptTemplatesInternal({
		cwd: cwd ?? getProjectDir(),
		agentDir: agentDir ?? getAgentDir(),
	});
}

/**
 * Discover file-based slash commands from commands/ directories.
 *
 * `agentDir` defaults to {@link getAgentDir} exactly the way
 * {@link discoverPromptTemplates} does, and it is FORWARDED. Without it the
 * user scope came from whichever profile the process booted with, so a session
 * rooted in another agent dir got that profile's AGENTS.md, skills and prompt
 * templates but the booted profile's slash commands.
 */
export async function discoverSlashCommands(cwd?: string, agentDir?: string): Promise<FileSlashCommand[]> {
	return loadSlashCommandsInternal({ cwd: cwd ?? getProjectDir(), agentDir: agentDir ?? getAgentDir() });
}

/**
 * Discover custom commands (TypeScript slash commands) from cwd and agentDir.
 */
export async function discoverCustomTSCommands(cwd?: string, agentDir?: string): Promise<CustomCommandsLoadResult> {
	const resolvedCwd = cwd ?? getProjectDir();
	const resolvedAgentDir = agentDir ?? getAgentDir();

	return loadCustomCommandsInternal({
		cwd: resolvedCwd,
		agentDir: resolvedAgentDir,
	});
}

/**
 * Discover MCP servers from .mcp.json files.
 * Returns the manager and loaded tools.
 */
export async function discoverMCPServers(cwd?: string): Promise<MCPToolsLoadResult> {
	const resolvedCwd = cwd ?? getProjectDir();
	return discoverAndLoadMCPTools(resolvedCwd);
}
