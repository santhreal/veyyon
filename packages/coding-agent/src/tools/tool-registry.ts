import type {
	AgentTelemetryConfig,
	AgentTool,
	AgentToolContext,
	ThinkingLevel,
	ToolCallContext,
} from "@veyyon/agent-core";
import type { FetchImpl, ImageContent, Model, ServiceTierByFamily, ToolChoice } from "@veyyon/ai";
import type { InMemorySnapshotStore } from "@veyyon/hashline";
import { logger } from "@veyyon/utils";
import { ARGOT_LOAD_TOOL, ARGOT_UNLOAD_TOOL } from "argot/constants";
import type { ArgotSession } from "argot/session";
import type { AsyncJobManager } from "../async/job-manager";
import type { ContextFile } from "../capability/context-file";
import type { Rule } from "../capability/rule";
import type { PromptTemplate } from "../config/prompt-templates";
import type { Settings } from "../config/settings";
import type { ToolPathWithSource } from "../extensibility/custom-tools";
import type { Skill } from "../extensibility/skills";
import type { GoalModeState, GoalRuntime } from "../goals";
import type { HindsightSessionState } from "../hindsight/state";
import type { LocalProtocolOptions } from "../internal-urls";
import type { MCPManager } from "../mcp";
import type { MnemopiSessionState } from "../mnemopi/state";
import type { PlanModeState } from "../plan-mode/state";
import type { AgentRegistry } from "../registry/agent-registry";
import type { ArtifactManager } from "../session/artifacts";
import type { ClientBridge } from "../session/client-bridge";
import type { CustomMessage } from "../session/messages";
import type { SubagentSpawnRecord, UsageStatistics } from "../session/session-entries";
import type { SideCompleteImpl } from "../session/side-complete";
import type { ToolChoiceQueue } from "../session/tool-choice-queue";
import type { AgentOutputManager } from "../task/output-manager";
import { delegationEnabled, resolveSessionMaxNestedSpawnDepth } from "../task/subagent-settings";
import { canSpawnAtDepth } from "../task/types";
import type { ConfiguredThinkingLevel } from "../thinking";
import { resolveEffectiveToolDiscoveryMode } from "../tool-discovery/mode";
import type { DiscoverableTool, DiscoverableToolSearchIndex } from "../tool-discovery/tool-index";
import type { EventBus } from "../utils/event-bus";
import type { WorkspaceTree } from "../workspace-tree";
import { type BuiltinToolName, type HiddenToolName, normalizeToolNames, TOOL } from "./builtin-names";
import type { CheckpointState, CompletedRewindState } from "./checkpoint";
import { resolveEvalBackends } from "./eval-backends";
import { isIrcEnabled } from "./irc-enabled";
import {
	augmentRequestedToolNames,
	type BuiltinToolPermissionInputs,
	countToolsForAutoDiscovery,
	isBuiltinToolAllowed,
	resolveEssentialToolNames,
	resolveEvalToolAvailability,
	selectBaseToolNames,
	withYieldToolAppended,
} from "./loading";
import { wrapToolWithMetaNotice } from "./output-meta";
import { RerootDetector, wrapToolWithRerootHint } from "./reroot-hint";
import type { TodoPhase } from "./todo";

export {
	type BuiltinToolLoadMode,
	DEFAULT_ESSENTIAL_TOOL_NAMES,
	filterInitialToolsForDiscoveryAll,
} from "./loading";
export type { ReadToolDetails, ReadToolInput } from "./read";
export type { WriteToolInput } from "./write";

export type Tool = AgentTool<any, any, any>;

export type ContextFileEntry = {
	path: string;
	content: string;
	depth?: number;
	level?: ContextFile["level"];
};

export type ImageAttachmentEntry = {
	label: string;
	uri: string;
	image: ImageContent;
};

export type {
	DiscoverableTool,
	DiscoverableToolSearchIndex,
	DiscoverableToolSearchResult,
	DiscoverableToolSource,
} from "../tool-discovery/tool-index";

export interface DeferredDiagnosticsEntry {
	path: string;
	summary: string;
	messages: string[];
	errored: boolean;
	isStale(): boolean;
}

export interface ToolSession {
	cwd: string;
	setCwd?(resolvedPath: string, options?: { validate?: boolean }): Promise<string>;
	obfuscateProviderText?: (text: string) => string;
	sideComplete?: SideCompleteImpl;
	hasUI: boolean;
	readonly thinkingLevel?: ThinkingLevel;
	suppressSpawnAdvisory?: boolean;
	fetch?: FetchImpl;
	skipPythonPreflight?: boolean;
	contextFiles?: ContextFileEntry[];
	workspaceTree?: WorkspaceTree;
	skills?: Skill[];
	promptTemplates?: PromptTemplate[];
	rules?: Rule[];
	extensionPaths?: string[];
	namedExtensionPaths?: string[];
	customToolPaths?: ToolPathWithSource[];
	enableLsp?: boolean;
	hasEditTool?: boolean;
	eventBus?: EventBus;
	outputSchema?: unknown;
	requireYieldTool?: boolean;
	taskDepth?: number;
	maxNestedSpawnDepth?: number;
	getEvalSessionId?: () => string | null;
	getSessionFile: () => string | null;
	getEvalKernelOwnerId?: () => string | null;
	assertEvalExecutionAllowed?: () => void;
	trackEvalExecution?<T>(execution: Promise<T>, abortController: AbortController): Promise<T>;
	getSessionId?: () => string | null;
	agentGrantedThisTurn?: (agentName: string) => boolean;
	getTurnIndex?: () => number;
	getHindsightSessionState?: () => HindsightSessionState | undefined;
	getArgotSession?: () => ArgotSession | undefined;
	refreshBaseSystemPrompt?(reason: string): Promise<void>;
	getMnemopiSessionState?: () => MnemopiSessionState | undefined;
	getAgentId?: () => string | null;
	isApprovalBypassed?: () => boolean;
	getToolContext?: (toolCall?: ToolCallContext) => AgentToolContext | undefined;
	getToolByName?: (name: string) => AgentTool | undefined;
	isToolActive?: (name: string) => boolean;
	setActiveToolNames?: (names: Iterable<string>) => void;
	agentRegistry?: AgentRegistry;
	getArtifactsDir?: () => string | null;
	recordSubagentSpawn?: (record: SubagentSpawnRecord) => void;
	getArtifactManager?: () => ArtifactManager | null;
	allocateOutputArtifact?: (toolType: string) => Promise<{ id?: string; path?: string }>;
	getSessionSpawns: () => string | null;
	getModelString?: () => string | undefined;
	getActiveModelString?: () => string | undefined;
	getActiveThinkingLevel?: () => ConfiguredThinkingLevel | undefined;
	getActiveModel?: () => Model | undefined;
	getServiceTierByFamily?: () => ServiceTierByFamily | undefined;
	authStorage?: import("../session/auth-storage").AuthStorage;
	modelRegistry?: import("../config/model-registry").ModelRegistry;
	agentOutputManager?: AgentOutputManager;
	asyncJobManager?: AsyncJobManager;
	mcpManager?: MCPManager;
	localProtocolOptions?: LocalProtocolOptions;
	settings: Settings;
	getPlanModeState?: () => PlanModeState | undefined;
	getPlanReferencePath?: () => string;
	getGoalModeState?: () => GoalModeState | undefined;
	getGoalRuntime?: () => GoalRuntime | undefined;
	getUsageStatistics?: () => UsageStatistics;
	getTurnBudget?: () => { total: number | null; spent: number; hard: boolean };
	recordEvalSubagentUsage?: (output: number) => void;
	getClientBridge?: () => ClientBridge | undefined;
	getTodoPhases?: () => TodoPhase[];
	setTodoPhases?: (phases: TodoPhase[]) => void;
	isMCPDiscoveryEnabled?: () => boolean;
	getSelectedMCPToolNames?: () => string[];
	activateDiscoveredMCPTools?: (toolNames: string[]) => Promise<string[]>;
	isToolDiscoveryEnabled?: () => boolean;
	getDiscoverableTools?: (filter?: {
		source?: import("../tool-discovery/tool-index").DiscoverableToolSource;
	}) => DiscoverableTool[];
	getDiscoverableToolSearchIndex?: () => DiscoverableToolSearchIndex;
	getSelectedDiscoveredToolNames?: () => string[];
	activateDiscoveredTools?: (toolNames: string[]) => Promise<string[]>;
	getToolChoiceQueue?(): ToolChoiceQueue;
	buildToolChoice?(toolName: string): ToolChoice | undefined;
	steer?(message: { customType: string; content: string; details?: unknown }): void;
	peekQueueInvoker?(): ((input: unknown) => Promise<unknown> | unknown) | undefined;
	peekPendingInvoker?(): ((input: unknown) => Promise<unknown> | unknown) | undefined;
	clearPendingInvokers?(): void;
	peekStandingResolveHandler?(): ((input: unknown) => Promise<unknown> | unknown) | undefined;
	setStandingResolveHandler?(handler: ((input: unknown) => Promise<unknown> | unknown) | null): void;
	getCheckpointState?: () => CheckpointState | undefined;
	setCheckpointState?: (state: CheckpointState | null) => void;
	getLastCompletedRewind?: () => CompletedRewindState | undefined;

	fileSnapshotStore?: InMemorySnapshotStore;

	conflictHistory?: import("./conflict-detect").ConflictHistory;

	diagnosticsLedger?: import("../lsp/diagnostics-ledger").DiagnosticsLedger;

	noopLoopGuard?: import("../edit/hashline/noop-loop-guard").NoopLoopGuard;

	queueDeferredMessage?(message: CustomMessage): void;
	queueDeferredDiagnostics?(entry: DeferredDiagnosticsEntry): void;
	bumpFileMutationVersion?(path: string): number;
	getFileMutationVersion?(path: string): number;
	getTelemetry?: () => AgentTelemetryConfig | undefined;
	getImageAttachments?: () => ImageAttachmentEntry[];
}

export type ToolFactory = (session: ToolSession) => Tool | null | Promise<Tool | null>;

export function computeEssentialBuiltinNames(settings: Settings): string[] {
	return resolveEssentialToolNames({
		override: settings.get("tools.essentialOverride"),
		isBuiltinName: name => name in BUILTIN_TOOLS,
	});
}

export const BUILTIN_TOOLS: Record<BuiltinToolName, ToolFactory> = {
	read: async s => new (await import("./read")).ReadTool(s),
	bash: async s => new (await import("./bash")).BashTool(s),
	launch: async s => new (await import("./launch")).LaunchTool(s),
	edit: async s => new (await import("../edit")).EditTool(s),
	ast_grep: async s => new (await import("./ast-grep")).AstGrepTool(s),
	ast_edit: async s => new (await import("./ast-edit")).AstEditTool(s),
	ask: async s => (await import("./ask")).AskTool.createIf(s),
	debug: async s => (await import("./debug")).DebugTool.createIf(s),
	eval: async s => (await import("./eval")).EvalTool.create(s),
	ssh: async s => (await import("./ssh")).loadSshTool(s),
	github: async s => (await import("./gh")).GithubTool.createIf(s),
	glob: async s => new (await import("./glob")).GlobTool(s, { rootPathAlias: true }),
	grep: async s => new (await import("./grep")).GrepTool(s),
	lsp: async s => (await import("../lsp")).LspTool.createIf(s),
	inspect_image: async s => new (await import("./inspect-image")).InspectImageTool(s),
	browser: async s => new (await import("./browser")).BrowserTool(s),
	checkpoint: async s => (await import("./checkpoint")).CheckpointTool.createIf(s),
	rewind: async s => (await import("./checkpoint")).RewindTool.createIf(s),
	task: async s => (await import("../task")).TaskTool.create(s),
	job: async s => new (await import("./job")).JobTool(s),
	irc: async s => (await import("./irc")).IrcTool.createIf(s),
	todo: async s => new (await import("./todo")).TodoTool(s),
	web_search: async s => new (await import("../web/search")).WebSearchTool(s),
	search_tool_bm25: async s => (await import("./search-tool-bm25")).SearchToolBm25Tool.createIf(s),
	set_cwd: async s => new (await import("./set-cwd")).SetCwdTool(s),
	write: async s => new (await import("./write")).WriteTool(s),
	memory_edit: async s => (await import("./memory-edit")).MemoryEditTool.createIf(s),
	retain: async s => (await import("./memory-retain")).MemoryRetainTool.createIf(s),
	recall: async s => (await import("./memory-recall")).MemoryRecallTool.createIf(s),
	reflect: async s => (await import("./memory-reflect")).MemoryReflectTool.createIf(s),
	learn: async s => (await import("./learn")).LearnTool.createIf(s),
	manage_skill: async s => (await import("./manage-skill")).ManageSkillTool.createIf(s),
	[ARGOT_LOAD_TOOL]: async s =>
		s.settings.get("argot.enabled") && s.getArgotSession?.() !== undefined
			? new (await import("./argot")).ArgotLoadTool(s)
			: null,
	[ARGOT_UNLOAD_TOOL]: async s =>
		s.settings.get("argot.enabled") && s.getArgotSession?.() !== undefined
			? new (await import("./argot")).ArgotUnloadTool(s)
			: null,
};

export const HIDDEN_TOOLS: Record<HiddenToolName, ToolFactory> = {
	yield: async s => new (await import("./yield")).YieldTool(s),
	report_finding: async () => (await import("./review")).reportFindingTool,
	report_tool_issue: async s => (await import("./report-tool-issue")).createReportToolIssueTool(s),
	resolve: async s => new (await import("./resolve")).ResolveTool(s),
	goal: async s => new (await import("../goals/tools/goal-tool")).GoalTool(s),
};

export type ToolName = BuiltinToolName;

export async function createTools(session: ToolSession, toolNames?: string[]): Promise<Tool[]> {
	const includeYield = session.requireYieldTool === true;
	const enableLsp = session.enableLsp ?? true;
	const taskDepth = session.taskDepth ?? 0;
	const memoryBackend = session.settings.get("memory.backend") ?? "";
	const goalEnabled = session.settings.get("goal.enabled");
	let requestedTools =
		toolNames && toolNames.length > 0
			? augmentRequestedToolNames(normalizeToolNames(toolNames), {
					goalEnabled,
					astGrepEnabled: session.settings.get("astGrep.enabled"),
					astEditEnabled: session.settings.get("astEdit.enabled"),
					memoryBackend,
					autolearnEnabled: session.settings.get("autolearn.enabled"),
					isTopLevelSession: taskDepth === 0,
				})
			: undefined;
	const backends = resolveEvalBackends(session);
	const allowPython = backends.python;
	const allowJs = backends.js;
	const allowRuby = backends.ruby;
	const allowJulia = backends.julia;
	const skipEvalPreflight = session.skipPythonPreflight === true;
	let pythonAvailable = true;
	let rubyAvailable = true;
	let juliaAvailable = true;
	const evalRequested = requestedTools === undefined || requestedTools.includes(TOOL.eval);
	if (!skipEvalPreflight && !allowJs && evalRequested) {
		if (allowPython) {
			const { checkPythonKernelAvailability } = await import("../eval/py/kernel");
			const availability = await logger.time(
				"createTools:pythonCheck",
				checkPythonKernelAvailability,
				session.cwd,
				session.settings.get("python.interpreter")?.trim() || undefined,
			);
			pythonAvailable = availability.ok;
			if (!availability.ok) {
				logger.warn("Python kernel unavailable and JS backend disabled", { reason: availability.reason });
			}
		}
		if (allowRuby) {
			const { checkRubyKernelAvailability } = await import("../eval/rb/kernel");
			const availability = await checkRubyKernelAvailability(
				session.cwd,
				session.settings.get("ruby.interpreter")?.trim() || undefined,
			);
			rubyAvailable = availability.ok;
			if (!availability.ok) {
				logger.warn("Ruby kernel unavailable and JS backend disabled", { reason: availability.reason });
			}
		}
		if (allowJulia) {
			const { checkJuliaKernelAvailability } = await import("../eval/jl/kernel");
			const availability = await checkJuliaKernelAvailability(
				session.cwd,
				session.settings.get("julia.interpreter")?.trim() || undefined,
			);
			juliaAvailable = availability.ok;
			if (!availability.ok) {
				logger.warn("Julia kernel unavailable and JS backend disabled", { reason: availability.reason });
			}
		}
	}

	const allowEval = resolveEvalToolAvailability({
		pythonAllowed: allowPython,
		jsAllowed: allowJs,
		rubyAllowed: allowRuby,
		juliaAllowed: allowJulia,
		pythonAvailable,
		rubyAvailable,
		juliaAvailable,
	});
	const effectiveDiscoveryMode = resolveEffectiveToolDiscoveryMode(
		session.settings,
		countToolsForAutoDiscovery(requestedTools ?? Object.keys(BUILTIN_TOOLS)),
	);
	const discoveryActive = effectiveDiscoveryMode !== "off";

	const allTools: Record<string, ToolFactory> = { ...BUILTIN_TOOLS, ...HIDDEN_TOOLS };
	const permissionInputs: BuiltinToolPermissionInputs = {
		goalEnabled,
		enableLsp,
		lspEnabled: session.settings.get("lsp.enabled"),
		lspTool: session.settings.get("lsp.tool"),
		bashEnabled: session.settings.get("bash.enabled"),
		launchEnabled: session.settings.get("launch.enabled"),
		evalAllowed: allowEval,
		debugEnabled: session.settings.get("debug.enabled"),
		requireYieldTool: includeYield,
		todoEnabled: session.settings.get("todo.enabled"),
		globEnabled: session.settings.get("glob.enabled"),
		grepEnabled: session.settings.get("grep.enabled"),
		githubEnabled: session.settings.get("github.enabled"),
		astGrepEnabled: session.settings.get("astGrep.enabled"),
		astEditEnabled: session.settings.get("astEdit.enabled"),
		inspectImageEnabled: session.settings.get("inspect_image.enabled"),
		webSearchEnabled: session.settings.get("web_search.enabled"),
		discoveryActive,
		askEnabled: session.settings.get("ask.enabled"),
		browserEnabled: session.settings.get("browser.enabled"),
		checkpointEnabled: session.settings.get("checkpoint.enabled"),
		ircEnabled: isIrcEnabled(session.settings, taskDepth, session.maxNestedSpawnDepth),
		memoryBackend,
		autolearnEnabled: session.settings.get("autolearn.enabled"),
		isTopLevelSession: taskDepth === 0,
		delegationEnabled: delegationEnabled(session.settings),
		canSpawnAtDepth: canSpawnAtDepth(
			resolveSessionMaxNestedSpawnDepth(session.settings, session.maxNestedSpawnDepth),
			taskDepth,
		),
	};
	const isToolAllowed = (name: string): boolean => isBuiltinToolAllowed(name, permissionInputs);
	if (includeYield && requestedTools) {
		requestedTools = withYieldToolAppended(requestedTools);
	}

	const baseEntries = selectBaseToolNames({
		requestedToolNames: requestedTools,
		isKnownToolName: name => name in allTools,
		isAllowed: isToolAllowed,
		builtinToolNames: Object.keys(BUILTIN_TOOLS),
		requireYieldTool: includeYield,
		goalEnabled,
	}).map(name => [name, allTools[name]] as const);

	const activeToolNames = new Set(baseEntries.map(([name]) => name));
	if (session.setActiveToolNames) {
		session.setActiveToolNames(activeToolNames);
	} else {
		session.isToolActive = name => activeToolNames.has(name);
	}

	const rerootDetector = new RerootDetector();
	const wrap = (tool: Tool): Tool => wrapToolWithRerootHint(wrapToolWithMetaNotice(tool), rerootDetector, session);

	const baseResults = await Promise.all(
		baseEntries.map(async ([name, factory]) => {
			const tool = await logger.time(`createTools:${name}`, factory as ToolFactory, session);
			return tool ? wrap(tool) : null;
		}),
	);
	const tools = baseResults.filter((r): r is Tool => r !== null);
	if (!tools.some(tool => tool.name === TOOL.resolve)) {
		const resolveTool = await logger.time("createTools:resolve", HIDDEN_TOOLS.resolve, session);
		if (resolveTool) {
			tools.push(wrap(resolveTool));
		}
	}

	const { createReportToolIssueTool, isAutoQaEnabled } = await import("./report-tool-issue");
	const autoQA = isAutoQaEnabled(session.settings);
	if (autoQA && !tools.some(t => t.name === TOOL.report_tool_issue)) {
		const activeBuiltinNames = tools
			.map(t => t.name)
			.filter(name => (name in BUILTIN_TOOLS || name in HIDDEN_TOOLS) && name !== TOOL.report_tool_issue);
		const qaTool = createReportToolIssueTool(session, activeBuiltinNames);
		if (qaTool) {
			tools.push(wrap(qaTool));
		}
	}

	return tools;
}
