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

export function dedupeAlwaysApplyRules(
	alwaysApplyRules: AlwaysApplyRule[] | undefined,
	promptSources: Array<string | null | undefined>,
): AlwaysApplyRule[] {
	if (!alwaysApplyRules || alwaysApplyRules.length === 0) return [];

	return alwaysApplyRules.filter(
		rule => !promptSources.some(source => promptSourceContainsRule(source, rule.content)),
	);
}

const SYSTEM_PROMPT_PREP_TIMEOUT_MS = 5000;

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

const PROMPT_FILE_EXTENSIONS = ["md", "markdown", "txt", "text", "prompt"] as const;

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
	cwd?: string;
	agentDir?: string;
}

type ScopedContextFile = {
	path: string;
	content: string;
	depth?: number;
	level: ContextFile["level"];
};

const CONTEXT_SCOPE_AUTHORITY: Record<ContextFile["level"], number> = { project: 0, user: 1, global: 2 };

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

export async function loadProjectContextFilesWithWarnings(
	options: LoadContextFilesOptions = {},
): Promise<{ files: ContextFileEntry[]; warnings: string[] }> {
	const resolvedCwd = options.cwd ?? getProjectDir();
	const resolvedAgentDir = path.resolve(options.agentDir ?? getAgentDir());

	const result = await loadCapability<ContextFile>(contextFileCapability.id, {
		cwd: resolvedCwd,
		agentDir: resolvedAgentDir,
	});
	const warnings = result.warnings.slice();

	const files: ScopedContextFile[] = await Promise.all(
		result.items.map(async item => ({
			path: item.path,
			content: await expandAtImports(item.content, item.path),
			depth: item.depth,
			level: item.level,
		})),
	);

	files.sort((a, b) => {
		const rankDelta = CONTEXT_SCOPE_AUTHORITY[a.level] - CONTEXT_SCOPE_AUTHORITY[b.level];
		if (rankDelta !== 0) return rankDelta;
		return (b.depth ?? -1) - (a.depth ?? -1);
	});

	return {
		files: dedupeContainedContextFiles(files, file => CONTEXT_SCOPE_AUTHORITY[file.level]).map(
			({ path, content, depth, level }) => ({ path, content, depth, level }),
		),
		warnings,
	};
}

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
	wireName?: string;
	parameters?: TSchema;
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

export interface BuildSystemPromptOptions extends Partial<GateInputs> {
	customPrompt?: string;
	resolvedCustomPrompt?: string;
	tools?: Map<string, SystemPromptToolMetadata>;
	toolNames?: string[];
	appendSystemPrompt?: string;
	resolvedAppendSystemPrompt?: string;
	skillsSettings?: SkillsSettings;
	cwd?: string;
	agentDir?: string;
	contextFiles?: Array<{ path: string; content: string; depth?: number }>;
	skills?: Skill[];
	rules?: Array<{ name: string; description?: string; path: string; globs?: string[] }>;
	mcpDiscoveryMode?: boolean;
	mcpDiscoveryServerSummaries?: string[];
	alwaysApplyRules?: AlwaysApplyRule[];
	secretsEnabled?: boolean;
	secretInventory?: string;
	argotPreamble?: string;
	argotHandles?: string;
	workspaceTree?: WorkspaceTree | Promise<WorkspaceTree>;
	memoryRootEnabled?: boolean;
	model?: string;
	activeRepoContext?: ActiveRepoContext | null;
	sectionOrder?: readonly string[];
}

export interface BuildSystemPromptResult {
	systemPrompt: string[];
	statementContext: StatementContext | null;
	statementOverrides: StatementOverrides | null;
	replacedStatementSections: readonly string[];
}

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

function resolveEvalStatementOverrides(): StatementOverrides {
	const overrides = parseStatementOverridesJson($env.VEYYON_EVAL_SYSTEM_PROMPT_STATEMENTS);
	const ids = Object.keys(overrides);
	if (ids.length === 0) return overrides;

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

export async function buildSystemPrompt(options: BuildSystemPromptOptions = {}): Promise<BuildSystemPromptResult> {
	if ($env.NULL_PROMPT === "true") {
		return {
			systemPrompt: [],
			statementContext: null,
			statementOverrides: null,
			replacedStatementSections: [],
		};
	}

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
			ensureManagedAgentsFilesOnStartup(resolvedAgentDir).then(() =>
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
					loadSkills({ ...skillsSettings, cwd: resolvedCwd, agentDir: resolvedAgentDir }).then(
						result => result.skills,
					)
				: Promise.resolve([]);
	const activeRepoContextPromise =
		providedActiveRepoContext !== undefined
			? Promise.resolve(providedActiveRepoContext)
			: logger.time("resolveActiveRepoContext", () => resolveActiveRepoContext(resolvedCwd));
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

	let toolNames = providedToolNames;
	if (!toolNames) {
		toolNames = tools ? Array.from(tools.keys()) : DEFAULT_SYSTEM_PROMPT_TOOL_NAMES.slice();
	}

	const toolPromptNames = new Map<string, string>(toolNames.map(name => [name, tools?.get(name)?.wireName ?? name]));
	const toolRefs = Object.fromEntries(toolPromptNames.entries());
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
		activeRepoRoot: activeRepoContext ? normalizePromptPath(activeRepoContext.relativeRepoRoot) : "",
		nonProjectCwd: nonProjectCwd ? NON_PROJECT_REASON_TEXT[nonProjectCwd] : "",
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
		hasSpawnableSubagent: subagentNames.length > 0,
		secretsEnabled,
		hasMemoryRoot: memoryRootEnabled,
		hasObsidian: hasObsidian(),
		includeWorkspaceTree,
		renderMermaid,
	};
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
		: Array.from(new Set(sectionOverrideFiles.filter(file => file.mode === "replace").map(file => file.id)));
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
	const projectPrompt = prompt
		.render(
			sessionPrompts["session/project-prompt"].text,
			hasCustomPrompt ? { ...data, contextFiles: [], appendPrompt: "" } : data,
		)
		.trim();

	const computedText: Record<ComputedRuntimeSectionId, string | undefined> = {
		project: projectPrompt,
	};
	const runtimeText = (section: RuntimeSectionEntry): string | undefined =>
		isOptionBackedSection(section) ? options[section.input.key] : computedText[section.id];

	const systemPrompt: string[] = rendered || !hasCustomPrompt ? [rendered] : [];
	for (const section of RUNTIME_SECTIONS) {
		const text = withSectionBanner(section, runtimeText(section));
		if (text) systemPrompt.push(text);
	}

	return {
		systemPrompt:
			reorderSections && !hasCustomPrompt
				? applyPromptSectionOrderToParts(systemPrompt, sectionOrder)
				: systemPrompt,
		statementContext: hasCustomPrompt ? null : data,
		statementOverrides: hasCustomPrompt ? null : evalStatementOverrides,
		replacedStatementSections: hasCustomPrompt ? [] : replacedStatementSections,
	};
}
