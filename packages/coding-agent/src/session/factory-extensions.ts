/**
 * Discovery for everything a session loads from disk: extensions, skills, rules,
 * context files, prompt templates, slash commands, TypeScript commands and MCP
 * server definitions, plus the load-failure report the operator sees.
 */

import type { OperatorNotices } from "@veyyon/kernel/session/operator-notices";
import { errorMessage, getAgentDir, getProjectDir, logger, prefetch, raceWithTimeout } from "@veyyon/utils";
import { type DiscoveredAdvisors, discoverAdvisorConfigs } from "../advisor/config";
import { discoverWatchdogFiles, formatActiveRepoWatchdogPrompt, formatAdvisorContextPrompt } from "../advisor/watchdog";
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
import { type ActiveRepoContext, resolveActiveRepoContext } from "../utils/active-repo-context";
import { EventBus } from "../utils/event-bus";
import { buildWorkspaceTree, type WorkspaceTree } from "../workspace-tree";
import type { ProjectAdvisorScope } from "./agent-session-types";
import type { CreateAgentSessionOptions } from "./factory-options";

/**
 * Discover extensions from cwd.
 */
export async function discoverExtensions(cwd?: string, agentDir?: string): Promise<LoadExtensionsResult> {
	const resolvedCwd = cwd ?? getProjectDir();

	return discoverAndLoadExtensions([], resolvedCwd, undefined, undefined, agentDir);
}

/**
 * Path-only counterpart of {@link loadSessionExtensions}: the FS-heavy scan
 * without the per-session module load. Agents reuse the parent's path list
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
 * The two roots every discovered layer resolves against: `cwd` defaulting to the project dir
 * and `agentDir` defaulting to the booted profile, both FORWARDED so a session rooted in
 * another profile reads that profile's files rather than the booted one's.
 */
function discoveryRoots(cwd: string | undefined, agentDir: string | undefined): { cwd: string; agentDir: string } {
	return { cwd: cwd ?? getProjectDir(), agentDir: agentDir ?? getAgentDir() };
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
	return await loadSkillsInternal({ ...settings, ...discoveryRoots(cwd, agentDir) });
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
	return await loadCapability<Rule>(ruleCapability.id, discoveryRoots(cwd, agentDir));
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
	return await loadContextFilesInternal(discoveryRoots(cwd, agentDir));
}

/** Bound on the workspace tree scan; a session builds without the tree past it. */
export const WORKSPACE_TREE_DEADLINE_MS = 5000;

/**
 * Every input a session reads from its project directory, each discovery started and none awaited.
 * Every promise is prefetched, so one that rejects before its consumer awaits it is not an unhandled
 * rejection; the consumer's `await` still receives the failure.
 */
export interface ProjectInputDiscovery {
	readonly cwd: string;
	readonly contextFiles: Promise<ContextFileEntry[]>;
	readonly workspaceTree: Promise<WorkspaceTree>;
	/** Null when the directory is in no repository or the lookup failed; the failure is logged. */
	readonly activeRepoContext: Promise<ActiveRepoContext | null>;
	readonly skills: Promise<{ skills: Skill[]; warnings: SkillWarning[] }>;
	readonly rules: Promise<Rule[]>;
	readonly watchdogFiles: Promise<string[]>;
	readonly advisors: Promise<DiscoveredAdvisors>;
}

/**
 * Start discovering the project inputs of `cwd`. An input the caller supplied is used as given:
 * `undefined` means discover it, and `[]` means resolved to nothing on purpose. Presence, not
 * truthiness, because `[]` is truthy.
 */
export function discoverProjectInputs(
	cwd: string,
	agentDir: string,
	settings: Settings,
	supplied: Pick<CreateAgentSessionOptions, "contextFiles" | "workspaceTree" | "skills" | "rules">,
): ProjectInputDiscovery {
	const skills =
		supplied.skills !== undefined
			? Promise.resolve({ skills: supplied.skills, warnings: [] })
			: logger.time("discoverSkills", discoverSkills, cwd, agentDir, {
					...settings.getGroup("skills"),
					disabledExtensions: settings.get("disabledExtensions") ?? [],
				});
	return {
		cwd,
		contextFiles: prefetch(
			supplied.contextFiles !== undefined
				? Promise.resolve(supplied.contextFiles)
				: logger.time("discoverContextFiles", discoverContextFiles, cwd, agentDir),
		),
		workspaceTree: prefetch(discoverWorkspaceTree(cwd, settings, supplied.workspaceTree)),
		activeRepoContext: logger.time("resolveActiveRepoContext", resolveActiveRepoContextOrNull, cwd),
		skills: prefetch(skills),
		rules: prefetch(
			supplied.rules !== undefined
				? Promise.resolve(supplied.rules)
				: logger.time("discoverRules", discoverRules, cwd, agentDir).then(result => result.items),
		),
		watchdogFiles: prefetch(logger.time("discoverWatchdogFiles", discoverWatchdogFiles, cwd, agentDir)),
		advisors: prefetch(logger.time("discoverAdvisorConfigs", discoverAdvisorConfigs, cwd, agentDir)),
	};
}

function discoverWorkspaceTree(
	cwd: string,
	settings: Settings,
	supplied: WorkspaceTree | undefined,
): Promise<WorkspaceTree> {
	if (supplied !== undefined) return Promise.resolve(supplied);
	if (!(settings.get("includeWorkspaceTree") ?? false)) {
		return Promise.resolve({ rootPath: cwd, rendered: "", truncated: false, totalLines: 0, agentsMdFiles: [] });
	}
	return logger.time("buildWorkspaceTree", buildWorkspaceTree, cwd, { timeoutMs: WORKSPACE_TREE_DEADLINE_MS });
}

async function resolveActiveRepoContextOrNull(cwd: string): Promise<ActiveRepoContext | null> {
	try {
		return await resolveActiveRepoContext(cwd);
	} catch (error) {
		// Null drops the prompt's branch and status enrichment, so the reason is a warning.
		logger.warn("Failed to resolve active repo context", { cwd, error: errorMessage(error) });
		return null;
	}
}

/**
 * The workspace tree when its scan finishes within {@link WORKSPACE_TREE_DEADLINE_MS}, else
 * undefined. The scan keeps running, and the system prompt races the same promise when it renders.
 * The deadline timer is cleared as soon as the scan settles.
 */
export async function workspaceTreeWithinDeadline(
	discovery: ProjectInputDiscovery,
): Promise<WorkspaceTree | undefined> {
	const deadline = new Error("workspace tree scan deadline");
	try {
		return await raceWithTimeout(discovery.workspaceTree, WORKSPACE_TREE_DEADLINE_MS, () => deadline);
	} catch (error) {
		if (error !== deadline) throw error;
		logger.warn("Startup scan exceeded deadline; deferring to system prompt fallback", {
			name: "buildWorkspaceTree",
			timeoutMs: WORKSPACE_TREE_DEADLINE_MS,
			cwd: discovery.cwd,
		});
		return undefined;
	}
}

/** The advisor scope a project's discovered inputs produce. */
export function projectAdvisorScope(inputs: {
	watchdogFiles: readonly string[];
	activeRepoContext: ActiveRepoContext | null;
	contextFiles: readonly ContextFileEntry[];
	advisors: DiscoveredAdvisors;
}): ProjectAdvisorScope {
	const watchdogPrompts = inputs.activeRepoContext
		? [...inputs.watchdogFiles, formatActiveRepoWatchdogPrompt(inputs.activeRepoContext)]
		: inputs.watchdogFiles;
	return {
		advisorWatchdogPrompt: watchdogPrompts.length > 0 ? watchdogPrompts.join("\n\n") : undefined,
		advisorContextPrompt: formatAdvisorContextPrompt(inputs.contextFiles),
		advisorSharedInstructions: inputs.advisors.sharedInstructions,
		advisorConfigs: inputs.advisors.advisors,
	};
}

/**
 * Discover prompt templates from cwd and agentDir.
 */
export async function discoverPromptTemplates(cwd?: string, agentDir?: string): Promise<PromptTemplate[]> {
	return await loadPromptTemplatesInternal(discoveryRoots(cwd, agentDir));
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
	return loadSlashCommandsInternal(discoveryRoots(cwd, agentDir));
}

/**
 * Discover custom commands (TypeScript slash commands) from cwd and agentDir.
 */
export async function discoverCustomTSCommands(cwd?: string, agentDir?: string): Promise<CustomCommandsLoadResult> {
	return loadCustomCommandsInternal(discoveryRoots(cwd, agentDir));
}

/**
 * Discover MCP servers from .mcp.json files.
 * Returns the manager and loaded tools.
 */
export async function discoverMCPServers(cwd?: string): Promise<MCPToolsLoadResult> {
	const resolvedCwd = cwd ?? getProjectDir();
	return discoverAndLoadMCPTools(resolvedCwd);
}
