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
import { formatLocalCalendarDate } from "./utils/local-date";
import { normalizePromptPath } from "./utils/prompt-path";
import { AGENTS_MD_LIMIT, buildWorkspaceTree, type WorkspaceTree } from "./workspace-tree";

export interface AlwaysApplyRule {
	name: string;
	content: string;
	path: string;
}

/**
 * Compile-time proof that every option key the registry declares is a REAL
 * `BuildSystemPromptOptions` field carrying string text.
 *
 * The registry cannot import this interface (that would be a cycle), so it
 * declares keys as strings. This check is what stops that from being a typo
 * channel: renaming or removing an option fails the build here instead of leaving
 * a section reading an undefined field forever.
 *
 * IT DID NOT DO THAT. The previous version mapped the registry's keys through
 * `section.input.key as StringOptionKeys` and annotated the result. A cast
 * asserts a type rather than checking one, so it accepted anything: pointing the
 * shorthand section at a key that existed nowhere compiled clean, and the section
 * would have rendered nothing for good. The comment above it claimed the
 * opposite, which is the part that made it worse than no check — a reader had a
 * stated reason not to look.
 *
 * The version below has no cast. `OptionBackedSectionKey` is a union of literals
 * (the registry keeps them now), so a key that is not a string-valued field of
 * this interface survives the `Exclude` and the initializer stops being
 * assignable. The failure names the offending key inside the expected type rather
 * than pointing at an index expression somewhere else.
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
 * How long prompt preparation may spend on its slow lookups before falling back.
 *
 * The prompt's budget, and the only place it is stated. The GPU probe is given it as
 * an argument rather than reading it across a module boundary, so the probe's own
 * margin (it must survive its deadline long enough to write the null cache) stays
 * with the probe.
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
 * Resolve a prompt option that may be a file path or the prompt text itself.
 *
 * THE BUG THIS FIXES. Any read failure used to return the input unchanged, with
 * `ENOENT` explicitly excluded from the warning, so a missing file said nothing at
 * all. `--system-prompt ./promtps/main.md` with a typo in the directory therefore
 * gave the model a system prompt whose entire content was the string
 * `./promtps/main.md`. That is not a degraded prompt, it is no prompt: every rule,
 * tool policy and workflow the agent depends on is gone, the session behaves nothing
 * like it should, and the only clue is that the run went strangely. The same held for
 * `--append-system-prompt` and `TITLE_SYSTEM.md`.
 *
 * HOW A FAILURE IS JUDGED. The read is still attempted first, because that is the
 * only test that costs nothing when it succeeds and it keeps working for a path
 * containing spaces. What changed is the answer when it fails:
 *
 *   - No whitespace anywhere AND it looks like a path (a separator, or a prompt-file
 *     extension): a path was unmistakably meant, so the failure is raised with the
 *     option, the path and the underlying error. Nothing about `./promtps/main.md`
 *     is a prompt.
 *   - Anything else is prose and is used as prose. A one-line instruction can easily
 *     contain a slash ("write in the style of Strunk/White") or end in a word with a
 *     dot, and refusing those would break a supported way to pass a prompt.
 *
 * Multi-line input is text by definition, since no path contains a newline.
 *
 * `looksLikeFilePath` is shared rather than spelled out here — Anthropic's
 * certificate options ask the same question — with the extension list per domain.
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
	 *
	 * It reaches the providers through `LoadOptions.agentDir` and lands on every
	 * `LoadContext`, so the profile scope is a function of this value rather than of
	 * whichever profile the process booted with. A caller running on behalf of an
	 * agent rooted in a different agent dir used to have no way to say so and
	 * silently got the active profile's files instead of its own.
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
 * Authority rank of a context-file scope, ascending.
 *
 * ONE table owns both the render order and the dedupe survivor, so the two can
 * no longer disagree. The sort below emits least authoritative first, which puts
 * the strongest file in the last and highest-recency slot; the dedupe keeps the
 * highest-ranked copy of duplicated text.
 *
 * `project` is lowest because a project file is content checked into a repository
 * the operator may not have written. `global` is highest because it is the
 * operator's own cross-profile configuration. `user` is the active profile's own
 * file and sits between them. The model-facing statement of the same ladder lives
 * in `prompts/session/context-file-authority.md`; keep the two in agreement.
 */
const CONTEXT_SCOPE_AUTHORITY: Record<ContextFile["level"], number> = { project: 0, user: 1, global: 2 };

/**
 * Drop a context file whose entire normalized paragraph sequence is already
 * contained in a copy that OUTRANKS it.
 *
 * Outranking is AUTHORITY first and position second, and that order is the whole
 * point. The survivor's `<file path=...>` label is what tells the model which
 * rules it is reading, so choosing by position alone re-attributes the operator's
 * global rules to whichever project file happens to quote them: identical bytes,
 * wrong provenance, and a repository's file wearing the authority of the user's
 * own configuration. Inverting the render order silently flipped exactly that,
 * which is why the rank is read from `CONTEXT_SCOPE_AUTHORITY` rather than from
 * where a file landed in the array.
 *
 * Position still breaks ties WITHIN one scope, where it is the real ordering: the
 * project file closest to cwd is the most specific project rule and keeps the
 * copy. Only bytes are dropped, never rewritten, so a longer project file that
 * quotes a shorter global one keeps both: the global copy survives on rank, and
 * the project file is left exactly as its author wrote it.
 *
 * A caller that supplies its own `contextFiles` array has no scope information to
 * give and gets the position-only tie-break for every pair, which is the same
 * contract the rest of that path follows: an explicit array is rendered as handed
 * over.
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
 * Load the context files for a session, all three scopes, and report what could
 * not be read.
 *
 * SCOPES. Resolution order is global, then profile, then project: profile is
 * resolved after global because it refines it, and project is the cwd walk.
 *
 *   - global  - the cross-profile `<config root>/AGENTS.md`.
 *   - profile - the agent dir's own instruction file, first hit on the ladder
 *               `<agentDir>/AGENTS.md`, `<profileDir>/AGENTS.md`,
 *               `<agentDir>/agent.md`, `<profileDir>/agent.md`. `options.agentDir`
 *               picks WHICH agent dir, so an agent that is not the active profile
 *               gets its own file and exactly one profile file is ever returned.
 *   - project - the repo-root-to-cwd walk, one file per directory. Which file a
 *               directory contributes is owned by `PROJECT_RULE_FILE_NAMES` in
 *               `discovery/builtin.ts`; it is not restated here.
 *
 * AUTHORITY is a different axis and the returned array is sorted by it, LEAST
 * authoritative first so the strongest file holds the last and highest-recency
 * slot: project (descending depth, so the repo root comes first and the file
 * closest to cwd comes last) → profile → GLOBAL LAST. The operator's own
 * cross-profile configuration therefore wins, and a repository that happens to be
 * checked out cannot outrank it. The ranks live in `CONTEXT_SCOPE_AUTHORITY`, which
 * the dedupe reads too. See `ContextFile.level` in capability/context-file.ts.
 *
 * ONE OWNER. All three scopes come from the capability providers, and the native
 * provider resolves global and profile from `LoadContext.agentDir` (fed by
 * `options.agentDir` below), so this function orders and dedupes what it is given
 * and reads no file itself. It used to re-resolve global and profile here and key
 * them by absolute path against the provider results, because the provider read the
 * process-global profile and had to be corrected. That is fixed at the source
 * (discovery/builtin.ts), and the pass was proved to change nothing on 16 fixtures
 * except one case where it was actively wrong: with `native` in `disabledProviders`
 * it re-added veyyon's two scopes anyway, overriding the operator's own setting.
 *
 * A file whose content is nothing but its managed guidance header contributes
 * nothing, by design (that is the seeded, unedited state). It never suppresses
 * another scope. The provider strips that header.
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
 * {@link loadProjectContextFilesWithWarnings} for callers that only want the
 * files: the same three scopes resolved the same way and ranked by the same
 * authority ladder, with every warning logged instead of returned.
 *
 * Logging rather than dropping is the point. A context file that exists and
 * cannot be read used to disappear into an empty list, and an empty list renders
 * as nothing at all, so the operator saw a prompt with no rules and no reason.
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
 * Everything `buildSystemPrompt` takes.
 *
 * The SETTINGS-FED gates are not listed here: they are `Partial<GateInputs>`, declared once in
 * `system-prompt-builder/gate-inputs.ts` alongside the resolver that fills them from settings and the
 * table that says what an omitted one is worth. They used to be declared in both places, with two doc
 * comments and two statements of each default; a session and the `veyyon prompt` inspector then read
 * one and the builder read the other.
 *
 * `Partial` because every gate is optional to a caller: omitting one means "no configuration to
 * offer", which {@link OMITTED_GATE_DEFAULTS} answers, and that is deliberately not the same as what a
 * default session resolves. `test/core/prompt-gate-inputs.test.ts` measures the difference.
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
	 * Context files this caller has ALREADY resolved. Presence, not length, is the switch:
	 *
	 * - `undefined` means "not resolved": this function runs the discovery walk itself.
	 * - `[]` means "resolved, and there are genuinely none": discovery is TURNED OFF and the
	 *   prompt ships with zero context files. That is a real caller intent (the legacy resource
	 *   loader's `noContextFiles: true` opt-out passes exactly this), which is why an empty array
	 *   is not quietly re-interpreted as "go look".
	 *
	 * So `contextFiles: someArray` at a call site is never harmless data passing. Handing this a
	 * list that a filter reduced to `[]` disables every scope the operator wrote, which is how
	 * three spawn sites silently stripped every `AGENTS.md` from every subagent. A caller that
	 * cannot resolve its own list passes `undefined`, never `[]`; see
	 * `task/context-inheritance.ts`, which returns `undefined` for exactly this reason. Taking the
	 * empty branch is logged, so an accidental `[]` is visible in the operator's log instead of
	 * showing up as a model that stopped following the rules.
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
	 * The rendered AVAILABLE SECRETS body: the credential placeholders this session
	 * can actually spend, one per name, values never included.
	 *
	 * `secretsEnabled` above says only that redaction is running, which is why it was
	 * not enough on its own: the vault outlives a session, so a fresh one had a live
	 * `#GITHUB_TOKEN#` it was never told about and could not use. The caller reads the
	 * names off the live obfuscator AT BUILD TIME (`namedSecretNames()`, which expires
	 * stale entries while answering) and renders them through
	 * `system-prompt-builder/secret-inventory.ts`, so a revoked or lapsed name is gone
	 * from the next build with no extra plumbing.
	 *
	 * Undefined when protection is off or the vault is empty; the section is optional,
	 * so undefined emits no banner at all rather than an empty heading.
	 */
	secretInventory?: string;
	/**
	 * The fixed argot notation block (the SDK's `renderPreamble({ tools: true })`),
	 * injected when the encode gate lets this model write shorthand: the active
	 * model is on the allowlist and the context is under the cutoff, resolved by
	 * the caller via the argot SDK's `shouldEncode`. It teaches the notation and
	 * tells the model to load its project itself through the argot_load tool.
	 * It gates only teaching; decoding (expansion) is unconditional and handled
	 * at the seams.
	 */
	argotPreamble?: string;
	/**
	 * The argot handle table to teach the model: a self-contained block listing
	 * each `§handle → expansion` for the loaded projects, produced by the SDK's
	 * `ArgotSession.promptFragment`. Present only when the encode gate is on and
	 * the model has loaded a project's shorthand; the dictionary lives in a local
	 * cache outside the repository, so this block is how the model learns the
	 * handles at all.
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
	 * The template data these blocks were rendered with.
	 *
	 * Returned for `prompt-inspect`, which prices each statement by re-assembling its section one
	 * statement at a time. Doing that against re-resolved inputs would price a prompt nobody was
	 * sent, since the resolution is where the settings, the tool set and the model profile all land.
	 *
	 * `null` means these blocks did not come from the statement registry: a custom system prompt
	 * replaced the assembly, or `NULL_PROMPT` suppressed it. Null rather than an empty context on
	 * purpose. An empty context evaluates every condition as false and reads as a legitimate cost
	 * breakdown of a minimal prompt, so a consumer would report statement costs for statements this
	 * prompt does not contain. A consumer has to handle the absence, and cannot mistake it for data.
	 */
	statementContext: StatementContext | null;
	/** Effective per-statement replacements used to assemble the returned blocks. */
	statementOverrides: StatementOverrides | null;
	/** Static sections whose shipped statements were replaced wholesale. */
	replacedStatementSections: readonly string[];
}

/**
 * Read the EVAL-ONLY per-section prompt override.
 *
 * WHY AN ENV VAR AND NOT CONFIG: a per-section override is a benchmark
 * instrument, not a product feature. If it lived in the config schema, any
 * `config.yml` — on a developer's machine or in production — could silently
 * swap a section of the system prompt, which is exactly the contamination this
 * must never allow. It is therefore reachable ONLY through
 * `VEYYON_EVAL_SYSTEM_PROMPT_SECTIONS`, an env var the deepswe-bench harness
 * sets around a single arm and nothing else sets. There is no config key, no
 * CLI flag, and no `BuildSystemPromptOptions` field — so a normal run cannot
 * reach this path at all.
 *
 * FAIL-CLOSED + LOUD: when the var is absent or empty the production prompt is
 * used verbatim (returns `{}`). When it IS present the override engages and we
 * `logger.warn` so the operator cannot mistake a benchmark run for a production
 * one; a malformed payload throws (see {@link parseSectionOverridesJson})
 * rather than silently reverting to production, which would invalidate the eval
 * while looking like it succeeded.
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
 * Read the EVAL-ONLY per-STATEMENT override, which is how a single rule is ablated or reworded.
 *
 * Same instrument as {@link resolveEvalSectionOverrides}, one level finer, and deliberately the same
 * shape: env var only, fail closed, warn loudly. A section override answers "is this section pulling
 * its weight", which is too coarse to act on when TOOL POLICY is one section and 34 rules. This
 * answers "is THIS RULE pulling its weight", which is the question an eval can actually attribute a
 * score change to.
 *
 * `VEYYON_EVAL_SYSTEM_PROMPT_STATEMENTS` is a JSON object of statement id to replacement text, or to
 * `null` to remove the rule entirely. There is no config key and no CLI flag, for the reason spelled
 * out above the section reader: a config-reachable prompt override could silently contaminate a
 * production run, and a contaminated eval reports a number that looks valid.
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

	const date = formatLocalCalendarDate();
	const dateTime = date;
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
		date,
		dateTime,
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
