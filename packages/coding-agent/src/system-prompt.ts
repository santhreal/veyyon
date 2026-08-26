/**
 * System prompt construction and project context loading
 */

import * as path from "node:path";
import type { AgentTool } from "@veyyon/agent-core";
import type { ToolExample, TSchema } from "@veyyon/ai";
import { renderToolInventory } from "@veyyon/ai/dialect";
import {
	$env,
	errorMessage,
	firstNonEmpty,
	getAgentDir,
	getProjectDir,
	kebabToCamel,
	logger,
	looksLikeFilePath,
	prompt,
} from "@veyyon/utils";
import { contextFileCapability } from "./capability/context-file";
import { findConfigFile } from "./config";
import type { SkillsSettings } from "./config/settings";
import { type ContextFile, loadCapability } from "./discovery";
import { ensureManagedAgentsFilesOnStartup, getGlobalAgentsPath } from "./discovery/agents-guidance";
import { expandAtImports } from "./discovery/at-imports";
import { loadSkills, type Skill } from "./extensibility/skills";
import { hasObsidian } from "./internal-urls/vault-protocol";
import {
	BUILTIN_PERSONALITIES,
	DEFAULT_PERSONALITY_NAME,
	type ResolvedPersonality,
	resolvePersonality,
} from "./personality/resolver";
import { assertEvalPromptOverrideIdsExist } from "./prompts/eval-overrides";
import { sessionPrompts } from "./prompts/session/rows";
import {
	assembleDefaultTemplate,
	assembleStatementSections,
	parseSectionOverridesJson,
} from "./system-prompt-builder/default-template";
import { type GateInputs, OMITTED_GATE_DEFAULTS } from "./system-prompt-builder/gate-inputs";
import { applyPromptSectionOrderToParts } from "./system-prompt-builder/prompt-sections";
import {
	applySectionOverrides,
	loadSectionOverrideFiles,
	PROMPT_SECTIONS_DIR,
} from "./system-prompt-builder/section-overrides";
import {
	type ComputedRuntimeSectionId,
	isOptionBackedSection,
	type OptionBackedSectionKey,
	RUNTIME_SECTIONS,
	type RuntimeSectionEntry,
	TEMPLATE_SECTIONS,
	withSectionBanner,
} from "./system-prompt-builder/section-registry";
import {
	conditionHolds,
	parseStatementOverridesJson,
	type StatementContext,
	type StatementOverrides,
	statementById,
} from "./system-prompt-builder/statement-registry";
import { normalizeConcurrencyLimit } from "./task/parallel";
import { usesCodexTaskPrompt } from "./task/prompt-policy";
import type { ContextFileEntry } from "./tools";
import { shortenPath } from "./tools/render-utils";
import { isNonProjectRoot, NON_PROJECT_REASON_TEXT, type NonProjectReason } from "./tools/reroot-hint";
import { type ActiveRepoContext, resolveActiveRepoContext } from "./utils/active-repo-context";
import { getCachedGpu, getCpuModel, getEnvironmentInfo } from "./utils/host-environment";
import { normalizePromptPath } from "./utils/prompt-path";
import { AGENTS_MD_LIMIT, buildWorkspaceTree, type WorkspaceTree } from "./workspace-tree";

export interface AlwaysApplyRule {
	name: string;
	content: string;
	path: string;
}

/**
 * Compile-time check ensuring registry option keys map to string-valued `BuildSystemPromptOptions` fields.
 */
type StringOptionKeys = {
	[K in keyof BuildSystemPromptOptions]-?: string extends BuildSystemPromptOptions[K] ? K : never;
}[keyof BuildSystemPromptOptions];
type UnknownDeclaredOptionKeys = Exclude<OptionBackedSectionKey, StringOptionKeys>;
const _assertDeclaredOptionKeysExist: [UnknownDeclaredOptionKeys] extends [never]
	? true
	: {
			error: "section-registry.ts declares a section option key that is not a string field of BuildSystemPromptOptions";
			keys: UnknownDeclaredOptionKeys;
		} = true;
void _assertDeclaredOptionKeysExist;

function normalizePromptBlock(content: string): string {
	return prompt.format(content, { renderPhase: "post-render" }).trim();
}

function splitComparablePromptBlocks(content: string | null | undefined): string[] {
	const normalized = firstNonEmpty(content);
	if (!normalized) return [];

	return normalizePromptBlock(normalized)
		.split(/\n{2,}/)
		.map(block => block.trim())
		.filter(block => block.length > 0);
}

/**
 * True when every paragraph block of `ruleContent` appears as a contiguous run
 * of blocks inside `source` (exact match after prompt normalization). Exported
 * for unit testing and used by {@link dedupeAlwaysApplyRules}. The match is
 * conservative: wording or block-boundary differences keep the rule.
 */
function promptBlocksContain(sourceBlocks: readonly string[], ruleBlocks: readonly string[]): boolean {
	if (sourceBlocks.length === 0 || ruleBlocks.length === 0 || ruleBlocks.length > sourceBlocks.length) return false;

	for (let start = 0; start <= sourceBlocks.length - ruleBlocks.length; start += 1) {
		if (ruleBlocks.every((block, offset) => sourceBlocks[start + offset] === block)) return true;
	}

	return false;
}

export function promptSourceContainsRule(source: string | null | undefined, ruleContent: string): boolean {
	return promptBlocksContain(splitComparablePromptBlocks(source), splitComparablePromptBlocks(ruleContent));
}

/** Drop always-apply rules whose content is already verbatim-present in any prompt source. Exported for unit testing. */
export function dedupeAlwaysApplyRules(
	alwaysApplyRules: AlwaysApplyRule[] | undefined,
	promptSources: Array<string | null | undefined>,
): AlwaysApplyRule[] {
	if (!alwaysApplyRules || alwaysApplyRules.length === 0) return [];

	return alwaysApplyRules.filter(
		rule => !promptSources.some(source => promptSourceContainsRule(source, rule.content)),
	);
}

/**
 * Budget for prompt preparation slow lookups (e.g. GPU probe) before fallback.
 */
const SYSTEM_PROMPT_PREP_TIMEOUT_MS = 5000;

/** Discover TITLE_SYSTEM.md file for automatic session-title prompt overrides */
export function discoverTitleSystemPromptFile(cwd?: string): string | undefined {
	const projectPath = findConfigFile("TITLE_SYSTEM.md", { user: false, cwd });
	if (projectPath) {
		return projectPath;
	}
	const globalPath = findConfigFile("TITLE_SYSTEM.md", { user: true, cwd });
	if (globalPath) {
		return globalPath;
	}
	return undefined;
}

/** Endings that read as a prompt FILE rather than as prompt text. */
const PROMPT_FILE_EXTENSIONS = ["md", "markdown", "txt", "text", "prompt"] as const;

/**
 * Resolve a prompt option that may be a file path or literal prompt text.
 * Throws when a path-like string cannot be read, rather than treating it as literal prose.
 */
export async function resolvePromptInput(input: string | undefined, description: string): Promise<string | undefined> {
	if (!input) return undefined;
	if (input.includes("\n")) return input;

	try {
		return await Bun.file(input).text();
	} catch (error) {
		if (/\s/.test(input) || !looksLikeFilePath(input, PROMPT_FILE_EXTENSIONS)) return input;
		throw new Error(
			`${description}: cannot read ${input}: ${errorMessage(error)}. ` +
				"It was taken as a file path because it has no spaces and contains a path separator or ends " +
				"in a prompt-file extension. Fix the path, or pass the prompt text directly if you meant it " +
				"literally.",
			{ cause: error },
		);
	}
}

export interface LoadContextFilesOptions {
	/** Working directory to start walking up from. Default: getProjectDir() */
	cwd?: string;
	/**
	 * Agent directory whose profile scope is loaded. Default: getAgentDir().
	 */
	agentDir?: string;
}

/** A context file plus the scope it came from, used only for ordering inside this module. */
type ScopedContextFile = {
	path: string;
	content: string;
	depth?: number;
	level: ContextFile["level"];
};

/**
 * Authority rank of context-file scopes (project: 0 < user: 1 < global: 2).
 */
const CONTEXT_SCOPE_AUTHORITY: Record<ContextFile["level"], number> = { project: 0, user: 1, global: 2 };

/**
 * Drop context files whose content is completely contained in a higher-authority file.
 */
function dedupeContainedContextFiles<T extends { content: string }>(
	contextFiles: T[],
	authorityOf: (file: T) => number = () => 0,
): T[] {
	const blocks = contextFiles.map(file => splitComparablePromptBlocks(file.content));
	const authority = contextFiles.map(authorityOf);
	const outranks = (candidate: number, subject: number): boolean =>
		authority[candidate] === authority[subject] ? candidate > subject : authority[candidate] > authority[subject];
	return contextFiles.filter(
		(_file, index) =>
			!blocks.some(
				(candidateBlocks, candidateIndex) =>
					outranks(candidateIndex, index) && promptBlocksContain(candidateBlocks, blocks[index]),
			),
	);
}

/**
 * Load and deduplicate context files across project, profile, and global scopes.
 * Returned array is sorted least-authoritative first (project -> profile -> global).
 */
export async function loadProjectContextFilesWithWarnings(
	options: LoadContextFilesOptions = {},
): Promise<{ files: ContextFileEntry[]; warnings: string[] }> {
	const resolvedCwd = options.cwd ?? getProjectDir();
	const resolvedAgentDir = path.resolve(options.agentDir ?? getAgentDir());

	const result = await loadCapability<ContextFile>(contextFileCapability.id, {
		cwd: resolvedCwd,
		agentDir: resolvedAgentDir,
	});
	const warnings = [...result.warnings];

	// Materialize ContextFile items, expanding any `@path/to/file` includes
	// in their content. The expansion uses the file's own directory as the
	// resolution base so relative imports work the same way Claude Code,
	// Goose, and other tools document.
	//
	// One profile file at most, and it is the caller's: `agentDir` reaches the
	// provider through `LoadContext`, which resolves the ladder for that dir and stops
	// at its first real hit. Filtering other-profile candidates here, as this used to,
	// was not free: the capability keys every `user`-level file to one slot, so
	// dropping the item that won that slot also dropped the foreign-tool home file it
	// had shadowed, and the operator lost a scope either way.
	const files: ScopedContextFile[] = await Promise.all(
		result.items.map(async item => ({
			path: item.path,
			content: await expandAtImports(item.content, item.path),
			depth: item.depth,
			level: item.level,
		})),
	);

	// Least prominent first (earliest in the prompt), most prominent last, ordered so POSITION
	// AGREES WITH AUTHORITY: project (farther from cwd first, so the file closest to cwd is the
	// most specific project rule) → profile (the active agent's own file) → GLOBAL LAST, because
	// the operator's cross-profile configuration is the highest file authority there is.
	//
	// This used to rank global FIRST, which is the WEAKEST recency position, putting every
	// project file above it. The operator hit the consequence: a repository's AGENTS.md saying
	// "do not use subagents for this repository" was obeyed over their own global rules AND over
	// a live instruction to use them. The prose in `prompts/session/context-file-authority.md`
	// ranked global highest while this sort put it lowest, and position won.
	//
	// The old comment already had the right instinct and applied it to only one pair: it said a
	// profile instruction files must not be silently outranked by whatever repository happens to
	// be checked out. That reasoning is stronger for global, not weaker. A project file is
	// content checked into a repository the operator may not have written, so it is the lowest
	// authority of the three and now renders in the weakest position.
	//
	// Resolution ORDER (which scope is consulted when) is a separate axis from rendering
	// PROMINENCE (this). Do not conflate them.
	files.sort((a, b) => {
		const rankDelta = CONTEXT_SCOPE_AUTHORITY[a.level] - CONTEXT_SCOPE_AUTHORITY[b.level];
		if (rankDelta !== 0) return rankDelta;
		// Within the project level, higher depth (farther from cwd) comes first. Both files are
		// project scope, so neither outranks the other on the ladder and the more specific one
		// takes the more prominent slot. This is intra-scope refinement, not a project file
		// outranking a broader scope.
		return (b.depth ?? -1) - (a.depth ?? -1);
	});

	// Dedupe AFTER the sort: the survivor is chosen by scope authority first, and only files of
	// the same scope fall back to this position. `level` rides along past this point on purpose:
	// the prompt renderer ignores it, but operator-scoped delivery channels (Cursor rules) key
	// off it, and dropping it here used to make provenance unrecoverable downstream.
	return {
		files: dedupeContainedContextFiles(files, file => CONTEXT_SCOPE_AUTHORITY[file.level]).map(
			({ path, content, depth, level }) => ({ path, content, depth, level }),
		),
		warnings,
	};
}

/**
 * Load project context files, logging any read warnings to the logger.
 */
export async function loadProjectContextFiles(options: LoadContextFilesOptions = {}): Promise<ContextFileEntry[]> {
	const { files, warnings } = await loadProjectContextFilesWithWarnings(options);
	for (const warning of warnings) {
		logger.warn(`Context file loading: ${warning}`, { cwd: options.cwd ?? getProjectDir() });
	}
	return files;
}

export const DEFAULT_SYSTEM_PROMPT_TOOL_NAMES = ["read", "bash", "edit", "write"] as const;

export interface SystemPromptToolMetadata {
	label: string;
	description: string;
	/** Tool name the model sees on the provider wire. Defaults to the internal tool name. */
	wireName?: string;
	/** Tool parameters schema (Zod or JSON Schema), fed to the verbose inventory renderer. */
	parameters?: TSchema;
	/** Illustrative examples rendered into the verbose inventory. */
	examples?: readonly ToolExample[];
}

export function buildSystemPromptToolMetadata(
	tools: Map<string, AgentTool>,
	overrides: Partial<Record<string, Partial<SystemPromptToolMetadata>>> = {},
): Map<string, SystemPromptToolMetadata> {
	return new Map(
		Array.from(tools.entries(), ([name, tool]) => {
			const toolRecord = tool as AgentTool & { label?: string; description?: string };
			const override = overrides[name];
			const wireName =
				override?.wireName ??
				(typeof toolRecord.customWireName === "string" ? toolRecord.customWireName : undefined);
			return [
				name,
				{
					label: override?.label ?? (typeof toolRecord.label === "string" ? toolRecord.label : ""),
					description:
						override?.description ?? (typeof toolRecord.description === "string" ? toolRecord.description : ""),
					parameters: override?.parameters ?? toolRecord.parameters,
					examples: override?.examples ?? toolRecord.examples,
					wireName,
				},
			] as const;
		}),
	);
}

/**
 * Options for `buildSystemPrompt`, including gate inputs and custom prompt settings.
 */
export interface BuildSystemPromptOptions extends Partial<GateInputs> {
	/** Custom system prompt (replaces default). */
	customPrompt?: string;
	/** Already-loaded custom system prompt text; bypasses path resolution. */
	resolvedCustomPrompt?: string;
	/** Tools to include in prompt. */
	tools?: Map<string, SystemPromptToolMetadata>;
	/** Tool names to include in prompt. */
	toolNames?: string[];
	/** Text to append to system prompt. */
	appendSystemPrompt?: string;
	/** Already-loaded append prompt text; bypasses path resolution. */
	resolvedAppendSystemPrompt?: string;
	/** Skills settings for discovery. */
	skillsSettings?: SkillsSettings;
	/** Working directory. Default: getProjectDir() */
	cwd?: string;
	/** Agent configuration directory. Default: getAgentDir() */
	agentDir?: string;
	/**
	 * Pre-resolved context files. An empty array disables discovery; undefined triggers discovery.
	 */
	contextFiles?: Array<{ path: string; content: string; depth?: number }>;
	/** Skills provided directly to system prompt construction. */
	skills?: Skill[];
	/** Pre-loaded rulebook rules (descriptions, excluding TTSR and always-apply). */
	rules?: Array<{ name: string; description?: string; path: string; globs?: string[] }>;
	/** Whether MCP tool discovery is active for this prompt build. */
	mcpDiscoveryMode?: boolean;
	/** Discoverable MCP server summaries to advertise when discovery mode is active. */
	mcpDiscoveryServerSummaries?: string[];
	/** Rules with alwaysApply=true — their full content is injected into the prompt. */
	alwaysApplyRules?: AlwaysApplyRule[];
	/** Whether secret obfuscation is active. When true, explains the redaction format in the prompt. */
	secretsEnabled?: boolean;
	/**
	 * Rendered available secrets inventory block with credential placeholders.
	 */
	secretInventory?: string;
	/**
	 * Argot notation preamble block injected when shorthand encoding is active.
	 */
	argotPreamble?: string;
	/**
	 * Argot handle table mapping `§handle -> expansion` for loaded projects.
	 */
	argotHandles?: string;
	/** Pre-loaded workspace tree (skips discovery if provided). May be a Promise to allow early kick-off. */
	workspaceTree?: WorkspaceTree | Promise<WorkspaceTree>;
	/** Whether the local memory://root summary is active. */
	memoryRootEnabled?: boolean;
	/** Active model identifier (e.g. "anthropic/claude-opus-4") used by prompt policy and optionally surfaced. */
	model?: string;
	/** Pre-resolved nested active repo context. Undefined resolves from cwd. */
	activeRepoContext?: ActiveRepoContext | null;
	/**
	 * Reorder the default template's banner sections (see {@link promptSectionNames}).
	 * Resolved from the model's harness profile `promptSectionOrder`. Ignored (loudly)
	 * for custom prompt templates, which have no banner sections.
	 */
	sectionOrder?: readonly string[];
}

/** Result of building provider-facing system prompt messages. */
export interface BuildSystemPromptResult {
	/** Ordered system prompt blocks. Providers should preserve entries as distinct messages/blocks. */
	systemPrompt: string[];
	/**
	 * Template context used to render prompt blocks, or null if custom/null prompt used.
	 */
	statementContext: StatementContext | null;
	/** Effective per-statement replacements used to assemble the returned blocks. */
	statementOverrides: StatementOverrides | null;
	/** Static sections whose shipped statements were replaced wholesale. */
	replacedStatementSections: readonly string[];
}

/**
 * Read eval-only section overrides from `VEYYON_EVAL_SYSTEM_PROMPT_SECTIONS`.
 * Fails closed and logs warnings when active.
 */
function resolveEvalSectionOverrides(): ReturnType<typeof parseSectionOverridesJson> {
	const raw = $env.VEYYON_EVAL_SYSTEM_PROMPT_SECTIONS;
	const overrides = parseSectionOverridesJson(raw);
	const keys = Object.keys(overrides);
	if (keys.length > 0) {
		logger.warn(
			`EVAL-ONLY system-prompt section override is ACTIVE (VEYYON_EVAL_SYSTEM_PROMPT_SECTIONS): ` +
				`replacing section(s) [${keys.join(", ")}]. This is NOT the production prompt — expected only inside a benchmark arm.`,
		);
	}
	return overrides;
}

/**
 * Read eval-only statement overrides from `VEYYON_EVAL_SYSTEM_PROMPT_STATEMENTS`.
 * Fails closed and logs warnings when active.
 */
function resolveEvalStatementOverrides(): StatementOverrides {
	const overrides = parseStatementOverridesJson($env.VEYYON_EVAL_SYSTEM_PROMPT_STATEMENTS);
	const ids = Object.keys(overrides);
	if (ids.length === 0) return overrides;

	// Ablations and rewordings are reported separately because they are different experiments, and an
	// operator reading the log needs to know which arm they are looking at.
	const ablated = ids.filter(id => overrides[id] === null);
	const reworded = ids.filter(id => overrides[id] !== null);
	logger.warn(
		`EVAL-ONLY system-prompt STATEMENT override is ACTIVE (VEYYON_EVAL_SYSTEM_PROMPT_STATEMENTS): ` +
			`${ablated.length > 0 ? `ablating [${ablated.join(", ")}]` : "ablating nothing"}, ` +
			`${reworded.length > 0 ? `replacing [${reworded.join(", ")}]` : "replacing nothing"}. ` +
			`This is NOT the production prompt — expected only inside a benchmark arm.`,
	);
	return overrides;
}

/** Build the system prompt with tools, guidelines, and context */
export async function buildSystemPrompt(options: BuildSystemPromptOptions = {}): Promise<BuildSystemPromptResult> {
	if ($env.NULL_PROMPT === "true") {
		// No prompt was rendered, so there is no context it was rendered with.
		return {
			systemPrompt: [],
			statementContext: null,
			statementOverrides: null,
			replacedStatementSections: [],
		};
	}

	// Every gate fallback below comes from ONE table, `OMITTED_GATE_DEFAULTS`, rather than being
	// written inline here. Inline values made each default a second owner independent of the
	// setting's own default, and the table states what an omitted option means in one place.
	const {
		customPrompt,
		resolvedCustomPrompt: providedResolvedCustomPrompt,
		tools,
		appendSystemPrompt,
		inlineToolDescriptors: providedInlineToolDescriptors,
		resolvedAppendSystemPrompt: providedResolvedAppendPrompt,
		nativeTools = OMITTED_GATE_DEFAULTS.nativeTools,
		skillsSettings,
		toolNames: providedToolNames,
		cwd,
		agentDir: providedAgentDir,
		contextFiles: providedContextFiles,
		skills: providedSkills,
		rules,
		alwaysApplyRules,
		intentField,
		mcpDiscoveryMode = false,
		mcpDiscoveryServerSummaries = [],
		eagerTasks = OMITTED_GATE_DEFAULTS.eagerTasks,
		eagerTasksAlways = OMITTED_GATE_DEFAULTS.eagerTasksAlways,
		taskBatch = OMITTED_GATE_DEFAULTS.taskBatch,
		taskMaxConcurrency = OMITTED_GATE_DEFAULTS.taskMaxConcurrency,
		taskIrcEnabled = OMITTED_GATE_DEFAULTS.taskIrcEnabled,
		subagentNames = OMITTED_GATE_DEFAULTS.subagentNames,
		secretsEnabled = false,
		// `argotPreamble`, `argotHandles` and `secretInventory` are deliberately NOT
		// destructured here. They are option-backed runtime sections, so the assembler
		// reads them off `options` through the section registry (`section.input.key`).
		// Naming them here as well left two bindings for one value, one of them dead,
		// and a reader could not tell which one the prompt actually used.
		workspaceTree: providedWorkspaceTree,
		memoryRootEnabled = false,
		model,
		includeModelInPrompt = OMITTED_GATE_DEFAULTS.includeModelInPrompt,
		personality = OMITTED_GATE_DEFAULTS.personality,
		includeWorkspaceTree = OMITTED_GATE_DEFAULTS.includeWorkspaceTree,
		renderMermaid = OMITTED_GATE_DEFAULTS.renderMermaid,
		activeRepoContext: providedActiveRepoContext,
		sectionOrder,
	} = options;
	const inlineToolDescriptors = providedInlineToolDescriptors ?? OMITTED_GATE_DEFAULTS.inlineToolDescriptors;
	const resolvedCwd = cwd ?? getProjectDir();
	const resolvedAgentDir = path.resolve(providedAgentDir ?? getAgentDir());
	// Every agentConfiguration row derives from ONE dir, `resolvedAgentDir`, which is also
	// the dir the profile context file was inlined from. Two of the five rows used to come
	// from `getActiveProfileOrDefault` / `getProfileRootDir` instead, i.e. the
	// process-booted profile: a session rooted in another agent dir was handed a "Profile
	// AGENTS.md" path pointing at a DIFFERENT file than the one whose bytes were in its
	// own prompt, so a model told to update the instruction files edited the wrong
	// profile. The agent dir is always `<config root>/profiles/<name>/agent`, so the
	// profile name is its parent's basename.
	const activeProfileName = path.basename(path.dirname(resolvedAgentDir));

	const prepDefaults = {
		resolvedCustomPrompt: undefined as string | undefined,
		resolvedAppendPrompt: undefined as string | undefined,
		contextFiles: dedupeContainedContextFiles(providedContextFiles ?? []),
		skills: providedSkills ?? ([] as Skill[]),
		workspaceTree: {
			rootPath: resolvedCwd,
			rendered: "",
			truncated: false,
			totalLines: 0,
			agentsMdFiles: [],
		} satisfies WorkspaceTree,
		activeRepoContext: null as ActiveRepoContext | null,
		// Null means "no reason to complain", which is the right answer when the check could not run:
		// a prompt that timed out preparing must not assert the session is misrooted.
		nonProjectCwd: null as NonProjectReason | null,
		cpuModel: undefined as string | undefined,
		gpu: undefined as string | undefined,
		resolvedPersonality: {
			name: DEFAULT_PERSONALITY_NAME,
			text: BUILTIN_PERSONALITIES[DEFAULT_PERSONALITY_NAME],
		} as ResolvedPersonality,
	};

	const { promise: deadline, resolve: fireDeadline } = Promise.withResolvers<"__timeout__">();
	const deadlineTimer = setTimeout(() => fireDeadline("__timeout__"), SYSTEM_PROMPT_PREP_TIMEOUT_MS);
	// Unref so a fast prep does not hold a one-shot CLI alive waiting for this timer.
	deadlineTimer.unref();
	const timedOut: string[] = [];
	const failed: Array<{ name: string; error: unknown }> = [];

	async function withDeadline<T>(name: string, work: Promise<T>, fallback: T): Promise<T> {
		const tagged = work
			.then(value => ({ kind: "ok" as const, value }))
			.catch(error => ({ kind: "err" as const, error }));
		const result = await Promise.race([tagged, deadline]);
		if (result === "__timeout__") {
			timedOut.push(name);
			// Let the work continue in the background so its caches still warm; just log on completion.
			void tagged.then(r => {
				if (r.kind === "err") {
					logger.warn("Background system prompt preparation step failed", { name, error: String(r.error) });
				} else {
					logger.debug("Background system prompt preparation step completed after timeout", { name });
				}
			});
			return fallback;
		}
		if (result.kind === "err") {
			failed.push({ name, error: result.error });
			return fallback;
		}
		return result.value;
	}

	// Presence, not truthiness. Every array is truthy, so the old `providedContextFiles ? ... : ...`
	// spelling read as "a caller supplied files" while actually meaning "a caller supplied the key",
	// and a list some spawn site had filtered down to `[]` took the resolved branch and switched
	// discovery off with nothing said. The distinction is the same one the option's doc states, and
	// the empty case is announced rather than assumed, because it is far more often a filter that
	// ate the list than a caller that truly wants a prompt with no operator context.
	const contextFilesResolvedByCaller = providedContextFiles !== undefined;
	if (contextFilesResolvedByCaller && providedContextFiles.length === 0) {
		logger.warn("Context file discovery disabled: caller supplied an empty resolved list", {
			cwd: resolvedCwd,
			agentDir: resolvedAgentDir,
		});
	}
	const contextFilesPromise = contextFilesResolvedByCaller
		? Promise.resolve(providedContextFiles)
		: // Seed the global ~/.veyyon/AGENTS.md AND the LOADING profile's AGENTS.md
			// with their guidance headers on first run (idempotent once they exist),
			// then load the context layers. Both live outside the git checkout, so
			// they survive source updates, unlike a file edited inside ~/.veyyon/src.
			// The profile seeded is `resolvedAgentDir`, the one this prompt is for:
			// seeding the booted profile instead left the profile actually in use
			// without the persistent file the whole back-fill exists to give it.
			ensureManagedAgentsFilesOnStartup(resolvedAgentDir).then(() =>
				// `resolvedAgentDir` is forwarded so the profile scope follows the agent
				// this prompt is being built for, not whichever profile the process booted with.
				logger.time("loadProjectContextFiles", loadProjectContextFiles, {
					cwd: resolvedCwd,
					agentDir: resolvedAgentDir,
				}),
			);
	const workspaceTreePromise =
		providedWorkspaceTree !== undefined
			? Promise.resolve(providedWorkspaceTree)
			: includeWorkspaceTree
				? logger.time("buildWorkspaceTree", () =>
						buildWorkspaceTree(resolvedCwd, { timeoutMs: SYSTEM_PROMPT_PREP_TIMEOUT_MS }),
					)
				: Promise.resolve({
						rootPath: resolvedCwd,
						rendered: "",
						truncated: false,
						totalLines: 0,
						agentsMdFiles: [],
					});
	const skillsPromise: Promise<Skill[]> =
		providedSkills !== undefined
			? Promise.resolve(providedSkills)
			: skillsSettings?.enabled !== false
				? // `resolvedAgentDir` is forwarded for the same reason the context files above
					// forward it: all three profile-rooted skill providers (native, veyyon-managed,
					// veyyon-plugins) read it off the `LoadContext`, and without it they fall back to
					// the process-active profile and the prompt carries a stranger's skills.
					loadSkills({ ...skillsSettings, cwd: resolvedCwd, agentDir: resolvedAgentDir }).then(
						result => result.skills,
					)
				: Promise.resolve([]);
	const activeRepoContextPromise =
		providedActiveRepoContext !== undefined
			? Promise.resolve(providedActiveRepoContext)
			: logger.time("resolveActiveRepoContext", () => resolveActiveRepoContext(resolvedCwd));
	// Whether the session is rooted somewhere that is not a project at all. Prepared here, under the
	// same deadline as everything else, because it may stat the working directory and scan a bounded
	// way below it; a prompt is never worth blocking on.
	const nonProjectCwdPromise = logger.time("isNonProjectRoot", () => isNonProjectRoot(resolvedCwd));
	const cpuModelPromise = logger.time("getCpuModel", getCpuModel);
	const gpuPromise = logger.time("getCachedGpu", () => getCachedGpu(SYSTEM_PROMPT_PREP_TIMEOUT_MS));
	const personalityPromise: Promise<ResolvedPersonality> =
		personality === "none"
			? Promise.resolve({ name: "none", text: "" })
			: logger.time("resolvePersonality", () => resolvePersonality(personality, { cwd: resolvedCwd }));

	const [
		resolvedCustomPrompt,
		resolvedAppendPrompt,
		contextFiles,
		skills,
		workspaceTree,
		activeRepoContext,
		nonProjectCwd,
		cpuModel,
		gpu,
		resolvedPersonality,
	] = await Promise.all([
		withDeadline(
			"customPrompt",
			providedResolvedCustomPrompt !== undefined
				? Promise.resolve(providedResolvedCustomPrompt)
				: resolvePromptInput(customPrompt, "system prompt"),
			prepDefaults.resolvedCustomPrompt,
		),
		withDeadline(
			"appendSystemPrompt",
			providedResolvedAppendPrompt !== undefined
				? Promise.resolve(providedResolvedAppendPrompt)
				: resolvePromptInput(appendSystemPrompt, "append system prompt"),
			prepDefaults.resolvedAppendPrompt,
		),
		withDeadline("loadProjectContextFiles", contextFilesPromise, prepDefaults.contextFiles).then(
			dedupeContainedContextFiles,
		),
		withDeadline("loadSkills", skillsPromise, prepDefaults.skills),
		withDeadline("buildWorkspaceTree", workspaceTreePromise, prepDefaults.workspaceTree),
		withDeadline("resolveActiveRepoContext", activeRepoContextPromise, prepDefaults.activeRepoContext),
		withDeadline("isNonProjectRoot", nonProjectCwdPromise, prepDefaults.nonProjectCwd),
		withDeadline("getCpuModel", cpuModelPromise, prepDefaults.cpuModel),
		withDeadline("getCachedGpu", gpuPromise, prepDefaults.gpu),
		withDeadline("resolvePersonality", personalityPromise, prepDefaults.resolvedPersonality),
	]);
	clearTimeout(deadlineTimer);

	if (resolvedPersonality.warning) {
		logger.warn(resolvedPersonality.warning, { cwd: resolvedCwd, requested: personality });
		process.stderr.write(`Warning: ${resolvedPersonality.warning}\n`);
	}
	const agentsMdFiles = Array.from(new Set(workspaceTree.agentsMdFiles)).sort().slice(0, AGENTS_MD_LIMIT);

	if (timedOut.length > 0) {
		logger.warn("System prompt preparation steps timed out; using minimal fallback for those steps", {
			cwd: resolvedCwd,
			timeoutMs: SYSTEM_PROMPT_PREP_TIMEOUT_MS,
			steps: timedOut,
		});
		process.stderr.write(
			`Warning: system prompt preparation steps timed out after ${SYSTEM_PROMPT_PREP_TIMEOUT_MS}ms (${timedOut.join(", ")}); using minimal fallback for those steps.\n`,
		);
	}
	if (failed.length > 0) {
		for (const { name, error } of failed) {
			logger.warn("System prompt preparation step failed; using minimal fallback", {
				cwd: resolvedCwd,
				step: name,
				error: String(error),
			});
		}
	}

	const promptCwd = shortenPath(normalizePromptPath(resolvedCwd));

	// Build tool metadata for system prompt rendering.
	// Priority: explicit list > tools map > conservative SDK fallback.
	let toolNames = providedToolNames;
	if (!toolNames) {
		toolNames = tools ? Array.from(tools.keys()) : [...DEFAULT_SYSTEM_PROMPT_TOOL_NAMES];
	}

	// Build tool descriptions for system prompt rendering.
	const toolPromptNames = new Map<string, string>(toolNames.map(name => [name, tools?.get(name)?.wireName ?? name]));
	const toolRefs = Object.fromEntries(toolPromptNames.entries());
	// Provider-native mode emits no prompt inventory because the provider schemas
	// already carry it. Other modes render full `# Tool:` descriptor sections.
	const toolListMode = !inlineToolDescriptors && nativeTools;
	const toolInventory = toolListMode
		? ""
		: renderToolInventory(
				toolNames.map(name => {
					const meta = tools?.get(name);
					return {
						name: toolPromptNames.get(name) ?? name,
						description: meta?.description ?? "",
						parameters: meta?.parameters ?? ({ type: "object" } as TSchema),
						examples: meta?.examples,
					};
				}),
				model ?? "",
			);

	// Filter skills for the rendered system prompt:
	// - require the `read` tool so the model can actually fetch skill content;
	// - drop skills with frontmatter `hide: true` (still loadable via skill:// and /skill:<name>).
	const hasRead = toolNames.includes("read");
	const filteredSkills = hasRead ? skills.filter(skill => skill.hide !== true) : [];

	const contextPromptSources = contextFiles.map(file => file.content);
	const promptSources = [resolvedCustomPrompt, resolvedAppendPrompt, ...contextPromptSources];
	const injectedAlwaysApplyRules = dedupeAlwaysApplyRules(alwaysApplyRules, promptSources);

	const environment = getEnvironmentInfo(cpuModel, gpu);
	const data = {
		customPrompt: resolvedCustomPrompt,
		appendPrompt: resolvedAppendPrompt ?? "",
		tools: toolNames,
		hasTools: toolNames.length > 0,
		toolInventory,
		inlineToolDescriptors,
		toolListMode,
		toolRefs,
		environment,
		agentConfiguration: [
			{ label: "Active profile", value: activeProfileName },
			{ label: "Agent directory", value: resolvedAgentDir },
			{ label: "Skills directory", value: path.join(resolvedAgentDir, "skills") },
			{ label: "Global AGENTS.md", value: getGlobalAgentsPath() },
			{ label: "Profile AGENTS.md", value: path.join(resolvedAgentDir, "AGENTS.md") },
		],
		// Merged into the project section: same input (cwd), same lifetime, same
		// invalidation as the rest of the project framing.
		activeRepoRoot: activeRepoContext ? normalizePromptPath(activeRepoContext.relativeRepoRoot) : "",
		// Why the working directory is not a project, when it is not one. The prompt turns the reason
		// into the sentence that names it; an empty string is "nothing to say".
		nonProjectCwd: nonProjectCwd ? NON_PROJECT_REASON_TEXT[nonProjectCwd] : "",
		// Two halves of one ruling, split because only one of them is conditional. The file ladder
		// only means something when files are loaded, so it renders inside the context block's
		// `{{#if contextFiles.length}}` gate. "The user's live instruction is absolute" is a standing
		// safety boundary that must hold for a session with no context files at all, where a rule,
		// an always-apply rule, or a memory could still tell the model to refuse, so it renders
		// unconditionally from `project-prompt.md`. It sits in the PROJECT runtime section rather
		// than in the cached prefix, so it costs no prefix-cache invalidation.
		userInstructionAuthority: sessionPrompts["session/user-instruction-authority"].text.trim(),
		contextFileAuthority: sessionPrompts["session/context-file-authority"].text.trim(),
		contextFiles,
		agentsMdSearch: { files: agentsMdFiles },
		workspaceTree,
		skills: filteredSkills,
		rules: rules ?? [],
		alwaysApplyRules: injectedAlwaysApplyRules,
		cwd: promptCwd,
		model: includeModelInPrompt ? (model ?? "") : "",
		useCodexTaskPrompt: usesCodexTaskPrompt(model),
		personality: resolvedPersonality.text,
		intentTracing: !!intentField,
		intentField: intentField ?? "",
		mcpDiscoveryMode,
		hasMCPDiscoveryServers: mcpDiscoveryServerSummaries.length > 0,
		mcpDiscoveryServerSummaries,
		eagerTasks,
		eagerTasksAlways,
		taskBatch,
		MAX_CONCURRENCY: normalizeConcurrencyLimit(taskMaxConcurrency),
		taskIrcEnabled,
		subagentNames,
		// Whether ANYTHING can be spawned, which gates the delegation guidance as a whole.
		//
		// The task tool is built whenever `subagent.enabled` is on, and it stays built with every agent
		// row disabled ON PURPOSE, because an ephemeral `/` command that names an agent is the operator
		// asking directly and is granted per turn. The model-facing PROSE is a different matter: with
		// nothing the model may choose, "fan the work out" is an instruction it can only fail, and the
		// agent-typing bullet interpolated an empty list and read "Only one agent type is enabled here
		// (``)" while telling the model to delegate for parallelism. `resolveDelegation` has always
		// computed this state and named it `blockedBy: "no-enabled-agents"`; nothing consumed it.
		hasSpawnableSubagent: subagentNames.length > 0,
		secretsEnabled,
		hasMemoryRoot: memoryRootEnabled,
		hasObsidian: hasObsidian(),
		includeWorkspaceTree,
		renderMermaid,
	};
	// A `VEYYON_EVAL_PROMPTS` id this build does not have is refused here, against the
	// generated id space of every registry. Assembly is before the first model call, so a
	// typo costs one hard error instead of an arm's worth of trials that quietly ran the
	// shipped prompt under a treatment's name.
	assertEvalPromptOverrideIdsExist();
	const evalSectionOverrides = resolveEvalSectionOverrides();
	const evalStatementOverrides = resolveEvalStatementOverrides();
	const overriddenStatementIds = Object.keys(evalStatementOverrides);
	const hasCustomPrompt = resolvedCustomPrompt !== undefined;
	if (hasCustomPrompt && overriddenStatementIds.length > 0) {
		throw new Error(
			"VEYYON_EVAL_SYSTEM_PROMPT_STATEMENTS cannot be combined with a custom system prompt " +
				"(--system-prompt): a custom prompt contains no registered statements to override.",
		);
	}
	for (const id of overriddenStatementIds) {
		const statement = statementById(id);
		if (statement !== undefined && !conditionHolds(statement.condition, data)) {
			throw new Error(
				`statement override for "${id}" is inactive for this prompt configuration; ` +
					`its condition (${JSON.stringify(statement.condition)}) does not hold`,
			);
		}
	}
	// The eval instrument wins outright and SUPPRESSES the file surface rather
	// than merging with it. A benchmark arm must measure the prompt it declared;
	// letting a `PROMPT_SECTIONS/` directory on the machine running the arm mix
	// into it would silently contaminate the result.
	const usingEvalOverrides = Object.keys(evalSectionOverrides).length > 0;
	const sectionOverrideFiles = await loadSectionOverrideFiles({ cwd: resolvedCwd });
	if (usingEvalOverrides && sectionOverrideFiles.length > 0) {
		logger.warn(
			`${PROMPT_SECTIONS_DIR}/ overrides are present but IGNORED because ` +
				"VEYYON_EVAL_SYSTEM_PROMPT_SECTIONS is set; the benchmark payload is the only section source.",
		);
	}

	const replacedStatementSections = usingEvalOverrides
		? TEMPLATE_SECTIONS.filter(section => Object.hasOwn(evalSectionOverrides, kebabToCamel(section.id))).map(
				section => section.id,
			)
		: [...new Set(sectionOverrideFiles.filter(file => file.mode === "replace").map(file => file.id))];
	const overriddenStatementSections = new Set(overriddenStatementIds.map(id => id.slice(0, id.indexOf("/"))));
	const overlappingSections = replacedStatementSections.filter(section => overriddenStatementSections.has(section));
	if (overlappingSections.length > 0) {
		throw new Error(
			`statement overrides cannot be combined with whole-section replacements for ` +
				`[${overlappingSections.join(", ")}]: the section replacement would silently discard the statement arm`,
		);
	}

	const hasSectionOverrides = usingEvalOverrides || sectionOverrideFiles.length > 0;
	if (hasCustomPrompt && hasSectionOverrides) {
		// A custom prompt has no registry sections. Refuse the conflict before
		// assembling the static statement map that the custom prompt would discard.
		const source = usingEvalOverrides
			? "VEYYON_EVAL_SYSTEM_PROMPT_SECTIONS"
			: `${PROMPT_SECTIONS_DIR}/ overrides (${sectionOverrideFiles.map(file => file.path).join(", ")})`;
		throw new Error(
			`${source} cannot be combined with a custom system prompt ` +
				"(--system-prompt): a custom prompt has no banner sections to override. Use one or the other.",
		);
	}

	let baseTemplate: string;
	if (hasCustomPrompt) {
		baseTemplate = sessionPrompts["session/custom-system-prompt"].text;
	} else {
		// Build statement sections only for the default prompt. Append-mode
		// overrides extend exactly what this session would otherwise send.
		const statementSections = assembleStatementSections(data, evalStatementOverrides);
		const sectionOverrides = usingEvalOverrides
			? evalSectionOverrides
			: applySectionOverrides(sectionOverrideFiles, statementSections);
		baseTemplate = assembleDefaultTemplate({ ...statementSections, ...sectionOverrides });
	}
	const rendered = prompt.render(baseTemplate, data);
	const reorderSections = Boolean(sectionOrder && sectionOrder.length > 0);
	if (reorderSections && hasCustomPrompt) {
		logger.warn("harness promptSectionOrder is ignored for custom system prompt templates (no banner sections)");
	}
	// Custom prompt templates already render context files and append text; the
	// project footer still carries environment, cwd, workspace, and dir-context.
	const projectPrompt = prompt
		.render(
			sessionPrompts["session/project-prompt"].text,
			hasCustomPrompt ? { ...data, contextFiles: [], appendPrompt: "" } : data,
		)
		.trim();

	// Runtime sections are assembled from the ONE registry, by section id. Order is
	// the registry's order, so it is declared data rather than an artifact of the
	// order statements happen to appear in this function, and a section cannot
	// reach the model without being registered.
	//
	// Keyed by the COMPUTED ids the registry derives from each row's `input.kind`,
	// so this map covers exactly the sections this function is responsible for:
	// registering a computed section without supplying its text is a compile error
	// here, and registering an OPTION-backed one does not touch this map at all.
	//
	// The shorthand sections teach the notation (and the load-yourself instruction)
	// whenever the encode gate is open, plus the concrete handle table once a
	// project is loaded. Dictionaries live in a local cache outside the repository,
	// so the model learns handles from these sections, not by reading a file. The
	// caller decides per turn whether to teach (model allowlist + context cutoff);
	// decoding is unconditional and runs at the seams.
	// Only COMPUTED sections are listed here — the ones this function produces
	// itself. Option-backed sections are read through the registry below, so their
	// text cannot be wired to the wrong option or silently left unwired.
	const computedText: Record<ComputedRuntimeSectionId, string | undefined> = {
		project: projectPrompt,
	};
	// No casts on either branch, and that is the point rather than tidiness. Both
	// sides used to be asserted (`as keyof BuildSystemPromptOptions`, `as
	// ComputedRuntimeSectionId`), which is what let the registry and this function
	// drift apart in silence: an option key that named no field read `undefined`,
	// and a section reclassified as computed missed the map and read `undefined`
	// too. Either way the section rendered nothing and the build stayed green.
	// Indexing with the registry's own literal types makes both of those a
	// compile error at the index itself.
	const runtimeText = (section: RuntimeSectionEntry): string | undefined =>
		isOptionBackedSection(section) ? options[section.input.key] : computedText[section.id];

	// Each runtime section is emitted as its own array entry, carrying the banner
	// the registry owns. Separate entries are a CACHING contract, not a structural
	// tier: `rendered` is the byte-stable prefix a provider can cache, and a
	// volatile section (the handle table changes whenever a dictionary loads) must
	// not sit inside it. Every entry is a banner section, so `splitPromptSections`
	// addresses runtime and template sections identically.
	const systemPrompt: string[] = rendered || !hasCustomPrompt ? [rendered] : [];
	for (const section of RUNTIME_SECTIONS) {
		const text = withSectionBanner(section, runtimeText(section));
		if (text) systemPrompt.push(text);
	}

	// One ordering pass over the WHOLE prompt. Template and runtime sections are
	// permuted from the same list, so a harness profile can move the shorthand
	// section the same way it moves tool-policy — the capability the appended tier
	// never had.
	return {
		systemPrompt:
			reorderSections && !hasCustomPrompt
				? applyPromptSectionOrderToParts(systemPrompt, sectionOrder)
				: systemPrompt,
		// A custom prompt is not assembled from statements, so pricing them against this context
		// would attribute cost to text the operator replaced.
		statementContext: hasCustomPrompt ? null : data,
		statementOverrides: hasCustomPrompt ? null : evalStatementOverrides,
		replacedStatementSections: hasCustomPrompt ? [] : replacedStatementSections,
	};
}
