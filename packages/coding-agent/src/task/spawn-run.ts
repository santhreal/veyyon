/**
 * One spawn of the task tool: the agent its params name, checked against the session's settings, run
 * to completion in place or inside an isolation worktree, and settled into the tool result the parent
 * reads. `TaskTool` decides how many spawns a call makes and whether each runs inline or as a background
 * job; every one of them runs through {@link runSpawn}.
 */
import * as fs from "node:fs/promises";
import path from "node:path";
import type { AgentToolResult, AgentToolUpdateCallback } from "@veyyon/agent-core";
import { directoryExists, errorMessage, getSessionsDir, prompt, Snowflake } from "@veyyon/utils";
import { ORPHAN_AGENT_TRANSCRIPT_PREFIX, sessionFileName } from "@veyyon/utils/session-file";
import type { ToolSession } from "..";
import type { LocalProtocolOptions } from "../internal-urls";
import { mcpManagerInstance } from "../mcp/manager-instance";
import { DEFAULT_PLAN_FILE_URL } from "../plan-mode/plan-file-url";
import { loadOverallPlanReference } from "../plan-mode/plan-handoff";
import { agentPrompts } from "../prompts/agent/rows";
import { planModePrompts } from "../prompts/plan-mode/rows";
import { toolsPrompts } from "../prompts/tools/rows";
import { AgentRegistry, MAIN_AGENT_ID } from "../registry/agent-registry";
import { TOOL } from "../tools/core/builtin-names";
import { formatBytes, formatDuration } from "../tools/core/render-utils";
import {
	agentModelSourceLabel,
	filterEnabledAgents,
	isAgentEnabled,
	resolveAgentModel,
	resolveAgentThinkingLevel,
} from "./agent-settings";
import { inheritContextFiles } from "./context-inheritance";
import { discoverAgents, getAgent } from "./discovery";
import { type ExecutorOptions, runSubprocess } from "./executor";
import { inheritResolvedCollection, resolveAutoloadSkills } from "./inherited-collections";
import {
	applyEligibleNestedPatches,
	type BuildCommitMessage,
	type IsolationContext,
	makeIsolationCommitMessage,
	mergeIsolatedChanges,
	prepareIsolationContext,
	runIsolatedSubprocess,
} from "./isolation-runner";
import { generateTaskName } from "./name-generator";
import { classifyAgentOutcome } from "./outcome";
import { AgentOutputManager } from "./output-manager";
import type { AgentDefinition, AgentProgress, AgentSource, SingleResult, TaskParams, TaskToolDetails } from "./types";
import { parseIsolationMode, type TaskIsolationMode } from "./worktree";

/** One spawn's call: its params, where it sits in the call, and how it reports while it runs. */
export interface SpawnRequest {
	toolCallId: string;
	params: TaskParams;
	signal?: AbortSignal;
	onUpdate?: AgentToolUpdateCallback<TaskToolDetails>;
	/** An agent id the call claimed up front, so its immediate result could name the agent. */
	preAllocatedId?: string;
	/** Position in the original call, so progress rows and merged results keep the call's order. */
	index: number;
	/** The spawn runs as a background job, so the parent's turn is not waiting on it. */
	detached: boolean;
	/** Epochs bracketing the spawn semaphore wait; see `ExecutorOptions.invokedAt`. */
	launchTiming?: { invokedAt: number; acquiredAt: number };
}

/** The isolation an isolated spawn runs in. */
interface SpawnIsolation {
	mode: TaskIsolationMode;
	context: IsolationContext;
	mergeMode: "patch" | "branch";
}

/** Where a spawn writes its transcript and artifacts, and whether that place is the parent's session directory. */
interface SpawnArtifacts {
	dir: string;
	persist: boolean;
}

/** What a spawn runs with once its agent, model, isolation and plan are settled. */
interface PreparedSpawn {
	/** The agent name the params gave, which the spawn's rows and messages report. */
	agentName: string;
	/** The agent as discovered. */
	agent: AgentDefinition;
	/** The agent as it runs: `agent` under plan mode's prompt and tools while plan mode is on. */
	runAgent: AgentDefinition;
	model: SpawnModel;
	/** Set exactly when the spawn runs isolated. */
	isolation: SpawnIsolation | null;
	sessionFile: ExecutorOptions["sessionFile"];
	artifacts: SpawnArtifacts;
	localProtocolOptions: LocalProtocolOptions;
	planReference: ExecutorOptions["planReference"];
}

type SpawnModel = Pick<ExecutorOptions, "modelOverride" | "thinkingLevel">;

/** Tools an agent declares that plan mode keeps beside its read-only base set. */
const PLAN_MODE_AGENT_TOOL_ALLOWLIST: ReadonlySet<string> = new Set([TOOL.report_finding]);

export function renderAgentUserPrompt(assignment: string): string {
	return prompt.render(agentPrompts["agent/user-prompt"].text, {
		assignment: assignment.trim(),
	});
}

/** The progress row of a spawn whose agent has not started. */
export function pendingSpawnProgress(
	index: number,
	id: string,
	agent: string,
	agentSource: AgentSource,
	assignment: string,
): AgentProgress {
	return {
		index,
		id,
		agent,
		agentSource,
		status: "pending",
		task: renderAgentUserPrompt(assignment),
		assignment,
		recentTools: [],
		recentOutput: [],
		toolCount: 0,
		requests: 0,
		tokens: 0,
		cost: 0,
		durationMs: 0,
	};
}

const noLocalValue = (): null => null;

/**
 * The internal-URL options an agent resolves `local://` and `artifact://` through: the parent's own,
 * or its artifacts dir and session id. Built from the session's own members: the child session keeps
 * these functions for as long as it lives, and a function created in the spawn body would keep the
 * whole spawn scope with them, the tool call's update callback and abort signal included.
 */
function localProtocolOptionsFor(session: ToolSession): LocalProtocolOptions {
	return (
		session.localProtocolOptions ?? {
			getArtifactsDir: session.getArtifactsDir ?? noLocalValue,
			getSessionId: session.getSessionId ?? noLocalValue,
		}
	);
}

/**
 * Preview text for a child result. Falls back to "(no output)" — annotated
 * with the request count when the child actually did work, so the parent can
 * tell a no-op child from one that burned requests before being cancelled.
 */
export function formatResultOutputFallback(result: Pick<SingleResult, "output" | "stderr" | "requests">): string {
	const base = result.output.trim() || result.stderr.trim();
	if (base) return base;
	return result.requests > 0 ? `(no output) after ${result.requests} req` : "(no output)";
}

/**
 * Resolve the ExecutorOptions.cwd for a spawn.
 * Default / `"inherit"` uses the parent's live session cwd at spawn time.
 * A relative path resolves against the parent's cwd (like `cd libs/scanner`
 * from where the parent agent is), and an absolute path is used as-is. Either
 * way the result must exist and be a directory (fail closed).
 */
export async function resolveSpawnCwd(raw: string | undefined, parentCwd: string): Promise<string> {
	const trimmed = typeof raw === "string" ? raw.trim() : "";
	if (!trimmed || trimmed === "inherit") {
		return parentCwd;
	}
	// A relative cwd is resolved against the parent agent's live cwd rather than
	// rejected: spawning an agent in `libs/scanner/rulec` from the parent should
	// behave like a `cd` there. Absolute paths already point where they point.
	// This adds no new reach an absolute path did not already allow.
	const resolved = path.isAbsolute(trimmed) ? path.resolve(trimmed) : path.resolve(parentCwd, trimmed);
	try {
		const st = await fs.stat(resolved);
		if (!st.isDirectory()) {
			throw new Error(`task cwd is not a directory: ${resolved}`);
		}
	} catch (err) {
		if (err instanceof Error && err.message.startsWith("task cwd")) throw err;
		// Name the relative input and what it resolved against, so a wrong parent
		// cwd is diagnosable instead of showing only the joined absolute path.
		const context = path.isAbsolute(trimmed) ? "" : ` (resolved from relative "${trimmed}" against ${parentCwd})`;
		throw new Error(`task cwd does not exist: ${resolved}${context}`);
	}
	if (!(await directoryExists(resolved))) {
		throw new Error(`task cwd does not exist: ${resolved}`);
	}
	return resolved;
}

/** A spawn that ends before its agent runs: the reason as the result text, and no result rows. */
function spawnRefusal(
	text: string,
	projectAgentsDir: string | null,
	totalDurationMs: number,
): AgentToolResult<TaskToolDetails> {
	return { content: [{ type: "text", text }], details: { projectAgentsDir, results: [], totalDurationMs } };
}

/**
 * Why a disabled agent cannot run, or undefined when it can. The setting governs what the MODEL may
 * choose, so there is no "disabled but still runs" state. A `/` command that names an agent is the USER
 * asking, and the command declares that up front, so the grant is checked here rather than the ban
 * being softened for everybody. See `agentGrantedThisTurn` on ToolSession.
 */
function disabledAgentRefusal(
	session: ToolSession,
	agents: AgentDefinition[],
	agent: AgentDefinition,
	agentName: string,
): string | undefined {
	if (isAgentEnabled(session.settings, agent) || session.agentGrantedThisTurn?.(agent.name)) return undefined;
	const enabled = filterEnabledAgents(session.settings, agents).map(a => a.name);
	return `Agent "${agentName}" is disabled (agent.agents.${agentName}.enabled is false), so it cannot be chosen. Enable it in the Agents settings tab (/settings), or use a different agent type.${enabled.length > 0 ? ` Enabled: ${enabled.join(", ")}` : ""}`;
}

/** The agent as plan mode runs it: the read-only base tools plus the allowlisted tools it declares, under the plan-mode prompt, spawning nothing. */
function planModeAgent(agent: AgentDefinition): AgentDefinition {
	const baseTools: string[] = [TOOL.read, TOOL.search, TOOL.lsp, TOOL.web_search];
	const declared = (agent.tools ?? []).filter(
		tool => PLAN_MODE_AGENT_TOOL_ALLOWLIST.has(tool) && !baseTools.includes(tool),
	);
	return {
		...agent,
		systemPrompt: `${planModePrompts["plan-mode/agent"].text}\n\n${agent.systemPrompt}`,
		tools: [...baseTools, ...declared],
		spawns: undefined,
	};
}

/**
 * The model and effort the child runs, or why the spawn is refused. The model resolves through the ONE
 * owner, whose only scope is this agent: the lane row governing this spawn, then the definition's
 * frontmatter, then the default model role. The parent's live model is not a layer, so a keystroke aimed
 * at this session cannot move a child. A configured-but-unresolvable pattern refuses the spawn instead of
 * quietly running whatever the next layer names. Depth rows key on the CHILD's depth, one below this
 * session, matching the executor's `childDepth`.
 */
function resolveSpawnModel(session: ToolSession, agentName: string, runAgent: AgentDefinition): SpawnModel | string {
	const taskDepth = (session.taskDepth ?? 0) + 1;
	const resolved = resolveAgentModel({
		settings: session.settings,
		agentName,
		agentModel: runAgent.model,
		fallbackModelPattern: session.getModelString?.(),
		taskDepth,
	});
	if (resolved.unresolved) {
		const { source, value, depth } = resolved.unresolved;
		return `Cannot spawn "${agentName}": ${agentModelSourceLabel(source, agentName, depth)} is set to "${value}", which matches no available model. Fix that setting in Agents → Roster → ${agentName} (or clear it to fall back to the default model role) and try again.`;
	}
	return {
		modelOverride: resolved.patterns,
		thinkingLevel: resolveAgentThinkingLevel({
			settings: session.settings,
			agentName,
			agentThinkingLevel: runAgent.thinkingLevel,
			taskDepth,
		}),
	};
}

/**
 * Where a spawn's transcript and artifacts go: beside the parent's session file, or, for a parent with no
 * session file, a fresh directory under the durable sessions dir. An agent transcript is a full session
 * record with `session_init`, so a fileless parent's agents still get one that outlives the process: never
 * `os.tmpdir`, which the OS reaps, and never deleted (GRAN-1).
 */
function spawnArtifacts(sessionFile: ExecutorOptions["sessionFile"]): SpawnArtifacts {
	const sessionDir = sessionFile ? sessionFile.slice(0, -6) : "";
	if (sessionDir) return { dir: sessionDir, persist: true };
	return { dir: path.join(getSessionsDir(), `${ORPHAN_AGENT_TRANSCRIPT_PREFIX}${Snowflake.next()}`), persist: false };
}

/**
 * Settle everything a spawn runs with, or refuse it. A refusal for the call's own shape (isolation off,
 * an unknown or disabled agent) reports no duration; one reached after resolving the model reports the
 * time spent so far.
 */
async function prepareSpawn(
	session: ToolSession,
	agents: AgentDefinition[],
	params: TaskParams,
	projectAgentsDir: string | null,
	startTime: number,
): Promise<PreparedSpawn | AgentToolResult<TaskToolDetails>> {
	const agentName = params.agent ?? "";
	const isolationMode = session.settings.get("agent.isolation.mode");
	if (isolationMode === "none" && "isolated" in params) {
		return spawnRefusal("Task isolation is disabled.", projectAgentsDir, 0);
	}
	const agent = getAgent(agents, agentName);
	if (!agent) {
		const available = agents.map(a => a.name).join(", ") || "none";
		return spawnRefusal(`Unknown agent "${agentName}". Available: ${available}`, projectAgentsDir, 0);
	}
	const disabled = disabledAgentRefusal(session, agents, agent, agentName);
	if (disabled) return spawnRefusal(disabled, projectAgentsDir, 0);

	const planMode = session.getPlanModeState?.()?.enabled === true;
	const runAgent = planMode ? planModeAgent(agent) : agent;
	const model = resolveSpawnModel(session, agentName, runAgent);
	if (typeof model === "string") return spawnRefusal(model, projectAgentsDir, Date.now() - startTime);

	let isolation: SpawnIsolation | null = null;
	if (isolationMode !== "none" && params.isolated === true) {
		try {
			isolation = {
				mode: isolationMode,
				context: await prepareIsolationContext(session.cwd),
				mergeMode: session.settings.get("agent.isolation.merge"),
			};
		} catch (err) {
			const message = `Isolated task execution requires a git repository. ${errorMessage(err)}`;
			return spawnRefusal(message, projectAgentsDir, Date.now() - startTime);
		}
	}

	const sessionFile = session.getSessionFile();
	const localProtocolOptions = localProtocolOptionsFor(session);
	// An agent spawned while the session executes an approved plan shares the main agent's plan context.
	// Plan mode itself hands its agents `plan-mode/agent` instead, and a session with no plan file at its
	// reference path hands nothing.
	const planReference = planMode
		? undefined
		: await loadOverallPlanReference(session.getPlanReferencePath?.() ?? DEFAULT_PLAN_FILE_URL, localProtocolOptions);
	return {
		agentName,
		agent,
		runAgent,
		model,
		isolation,
		sessionFile,
		artifacts: spawnArtifacts(sessionFile),
		localProtocolOptions,
		planReference,
	};
}

/**
 * Inherit the parent's cwd-discovered layers: context files, skills, prompt templates and rules.
 *
 * Resolved against `spawnCwd`, not the isolation mount. An isolated spawn runs in a mount whose
 * post-`start` invariant is "mirror lower's live working tree", so the parent's lists describe the same
 * content. Feeding the mount path in instead would force rediscovery and lose data twice over: the mount is
 * rooted at the repo root rather than at `spawnCwd`, so a nested `<cwd>/AGENTS.md` would drop out of the
 * walk, and the git-worktree seeding path copies untracked files through `ls-files --others
 * --exclude-standard`, so a gitignored project layer is not in the mount at all. An empty list reads
 * downstream as "already resolved", and a list from the parent's tree is wrong for a child pointed at
 * another one, which is why every layer passes through the same guard.
 *
 * Autoload names are matched against the skills the child runs with. `undefined` there means the child
 * rediscovers, so the names travel unmatched and are settled in the child.
 */
function inheritSpawnLayers(
	session: ToolSession,
	spawnCwd: string,
	agentName: string,
	autoloadSkills: AgentDefinition["autoloadSkills"],
): Pick<ExecutorOptions, "contextFiles" | "skills" | "autoloadSkills" | "promptTemplates" | "rules"> {
	const scope = { parentCwd: session.cwd, spawnCwd, agentName };
	const contextFiles = inheritContextFiles({ parentContextFiles: session.contextFiles, ...scope });
	const skills = inheritResolvedCollection({ items: session.skills, kind: "skills", ...scope });
	return {
		contextFiles,
		skills,
		autoloadSkills: resolveAutoloadSkills(autoloadSkills, skills, agentName),
		promptTemplates: inheritResolvedCollection({ items: session.promptTemplates, kind: "promptTemplates", ...scope }),
		rules: inheritResolvedCollection({ items: session.rules, kind: "rules", ...scope }),
	};
}

/** The run options a child takes from its parent session as the session is when the spawn starts. */
function parentRunOptions(session: ToolSession, parentApprovalBypassed: () => boolean): Partial<ExecutorOptions> {
	return {
		// Not a resolution layer: the executor uses it only when the model the agent resolved to has no
		// working credentials, and warns when it does.
		parentActiveModelPattern: session.getActiveModelString?.(),
		parentThinkingLevel: session.getActiveThinkingLevel?.(),
		enableLsp: (session.enableLsp ?? true) && session.settings.get("agent.enableLsp"),
		eventBus: session.eventBus,
		authStorage: session.authStorage,
		modelRegistry: session.modelRegistry,
		settings: session.settings,
		// The `/yolo` bypass lives on the session, not in settings, so it is handed over explicitly or the
		// child drops a rung. The snapshot is the child's starting rung; the probe reaches it live.
		bypassAllApprovals: session.isApprovalBypassed?.() ?? false,
		parentApprovalBypassed,
		obfuscateProviderText: session.obfuscateProviderText,
		completeImpl: session.sideComplete,
		mcpManager: session.mcpManager ?? mcpManagerInstance(),
		// The child's own background jobs report to this conversation, not to whichever top-level session in
		// the process was built first.
		asyncJobManager: session.asyncJobManager,
		workspaceTree: session.workspaceTree,
		preloadedExtensionPaths: session.extensionPaths,
		preloadedNamedExtensionPaths: session.namedExtensionPaths,
		preloadedCustomToolPaths: session.customToolPaths,
		// The child adopts the parent's ArtifactManager so artifact ids are unique across the whole tree and
		// outputs land flat in the parent's dir.
		parentArtifactManager: session.getArtifactManager?.() ?? undefined,
		parentHindsightSessionState: session.getHindsightSessionState?.(),
		parentMnemopiSessionState: session.getMnemopiSessionState?.(),
		parentArgot: session.getArgotSession?.(),
		parentTelemetry: session.getTelemetry?.(),
		parentEvalSessionId: session.getEvalSessionId?.() ?? undefined,
		parentAgentId: session.getAgentId?.() ?? MAIN_AGENT_ID,
		// The child joins THIS session's budget group instead of opening a second one, so a resource limit
		// cannot be multiplied by delegating.
		parentSessionId: session.getSessionId?.() ?? undefined,
		// Live source of truth for `tier.agent: inherit`: the per-family map, or null for an explicit none
		// (`/fast off`). A session with no tier accessor leaves it undefined, so inherit falls back to the
		// agent's configured `tier.*` settings.
		parentServiceTier: session.getServiceTierByFamily ? (session.getServiceTierByFamily() ?? null) : undefined,
	};
}

/** The result an isolated spawn reports when its isolation could not be set up. */
function isolationSetupFailure(options: ExecutorOptions, startedAt: number, err: unknown): SingleResult {
	const message = errorMessage(err);
	return {
		index: options.index,
		id: options.id,
		agent: options.agent.name,
		agentSource: options.agent.source,
		task: options.task,
		assignment: options.assignment,
		exitCode: 1,
		output: "",
		stderr: message,
		truncated: false,
		durationMs: Date.now() - startedAt,
		tokens: 0,
		requests: 0,
		modelOverride: options.modelOverride,
		error: message,
	};
}

/**
 * Bring an isolated spawn's changes back into the parent's tree, root repository first, then the nested
 * repositories. A merge or nested apply that does not land sets the run's `error`, so
 * `classifyAgentOutcome` reports `merge-failed` instead of a clean completion whose work is not in the tree.
 */
async function landIsolatedChanges(
	result: SingleResult,
	isolation: SpawnIsolation,
	buildCommitMessage: BuildCommitMessage,
): Promise<{ result: SingleResult; summary: string }> {
	const { mergeMode } = isolation;
	const repoRoot = isolation.context.repoRoot;
	const merged = await mergeIsolatedChanges({ result, repoRoot, mergeMode });
	let landed = merged.failure !== undefined && !result.error ? { ...result, error: merged.failure } : result;
	let nestedFailure: string | undefined;
	const nestedSummary = await applyEligibleNestedPatches({
		result: landed,
		repoRoot,
		mergeMode,
		changesApplied: merged.changesApplied,
		mergedBranchForNestedPatches: merged.mergedBranchForNestedPatches,
		commitMessage: buildCommitMessage(),
		onApplyFailure: error => {
			nestedFailure = errorMessage(error);
		},
	});
	if (nestedFailure !== undefined && !landed.error) {
		landed = { ...landed, error: `Merge failed: nested repository patches did not apply: ${nestedFailure}` };
	}
	return { result: landed, summary: merged.summary + nestedSummary };
}

/**
 * Record the parent's index row for a settled spawn, pointing at the child's durable transcript, so a
 * study or backtest tool can enumerate a session's agents without scraping tool-result prose (GRAN-2).
 * The transcript path is derived as the executor derives it: `<artifactsDir>/<id>.jsonl`.
 */
function recordSpawn(
	session: ToolSession,
	result: SingleResult,
	artifactsDir: string,
	isolation: SpawnIsolation | null,
): void {
	const outcome = classifyAgentOutcome(result);
	session.recordAgentSpawn?.({
		agentId: result.id,
		agentName: result.agent,
		task: result.task,
		sessionFile: path.join(artifactsDir, sessionFileName(result.id)),
		isolation: isolation ? isolation.mode : "none",
		status: outcome.kind === "aborted" ? "cancelled" : outcome.isError ? "failed" : "completed",
		exitCode: result.exitCode,
		durationMs: result.durationMs,
		usage: result.usage,
		error: result.error,
	});
}

/** The manager that hands out agent ids unique across the session, so no two agents' artifacts collide. */
export function agentOutputManagerFor(session: ToolSession): AgentOutputManager {
	return session.agentOutputManager ?? new AgentOutputManager(session.getArtifactsDir ?? (() => null));
}

/** A fresh agent id: the name the call gave, else a generated one. */
export function allocateAgentId(outputManager: AgentOutputManager, name: string | undefined): Promise<string> {
	return outputManager.allocate(name?.trim() || generateTaskName());
}

/** Run a prepared spawn's agent to completion and settle its result. */
async function runPreparedSpawn(
	session: ToolSession,
	parentApprovalBypassed: () => boolean,
	request: SpawnRequest,
	spawn: PreparedSpawn,
	projectAgentsDir: string | null,
	startTime: number,
): Promise<AgentToolResult<TaskToolDetails>> {
	const { params, onUpdate } = request;
	await fs.mkdir(spawn.artifacts.dir, { recursive: true });
	const agentId = request.preAllocatedId || (await allocateAgentId(agentOutputManagerFor(session), params.name));
	const assignment = (params.task ?? "").trim();
	let latestProgress: AgentProgress = {
		...pendingSpawnProgress(request.index, agentId, spawn.agentName, spawn.agent.source, assignment),
		modelOverride: spawn.model.modelOverride,
	};
	const emitProgress = () => {
		onUpdate?.({
			content: [{ type: "text", text: `Running agent ${agentId}...` }],
			details: {
				projectAgentsDir,
				results: [],
				totalDurationMs: Date.now() - startTime,
				progress: [latestProgress],
			},
		});
	};
	emitProgress();

	const buildCommitMessage = makeIsolationCommitMessage(session);
	let spawnCwd: string;
	try {
		spawnCwd = await resolveSpawnCwd(params.cwd, session.cwd);
	} catch (err) {
		return spawnRefusal(errorMessage(err), projectAgentsDir, Date.now() - startTime);
	}

	const options: ExecutorOptions = {
		...parentRunOptions(session, parentApprovalBypassed),
		// After `spawnCwd`: whether the child inherits the parent's layers depends on where it runs.
		...inheritSpawnLayers(session, spawnCwd, spawn.agentName, spawn.agent.autoloadSkills),
		cwd: spawnCwd,
		agent: spawn.runAgent,
		task: renderAgentUserPrompt(assignment),
		assignment,
		context: session.settings.get("agent.batch") ? params.context?.trim() || undefined : undefined,
		planReference: spawn.planReference,
		index: request.index,
		parentToolCallId: request.toolCallId,
		detached: request.detached,
		id: agentId,
		taskDepth: session.taskDepth ?? 0,
		invokedAt: request.launchTiming?.invokedAt,
		acquiredAt: request.launchTiming?.acquiredAt,
		...spawn.model,
		// Output schema priority: agent frontmatter, then the inherited parent session. The task call itself
		// never carries a schema; workflows needing ad-hoc structured output go through eval agent(prompt, schema).
		outputSchema: spawn.runAgent.output ?? session.outputSchema,
		sessionFile: spawn.sessionFile,
		persistArtifacts: spawn.artifacts.persist,
		artifactsDir: spawn.artifacts.dir,
		localProtocolOptions: spawn.localProtocolOptions,
		signal: request.signal,
		onProgress: progress => {
			// Shallow snapshot; recentTools is mutated in place by the executor, the rest is reassigned or
			// immutable. A deep clone here cost O(extractedToolData) per progress event.
			latestProgress = { ...progress, recentTools: progress.recentTools.slice() };
			emitProgress();
		},
	};

	const { isolation } = spawn;
	let result: SingleResult;
	let mergeSummary = "";
	if (isolation) {
		const taskStart = Date.now();
		const run = await runIsolatedSubprocess({
			baseOptions: options,
			context: isolation.context,
			preferredBackend: parseIsolationMode(isolation.mode),
			agentId,
			mergeMode: isolation.mergeMode,
			artifactsDir: spawn.artifacts.dir,
			buildCommitMessage,
			buildFailureResult: err => isolationSetupFailure(options, taskStart, err),
		});
		({ result, summary: mergeSummary } = await landIsolatedChanges(run, isolation, buildCommitMessage));
	} else {
		result = await runSubprocess(options);
	}

	recordSpawn(session, result, spawn.artifacts.dir, isolation);
	return buildResultPayload(result, projectAgentsDir, Date.now() - startTime, mergeSummary);
}

/**
 * Spawn a fresh agent and run it to completion. A refusal and a run that throws both come back as a
 * result rather than a rejection; discovery, isolation setup and the plan reference are read before the
 * run starts.
 */
export async function runSpawn(
	session: ToolSession,
	parentApprovalBypassed: () => boolean,
	request: SpawnRequest,
): Promise<AgentToolResult<TaskToolDetails>> {
	const startTime = Date.now();
	const { agents, projectAgentsDir } = await discoverAgents(session.cwd);
	const spawn = await prepareSpawn(session, agents, request.params, projectAgentsDir, startTime);
	if ("content" in spawn) return spawn;
	try {
		return await runPreparedSpawn(session, parentApprovalBypassed, request, spawn, projectAgentsDir, startTime);
	} catch (err) {
		return spawnRefusal(`Task execution failed: ${err}`, projectAgentsDir, Date.now() - startTime);
	}
}

/** Build the tool result (summary text + details) for a settled run. */
function buildResultPayload(
	result: SingleResult,
	projectAgentsDir: string | null,
	totalDurationMs: number,
	mergeSummary: string,
): AgentToolResult<TaskToolDetails> {
	const outcome = classifyAgentOutcome(result);
	const status = outcome.label;
	const output = formatResultOutputFallback(result);
	// `meta` counts the block the reader sees. When that block is the child's
	// output, the artifact's numbers apply (the preview may be a slice of the
	// `agent://` file); when the output was empty and stderr or a placeholder
	// stands in for it, the artifact's `size="0B"` would describe text that is
	// not shown.
	const emittedMeta =
		result.outputMeta && result.output.trim().length > 0
			? result.outputMeta
			: { lineCount: output.split("\n").length, charCount: output.length };
	const outputCharCount = emittedMeta.charCount;
	const fullOutputThreshold = 5000;
	let preview = output;
	let truncated = false;
	if (outputCharCount > fullOutputThreshold) {
		const slice = output.slice(0, fullOutputThreshold);
		const lastNewline = slice.lastIndexOf("\n");
		preview = lastNewline >= 0 ? slice.slice(0, lastNewline) : slice;
		truncated = true;
	}
	// A stopped-but-adopted agent (soft-budget stop) stays messageable; tell
	// the parent so it can resume via irc instead of redoing the work.
	const refStatus = AgentRegistry.global().get(result.id)?.status;
	const resumable = result.aborted && (refStatus === "idle" || refStatus === "parked");
	const summary = prompt.render(toolsPrompts["tools/task-summary"].text, {
		agentName: result.agent,
		id: result.id,
		status,
		duration: formatDuration(totalDurationMs),
		abortReason: result.aborted ? result.abortReason : undefined,
		resumable,
		preview,
		truncated,
		meta: result.outputMeta
			? {
					lineCount: emittedMeta.lineCount,
					charSize: formatBytes(emittedMeta.charCount),
				}
			: undefined,
		mergeSummary,
	});

	return {
		content: [{ type: "text", text: summary }],
		// Without this the parent model receives a structurally successful
		// tool result whose text merely says "failed", and `agent-loop` has
		// nothing to surface as an error on the wire.
		isError: outcome.isError,
		details: {
			projectAgentsDir,
			results: [result],
			totalDurationMs,
			usage: result.usage,
			outputPaths: result.outputPath ? [result.outputPath] : undefined,
		},
	};
}
