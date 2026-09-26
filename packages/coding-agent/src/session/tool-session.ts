/**
 * The {@link ToolSession} a session's tools run against, and the advisor's view of it.
 *
 * The tool session exists before the {@link AgentSession} does: the built-in tools are created
 * from it, and the session is constructed from the tools. Every field that belongs to the session
 * is therefore read through a resolver when a tool calls it, never captured at construction.
 */

import type { Agent } from "@veyyon/agent-core";
import type { Model } from "@veyyon/ai";
import type { HostNotifier } from "@veyyon/host";
import type { SessionManager } from "@veyyon/kernel/session/session-manager";
import { errorMessage, logger, setProjectDir } from "@veyyon/utils";
import { formatModelString } from "../config/model-resolver";
import { defaultEvalSessionId } from "../eval/session-id";
import { DEFAULT_PLAN_FILE_URL } from "../plan-mode/plan-file-url";
import { TOOL_SESSION_LOCAL_STATE_KEYS, type ToolSession } from "../tools";
import { normalizeToolNames, TOOL } from "../tools/core/builtin-names";
import { buildNamedToolChoice } from "../utils/tool-choice";
import type { AgentSession } from "./agent-session";
import type { CreateAgentSessionOptions } from "./factory-options";
import { LSP_LATE_DIAGNOSTIC_MESSAGE_TYPE } from "./messages";

/** What the session factory resolves before the tool session exists. */
export interface SessionToolSessionInputs {
	options: CreateAgentSessionOptions;
	sessionManager: SessionManager;
	/** The session, once constructed. */
	session: () => AgentSession | undefined;
	/** The agent, once constructed. */
	agent: () => Agent | undefined;
	/** The model the session starts on. Live: extension providers may replace it during startup. */
	startupModel: () => Model | undefined;
	/** Whether the startup model was chosen explicitly rather than by role default. */
	hasExplicitModel: boolean;
	obfuscateProviderText: (text: string) => string;
	/** A spawned agent shares this process with its parent and may not move the process cwd. */
	isSpawned: boolean;
	agentId: string;
	evalKernelOwnerId: string;
	/** Fields passed through as resolved. The factory reassigns the project inputs on a cwd change. */
	fields: Pick<
		ToolSession,
		| "enableLsp"
		| "contextFiles"
		| "workspaceTree"
		| "skills"
		| "rules"
		| "eventBus"
		| "agentRegistry"
		| "settings"
		| "authStorage"
		| "modelRegistry"
		| "asyncJobManager"
	>;
}

export interface SessionToolSession {
	/** The primary agent's tool session. */
	toolSession: ToolSession;
	/**
	 * The advisor's tool session: its own `-advisor` session id and agent id, so every tool cache
	 * keyed on session identity stays apart from the primary's, with edit, write and bash fully
	 * functional because the advisor's config selects which of its tools it receives.
	 */
	advisorToolSession: ToolSession;
	/** Replace the set of built-in tools active this turn, read by `isToolActive`. */
	setActiveToolNames(names: Iterable<string>): void;
	/** Install the running host's out-of-band notification delivery, read by `notify`. */
	setNotifier(notify: HostNotifier): void;
	/** The model the session runs on now, formatted as `provider/id`. */
	activeModelString(): string | undefined;
}

/**
 * A {@link ToolSession} that reads every field of `base` live and replaces the ones in `overrides`.
 *
 * Prototype delegation, not a spread. A spread copies a getter's value at the moment of the copy,
 * so a field the base resolves late (`notify`, installed by the host after startup, and
 * `sideComplete`, which exists once the session does) or reassigns later (the project inputs on a
 * working-directory change) stays at its value from the copy. The per-session state a tool
 * attaches on first use ({@link TOOL_SESSION_LOCAL_STATE_KEYS}) is shadowed, so the derived
 * session builds its own instead of reading the base's.
 */
export function deriveToolSession(base: ToolSession, overrides: Partial<ToolSession>): ToolSession {
	const derived = Object.create(base, Object.getOwnPropertyDescriptors(overrides)) as ToolSession;
	for (const key of TOOL_SESSION_LOCAL_STATE_KEYS) {
		if (Object.hasOwn(derived, key)) continue;
		Object.defineProperty(derived, key, { value: undefined, writable: true, enumerable: true, configurable: true });
	}
	return derived;
}

export function createSessionToolSession(inputs: SessionToolSessionInputs): SessionToolSession {
	const { options, sessionManager } = inputs;
	const liveSession = (): AgentSession => {
		const session = inputs.session();
		if (!session) throw new Error("A tool called into its session before the session was constructed.");
		return session;
	};
	const activeModel = (): Model | undefined => inputs.agent()?.state.model ?? inputs.startupModel();
	const activeModelString = (): string | undefined => {
		const model = activeModel();
		return model ? formatModelString(model) : undefined;
	};
	// Per-path mutation counter shared across edit/write tools. Late-diagnostics
	// entries capture it at fetch time and are dropped at injection if a newer
	// mutation (any tool) bumped it in the meantime.
	const fileMutationVersions = new Map<string, number>();
	const activeToolNames = new Set<string>();
	const setActiveToolNames = (names: Iterable<string>): void => {
		activeToolNames.clear();
		for (const name of names) activeToolNames.add(name);
	};
	// Installed by whichever host is running. Nothing here has a host, so a
	// terminal, a GUI and a headless run all reach the same slot.
	let notifier: HostNotifier | undefined;
	const requestedToolNames = options.toolNames ? normalizeToolNames(options.toolNames) : undefined;

	/**
	 * Move the session working directory before an `AgentSession` exists. Once it does, the
	 * move is `AgentSession.setCwd`, which re-scopes far more than this. The process-global
	 * half is skipped for a spawned agent for the reason `AgentSession.rescopeToCwd` skips it.
	 */
	const setCwd: NonNullable<ToolSession["setCwd"]> = async (resolvedPath, cwdOptions) => {
		const session = inputs.session();
		if (session) return session.setCwd(resolvedPath, cwdOptions);
		const previous = sessionManager.getCwd();
		const cwd = await sessionManager.setCwd(resolvedPath, cwdOptions);
		if (cwd !== previous) {
			if (!inputs.isSpawned) setProjectDir(cwd);
			const note = `Session working directory changed: ${previous} → ${cwd}`;
			sessionManager.appendCustomMessageEntry("cwd_changed", note, true, { previous, cwd }, "agent");
		}
		return cwd;
	};

	const toolSession: ToolSession = {
		...inputs.fields,
		get cwd() {
			return sessionManager.getCwd();
		},
		setCwd,
		obfuscateProviderText: inputs.obfuscateProviderText,
		// A generated spawned agent label is a side request of THIS session, so it
		// rides the session's side transport and inherits its watchdogs and
		// concurrency bracket.
		get sideComplete() {
			return inputs.session()?.sideComplete;
		},
		// Reported, never no-oped: until a host installs a notifier this is
		// undefined, so a tool can see that nothing reaches the operator.
		get notify() {
			return notifier;
		},
		isToolActive: name => activeToolNames.has(name),
		setActiveToolNames,
		hasUI: options.hasUI ?? false,
		hasEditTool: !requestedToolNames || requestedToolNames.includes(TOOL.edit),
		skipPythonPreflight: options.skipPythonPreflight,
		outputSchema: options.outputSchema,
		requireYieldTool: options.requireYieldTool,
		taskDepth: options.taskDepth ?? 0,
		maxNestedSpawnDepth: options.maxNestedSpawnDepth,
		getSessionFile: () => sessionManager.getSessionFile() ?? null,
		getEvalKernelOwnerId: () => inputs.evalKernelOwnerId,
		getEvalSessionId: () =>
			inputs.session()?.getEvalSessionId() ?? options.parentEvalSessionId ?? defaultEvalSessionId(toolSession),
		assertEvalExecutionAllowed: () => inputs.session()?.assertEvalExecutionAllowed(),
		trackEvalExecution: (execution, abortController) =>
			inputs.session()?.trackEvalExecution(execution, abortController) ?? execution,
		getSessionId: () => sessionManager.getSessionId?.() ?? null,
		getTurnIndex: () => inputs.session()?.getTurnIndex() ?? 0,
		getHindsightSessionState: () => inputs.session()?.getHindsightSessionState(),
		getMnemopiSessionState: () => inputs.session()?.getMnemopiSessionState(),
		getAgentId: () => inputs.agentId,
		getToolByName: name => inputs.session()?.getToolByName(name),
		getSessionSpawns: () => options.spawns ?? "*",
		getModelString: () => {
			const model = inputs.startupModel();
			return inputs.hasExplicitModel && model ? formatModelString(model) : undefined;
		},
		getActiveModelString: activeModelString,
		getActiveThinkingLevel: () => inputs.session()?.configuredThinkingLevel() ?? options.thinkingLevel,
		getActiveModel: activeModel,
		getServiceTierByFamily: () => inputs.session()?.serviceTierByFamily,
		getImageAttachments: () => inputs.session()?.getImageAttachments() ?? [],
		getPlanModeState: () => inputs.session()?.getPlanModeState(),
		getPlanReferencePath: () => inputs.session()?.getPlanReferencePath() ?? DEFAULT_PLAN_FILE_URL,
		getGoalModeState: () => inputs.session()?.getGoalModeState(),
		getGoalRuntime: () => inputs.session()?.goalRuntime,
		getUsageStatistics: () => sessionManager.getUsageStatistics(),
		getTurnBudget: () => sessionManager.getTurnBudget(),
		recordEvalAgentUsage: output => sessionManager.recordEvalAgentOutput(output),
		getClientBridge: () => inputs.session()?.clientBridge,
		queueDeferredDiagnostics: entry => inputs.session()?.yieldQueue.enqueue(LSP_LATE_DIAGNOSTIC_MESSAGE_TYPE, entry),
		bumpFileMutationVersion: path => {
			const next = (fileMutationVersions.get(path) ?? 0) + 1;
			fileMutationVersions.set(path, next);
			return next;
		},
		getFileMutationVersion: path => fileMutationVersions.get(path) ?? 0,
		getTodoPhases: () => liveSession().getTodoPhases(),
		setTodoPhases: phases => liveSession().setTodoPhases(phases),
		isMCPDiscoveryEnabled: () => liveSession().isMCPDiscoveryEnabled(),
		getSelectedMCPToolNames: () => liveSession().getSelectedMCPToolNames(),
		activateDiscoveredMCPTools: toolNames => liveSession().activateDiscoveredMCPTools(toolNames),
		// Generic tool discovery (unified — covers built-in + MCP + extension)
		isToolDiscoveryEnabled: () => liveSession().isToolDiscoveryEnabled(),
		getDiscoverableTools: filter => liveSession().getDiscoverableTools(filter),
		getDiscoverableToolSearchIndex: () => liveSession().getDiscoverableToolSearchIndex(),
		getSelectedDiscoveredToolNames: () => liveSession().getSelectedDiscoveredToolNames(),
		activateDiscoveredTools: toolNames => liveSession().activateDiscoveredTools(toolNames),
		getCheckpointState: () => liveSession().getCheckpointState(),
		setCheckpointState: state => liveSession().setCheckpointState(state ?? undefined),
		getLastCompletedRewind: () => liveSession().getLastCompletedRewind(),
		getToolChoiceQueue: () => liveSession().toolChoiceQueue,
		buildToolChoice: name => {
			const model = liveSession().model;
			return model ? buildNamedToolChoice(name, model) : undefined;
		},
		steer: message =>
			liveSession().agent.steer({
				role: "custom",
				customType: message.customType,
				content: message.content,
				display: false,
				details: message.details,
				attribution: "agent",
				timestamp: Date.now(),
			}),
		peekQueueInvoker: () => liveSession().peekQueueInvoker(),
		peekPendingInvoker: () => liveSession().peekPendingInvoker(),
		clearPendingInvokers: () => liveSession().clearPendingInvokers(),
		peekStandingResolveHandler: () => liveSession().peekStandingResolveHandler(),
		setStandingResolveHandler: handler => liveSession().setStandingResolveHandler(handler),
		allocateOutputArtifact: async toolType => {
			try {
				return await sessionManager.allocateArtifactPath(toolType);
			} catch (error) {
				// Without an artifact, oversized output is truncated with no
				// full-output copy — never degrade to that silently.
				logger.error("Artifact allocation failed; large output will be truncated without a saved copy", {
					toolType,
					error: errorMessage(error),
				});
				return {};
			}
		},
		getArtifactManager: () => sessionManager.getArtifactManager(),
		recordAgentSpawn: record => sessionManager.appendAgentSpawn(record),
		getTelemetry: () => inputs.agent()?.telemetry,
	};

	const advisorToolSession = deriveToolSession(toolSession, {
		hasEditTool: true,
		requireYieldTool: false,
		getSessionId: () => {
			const id = sessionManager.getSessionId?.();
			return id ? `${id}-advisor` : null;
		},
		getAgentId: () => "advisor",
	});

	return {
		toolSession,
		advisorToolSession,
		setActiveToolNames,
		setNotifier: notify => {
			notifier = notify;
		},
		activeModelString,
	};
}
