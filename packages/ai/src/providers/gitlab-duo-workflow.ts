import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
	discoverGitLabDuoWorkflowRuntimeNamespace,
	type GitLabDuoWorkflowNamespaceSelection,
} from "@veyyon/catalog/discovery/gitlab-duo-workflow";
import { emptyUsage } from "@veyyon/catalog/models";
import { GITLAB_SAAS_URL } from "@veyyon/catalog/provider-endpoints";
import { tryParseJson } from "@veyyon/utils/json";
import * as logger from "@veyyon/utils/logger";
import { scopedTimeoutSignal } from "@veyyon/utils/scoped-timeout";
import { errorMessage, getNonBlankStringProperty, isRecord } from "@veyyon/utils/type-guards";
import { trimTrailingSlashes } from "@veyyon/utils/url";
import { parseToolArgsText } from "../dialect/coercion";
import * as AIError from "../error";
import { AI_PROMPTS } from "../prompts/registry";
import type {
	Api,
	AssistantMessage,
	Context,
	FetchImpl,
	Message,
	Model,
	ProviderSessionState,
	StreamFunction,
	StreamOptions,
	Tool,
	ToolCall,
	ToolChoice,
	ToolResultMessage,
} from "../types";
import { normalizeSystemPrompts } from "../utils";
import { AssistantMessageEventStream } from "../utils/event-stream";
import { openBoundedFirstEventBudget } from "../utils/first-event-budget";
import { toolWireSchema } from "../utils/schema/wire";

export const GITLAB_DUO_WORKFLOW_PROVIDER_ID = "gitlab-duo-agent";
export const GITLAB_DUO_WORKFLOW_API = "gitlab-duo-agent";
export const GITLAB_DUO_WORKFLOW_DEFINITION = "ambient";
export type GitLabDuoWorkflowDefinition = "ambient" | (string & {});

const GITLAB_DUO_WORKFLOW_TRACE_ENV = "GITLAB_DUO_WORKFLOW_TRACE";
const GITLAB_DUO_WORKFLOW_TRACE_FILE_ENV = "GITLAB_DUO_WORKFLOW_TRACE_FILE";
const DEFAULT_GITLAB_DUO_WORKFLOW_TRACE_FILE = path.resolve(
	import.meta.dir,
	"../../../../.tmp/gitlab-duo-workflow-trace.log",
);
const GITLAB_DUO_WORKFLOW_CLIENT_TYPE = "node-websocket";
/**
 * Idle deadline for the workflow WebSocket. The socket has no server-side
 * keepalive contract veyyon can rely on, so a connection silently going half-open
 * (proxy/LB drops the TCP link without delivering FIN/RST) would otherwise leave
 * `runGitLabDuoWorkflowSocket` waiting forever. If no frame arrives within this
 * window — before open or between checkpoints — the socket is aborted and the
 * run reconnects once on the same `workflowID` (server-side resume).
 */
const GITLAB_DUO_WORKFLOW_IDLE_TIMEOUT_MS = 90_000;
/**
 * Absolute deadline (ms) for each REST setup fetch (`ensureGitLabDuoWorkflowSettings`,
 * `discoverGitLabDuoWorkflowProject`, `resolveGitLabDuoWorkflowNumericProjectId`,
 * `requestGitLabDuoWorkflowDirectAccess`, `createGitLabDuoWorkflow`,
 * `fetchGitLabDuoWorkflowAvailableModels`, `stopGitLabDuoWorkflow`).
 *
 * `streamGitLabDuoWorkflow` pushes its `start` event before these calls run and the
 * `gitlab-duo-agent` bypass in `streamSimple` skips the `register-builtins`
 * `iterateWithIdleTimeout` wrapper, so a stalled setup fetch would otherwise leave
 * the stream with no terminal event. 30s covers healthy p99 for every REST endpoint
 * the workflow touches while still surfacing a real stall as a provider error;
 * matches the OAuth `TOKEN_REQUEST_TIMEOUT_MS` used by sibling GitLab flows.
 */
const GITLAB_DUO_WORKFLOW_REST_TIMEOUT_MS = 30_000;
/**
 * Absolute deadline (ms) for the WHOLE setup phase, however many REST calls it
 * takes. Each call has its own {@link GITLAB_DUO_WORKFLOW_REST_TIMEOUT_MS}
 * deadline and nothing bounded the chain: six calls in series, run twice when a
 * cached namespace turns out stale, is minutes of a live turn whose `start`
 * event has already been pushed and whose stream carries nothing. Three times
 * the per-call deadline is well clear of a healthy setup (single-digit seconds
 * against gitlab.com) and far below the old worst case. A caller that declared
 * a shorter `streamFirstEventTimeoutMs` wins over this ceiling.
 */
const GITLAB_DUO_WORKFLOW_SETUP_TIMEOUT_MS = 3 * GITLAB_DUO_WORKFLOW_REST_TIMEOUT_MS;
/**
 * How many times a single stream may restart on a FRESH workflow after the server
 * reports its per-workflow step (graph-recursion) limit. Long veyyon tool-call loops
 * legitimately overrun the cap; each restart resets the budget. Bounded so a task
 * that perpetually overruns degrades to a graceful stop instead of looping on quota.
 */
const GITLAB_DUO_WORKFLOW_MAX_STEP_LIMIT_RESTARTS = 4;
/**
 * How many times a single stream may restart on a FRESH workflow after the server
 * returns its de-identified catch-all FAILED (transient upstream fault wrapper).
 * Kept low because, unlike the step limit, a generic failure that repeats is more
 * likely deterministic; one bounded retry covers the common transient case without
 * looping on quota.
 */
const GITLAB_DUO_WORKFLOW_MAX_GENERIC_ERROR_RETRIES = 1;
/**
 * How many times a single stream may restart on a FRESH workflow after detecting a
 * stalled workflow: the server emitted a fresh checkpoint at a tool-call boundary
 * but its `ui_chat_log` total did NOT advance past the previous tool-call boundary
 * of the SAME workflow. A healthy run strictly grows the log each turn (agent
 * reasoning + tool boundary entries); a flat total means the server-side turn did
 * not progress — the model re-issues the same tool call against a history that
 * never gained its prior call/result (captured live: total pinned at 2 while the
 * model repeated `next_step({"n":1})`). Restarting on a fresh workflow resends the
 * full goal transcript (rebuilt from the agent loop's intact `context.messages`,
 * so no in-flight tool result is lost) and the new run progresses. Bounded so a
 * persistently stalling endpoint degrades to a surfaced result instead of a quota
 * sink.
 */
const GITLAB_DUO_WORKFLOW_MAX_STALL_RESTARTS = 2;
/**
 * Surfaced when a workflow stalled (its `ui_chat_log` total stopped advancing) and
 * every bounded fresh-workflow restart also stalled. Phrased as a transient
 * server-side failure so the agent loop treats it as a normal error rather than a
 * client bug.
 */
const GITLAB_DUO_WORKFLOW_STALL_ERROR_MESSAGE =
	"GitLab Duo Agent stopped making progress (the workflow's visible history did not advance after multiple restarts).";
/**
 * Two rendered-`goal` byte thresholds bounding three reliability zones. Empirically
 * the DWS/Workhorse transport accepts no fixed token wall (it has tokenized
 * 970k-token goals) but its failure probability rises with the rendered-goal BYTE
 * size: ≤~1MB is the reliable floor we now treat as the auto-compaction trigger,
 * ~1.4–1.7MB is a jitter band where a request fails more often than not but can still
 * go through, ≥~2MB basically always fails, and 4MB is the DWS gRPC `MAX_MESSAGE_SIZE`
 * hard cap. The soft threshold was lowered from 1.25MB to 1MB because the higher value
 * almost never fired in practice — auto-compaction needs to engage earlier.
 *
 * - `[0, SOFT)` reliable zone: send normally; an error here is a genuine upstream
 *   fault and surfaces verbatim.
 * - `[SOFT, HARD)` jitter zone: still attempt once (it can succeed); if the run then
 *   ERRORS, the size is the likely cause, so re-label it as a context-overflow to
 *   drive auto-compaction.
 * - `[HARD, ∞)` necessary-fail zone: do NOT spend the request — proactively end the
 *   stream with the overflow error so the session compacts immediately.
 *
 * `SOFT` is the auto-compaction trigger floor; `HARD` is the necessary-fail floor.
 * Re-labeling uses {@link buildGitLabDuoWorkflowGoalOverflowMessage}.
 */
const GITLAB_DUO_WORKFLOW_GOAL_SOFT_OVERFLOW_BYTES = 1_048_576;
const GITLAB_DUO_WORKFLOW_GOAL_HARD_OVERFLOW_BYTES = 2_000_000;

// Overflow-pattern message for oversized goal triggers auto-compaction.
function buildGitLabDuoWorkflowGoalOverflowMessage(goalBytes: number): string {
	return `prompt is too long: ${goalBytes} bytes exceeds the GitLab Duo Agent goal byte budget (soft ${GITLAB_DUO_WORKFLOW_GOAL_SOFT_OVERFLOW_BYTES}, hard ${GITLAB_DUO_WORKFLOW_GOAL_HARD_OVERFLOW_BYTES})`;
}
const GITLAB_DUO_WORKFLOW_LANGUAGE_SERVER_VERSION = "8.104.0";
const GITLAB_DUO_WORKFLOW_AVAILABLE_MODELS_QUERY = `query veyyon_gitlabDuoWorkflowAvailableModels($rootNamespaceId: GroupID!) {
  aiChatAvailableModels(rootNamespaceId: $rootNamespaceId) {
    defaultModel { name ref }
    selectableModels { name ref }
    pinnedModel { name ref }
  }
}`;

export const GITLAB_DUO_WORKFLOW_CLIENT_CAPABILITIES = [
	"incremental_streaming",
	"read_file_chunked",
	"shell_command",
	"command_timeout",
	"tool_call_approval",
] as const;

const GITLAB_DUO_WORKFLOW_INLINE_AGENT_NAME = "veyyon_agent";
const GITLAB_DUO_WORKFLOW_INLINE_PROMPT_ID = "veyyon_inline_prompt";
// Opt in to agent reasoning / chain-of-thought on inline flows.
const GITLAB_DUO_WORKFLOW_INLINE_UI_LOG_EVENTS = [
	"on_agent_reasoning",
	"on_agent_final_answer",
	"on_tool_execution_success",
	"on_tool_execution_failed",
] as const;

const GITLAB_DUO_WORKFLOW_ACTION_NAMES = ["runMCPTool", "run_mcp_tool"] as const;

export interface GitLabMcpToolArgs {
	name?: string;
	tool_name?: string;
	toolName?: string;
	providerIdentifier?: string;
	provider_identifier?: string;
	toolCallId?: string;
	tool_call_id?: string;
	args?: Record<string, unknown> | string;
	arguments?: Record<string, unknown> | string;
}

export interface GitLabPlainTextResponse {
	response?: string;
	error?: string;
}

export type PlainTextResponse = GitLabPlainTextResponse;
export interface GitLabDuoWorkflowOptions extends StreamOptions {
	rootNamespaceId?: string;
	namespaceId?: string;
	projectId?: string;
	projectPath?: string;
	workflowDefinition?: GitLabDuoWorkflowDefinition;
	workflowId?: string;
	workflowToken?: string;
	cwd?: string;
	webSocketFactory?: GitLabDuoWorkflowWebSocketFactory;
	/** Idle WebSocket deadline (ms) before aborting and resuming; defaults to {@link GITLAB_DUO_WORKFLOW_IDLE_TIMEOUT_MS}. */
	idleTimeoutMs?: number;
	/**
	 * Tool-choice override forwarded from the stream layer. Only `"none"` is
	 * acted on: a side-request (e.g. handoff) keeps tool definitions in the cache
	 * prefix but disables tool use, so the provider must not advertise them to Duo.
	 */
	toolChoice?: ToolChoice;
}

export interface GitLabDuoWorkflowWebSocketLike {
	readyState?: number;
	binaryType?: string;
	onopen: ((event: Event) => void) | null;
	onmessage: ((event: MessageEvent) => void) | null;
	onerror: ((event: Event) => void) | null;
	onclose: ((event: CloseEvent) => void) | null;
	send(data: string): void;
	close(code?: number, reason?: string): void;
}

export interface GitLabDuoWorkflowWebSocketFactoryOptions {
	headers: Record<string, string>;
	protocols?: string[];
}

export type GitLabDuoWorkflowWebSocketFactory = (
	url: string,
	options: GitLabDuoWorkflowWebSocketFactoryOptions,
) => GitLabDuoWorkflowWebSocketLike;

export interface GitLabDirectAccessResponse {
	token?: string;
	access_token?: string;
	jwt?: string;
	workflow_token?: string;
	duo_workflow_access_token?: string;
	duo_workflow_service?: { token?: string; base_url?: string; headers?: Record<string, string> };
	gitlab_rails?: { token?: string };
	[key: string]: unknown;
}

interface GitLabDuoWorkflowDirectAccessConnection {
	token: string;
	baseUrl?: string;
	headers: Record<string, string>;
	serviceEndpoint: boolean;
}

interface GitLabCreateWorkflowResponse {
	id?: string | number;
	workflow_id?: string | number;
	workflowId?: string | number;
	[key: string]: unknown;
}

interface GitLabDuoWorkflowCreateBodyOptions {
	projectId?: string;
	goal?: string;
	workflowDefinition?: GitLabDuoWorkflowDefinition;
}

interface GitLabDuoWorkflowStartMetadataOptions {
	projectId?: string;
	projectPath?: string;
	namespaceId?: string;
	rootNamespaceId?: string;
	workflowDefinition?: GitLabDuoWorkflowDefinition;
	inlineFlow?: boolean;
}
export interface GitLabMcpToolDefinition {
	name: string;
	originalToolName: string;
	serverName: string;
	description: string;
	inputSchema: string;
	isApproved: boolean;
}

export interface GitLabDuoWorkflowAdditionalContextItem {
	id: string;
	category: "agent_user_environment" | "user_rule";
	content: string;
	metadata: {
		title: string;
		enabled: boolean;
		subType: "snippet";
		icon: string;
		secondaryText: string;
		subTypeLabel: string;
	};
}

export interface GitLabDuoWorkflowStartRequest {
	workflowID: string;
	clientVersion: "1.0";
	workflowDefinition: GitLabDuoWorkflowDefinition;
	goal: string;
	workflowMetadata: string;
	additional_context: readonly GitLabDuoWorkflowAdditionalContextItem[];
	approval?: {
		approval?: Record<string, never>;
		rejection?: { message?: string };
	};
	clientCapabilities: readonly (typeof GITLAB_DUO_WORKFLOW_CLIENT_CAPABILITIES)[number][];
	mcpTools: GitLabMcpToolDefinition[];
	preapproved_tools: string[];
	flowConfigSchemaVersion?: "v1";
	flowConfigId?: string;
	flowVersion?: string;
	flowConfig?: GitLabDuoWorkflowInlineFlowConfig;
}

export interface GitLabDuoWorkflowInlineFlowComponent {
	name: string;
	type: "AgentComponent";
	prompt_id: string;
	toolset: string[];
	inputs: { from: string; as: string }[];
	ui_log_events: string[];
}

export interface GitLabDuoWorkflowInlineFlowPrompt {
	name: string;
	prompt_id: string;
	unit_primitives: string[];
	prompt_template: { system: string; user: string; placeholder: string };
}

export interface GitLabDuoWorkflowInlineFlowConfig {
	version: "v1";
	environment: "ambient";
	flow: { entry_point: string };
	components: GitLabDuoWorkflowInlineFlowComponent[];
	routers: { from: string; to: string }[];
	prompts: GitLabDuoWorkflowInlineFlowPrompt[];
}

export interface GitLabDuoWorkflowActionResponse {
	actionResponse: {
		requestID: string;
		plainTextResponse?: GitLabPlainTextResponse;
	};
}

interface GitLabDuoWorkflowActionDescriptor {
	requestID: string;
	name: string;
	args: unknown;
}

export interface GitLabDuoWorkflowActiveSession {
	workflowId: string;
	startPayload: GitLabDuoWorkflowStartRequest;
	ws: GitLabDuoWorkflowWebSocketLike;
	// Best-effort server-side stop for this workflow; never throws.
	stop?: () => void;
	pendingActions?: GitLabDuoWorkflowActionDescriptor[];
	checkpointAgentContentByKey?: Record<string, string>;
	checkpointAgentContentSignatures?: Record<string, true>;
	paused?: boolean;
	pauseBuffer?: unknown[];
	// Last checkpoint byte length; equal lengths across consecutive boundaries flag a stall.
	lastToolBoundaryContentLength?: number;
}

export interface GitLabDuoWorkflowProviderSessionState extends ProviderSessionState {
	active?: GitLabDuoWorkflowActiveSession;
}

export interface GitLabDuoWorkflowStreamState {
	stream: AssistantMessageEventStream;
	output: AssistantMessage;
	activeTextIndex?: number;
	activeThinkingIndex?: number;
	activeCheckpointMessageKey?: string;
	started: boolean;
	checkpointAgentContentByKey?: Record<string, string>;
	checkpointAgentContentSignatures?: Record<string, true>;
	pauseRequested?: boolean;
	stepLimitRequested?: boolean;
	retryableErrorRequested?: boolean;
	// Latest checkpoint byte length to detect non-advancing stall.
	lastCheckpointContentLength?: number;
	// Set when checkpoint byte length did not change across boundaries.
	stalledRequested?: boolean;
	providerSessionState?: GitLabDuoWorkflowProviderSessionState;
	lastApprovalStatus?: string;
	// Carries overflow message when rendered goal exceeds byte budget.
	goalOverflowMessage?: string;
}

type GitLabDuoWorkflowSocketResult =
	| "closed"
	| "terminal"
	| "approval"
	| "action"
	| "pause"
	| "timeout"
	| "step_limit"
	| "retryable_error"
	| "stalled";

export interface GitLabAvailableModel {
	name?: string | null;
	ref?: string | null;
}

export interface GitLabAvailableModelsPayload {
	pinnedModel?: GitLabAvailableModel | null;
	selectedModel?: GitLabAvailableModel | null;
	defaultModel?: GitLabAvailableModel | null;
	selectableModels?: GitLabAvailableModel[] | null;
}

export const streamGitLabDuoWorkflow: StreamFunction<"gitlab-duo-agent"> = (
	model: Model<"gitlab-duo-agent">,
	context: Context,
	options: GitLabDuoWorkflowOptions,
): AssistantMessageEventStream => {
	const stream = new AssistantMessageEventStream();
	const output = createAssistantMessage(model);
	stream.push({ type: "start", partial: output });
	const state: GitLabDuoWorkflowStreamState = { stream, output, started: true };

	void runGitLabDuoWorkflow(model, context, options, state).catch(error => {
		const errorText = gitLabDuoWorkflowErrorText(error);
		if (!stream.done) {
			output.stopReason = "error";
			// Surface oversized goal errors as context-overflow to trigger compaction.
			output.errorMessage = state.goalOverflowMessage ?? errorText;
			stream.push({ type: "error", reason: "error", error: output });
		}
	});

	return stream;
};

export function buildGitLabDuoWorkflowDirectAccessBody(
	rootNamespaceId: string,
	projectId?: string,
	workflowDefinition: GitLabDuoWorkflowDefinition = GITLAB_DUO_WORKFLOW_DEFINITION,
): Record<string, string> {
	return {
		workflow_definition: workflowDefinition,
		root_namespace_id: toGitLabGraphQLNamespaceId(rootNamespaceId),
		...(projectId ? { project_id: projectId } : undefined),
	};
}

export function buildGitLabDuoWorkflowCreateBody(
	namespaceId?: string,
	options: GitLabDuoWorkflowCreateBodyOptions = {},
): Record<string, string | boolean | string[] | number[]> {
	return {
		workflow_definition: options.workflowDefinition ?? GITLAB_DUO_WORKFLOW_DEFINITION,
		environment: "ide",
		allow_agent_to_request_user: false,
		agent_privileges: [6],
		pre_approved_agent_privileges: [6],
		requires_duo_cli_enabled: false,
		...(namespaceId && !options.projectId ? { namespace_id: namespaceId } : undefined),
		...(options.projectId ? { project_id: options.projectId } : undefined),
		...(options.goal !== undefined ? { goal: options.goal } : { goal: "" }),
	};
}

export function buildGitLabDuoWorkflowStopBody(): Record<string, string> {
	return { status_event: "stop" };
}

export function buildGitLabDuoWorkflowWebSocketUrl(
	baseUrl: string,
	options: {
		projectId?: string;
		namespaceId?: string;
		rootNamespaceId?: string;
		selectedModelIdentifier?: string;
		workflowDefinition?: GitLabDuoWorkflowDefinition;
		serviceEndpoint?: boolean;
	} = {},
): string {
	// Route to DWS runway host (root path) or GitLab instance with relative base path.
	const wsUrl = options.serviceEndpoint
		? new URL("/", normalizeGitLabBaseUrl(baseUrl))
		: gitLabApiUrl(baseUrl, "/api/v4/ai/duo_workflows/ws");
	wsUrl.protocol = wsUrl.protocol === "http:" ? "ws:" : "wss:";
	if (options.projectId) wsUrl.searchParams.set("project_id", options.projectId);
	if (options.namespaceId && !options.serviceEndpoint)
		wsUrl.searchParams.set("namespace_id", toGitLabRestNamespaceId(options.namespaceId));
	if (options.rootNamespaceId)
		wsUrl.searchParams.set("root_namespace_id", toGitLabRestNamespaceId(options.rootNamespaceId));
	if (options.selectedModelIdentifier)
		wsUrl.searchParams.set("user_selected_model_identifier", options.selectedModelIdentifier);
	if (options.workflowDefinition) wsUrl.searchParams.set("workflow_definition", options.workflowDefinition);
	return wsUrl.toString();
}

export function buildGitLabDuoWorkflowWebSocketHeaders(options: {
	token: string;
	baseUrl?: string;
	projectId?: string;
	namespaceId?: string;
	rootNamespaceId?: string;
	extraHeaders?: Record<string, string>;
}): Record<string, string> {
	const base = new URL(normalizeGitLabBaseUrl(options.baseUrl ?? GITLAB_SAAS_URL));
	return {
		...options.extraHeaders,
		authorization: `Bearer ${options.token}`,
		"x-gitlab-client-type": GITLAB_DUO_WORKFLOW_CLIENT_TYPE,
		"x-gitlab-language-server-version": GITLAB_DUO_WORKFLOW_LANGUAGE_SERVER_VERSION,
		"user-agent": `unknown/unknown unknown/unknown gitlab-language-server/${GITLAB_DUO_WORKFLOW_LANGUAGE_SERVER_VERSION}`,
		origin: base.origin,
		...(options.projectId ? { "x-gitlab-project-id": options.projectId } : {}),
		...(options.namespaceId ? { "x-gitlab-namespace-id": toGitLabRestNamespaceId(options.namespaceId) } : {}),
		...(options.rootNamespaceId
			? { "x-gitlab-root-namespace-id": toGitLabRestNamespaceId(options.rootNamespaceId) }
			: {}),
	};
}
export function buildGitLabDuoWorkflowStartRequest(
	workflowId: string,
	model: Model<"gitlab-duo-agent">,
	context: Context,
	tools: Tool[] | undefined = context.tools,
	availableModels?: GitLabAvailableModelsPayload | null,
	metadataOptions: GitLabDuoWorkflowStartMetadataOptions = {},
): GitLabDuoWorkflowStartRequest {
	const workflowMetadata = buildGitLabDuoWorkflowStartMetadata(model, availableModels, metadataOptions);
	const mcpTools = buildGitLabDuoWorkflowMcpTools(tools);
	return {
		workflowID: workflowId,
		clientVersion: "1.0",
		workflowDefinition: metadataOptions.workflowDefinition ?? GITLAB_DUO_WORKFLOW_DEFINITION,
		goal: buildGitLabDuoWorkflowGoal(context),
		workflowMetadata: JSON.stringify(workflowMetadata),
		additional_context: buildGitLabDuoWorkflowClientAdditionalContext(),
		clientCapabilities: GITLAB_DUO_WORKFLOW_CLIENT_CAPABILITIES,
		mcpTools,
		preapproved_tools: mcpTools.map(tool => tool.name),
		flowConfigSchemaVersion: "v1" as const,
		flowConfig: buildGitLabDuoWorkflowInlineFlowConfig(buildGitLabDuoWorkflowSystemPrompt(context)),
	};
}

// Build inline ambient flow (Path B / flowConfig) with system prompt and {{goal}} slot.
export function buildGitLabDuoWorkflowInlineFlowConfig(systemPrompt: string): GitLabDuoWorkflowInlineFlowConfig {
	return {
		version: "v1",
		environment: "ambient",
		flow: { entry_point: GITLAB_DUO_WORKFLOW_INLINE_AGENT_NAME },
		components: [
			{
				name: GITLAB_DUO_WORKFLOW_INLINE_AGENT_NAME,
				type: "AgentComponent",
				prompt_id: GITLAB_DUO_WORKFLOW_INLINE_PROMPT_ID,
				toolset: [],
				inputs: [{ from: "context:goal", as: "goal" }],
				ui_log_events: GITLAB_DUO_WORKFLOW_INLINE_UI_LOG_EVENTS.slice(),
			},
		],
		routers: [{ from: GITLAB_DUO_WORKFLOW_INLINE_AGENT_NAME, to: "end" }],
		prompts: [
			{
				name: GITLAB_DUO_WORKFLOW_INLINE_PROMPT_ID,
				prompt_id: GITLAB_DUO_WORKFLOW_INLINE_PROMPT_ID,
				unit_primitives: ["duo_agent_platform"],
				prompt_template: { system: systemPrompt, user: "{{goal}}", placeholder: "history" },
			},
		],
	};
}

function buildGitLabDuoWorkflowStartMetadata(
	model: Model<"gitlab-duo-agent">,
	availableModels: GitLabAvailableModelsPayload | null | undefined,
	metadataOptions: GitLabDuoWorkflowStartMetadataOptions,
): Record<string, string> {
	return {
		environment: "ide",
		client_type: GITLAB_DUO_WORKFLOW_CLIENT_TYPE,
		...(metadataOptions.projectId ? { projectId: metadataOptions.projectId } : undefined),
		...(metadataOptions.namespaceId
			? { namespaceId: toGitLabRestNamespaceId(metadataOptions.namespaceId) }
			: undefined),
		...(metadataOptions.rootNamespaceId
			? { rootNamespaceId: toGitLabRestNamespaceId(metadataOptions.rootNamespaceId) }
			: undefined),
		selectedModelIdentifier: selectGitLabDuoWorkflowModelRef(model.id, availableModels),
	};
}

export function buildGitLabDuoWorkflowClientAdditionalContext(): GitLabDuoWorkflowAdditionalContextItem[] {
	return [];
}

export function buildGitLabDuoWorkflowMcpTools(tools: Tool[] | undefined): GitLabMcpToolDefinition[] {
	return tools?.map(buildGitLabMcpToolDefinition) ?? [];
}

export function selectGitLabDuoWorkflowModelRef(
	selectedModel: string,
	availableModels?: GitLabAvailableModelsPayload | null,
): string {
	const pinned = availableModels?.pinnedModel?.ref;
	if (pinned) return pinned;
	return selectedModel;
}

export function buildGitLabPlainTextFromToolResult(toolResult: ToolResultMessage): GitLabPlainTextResponse {
	const text = gitLabToolResultToText(toolResult);
	return toolResult.isError ? { error: text } : { response: text };
}
function findGitLabDuoWorkflowToolResultById(
	messages: readonly Message[],
	requestID: string,
): ToolResultMessage | undefined {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (message?.role === "toolResult" && message.toolCallId === requestID) return message;
	}
	return undefined;
}

// Resolve pending actions to tool results; returns pairs only when all are present.
function resolveGitLabDuoWorkflowActionBatch(
	messages: readonly Message[],
	actions: readonly GitLabDuoWorkflowActionDescriptor[],
): { requestID: string; result: ToolResultMessage }[] | undefined {
	const resolved: { requestID: string; result: ToolResultMessage }[] = [];
	for (const action of actions) {
		const result = findGitLabDuoWorkflowToolResultById(messages, action.requestID);
		if (!result) return undefined;
		resolved.push({ requestID: action.requestID, result });
	}
	return resolved;
}

// True when a user/developer message sits after the last resolved tool result (mid-loop steer).
function hasGitLabDuoWorkflowSteerAfterBatch(
	messages: readonly Message[],
	batch: readonly { requestID: string; result: ToolResultMessage }[],
): boolean {
	let lastBatchResultIndex = -1;
	const requestIds = new Set(batch.map(entry => entry.requestID));
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (message?.role === "toolResult" && requestIds.has(message.toolCallId)) {
			lastBatchResultIndex = index;
			break;
		}
	}
	if (lastBatchResultIndex < 0) return false;
	for (let index = lastBatchResultIndex + 1; index < messages.length; index++) {
		const role = messages[index]?.role;
		if (role === "user" || role === "developer") return true;
	}
	return false;
}

function buildGitLabDuoWorkflowResponseFromToolResult(toolResult: ToolResultMessage): GitLabPlainTextResponse {
	return buildGitLabPlainTextFromToolResult(toolResult);
}

// Stream one tool_call into the assistant message and finalize the turn.
function emitGitLabDuoWorkflowActionToolCall(
	state: GitLabDuoWorkflowStreamState,
	action: GitLabDuoWorkflowActionDescriptor,
): void {
	endGitLabDuoWorkflowText(state);
	endGitLabDuoWorkflowThinking(state);
	const toolCall = buildGitLabDuoWorkflowActionToolCall(action);
	state.output.content.push(toolCall);
	const contentIndex = state.output.content.length - 1;
	state.stream.push({ type: "toolcall_start", contentIndex, partial: state.output });
	state.stream.push({
		type: "toolcall_delta",
		contentIndex,
		delta: JSON.stringify(toolCall.arguments),
		partial: state.output,
	});
	state.stream.push({ type: "toolcall_end", contentIndex, toolCall, partial: state.output });
	finishGitLabDuoWorkflowStream(state, "toolUse");
	if (state.providerSessionState?.active) {
		state.providerSessionState.active.pendingActions = [action];
	}
}

// Returns true when consecutive checkpoint byte lengths are identical (stalled workflow).
function detectGitLabDuoWorkflowStall(state: GitLabDuoWorkflowStreamState): boolean {
	const active = state.providerSessionState?.active;
	const length = state.lastCheckpointContentLength;
	if (!active || length === undefined) return false;
	const previousLength = active.lastToolBoundaryContentLength;
	const stalled = previousLength !== undefined && length === previousLength;
	active.lastToolBoundaryContentLength = length;
	return stalled;
}

function buildGitLabDuoWorkflowActionToolCall(action: GitLabDuoWorkflowActionDescriptor): ToolCall {
	const args = isRecord(action.args) ? (action.args as Record<string, unknown>) : {};
	const mapped = mapGitLabDuoWorkflowActionToOmpTool(action.name, args);
	return {
		type: "toolCall",
		id: action.requestID,
		name: mapped.name,
		arguments: mapped.arguments,
	};
}

function mapGitLabDuoWorkflowActionToOmpTool(
	actionName: string,
	args: Record<string, unknown>,
): { name: string; arguments: Record<string, unknown> } {
	switch (actionName) {
		case "runMCPTool":
		case "run_mcp_tool":
			return mapGitLabDuoWorkflowMcpToolCall(args);
		default:
			return { name: actionName, arguments: { ...args } };
	}
}

function mapGitLabDuoWorkflowMcpToolCall(args: Record<string, unknown>): {
	name: string;
	arguments: Record<string, unknown>;
} {
	const rawName =
		getNonBlankStringProperty(args, "toolName") ??
		getNonBlankStringProperty(args, "tool_name") ??
		getNonBlankStringProperty(args, "name") ??
		"";
	const toolName = rawName.startsWith("mcp__veyyon__") ? rawName.slice("mcp__veyyon__".length) : rawName;
	const parsedArgs = parseGitLabDuoWorkflowMcpArguments(args.args ?? args.arguments, toolName || undefined);
	if (toolName === "edit" && typeof parsedArgs.input === "string") {
		return { name: "edit", arguments: { input: parsedArgs.input } };
	}
	return { name: toolName, arguments: parsedArgs };
}

function parseGitLabDuoWorkflowMcpArguments(value: unknown, tool?: string): Record<string, unknown> {
	if (value === undefined) return {};

	if (typeof value === "string") return parseToolArgsText(value, { source: "gitlab-duo-workflow", tool });
	if (isRecord(value)) return value as Record<string, unknown>;
	logger.warn("Tool call arguments were not an object; the tool is being called with none", {
		source: "gitlab-duo-workflow",
		tool,
		received: Array.isArray(value) ? "array" : typeof value,
	});
	return {};
}

function gitLabDuoWorkflowProviderSessionStateKey(
	baseUrl: string,
	modelId: string,
	sessionId: string | undefined,
): string {
	return `gitlab-duo-agent:${baseUrl}\u0000${modelId}\u0000${sessionId ?? ""}`;
}

function createGitLabDuoWorkflowProviderSessionState(): GitLabDuoWorkflowProviderSessionState {
	const state: GitLabDuoWorkflowProviderSessionState = {
		close: () => {
			// Stop the server-side workflow before tearing down the socket.
			try {
				state.active?.stop?.();
			} catch {
				// Best-effort: never let a stop failure block disposal.
			}
			try {
				state.active?.ws.close();
			} catch {
				// Ignore close failures from already-closed sockets.
			}
			state.active = undefined;
		},
	};
	return state;
}

function getGitLabDuoWorkflowProviderSessionState(
	providerSessionState: Map<string, ProviderSessionState> | undefined,
	baseUrl: string,
	modelId: string,
	sessionId: string | undefined,
): GitLabDuoWorkflowProviderSessionState | undefined {
	if (!providerSessionState) return undefined;
	const key = gitLabDuoWorkflowProviderSessionStateKey(baseUrl, modelId, sessionId);
	const existing = providerSessionState.get(key) as GitLabDuoWorkflowProviderSessionState | undefined;
	if (existing) return existing;
	const created = createGitLabDuoWorkflowProviderSessionState();
	providerSessionState.set(key, created);
	return created;
}

interface GitLabDuoWorkflowAccountState {
	namespaceSelection?: GitLabDuoWorkflowNamespaceSelection;
	// Cache namespace Duo settings enablement per account.
	settingsEnsured?: boolean;
}

// Per-(account, workspace) provider state keyed by credential, baseUrl, and cwd.
const gitLabDuoWorkflowAccountState = new Map<string, GitLabDuoWorkflowAccountState>();

function gitLabDuoWorkflowAccountKey(apiKey: string, baseUrl: string, cwd: string | undefined): string {
	return `${Bun.hash(apiKey).toString(36)}\u0000${baseUrl}\u0000${cwd ?? ""}`;
}

function getGitLabDuoWorkflowAccountState(
	apiKey: string,
	baseUrl: string,
	cwd: string | undefined,
): GitLabDuoWorkflowAccountState {
	const key = gitLabDuoWorkflowAccountKey(apiKey, baseUrl, cwd);
	const existing = gitLabDuoWorkflowAccountState.get(key);
	if (existing) return existing;
	const created: GitLabDuoWorkflowAccountState = {};
	gitLabDuoWorkflowAccountState.set(key, created);
	return created;
}

function getGitLabDuoWorkflowCachedNamespace(
	apiKey: string,
	baseUrl: string,
	cwd: string | undefined,
): GitLabDuoWorkflowNamespaceSelection | undefined {
	return getGitLabDuoWorkflowAccountState(apiKey, baseUrl, cwd).namespaceSelection;
}

function setGitLabDuoWorkflowCachedNamespace(
	apiKey: string,
	baseUrl: string,
	cwd: string | undefined,
	selection: GitLabDuoWorkflowNamespaceSelection,
): void {
	getGitLabDuoWorkflowAccountState(apiKey, baseUrl, cwd).namespaceSelection = selection;
}

function clearGitLabDuoWorkflowCachedNamespace(apiKey: string, baseUrl: string, cwd: string | undefined): void {
	getGitLabDuoWorkflowAccountState(apiKey, baseUrl, cwd).namespaceSelection = undefined;
}

function isGitLabDuoWorkflowSettingsEnsured(apiKey: string, baseUrl: string, cwd: string | undefined): boolean {
	return getGitLabDuoWorkflowAccountState(apiKey, baseUrl, cwd).settingsEnsured === true;
}

function markGitLabDuoWorkflowSettingsEnsured(apiKey: string, baseUrl: string, cwd: string | undefined): void {
	getGitLabDuoWorkflowAccountState(apiKey, baseUrl, cwd).settingsEnsured = true;
}

// True when namespace/project is pinned explicitly.
function hasGitLabDuoWorkflowExplicitNamespace(options: GitLabDuoWorkflowOptions): boolean {
	return Boolean(
		nonEmptyString(options.rootNamespaceId) ??
			nonEmptyString(options.namespaceId) ??
			nonEmptyString(Bun.env.GITLAB_DUO_NAMESPACE_ID) ??
			nonEmptyString(options.projectId) ??
			nonEmptyString(options.projectPath) ??
			nonEmptyString(Bun.env.GITLAB_DUO_PROJECT_ID) ??
			nonEmptyString(Bun.env.GITLAB_DUO_PROJECT_PATH),
	);
}

export function gitLabDuoWorkflowErrorText(error: unknown): string {
	return errorMessage(error);
}

// Scoped absolute deadline for one REST setup fetch folding in caller abort signal.
function gitLabDuoWorkflowRestTimeout(callerSignal?: AbortSignal): { signal: AbortSignal; cancel(): void } {
	return scopedTimeoutSignal(GITLAB_DUO_WORKFLOW_REST_TIMEOUT_MS, callerSignal);
}

async function readGitLabDuoWorkflowResponseErrorMessage(response: Response): Promise<string | undefined> {
	try {
		const payload: unknown = await response.json();
		const message =
			getGitLabDuoWorkflowErrorField(payload, "message") ?? getGitLabDuoWorkflowErrorField(payload, "error");
		return message ? gitLabDuoWorkflowErrorText(message) : undefined;
	} catch {
		return undefined;
	}
}

function getGitLabDuoWorkflowErrorField(payload: unknown, field: "message" | "error"): string | undefined {
	if (!isRecord(payload)) return undefined;
	const value = (payload as Record<string, unknown>)[field];
	if (typeof value !== "string" || value.trim().length === 0) return undefined;
	return value;
}

// Resolved namespace state: IDs, project scoping, START payload, and direct_access connection.
interface GitLabDuoWorkflowNamespaceSetup {
	rootNamespaceId: string;
	restNamespaceId: string;
	createNamespaceId: string;
	restProjectId: string | undefined;
	startPayload: GitLabDuoWorkflowStartRequest;
	webSocketProjectId: string | undefined;
	workflowConnection: GitLabDuoWorkflowDirectAccessConnection;
	workflowId: string;
	selectedModelIdentifier: string;
}

async function runGitLabDuoWorkflow(
	model: Model<"gitlab-duo-agent">,
	context: Context,
	options: GitLabDuoWorkflowOptions,
	state: GitLabDuoWorkflowStreamState,
): Promise<void> {
	const apiKey = options.apiKey;
	if (!apiKey) throw new AIError.MissingApiKeyError("gitlab-duo-agent");
	const baseUrl = normalizeGitLabBaseUrl(model.baseUrl || GITLAB_SAAS_URL);
	const fetchImpl = options.fetch ?? fetch;
	const providerSessionState = getGitLabDuoWorkflowProviderSessionState(
		options.providerSessionState,
		baseUrl,
		model.id,
		options.sessionId,
	);
	state.providerSessionState = providerSessionState;
	const pendingSession = providerSessionState?.active;
	if (pendingSession) {
		hydrateGitLabDuoWorkflowCheckpointState(state, pendingSession);
	}
	const pendingActions = pendingSession?.pendingActions;
	const resolvedBatch =
		pendingSession && pendingActions && pendingActions.length > 0
			? resolveGitLabDuoWorkflowActionBatch(context.messages, pendingActions)
			: undefined;
	// Steer mid-tool-loop: abandon workflow and re-seed fresh with updated transcript.
	const steeredMidBatch = Boolean(
		resolvedBatch && hasGitLabDuoWorkflowSteerAfterBatch(context.messages, resolvedBatch),
	);
	if (pendingSession && resolvedBatch && !steeredMidBatch) {
		const responses = resolvedBatch.map(({ requestID, result }) =>
			buildGitLabDuoWorkflowActionResponse(requestID, buildGitLabDuoWorkflowResponseFromToolResult(result)),
		);
		pendingSession.pendingActions = undefined;
		const resumeResult = await resumeGitLabDuoWorkflowSocket(
			{ fetchImpl, baseUrl, apiKey, workflowId: pendingSession.workflowId, state, providerSessionState },
			() =>
				runGitLabDuoWorkflowSocket(
					pendingSession.ws,
					pendingSession.startPayload,
					state,
					options,
					responses,
					undefined,
					model,
				),
		);
		// Fall through to seed a fresh workflow on stall.
		if (resumeResult !== "stalled") return;
	}
	if (providerSessionState?.active?.paused) {
		const session = providerSessionState.active;
		const replay = session.pauseBuffer ?? [];
		session.paused = false;
		session.pauseBuffer = [];
		const sessionWorkflowId = session.workflowId;
		const resumeResult = await resumeGitLabDuoWorkflowSocket(
			{ fetchImpl, baseUrl, apiKey, workflowId: sessionWorkflowId, state, providerSessionState },
			() => runGitLabDuoWorkflowSocket(session.ws, session.startPayload, state, options, undefined, replay, model),
		);

		if (resumeResult !== "stalled") return;
	}
	// Clean up abandoned pending session before seeding a fresh workflow.
	const abandonStaleSession = Boolean(
		pendingSession && (steeredMidBatch || (pendingActions && pendingActions.length > 0 && !resolvedBatch)),
	);
	if (abandonStaleSession && pendingSession) {
		traceGitLabDuoWorkflow(steeredMidBatch ? "workflow.steer_restart" : "workflow.stale_action_restart", {
			workflowId: pendingSession.workflowId,
		});
		pendingSession.pendingActions = undefined;
		try {
			pendingSession.ws.close();
		} catch {
			// Ignore close failures from already-closed sockets.
		}
		if (providerSessionState) providerSessionState.active = undefined;
		await stopGitLabDuoWorkflow(fetchImpl, baseUrl, apiKey, pendingSession.workflowId);
	}
	const workflowDefinition = resolveGitLabDuoWorkflowDefinition(options.workflowDefinition);
	const explicitNamespace = hasGitLabDuoWorkflowExplicitNamespace(options);
	const configuredProjectPath = nonEmptyString(options.projectPath) ?? nonEmptyString(Bun.env.GITLAB_DUO_PROJECT_PATH);
	const configuredProjectId = nonEmptyString(options.projectId) ?? nonEmptyString(Bun.env.GITLAB_DUO_PROJECT_ID);
	const goal = extractLatestUserPrompt(context.messages);

	const setupBudget = openBoundedFirstEventBudget(
		options.streamFirstEventTimeoutMs,
		GITLAB_DUO_WORKFLOW_SETUP_TIMEOUT_MS,
	);
	const setupFence = setupBudget.fence(options.signal);
	const setupSignal = setupFence.signal;
	const setupOptions: GitLabDuoWorkflowOptions = { ...options, signal: setupSignal };

	// Resolve namespace and scoped settings/project/direct_access/workflow.
	const setupForNamespace = async (
		namespaceSelection: GitLabDuoWorkflowNamespaceSelection,
	): Promise<GitLabDuoWorkflowNamespaceSetup> => {
		const rootNamespaceId = namespaceSelection.rootNamespaceId;
		const restNamespaceId = toGitLabRestNamespaceId(rootNamespaceId);
		const createNamespaceId = namespaceSelection.namespacePath ?? restNamespaceId;
		traceGitLabDuoWorkflow("run.start", {
			baseUrl,
			model: model.id,
			rootNamespaceId,
			restNamespaceId,
			namespaceSource: namespaceSelection.source,
			toolCount: context.tools?.length ?? 0,
		});
		// Best-effort ensure Duo agent-platform + MCP flags are enabled on the namespace.
		if (
			!isGitLabDuoWorkflowSettingsEnsured(apiKey, baseUrl, options.cwd) &&
			isGitLabDuoWorkflowInlineFlow(workflowDefinition)
		) {
			if (await ensureGitLabDuoWorkflowSettings(fetchImpl, baseUrl, apiKey, restNamespaceId, setupSignal)) {
				markGitLabDuoWorkflowSettingsEnsured(apiKey, baseUrl, options.cwd);
			}
		}
		// Auto-discover project if not configured (required by inline ambient flow).
		const discoveredProject =
			!configuredProjectPath && !configuredProjectId && isGitLabDuoWorkflowInlineFlow(workflowDefinition)
				? namespaceSelection.projectPath
					? { path: namespaceSelection.projectPath }
					: await discoverGitLabDuoWorkflowProject(fetchImpl, baseUrl, apiKey, restNamespaceId, setupSignal)
				: undefined;
		if (discoveredProject) {
			traceGitLabDuoWorkflow("project.discover", {
				projectId: discoveredProject.id,
				hasPath: Boolean(discoveredProject.path),
				fromRemote: Boolean(namespaceSelection.projectPath),
			});
		}
		// Resolve slash-separated project path to numeric ID for WebSocket routing.
		const configuredProjectIdIsPath = Boolean(configuredProjectId?.includes("/"));
		const numericConfiguredProjectId = configuredProjectIdIsPath ? undefined : configuredProjectId;
		const pathConfiguredProjectId = configuredProjectIdIsPath ? configuredProjectId : undefined;
		const projectPath = configuredProjectPath ?? pathConfiguredProjectId ?? discoveredProject?.path;
		const projectId = numericConfiguredProjectId ?? discoveredProject?.id;
		const restProjectId = configuredProjectPath ?? configuredProjectId ?? discoveredProject?.path;
		const webSocketProjectId =
			projectId ??
			(projectPath
				? await resolveGitLabDuoWorkflowNumericProjectId(fetchImpl, baseUrl, apiKey, projectPath, setupSignal)
				: undefined);
		const workflowConnection: GitLabDuoWorkflowDirectAccessConnection = options.workflowToken
			? { token: options.workflowToken, headers: {}, serviceEndpoint: false }
			: await requestGitLabDuoWorkflowDirectAccess(
					fetchImpl,
					baseUrl,
					apiKey,
					rootNamespaceId,
					restProjectId,
					workflowDefinition,
					setupSignal,
				);
		const workflowId =
			options.workflowId ??
			(await createGitLabDuoWorkflow(
				fetchImpl,
				baseUrl,
				apiKey,
				createNamespaceId,
				goal,
				restProjectId,
				workflowDefinition,
				model,
				options.onPayload,
				setupSignal,
			));
		const availableModels = await fetchGitLabDuoWorkflowAvailableModels(
			fetchImpl,
			baseUrl,
			apiKey,
			rootNamespaceId,
			setupSignal,
		);
		const selectedModelIdentifier = selectGitLabDuoWorkflowModelRef(model.id, availableModels);
		// When toolChoice is "none", omit tool definitions from start request.
		const advertisedTools = options.toolChoice === "none" ? [] : context.tools;
		const startPayload = buildGitLabDuoWorkflowStartRequest(
			workflowId,
			model,
			context,
			advertisedTools,
			availableModels,
			{
				projectId: webSocketProjectId,
				projectPath,
				namespaceId: restNamespaceId,
				rootNamespaceId: restNamespaceId,
				workflowDefinition,
				inlineFlow: isGitLabDuoWorkflowInlineFlow(workflowDefinition),
			},
		);
		return {
			rootNamespaceId,
			restNamespaceId,
			createNamespaceId,
			restProjectId,
			startPayload,
			webSocketProjectId,
			workflowConnection,
			workflowId,
			selectedModelIdentifier,
		};
	};

	const cachedNamespace = explicitNamespace
		? undefined
		: getGitLabDuoWorkflowCachedNamespace(apiKey, baseUrl, options.cwd);
	const resolveSetup = async (): Promise<GitLabDuoWorkflowNamespaceSetup> => {
		if (cachedNamespace) {
			try {
				return await setupForNamespace(cachedNamespace);
			} catch (cachedError) {
				// Invalidate stale cached namespace and re-discover.
				traceGitLabDuoWorkflow("namespace.cache_invalidate", {
					rootNamespaceId: cachedNamespace.rootNamespaceId,
					error: gitLabDuoWorkflowErrorText(cachedError),
				});
				clearGitLabDuoWorkflowCachedNamespace(apiKey, baseUrl, options.cwd);
				const rediscovered = await resolveGitLabDuoWorkflowNamespaceSelection(
					model,
					setupOptions,
					apiKey,
					baseUrl,
					fetchImpl,
				);
				const rediscoveredSetup = await setupForNamespace(rediscovered);
				setGitLabDuoWorkflowCachedNamespace(apiKey, baseUrl, options.cwd, rediscovered);
				return rediscoveredSetup;
			}
		}
		const namespaceSelection = await resolveGitLabDuoWorkflowNamespaceSelection(
			model,
			setupOptions,
			apiKey,
			baseUrl,
			fetchImpl,
		);
		const freshSetup = await setupForNamespace(namespaceSelection);

		if (!explicitNamespace) {
			setGitLabDuoWorkflowCachedNamespace(apiKey, baseUrl, options.cwd, namespaceSelection);
		}
		return freshSetup;
	};

	const setup = await resolveSetup().finally(() => setupFence.cancel());
	const restNamespaceId = setup.restNamespaceId;
	const createNamespaceId = setup.createNamespaceId;
	const restProjectId = setup.restProjectId;
	const webSocketProjectId = setup.webSocketProjectId;
	const workflowConnection = setup.workflowConnection;
	const selectedModelIdentifier = setup.selectedModelIdentifier;
	let workflowId = setup.workflowId;
	let startPayload = setup.startPayload;
	// Proactively fail if goal exceeds hard overflow threshold.
	const renderedGoalBytes = Buffer.byteLength(startPayload.goal, "utf8");
	if (renderedGoalBytes >= GITLAB_DUO_WORKFLOW_GOAL_HARD_OVERFLOW_BYTES) {
		traceGitLabDuoWorkflow("goal.over_budget", {
			renderedGoalBytes,
			zone: "hard",
			soft: GITLAB_DUO_WORKFLOW_GOAL_SOFT_OVERFLOW_BYTES,
			hard: GITLAB_DUO_WORKFLOW_GOAL_HARD_OVERFLOW_BYTES,
		});
		if (!state.stream.done) {
			state.output.stopReason = "error";
			state.output.errorMessage = buildGitLabDuoWorkflowGoalOverflowMessage(renderedGoalBytes);
			state.stream.push({ type: "error", reason: "error", error: state.output });
		}

		if (providerSessionState) providerSessionState.active = undefined;
		await stopGitLabDuoWorkflow(fetchImpl, baseUrl, apiKey, workflowId);
		return;
	}
	if (renderedGoalBytes >= GITLAB_DUO_WORKFLOW_GOAL_SOFT_OVERFLOW_BYTES) {
		state.goalOverflowMessage = buildGitLabDuoWorkflowGoalOverflowMessage(renderedGoalBytes);
		traceGitLabDuoWorkflow("goal.over_budget", {
			renderedGoalBytes,
			zone: "jitter",
			soft: GITLAB_DUO_WORKFLOW_GOAL_SOFT_OVERFLOW_BYTES,
			hard: GITLAB_DUO_WORKFLOW_GOAL_HARD_OVERFLOW_BYTES,
		});
	}
	let lastSocketResult: GitLabDuoWorkflowSocketResult = "closed";
	let timeoutReconnected = false;
	let stepLimitRestarts = 0;
	let genericErrorRetries = 0;
	let stallRestarts = 0;
	let settledNormally = false;
	try {
		for (let attempt = 0; attempt < 12; attempt++) {
			const ws = openGitLabDuoWorkflowSocket(workflowConnection.baseUrl ?? baseUrl, {
				token: workflowConnection.token,
				projectId: webSocketProjectId,

				namespaceId: restNamespaceId,
				rootNamespaceId: restNamespaceId,
				selectedModelIdentifier,
				workflowDefinition,
				serviceEndpoint: workflowConnection.serviceEndpoint,
				extraHeaders: workflowConnection.headers,
				originBaseUrl: baseUrl,
				webSocketFactory: options.webSocketFactory,
			});
			if (providerSessionState) {
				const stopWorkflowId = workflowId;
				providerSessionState.active = {
					workflowId,
					startPayload,
					ws,
					stop: () => {
						void stopGitLabDuoWorkflow(fetchImpl, baseUrl, apiKey, stopWorkflowId);
					},
				};
			}
			lastSocketResult = await runGitLabDuoWorkflowSocket(
				ws,
				startPayload,
				state,
				options,
				undefined,
				undefined,
				model,
			);
			if (lastSocketResult === "approval") {
				startPayload = buildGitLabDuoWorkflowApprovalStartRequest(startPayload);
				state.lastApprovalStatus = undefined;
				continue;
			}
			// On idle timeout, stop dead workflow and restart fresh with replayed transcript.
			if (lastSocketResult === "timeout" && !timeoutReconnected) {
				timeoutReconnected = true;
				traceGitLabDuoWorkflow("websocket.idle_restart", { workflowId });
				await stopGitLabDuoWorkflow(fetchImpl, baseUrl, apiKey, workflowId);
				workflowId = await createGitLabDuoWorkflow(
					fetchImpl,
					baseUrl,
					apiKey,
					createNamespaceId,
					goal,
					restProjectId,
					workflowDefinition,
					model,
					options.onPayload,
					options.signal,
				);
				startPayload = { ...startPayload, workflowID: workflowId };
				continue;
			}
			// On step limit, restart fresh with conversation transcript to reset step budget.
			if (lastSocketResult === "step_limit" && stepLimitRestarts < GITLAB_DUO_WORKFLOW_MAX_STEP_LIMIT_RESTARTS) {
				stepLimitRestarts++;
				state.stepLimitRequested = false;
				traceGitLabDuoWorkflow("websocket.step_limit_restart", { workflowId, restart: stepLimitRestarts });
				await stopGitLabDuoWorkflow(fetchImpl, baseUrl, apiKey, workflowId);
				workflowId = await createGitLabDuoWorkflow(
					fetchImpl,
					baseUrl,
					apiKey,
					createNamespaceId,
					goal,
					restProjectId,
					workflowDefinition,
					model,
					options.onPayload,
					options.signal,
				);
				startPayload = { ...startPayload, workflowID: workflowId };
				continue;
			}
			// On stalled workflow, stop and restart fresh with rebuilt transcript.
			if (lastSocketResult === "stalled" && stallRestarts < GITLAB_DUO_WORKFLOW_MAX_STALL_RESTARTS) {
				stallRestarts++;
				state.stalledRequested = false;
				traceGitLabDuoWorkflow("websocket.stall_restart", { workflowId, restart: stallRestarts });
				await stopGitLabDuoWorkflow(fetchImpl, baseUrl, apiKey, workflowId);
				workflowId = await createGitLabDuoWorkflow(
					fetchImpl,
					baseUrl,
					apiKey,
					createNamespaceId,
					goal,
					restProjectId,
					workflowDefinition,
					model,
					options.onPayload,
					options.signal,
				);
				startPayload = { ...startPayload, workflowID: workflowId };
				continue;
			}
			// Retry on fresh workflow after transient upstream FAILED error.
			if (
				lastSocketResult === "retryable_error" &&
				genericErrorRetries < GITLAB_DUO_WORKFLOW_MAX_GENERIC_ERROR_RETRIES
			) {
				genericErrorRetries++;
				state.retryableErrorRequested = false;
				// Clear the stashed message: it only surfaces if the retry also fails.
				state.output.errorMessage = undefined;
				traceGitLabDuoWorkflow("websocket.generic_error_retry", { workflowId, retry: genericErrorRetries });
				await stopGitLabDuoWorkflow(fetchImpl, baseUrl, apiKey, workflowId);
				workflowId = await createGitLabDuoWorkflow(
					fetchImpl,
					baseUrl,
					apiKey,
					createNamespaceId,
					goal,
					restProjectId,
					workflowDefinition,
					model,
					options.onPayload,
					options.signal,
				);
				startPayload = { ...startPayload, workflowID: workflowId };
				continue;
			}

			if (lastSocketResult === "retryable_error" && !state.stream.done) {
				state.output.stopReason = "error";

				if (state.goalOverflowMessage) state.output.errorMessage = state.goalOverflowMessage;
				state.stream.push({ type: "error", reason: "error", error: state.output });
			}

			if (lastSocketResult === "stalled" && !state.stream.done) {
				state.output.stopReason = "error";
				state.output.errorMessage =
					state.goalOverflowMessage ?? state.output.errorMessage ?? GITLAB_DUO_WORKFLOW_STALL_ERROR_MESSAGE;
				state.stream.push({ type: "error", reason: "error", error: state.output });
			}
			break;
		}
		settledNormally = true;
		finalizeGitLabDuoWorkflowResumeResult(state, providerSessionState, lastSocketResult);
	} finally {
		// Stop remote workflow on abnormal termination or unresumable state.
		const aborted = options.signal?.aborted ?? false;
		if (
			aborted ||
			!settledNormally ||
			lastSocketResult === "closed" ||
			lastSocketResult === "timeout" ||
			lastSocketResult === "stalled"
		) {
			if (providerSessionState) {
				providerSessionState.active = undefined;
			}
			await stopGitLabDuoWorkflow(fetchImpl, baseUrl, apiKey, workflowId);
		}
	}
}

async function fetchGitLabDuoWorkflowAvailableModels(
	fetchImpl: FetchImpl,
	baseUrl: string,
	apiKey: string,
	rootNamespaceId: string,
	signal?: AbortSignal,
): Promise<GitLabAvailableModelsPayload | undefined> {
	const restTimeout = gitLabDuoWorkflowRestTimeout(signal);
	try {
		const response = await fetchImpl(gitLabApiUrl(baseUrl, "/api/graphql"), {
			method: "POST",
			headers: {
				Authorization: `Bearer ${apiKey}`,
				"content-type": "application/json",
			},
			body: JSON.stringify({
				query: GITLAB_DUO_WORKFLOW_AVAILABLE_MODELS_QUERY,
				variables: { rootNamespaceId: toGitLabGraphQLNamespaceId(rootNamespaceId) },
			}),
			signal: restTimeout.signal,
		});
		if (!response.ok) return undefined;
		const payload: unknown = await response.json();
		const models = getRecord(getRecord(payload, "data"), "aiChatAvailableModels");
		return parseGitLabAvailableModelsPayload(models);
	} catch (error) {
		if (signal?.aborted) throw error;
		return undefined;
	} finally {
		restTimeout.cancel();
	}
}

function parseGitLabAvailableModelsPayload(value: unknown): GitLabAvailableModelsPayload | undefined {
	if (!value || typeof value !== "object") return undefined;
	return {
		pinnedModel: parseGitLabAvailableModel(getRecord(value, "pinnedModel")),
		selectedModel: parseGitLabAvailableModel(getRecord(value, "selectedModel")),
		defaultModel: parseGitLabAvailableModel(getRecord(value, "defaultModel")),
		selectableModels: parseGitLabAvailableModelArray((value as Record<string, unknown>).selectableModels),
	};
}

function parseGitLabAvailableModel(value: unknown): GitLabAvailableModel | null {
	if (!value || typeof value !== "object") return null;
	return { name: getRecordString(value, "name") ?? null, ref: getRecordString(value, "ref") ?? null };
}

function parseGitLabAvailableModelArray(value: unknown): GitLabAvailableModel[] | undefined {
	if (!Array.isArray(value)) return undefined;
	return value.map(parseGitLabAvailableModel).filter((model): model is GitLabAvailableModel => Boolean(model));
}

async function resolveGitLabDuoWorkflowNumericProjectId(
	fetchImpl: FetchImpl,
	baseUrl: string,
	apiKey: string,
	projectPath: string,
	signal?: AbortSignal,
): Promise<string | undefined> {
	const restTimeout = gitLabDuoWorkflowRestTimeout(signal);
	try {
		const response = await fetchImpl(gitLabApiUrl(baseUrl, `/api/v4/projects/${encodeURIComponent(projectPath)}`), {
			method: "GET",
			headers: {
				Authorization: `Bearer ${apiKey}`,
				"content-type": "application/json",
			},
			signal: restTimeout.signal,
		});
		if (!response.ok) return undefined;
		const payload: unknown = await response.json();
		return getRecordString(payload, "id");
	} catch (error) {
		if (signal?.aborted) throw error;
		return undefined;
	} finally {
		restTimeout.cancel();
	}
}

interface GitLabDuoWorkflowDiscoveredProject {
	id?: string;
	path: string;
}

// Auto-discover GitLab namespace/project from git remote or user memberships.
async function discoverGitLabDuoWorkflowProject(
	fetchImpl: FetchImpl,
	baseUrl: string,
	apiKey: string,
	restNamespaceId: string,
	signal?: AbortSignal,
): Promise<GitLabDuoWorkflowDiscoveredProject | undefined> {
	const query = "per_page=1&min_access_level=30&order_by=last_activity_at&sort=desc";
	const endpoints = [
		`/api/v4/groups/${encodeURIComponent(restNamespaceId)}/projects?include_subgroups=true&${query}`,
		`/api/v4/projects?membership=true&${query}`,
	];
	for (const endpoint of endpoints) {
		const restTimeout = gitLabDuoWorkflowRestTimeout(signal);
		try {
			const response = await fetchImpl(gitLabApiUrl(baseUrl, endpoint), {
				method: "GET",
				headers: {
					Authorization: `Bearer ${apiKey}`,
					"content-type": "application/json",
				},
				signal: restTimeout.signal,
			});
			if (!response.ok) continue;
			const payload: unknown = await response.json();
			const first = Array.isArray(payload) ? payload[0] : undefined;
			const id = getRecordString(first, "id");
			const path = getRecordString(first, "path_with_namespace");
			if (id && path) return { id, path };
		} catch (error) {
			if (signal?.aborted) throw error;
		} finally {
			restTimeout.cancel();
		}
	}
	return undefined;
}

async function requestGitLabDuoWorkflowDirectAccess(
	fetchImpl: FetchImpl,
	baseUrl: string,
	apiKey: string,
	rootNamespaceId: string,
	projectId?: string,
	workflowDefinition: GitLabDuoWorkflowDefinition = GITLAB_DUO_WORKFLOW_DEFINITION,
	signal?: AbortSignal,
): Promise<GitLabDuoWorkflowDirectAccessConnection> {
	const restTimeout = gitLabDuoWorkflowRestTimeout(signal);
	try {
		const response = await fetchImpl(gitLabApiUrl(baseUrl, "/api/v4/ai/duo_workflows/direct_access"), {
			method: "POST",
			headers: {
				Authorization: `Bearer ${apiKey}`,
				"content-type": "application/json",
			},
			body: JSON.stringify(buildGitLabDuoWorkflowDirectAccessBody(rootNamespaceId, projectId, workflowDefinition)),
			signal: restTimeout.signal,
		});
		traceGitLabDuoWorkflow("direct_access.response", {
			status: response.status,
			ok: response.ok,
			rootNamespaceId,
			hasProjectId: Boolean(projectId),
		});
		if (!response.ok) {
			const message = await readGitLabDuoWorkflowResponseErrorMessage(response);
			// Include HTTP status in error message for auth-retry/rotation classification.
			throw new AIError.GitLabDuoWorkflowApiError(
				message
					? `GitLab Duo Workflow direct_access failed with HTTP ${response.status}: ${message}`
					: `GitLab Duo Workflow direct_access failed with HTTP ${response.status}`,
				response.status,
			);
		}
		const payload = (await response.json()) as GitLabDirectAccessResponse;
		const token = extractGitLabWorkflowToken(payload);
		if (!token) {
			throw new AIError.ProviderResponseError("GitLab Duo Workflow direct_access did not return credentials", {
				provider: "gitlab-duo-agent",
				kind: "empty-body",
			});
		}
		traceGitLabDuoWorkflow("direct_access.token", { hasToken: true });
		const serviceEndpoint = !payload.gitlab_rails?.token && Boolean(payload.duo_workflow_service?.base_url);
		return {
			token,
			...(serviceEndpoint && payload.duo_workflow_service?.base_url
				? { baseUrl: normalizeGitLabDuoWorkflowServiceBaseUrl(payload.duo_workflow_service.base_url) }
				: {}),
			headers: serviceEndpoint ? (payload.duo_workflow_service?.headers ?? {}) : {},
			serviceEndpoint,
		};
	} finally {
		restTimeout.cancel();
	}
}

async function createGitLabDuoWorkflow(
	fetchImpl: FetchImpl,
	baseUrl: string,
	apiKey: string,
	namespaceId: string,
	goal: string | undefined,
	projectId: string | undefined,
	workflowDefinition: GitLabDuoWorkflowDefinition,
	model: Model<"gitlab-duo-agent">,
	onPayload: GitLabDuoWorkflowOptions["onPayload"],
	signal?: AbortSignal,
): Promise<string> {
	const body = buildGitLabDuoWorkflowCreateBody(namespaceId, {
		goal: isGitLabDuoWorkflowInlineFlow(workflowDefinition) ? "" : goal,
		projectId,
		workflowDefinition,
	});
	const replacementBody = await onPayload?.(body, model);
	const outboundBody = replacementBody === undefined ? body : replacementBody;
	// The fence spans the body read below, not just the fetch.
	const restTimeout = gitLabDuoWorkflowRestTimeout(signal);
	try {
		const response = await fetchImpl(gitLabApiUrl(baseUrl, "/api/v4/ai/duo_workflows/workflows"), {
			method: "POST",
			headers: {
				Authorization: `Bearer ${apiKey}`,
				"content-type": "application/json",
			},
			body: JSON.stringify(outboundBody),
			signal: restTimeout.signal,
		});
		traceGitLabDuoWorkflow("workflow.create.response", {
			status: response.status,
			ok: response.ok,
			namespaceId,
			hasProjectId: Boolean(projectId),
		});
		if (!response.ok) {
			throw new AIError.GitLabDuoWorkflowApiError(
				`GitLab Duo Workflow create failed with HTTP ${response.status}`,
				response.status,
			);
		}
		const payload = (await response.json()) as GitLabCreateWorkflowResponse;
		const workflowId = payload.id ?? payload.workflow_id ?? payload.workflowId;
		if (workflowId === undefined) {
			throw new AIError.ProviderResponseError(
				`GitLab Duo Workflow create response missing workflow id (HTTP ${response.status})`,
				{ provider: "gitlab-duo-agent", kind: "empty-body" },
			);
		}
		traceGitLabDuoWorkflow("workflow.create.id", { workflowId });
		return String(workflowId);
	} finally {
		restTimeout.cancel();
	}
}

async function stopGitLabDuoWorkflow(
	fetchImpl: FetchImpl,
	baseUrl: string,
	apiKey: string,
	workflowId: string,
): Promise<void> {
	const restTimeout = gitLabDuoWorkflowRestTimeout();
	try {
		await fetchImpl(gitLabApiUrl(baseUrl, `/api/v4/ai/duo_workflows/workflows/${encodeURIComponent(workflowId)}`), {
			method: "PATCH",
			headers: {
				Authorization: `Bearer ${apiKey}`,
				"content-type": "application/json",
			},
			body: JSON.stringify(buildGitLabDuoWorkflowStopBody()),
			signal: restTimeout.signal,
		});
	} catch (error) {
		// Best-effort stop; swallow errors.
		traceGitLabDuoWorkflow("workflow.stop_error", {
			workflowId,
			error: gitLabDuoWorkflowErrorText(error),
		});
	} finally {
		restTimeout.cancel();
	}
}

// Group PUT payload enabling required Duo agent platform flags.
export function buildGitLabDuoWorkflowSettingsBody(): Record<string, unknown> {
	return {
		experiment_features_enabled: true,
		ai_settings_attributes: {
			duo_agent_platform_enabled: true,
			duo_workflow_mcp_enabled: true,
		},
	};
}

// Best-effort enable of namespace Duo settings needed by inline ambient flow.
async function ensureGitLabDuoWorkflowSettings(
	fetchImpl: FetchImpl,
	baseUrl: string,
	apiKey: string,
	restNamespaceId: string,
	signal?: AbortSignal,
): Promise<boolean> {
	const restTimeout = gitLabDuoWorkflowRestTimeout(signal);
	try {
		const response = await fetchImpl(gitLabApiUrl(baseUrl, `/api/v4/groups/${encodeURIComponent(restNamespaceId)}`), {
			method: "PUT",
			headers: {
				Authorization: `Bearer ${apiKey}`,
				"content-type": "application/json",
			},
			body: JSON.stringify(buildGitLabDuoWorkflowSettingsBody()),
			signal: restTimeout.signal,
		});
		traceGitLabDuoWorkflow("settings.ensure", { status: response.status, ok: response.ok });
		return response.status < 500;
	} catch (error) {
		traceGitLabDuoWorkflow("settings.ensure_error", { error: gitLabDuoWorkflowErrorText(error) });

		if (signal?.aborted) throw error;
		return false;
	} finally {
		restTimeout.cancel();
	}
}

function openGitLabDuoWorkflowSocket(
	baseUrl: string,
	options: {
		token: string;
		projectId?: string;
		namespaceId?: string;
		rootNamespaceId?: string;
		selectedModelIdentifier?: string;
		originBaseUrl?: string;
		workflowDefinition?: GitLabDuoWorkflowDefinition;
		serviceEndpoint?: boolean;
		extraHeaders?: Record<string, string>;
		webSocketFactory?: GitLabDuoWorkflowWebSocketFactory;
	},
): GitLabDuoWorkflowWebSocketLike {
	const url = buildGitLabDuoWorkflowWebSocketUrl(baseUrl, options);
	const headers = buildGitLabDuoWorkflowWebSocketHeaders({
		...options,
		baseUrl: normalizeGitLabBaseUrl(options.originBaseUrl ?? baseUrl),
	});
	const factory = options.webSocketFactory ?? defaultGitLabDuoWorkflowWebSocketFactory;
	traceGitLabDuoWorkflow("websocket.create", { url });
	return factory(url, { headers });
}
function defaultGitLabDuoWorkflowWebSocketFactory(
	url: string,
	options: GitLabDuoWorkflowWebSocketFactoryOptions,
): GitLabDuoWorkflowWebSocketLike {
	return new (
		WebSocket as unknown as new (
			url: string,
			options: Bun.WebSocketOptions,
		) => GitLabDuoWorkflowWebSocketLike
	)(url, { headers: options.headers });
}

export function runGitLabDuoWorkflowSocket(
	ws: GitLabDuoWorkflowWebSocketLike,
	startPayload: GitLabDuoWorkflowStartRequest,
	state: GitLabDuoWorkflowStreamState,
	options: GitLabDuoWorkflowOptions,
	resumeResponse?: GitLabDuoWorkflowActionResponse | readonly GitLabDuoWorkflowActionResponse[],
	replayMessages?: readonly unknown[],
	model?: Model<"gitlab-duo-agent">,
): Promise<GitLabDuoWorkflowSocketResult> {
	const { promise, resolve, reject } = Promise.withResolvers<GitLabDuoWorkflowSocketResult>();
	let settled = false;
	let idleTimer: NodeJS.Timeout | undefined;
	const clearIdleTimer = (): void => {
		if (idleTimer !== undefined) {
			clearTimeout(idleTimer);
			idleTimer = undefined;
		}
	};
	const settle = (result: GitLabDuoWorkflowSocketResult = "closed", error?: unknown): void => {
		if (settled) return;
		settled = true;
		clearIdleTimer();
		if (error) reject(error);
		else resolve(result);
	};
	const idleTimeoutMs =
		options.idleTimeoutMs !== undefined && options.idleTimeoutMs > 0
			? options.idleTimeoutMs
			: GITLAB_DUO_WORKFLOW_IDLE_TIMEOUT_MS;
	const resetIdleTimer = (): void => {
		clearIdleTimer();
		if (settled) return;
		idleTimer = setTimeout(() => {
			traceGitLabDuoWorkflow("websocket.idle_timeout", { timeoutMs: idleTimeoutMs });
			close();
			settle("timeout");
		}, idleTimeoutMs);
	};
	const close = (): void => {
		try {
			ws.close();
		} catch {
			// Ignore close failures from test doubles or already closed sockets.
		}
	};
	const abort = (): void => {
		close();
		settle("closed", new AIError.RequestAbortError("GitLab Duo Workflow request aborted"));
	};
	if (options.signal?.aborted) {
		abort();
		return promise;
	}
	options.signal?.addEventListener("abort", abort, { once: true });

	const active = state.providerSessionState?.active;
	const handleSocketResult = (
		result: GitLabDuoWorkflowMessageResult,
		data: unknown,
		remaining: readonly unknown[],
	): boolean => {
		if (result === "pause") {
			if (active) {
				active.paused = true;
				active.pauseBuffer = [data, ...remaining, ...(active.pauseBuffer ?? [])];
			}
			pauseGitLabDuoWorkflowStream(state);
			settle("pause");
			return false;
		}
		if (result === "action") {
			settle("action");
			return false;
		}
		if (result !== "continue") {
			close();
			settle(result);
			return false;
		}
		return true;
	};
	ws.onerror = event => {
		const detail = describeGitLabDuoWorkflowSocketEvent(event);
		traceGitLabDuoWorkflow("websocket.error", { event: detail });
		settle(
			"closed",
			new AIError.ProviderResponseError(`GitLab Duo Workflow WebSocket error: ${detail}`, {
				provider: "gitlab-duo-agent",
				kind: "runtime",
			}),
		);
	};
	ws.onclose = event => {
		traceGitLabDuoWorkflow("websocket.close", { code: event.code, reason: event.reason });
		settle(state.lastApprovalStatus ? "approval" : "closed");
	};
	ws.onmessage = event => {
		resetIdleTimer();
		if (active?.paused) {
			active.pauseBuffer ??= [];
			active.pauseBuffer.push(event.data);
			return;
		}
		void handleGitLabDuoWorkflowSocketMessage(event.data, state).then(
			result => {
				handleSocketResult(result, event.data, []);
			},
			error => settle("closed", error),
		);
	};
	const sendPayloads = (payloads: readonly unknown[]): void => {
		const onPayload = options.onPayload;
		if (!onPayload) {
			for (const payload of payloads) {
				ws.send(JSON.stringify(payload));
			}
			return;
		}
		void (async () => {
			for (const payload of payloads) {
				const replacementPayload = await onPayload(payload, model);
				if (settled) return;
				ws.send(JSON.stringify(replacementPayload === undefined ? payload : replacementPayload));
			}
		})().catch(error => {
			close();
			settle("closed", error);
		});
	};
	if (replayMessages && replayMessages.length > 0) {
		ws.onopen = null;
		void (async () => {
			if (active) active.paused = true;
			const pending: unknown[] = replayMessages.slice();
			while (!settled) {
				if (pending.length === 0) {
					if (active?.pauseBuffer && active.pauseBuffer.length > 0) {
						for (let pi = 0; pi < active.pauseBuffer.length; pi++) pending.push(active.pauseBuffer[pi]!);
						active.pauseBuffer = [];
						continue;
					}
					// Replay queue fully drained and no buffered frames remain.
					break;
				}
				const data = pending.shift();
				let result: GitLabDuoWorkflowMessageResult;
				try {
					result = await handleGitLabDuoWorkflowSocketMessage(data, state);
				} catch (error) {
					settle("closed", error);
					return;
				}
				if (!handleSocketResult(result, data, pending)) {
					if (active) active.paused = false;
					return;
				}
				if (active?.pauseBuffer && active.pauseBuffer.length > 0) {
					for (let pi = 0; pi < active.pauseBuffer.length; pi++) pending.push(active.pauseBuffer[pi]!);
					active.pauseBuffer = [];
				}
			}
			if (!settled && active) active.paused = false;
		})();
	} else if (resumeResponse && (!Array.isArray(resumeResponse) || resumeResponse.length > 0)) {
		ws.onopen = null;
		// Resume live socket by returning tool result for pending action.
		const responses = Array.isArray(resumeResponse) ? resumeResponse : [resumeResponse];
		sendPayloads(responses.map(response => structuredClone(response)));
	} else {
		ws.onopen = () => {
			traceGitLabDuoWorkflow("websocket.open", {
				workflowId: startPayload.workflowID,
				workflowDefinition: startPayload.workflowDefinition,
				flowConfigId: startPayload.flowConfigId,
				flowVersion: startPayload.flowVersion,
				flowConfigSchemaVersion: startPayload.flowConfigSchemaVersion,
				mcpTools: startPayload.mcpTools.length,
				preapprovedTools: startPayload.preapproved_tools.length,
			});
			sendPayloads([{ startRequest: structuredClone(startPayload) }]);
		};
	}
	resetIdleTimer();
	return promise.finally(() => {
		clearIdleTimer();
		options.signal?.removeEventListener("abort", abort);
	});
}

type GitLabDuoWorkflowMessageResult =
	| "continue"
	| "terminal"
	| "approval"
	| "action"
	| "pause"
	| "step_limit"
	| "retryable_error"
	| "stalled";

type GitLabDuoWorkflowCheckpointKind = "text" | "thinking";

interface GitLabDuoWorkflowCheckpointAgentEntry {
	kind: GitLabDuoWorkflowCheckpointKind;
	messageIndex: number;
	messageKey: string;
	content: string;
}

interface GitLabDuoWorkflowCheckpointBoundaryEntry {
	kind: "boundary";
	messageIndex: number;
}

type GitLabDuoWorkflowCheckpointEntry =
	| GitLabDuoWorkflowCheckpointAgentEntry
	| GitLabDuoWorkflowCheckpointBoundaryEntry;

interface GitLabDuoWorkflowContextUsage {
	used: number;
	window: number;
}

interface GitLabDuoWorkflowCheckpointContent {
	entries: GitLabDuoWorkflowCheckpointEntry[];
	contentLength: number;
	latestMessageType?: string;
	contextUsage?: GitLabDuoWorkflowContextUsage;
}

async function handleGitLabDuoWorkflowSocketMessage(
	data: unknown,
	state: GitLabDuoWorkflowStreamState,
): Promise<GitLabDuoWorkflowMessageResult> {
	const event = parseGitLabDuoWorkflowSocketData(data);
	if (!event) return "continue";
	const status =
		getRecordString(event, "status") ??
		getNestedRecordString(event, "workflowStatus", "status") ??
		getNestedRecordString(event, "newCheckpoint", "status");
	const checkpoint = extractGitLabDuoWorkflowCheckpoint(event);
	traceGitLabDuoWorkflow("websocket.message", {
		keys: Object.keys(event),
		status,
		hasCheckpoint: Boolean(getRecord(event, "newCheckpoint") ?? getRecord(event, "checkpoint")),
		checkpointLength: checkpoint?.contentLength ?? 0,
	});
	if (checkpoint) {
		emitGitLabDuoWorkflowCheckpoint(state, checkpoint);
	}
	if (state.pauseRequested) {
		state.pauseRequested = false;
		return "pause";
	}
	if (isGitLabWorkflowApprovalStatus(status)) {
		state.lastApprovalStatus = status;
		traceGitLabDuoWorkflow("websocket.approval", { status });
		return "approval";
	}
	if (isGitLabWorkflowCompletionStatus(status)) {
		traceGitLabDuoWorkflow("websocket.terminal", { status, checkpointLength: checkpoint?.contentLength ?? 0 });
		finishGitLabDuoWorkflowStream(state, "stop");
		return "terminal";
	}
	if (status === "FAILED" || status === "STOPPED") {
		const message = gitLabDuoWorkflowErrorText(
			getRecordString(event, "error") ?? getRecordString(event, "message") ?? status,
		);
		// Settle "step_limit" when server step limit is reached.
		if (status === "FAILED" && isGitLabDuoWorkflowStepLimitMessage(message)) {
			traceGitLabDuoWorkflow("websocket.step_limit", { status });
			state.stepLimitRequested = true;
			return "step_limit";
		}
		// Settle "retry" on transient upstream FAILED errors.
		if (status === "FAILED" && isGitLabDuoWorkflowGenericProcessingError(message)) {
			traceGitLabDuoWorkflow("websocket.generic_error", { status });
			state.retryableErrorRequested = true;

			state.output.errorMessage = message;
			return "retryable_error";
		}
		traceGitLabDuoWorkflow("websocket.failed", { status });
		state.output.stopReason = "error";

		state.output.errorMessage = state.goalOverflowMessage ?? message;
		state.stream.push({ type: "error", reason: "error", error: state.output });
		return "terminal";
	}
	const action = extractGitLabDuoWorkflowAction(event);
	if (!action) return "continue";
	traceGitLabDuoWorkflow("websocket.action", {
		actionName: action.name,
		requestID: action.requestID,
		toolName:
			getRecordString(action.args as Record<string, unknown>, "name") ??
			getRecordString(action.args as Record<string, unknown>, "toolName") ??
			getRecordString(action.args as Record<string, unknown>, "tool_name"),
		argKeys: Object.keys(action.args as Record<string, unknown>).slice(0, 20),
	});
	// Settle "stalled" if checkpoint log did not advance across tool-call boundaries.
	if (detectGitLabDuoWorkflowStall(state)) {
		traceGitLabDuoWorkflow("websocket.stalled", {
			checkpointLength: state.lastCheckpointContentLength,
			actionName: action.name,
		});
		state.stalledRequested = true;
		return "stalled";
	}
	// Finalize tool_call assistant message and settle "action".
	emitGitLabDuoWorkflowActionToolCall(state, action);
	return "action";
}
function isGitLabWorkflowApprovalStatus(status: string | undefined): boolean {
	return status === "PLAN_APPROVAL_REQUIRED" || status === "TOOL_CALL_APPROVAL_REQUIRED";
}

function isGitLabWorkflowCompletionStatus(status: string | undefined): boolean {
	return status === "INPUT_REQUIRED" || status === "FINISHED";
}
// Matches DWS GraphRecursionError step limit message.
function isGitLabDuoWorkflowStepLimitMessage(message: string): boolean {
	return message.toLowerCase().includes("reached its maximum step limit");
}
// Matches DWS de-identified catch-all FAILED error message.
function isGitLabDuoWorkflowGenericProcessingError(message: string): boolean {
	return message.toLowerCase().includes("error processing your request in the duo agent platform");
}
export function buildGitLabDuoWorkflowApprovalStartRequest(
	startPayload: GitLabDuoWorkflowStartRequest,
): GitLabDuoWorkflowStartRequest {
	return {
		...startPayload,
		goal: "",
		additional_context: [],
		approval: { approval: {} },
	};
}

function buildGitLabDuoWorkflowActionResponse(
	requestID: string,
	response: GitLabPlainTextResponse,
): GitLabDuoWorkflowActionResponse {
	return { actionResponse: { requestID, plainTextResponse: response } };
}

function gitLabToolResultToText(toolResult: ToolResultMessage): string {
	return toolResult.content.map(item => (item.type === "text" ? item.text : `[${item.mimeType} image]`)).join("\n");
}

function buildGitLabMcpToolDefinition(tool: Tool): GitLabMcpToolDefinition {
	const schema = toolWireSchema(tool);
	// Register tool under bare name matching model schema and tool docs.
	return {
		name: tool.name,
		originalToolName: tool.name,
		serverName: "veyyon",
		description: tool.description || "",
		inputSchema: JSON.stringify(
			schema && typeof schema === "object" ? schema : { type: "object", properties: {}, required: [] },
		),
		isApproved: true,
	};
}

function createAssistantMessage(model: Model<Api>): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: emptyUsage(),
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function hydrateGitLabDuoWorkflowCheckpointState(
	state: GitLabDuoWorkflowStreamState,
	session: GitLabDuoWorkflowActiveSession,
): void {
	state.checkpointAgentContentByKey = session.checkpointAgentContentByKey;
	state.checkpointAgentContentSignatures = session.checkpointAgentContentSignatures;
}

function syncGitLabDuoWorkflowCheckpointState(state: GitLabDuoWorkflowStreamState): void {
	const active = state.providerSessionState?.active;
	if (!active) return;
	active.checkpointAgentContentByKey = state.checkpointAgentContentByKey;
	active.checkpointAgentContentSignatures = state.checkpointAgentContentSignatures;
}

function emitGitLabDuoWorkflowCheckpoint(
	state: GitLabDuoWorkflowStreamState,
	checkpoint: GitLabDuoWorkflowCheckpointContent,
): void {
	if (checkpoint.contextUsage) {
		applyGitLabDuoWorkflowContextUsage(state, checkpoint.contextUsage);
	}
	// Track latest checkpoint byte length to detect non-advancing stall.
	state.lastCheckpointContentLength = checkpoint.contentLength;
	// Pause only on boundaries following a delta emitted in this checkpoint.
	let deltaThisCheckpoint = false;
	// Turn position index within full-snapshot replay to dedupe across turns.
	let turnIndex = 0;
	for (const entry of checkpoint.entries) {
		if (entry.kind === "boundary") {
			if (deltaThisCheckpoint && state.providerSessionState?.active) {
				state.pauseRequested = true;
				return;
			}
			endGitLabDuoWorkflowText(state);
			endGitLabDuoWorkflowThinking(state);
			turnIndex += 1;
			continue;
		}

		const contentByKey = state.checkpointAgentContentByKey ?? {};
		const contentSignatures = state.checkpointAgentContentSignatures ?? {};
		const previousContent = contentByKey[entry.messageKey];
		const contentSignature = `${turnIndex}\u0000${entry.kind}\u0000${entry.content}`;
		const contentOnlySignature = `${turnIndex}\u0000content\u0000${entry.content}`;
		const duplicateContent =
			previousContent === undefined &&
			(contentSignatures[contentSignature] === true || contentSignatures[contentOnlySignature] === true);
		const rewroteExistingContent =
			previousContent !== undefined &&
			!entry.content.startsWith(previousContent) &&
			previousContent !== entry.content;
		const delta = duplicateContent
			? ""
			: rewroteExistingContent
				? ""
				: previousContent !== undefined
					? entry.content.slice(previousContent.length)
					: entry.content;

		contentByKey[entry.messageKey] = entry.content;
		contentSignatures[contentSignature] = true;
		contentSignatures[contentOnlySignature] = true;
		state.checkpointAgentContentByKey = contentByKey;
		state.checkpointAgentContentSignatures = contentSignatures;
		syncGitLabDuoWorkflowCheckpointState(state);

		if (delta.length === 0) continue;

		if (
			state.activeCheckpointMessageKey &&
			state.activeCheckpointMessageKey !== entry.messageKey &&
			previousContent === undefined
		) {
			endGitLabDuoWorkflowText(state);
			endGitLabDuoWorkflowThinking(state);
		}
		emitGitLabDuoWorkflowCheckpointSegment(state, entry.kind, delta);
		state.activeCheckpointMessageKey = entry.messageKey;
		deltaThisCheckpoint = true;
	}
}

// Map server per-agent context occupancy onto assistant usage.
function applyGitLabDuoWorkflowContextUsage(
	state: GitLabDuoWorkflowStreamState,
	contextUsage: GitLabDuoWorkflowContextUsage,
): void {
	const usage = state.output.usage;
	usage.input = contextUsage.used;
	usage.totalTokens = usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
}

function emitGitLabDuoWorkflowCheckpointSegment(
	state: GitLabDuoWorkflowStreamState,
	kind: GitLabDuoWorkflowCheckpointKind,
	delta: string,
): void {
	if (kind === "thinking") {
		emitGitLabDuoWorkflowThinking(state, delta);
		return;
	}
	emitGitLabDuoWorkflowText(state, delta);
}

function emitGitLabDuoWorkflowText(state: GitLabDuoWorkflowStreamState, text: string): void {
	if (!text) return;
	endGitLabDuoWorkflowThinking(state);
	let activeTextIndex = state.activeTextIndex;
	if (activeTextIndex === undefined) {
		const block = { type: "text" as const, text: "" };
		state.output.content.push(block);
		activeTextIndex = state.output.content.length - 1;
		state.activeTextIndex = activeTextIndex;
		state.stream.push({ type: "text_start", contentIndex: activeTextIndex, partial: state.output });
	}
	const block = state.output.content[activeTextIndex];
	if (block?.type !== "text") return;
	block.text += text;
	state.stream.push({ type: "text_delta", contentIndex: activeTextIndex, delta: text, partial: state.output });
}

function emitGitLabDuoWorkflowThinking(state: GitLabDuoWorkflowStreamState, thinking: string): void {
	if (!thinking) return;
	endGitLabDuoWorkflowText(state);
	let activeThinkingIndex = state.activeThinkingIndex;
	if (activeThinkingIndex === undefined) {
		const block = { type: "thinking" as const, thinking: "" };
		state.output.content.push(block);
		activeThinkingIndex = state.output.content.length - 1;
		state.activeThinkingIndex = activeThinkingIndex;
		state.stream.push({ type: "thinking_start", contentIndex: activeThinkingIndex, partial: state.output });
	}
	const block = state.output.content[activeThinkingIndex];
	if (block?.type !== "thinking") return;
	block.thinking += thinking;
	state.stream.push({
		type: "thinking_delta",
		contentIndex: activeThinkingIndex,
		delta: thinking,
		partial: state.output,
	});
}

function endGitLabDuoWorkflowText(state: GitLabDuoWorkflowStreamState): void {
	if (state.activeTextIndex === undefined) return;
	const block = state.output.content[state.activeTextIndex];
	if (block?.type === "text") {
		state.stream.push({
			type: "text_end",
			contentIndex: state.activeTextIndex,
			content: block.text,
			partial: state.output,
		});
	}
	state.activeTextIndex = undefined;
}

function endGitLabDuoWorkflowThinking(state: GitLabDuoWorkflowStreamState): void {
	if (state.activeThinkingIndex === undefined) return;
	const block = state.output.content[state.activeThinkingIndex];
	if (block?.type === "thinking") {
		state.stream.push({
			type: "thinking_end",
			contentIndex: state.activeThinkingIndex,
			content: block.thinking,
			partial: state.output,
		});
	}
	state.activeThinkingIndex = undefined;
}

function finishGitLabDuoWorkflowStream(
	state: GitLabDuoWorkflowStreamState,
	reason: Extract<AssistantMessage["stopReason"], "stop" | "length" | "toolUse">,
): void {
	endGitLabDuoWorkflowText(state);
	endGitLabDuoWorkflowThinking(state);
	state.output.stopReason = reason;
	state.stream.push({ type: "done", reason, message: state.output });
}

// Finalize resumed-socket turn, emitting terminal done when session drops.
function finalizeGitLabDuoWorkflowResumeResult(
	state: GitLabDuoWorkflowStreamState,
	providerSessionState: GitLabDuoWorkflowProviderSessionState | undefined,
	result: GitLabDuoWorkflowSocketResult,
): void {
	if (result === "action" || result === "pause") return;
	if (providerSessionState) {
		providerSessionState.active = undefined;
	}
	if (result !== "terminal" && !state.stream.done) {
		finishGitLabDuoWorkflowStream(state, "stop");
	}
}

// Run resume on preserved socket and finalize or clean up on failure.
async function resumeGitLabDuoWorkflowSocket(
	args: {
		fetchImpl: FetchImpl;
		baseUrl: string;
		apiKey: string;
		workflowId: string;
		state: GitLabDuoWorkflowStreamState;
		providerSessionState: GitLabDuoWorkflowProviderSessionState | undefined;
	},
	run: () => Promise<GitLabDuoWorkflowSocketResult>,
): Promise<GitLabDuoWorkflowSocketResult> {
	let socketResult: GitLabDuoWorkflowSocketResult;
	try {
		socketResult = await run();
	} catch (error) {
		if (args.providerSessionState) {
			args.providerSessionState.active = undefined;
		}
		await stopGitLabDuoWorkflow(args.fetchImpl, args.baseUrl, args.apiKey, args.workflowId);
		throw error;
	}

	if (socketResult === "stalled") {
		if (args.providerSessionState) args.providerSessionState.active = undefined;
		await stopGitLabDuoWorkflow(args.fetchImpl, args.baseUrl, args.apiKey, args.workflowId);
		return socketResult;
	}
	finalizeGitLabDuoWorkflowResumeResult(args.state, args.providerSessionState, socketResult);

	if (socketResult === "closed" || socketResult === "timeout") {
		await stopGitLabDuoWorkflow(args.fetchImpl, args.baseUrl, args.apiKey, args.workflowId);
	}
	return socketResult;
}

function pauseGitLabDuoWorkflowStream(state: GitLabDuoWorkflowStreamState): void {
	endGitLabDuoWorkflowText(state);
	endGitLabDuoWorkflowThinking(state);
	state.output.stopReason = "stop";
	state.output.stopDetails = { type: "pause_turn" };
	state.stream.push({ type: "done", reason: "stop", message: state.output });
}
interface GitLabDuoWorkflowReplayToolCall {
	id: string;
	name: string;
	arguments: Record<string, unknown>;
}

interface GitLabDuoWorkflowReplayMessage {
	role: "user" | "assistant" | "tool";
	content: string;
	toolCalls?: GitLabDuoWorkflowReplayToolCall[];
	toolCallId?: string;
	toolName?: string;
	isError?: boolean;
}

const GITLAB_DUO_WORKFLOW_CHATML_HISTORY_NOTE = AI_PROMPTS["provider/gitlab-duo-workflow-chatml-note"].text.trim();

// Builds system prompt for inline flow's system slot.
function buildGitLabDuoWorkflowSystemPrompt(context: Context): string {
	const base = normalizeSystemPrompts(context.systemPrompt).join("\n\n");
	if (!isGitLabDuoWorkflowChatMlGoal(context)) return base;
	return base ? `${base}\n\n${GITLAB_DUO_WORKFLOW_CHATML_HISTORY_NOTE}` : GITLAB_DUO_WORKFLOW_CHATML_HISTORY_NOTE;
}

function isGitLabDuoWorkflowChatMlGoal(context: Context): boolean {
	return buildGitLabDuoWorkflowConversationHistory(context.messages).length > 1;
}

// Render conversation transcript for the {{goal}} slot in ChatML format.
function buildGitLabDuoWorkflowGoal(context: Context): string {
	const conversation = buildGitLabDuoWorkflowConversationHistory(context.messages);
	if (conversation.length <= 1) {
		return extractLatestUserPrompt(context.messages);
	}
	return renderGitLabDuoWorkflowChatMl(conversation);
}

const GITLAB_DUO_WORKFLOW_CHATML_START = "<|im_start|>";
const GITLAB_DUO_WORKFLOW_CHATML_END = "<|im_end|>";

// Render transcript turns as ChatML with past-tense <ran NAME> tool call records.
function renderGitLabDuoWorkflowChatMl(conversation: readonly GitLabDuoWorkflowReplayMessage[]): string {
	return conversation.map(renderGitLabDuoWorkflowChatMlTurn).join("\n");
}

function renderGitLabDuoWorkflowChatMlTurn(message: GitLabDuoWorkflowReplayMessage): string {
	const body = gitLabDuoWorkflowChatMlBody(message);
	return `${GITLAB_DUO_WORKFLOW_CHATML_START}${message.role}\n${body}${GITLAB_DUO_WORKFLOW_CHATML_END}`;
}

function gitLabDuoWorkflowChatMlBody(message: GitLabDuoWorkflowReplayMessage): string {
	const parts: string[] = [];
	if (message.content.length > 0) parts.push(message.content);
	if (message.role === "assistant" && message.toolCalls) {
		for (const toolCall of message.toolCalls) {
			parts.push(renderGitLabDuoWorkflowChatMlToolCall(toolCall));
		}
	}
	if (message.role === "tool") {
		const header = gitLabDuoWorkflowChatMlToolResultHeader(message);
		return header ? `${header}\n${message.content}\n` : `${message.content}\n`;
	}
	return `${parts.join("\n")}\n`;
}

function gitLabDuoWorkflowChatMlToolResultHeader(message: GitLabDuoWorkflowReplayMessage): string | undefined {
	if (!message.toolName && !message.toolCallId) return undefined;
	const status = message.isError ? " status=error" : "";
	// Tool results render as past-tense <ran:result> immediately after the call.
	return `<ran:result${status}>`;
}

function renderGitLabDuoWorkflowChatMlToolCall(toolCall: GitLabDuoWorkflowReplayToolCall): string {
	// Render tool calls as <ran NAME>{args}</ran> past-tense records.
	const args = JSON.stringify(toolCall.arguments) ?? "null";
	return `<ran ${toolCall.name}>${args}</ran>`;
}

// Flattens session context messages into an ordered transcript.
function buildGitLabDuoWorkflowConversationHistory(messages: readonly Message[]): GitLabDuoWorkflowReplayMessage[] {
	const history: GitLabDuoWorkflowReplayMessage[] = [];
	for (let index = 0; index < messages.length; index++) {
		const replayMessage = buildGitLabDuoWorkflowReplayMessage(messages[index]);
		if (replayMessage) history.push(replayMessage);
	}
	return history;
}

function buildGitLabDuoWorkflowReplayMessage(message: Message | undefined): GitLabDuoWorkflowReplayMessage | undefined {
	if (!message) return undefined;
	if (message.role === "toolResult") {
		const content = gitLabDuoWorkflowMessageContentToText(message);
		return {
			role: "tool",
			content,
			toolCallId: message.toolCallId,
			toolName: message.toolName,
			isError: message.isError,
		};
	}
	if (message.role === "assistant") {
		const content = gitLabDuoWorkflowMessageContentToText(message);
		const toolCalls = gitLabDuoWorkflowAssistantToolCalls(message);
		if (content.length === 0 && toolCalls.length === 0) return undefined;
		return toolCalls.length > 0 ? { role: "assistant", content, toolCalls } : { role: "assistant", content };
	}
	const content = gitLabDuoWorkflowMessageContentToText(message);
	if (content.length === 0) return undefined;
	return { role: "user", content };
}

function gitLabDuoWorkflowAssistantToolCalls(message: AssistantMessage): GitLabDuoWorkflowReplayToolCall[] {
	const toolCalls: GitLabDuoWorkflowReplayToolCall[] = [];
	for (const item of message.content) {
		if (item.type === "toolCall") {
			toolCalls.push({
				id: item.id,
				name: item.name,
				arguments: stripGitLabDuoWorkflowReplayIntent(item.arguments),
			});
		}
	}
	return toolCalls;
}

// Strips UI-only `i` intent key from replayed tool call arguments to reduce payload size.
function stripGitLabDuoWorkflowReplayIntent(args: Record<string, unknown>): Record<string, unknown> {
	if (!("i" in args)) return args;
	const { i: _intent, ...rest } = args;
	return rest;
}

function extractLatestUserPrompt(messages: readonly Message[]): string {
	const index = findLatestGitLabDuoWorkflowUserMessageIndex(messages);
	if (index < 0) return "";
	return gitLabDuoWorkflowUserContentToText(messages[index] as Exclude<Message, AssistantMessage>);
}

function findLatestGitLabDuoWorkflowUserMessageIndex(messages: readonly Message[]): number {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (message?.role === "user" || message?.role === "developer") return index;
	}
	return -1;
}

function gitLabDuoWorkflowMessageContentToText(message: Message): string {
	if (message.role === "assistant") {
		return message.content
			.map(item => {
				if (item.type === "text") return item.text;
				if (item.type === "thinking" || item.type === "redactedThinking") return "";
				return "";
			})
			.join("\n");
	}
	return gitLabDuoWorkflowUserContentToText(message);
}

function gitLabDuoWorkflowUserContentToText(message: Exclude<Message, AssistantMessage>): string {
	if (typeof message.content === "string") return message.content;
	return message.content.map(item => (item.type === "text" ? item.text : `[${item.mimeType} image]`)).join("\n");
}

export function describeGitLabDuoWorkflowSocketEvent(event: unknown): string {
	const fields: string[] = [];
	if (event && typeof event === "object") {
		const type = getRecordString(event, "type");
		const message = getRecordString(event, "message");
		const code = getRecordString(event, "code");
		const reason = getRecordString(event, "reason");
		const error = socketEventErrorText((event as Record<string, unknown>).error);
		if (type) fields.push(`type=${type}`);
		if (message) fields.push(`message=${message}`);
		if (error) fields.push(`error=${error}`);
		if (code) fields.push(`code=${code}`);
		if (reason) fields.push(`reason=${reason}`);
	}
	const fallback = fields.length > 0 ? fields.join(", ") : String(event);
	return gitLabDuoWorkflowErrorText(fallback);
}

function socketEventErrorText(error: unknown): string | undefined {
	if (typeof error === "string" || typeof error === "number") return String(error);
	if (error instanceof Error) return error.message;
	if (error && typeof error === "object") {
		return getRecordString(error, "message") ?? getRecordString(error, "name");
	}
	return undefined;
}

export function traceGitLabDuoWorkflow(event: string, data: Record<string, unknown> = {}): void {
	if (Bun.env[GITLAB_DUO_WORKFLOW_TRACE_ENV] !== "1") return;
	const traceFile = Bun.env[GITLAB_DUO_WORKFLOW_TRACE_FILE_ENV]?.trim() || DEFAULT_GITLAB_DUO_WORKFLOW_TRACE_FILE;
	const line = `${JSON.stringify({
		time: new Date().toISOString(),
		event,
		...truncateGitLabTraceData(data),
	})}\n`;

	void fs
		.mkdir(path.dirname(traceFile), { recursive: true })
		.then(() => fs.appendFile(traceFile, line, "utf8"))
		.catch(() => {});
}

function truncateGitLabTraceData(data: Record<string, unknown>): Record<string, unknown> {
	const truncated: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(data)) {
		truncated[key] = truncateGitLabTraceValue(value);
	}
	return truncated;
}

function truncateGitLabTraceValue(value: unknown): unknown {
	if (typeof value === "string") return value.slice(0, 500);
	if (typeof value === "number" || typeof value === "boolean" || value === null) return value;
	if (Array.isArray(value)) return value.slice(0, 20).map(item => truncateGitLabTraceValue(item));
	if (value && typeof value === "object") return truncateGitLabTraceData(value as Record<string, unknown>);
	return value;
}

function normalizeGitLabBaseUrl(baseUrl: string): string {
	return trimTrailingSlashes(baseUrl) || GITLAB_SAAS_URL;
}

// Join GitLab API path onto base URL preserving relative base paths.
function gitLabApiUrl(baseUrl: string, path: string): URL {
	const normalized = normalizeGitLabBaseUrl(baseUrl);
	return new URL(`${normalized}${path.startsWith("/") ? path : `/${path}`}`);
}

function normalizeGitLabDuoWorkflowServiceBaseUrl(baseUrl: string): string {
	const trimmed = baseUrl.trim();
	const absolute = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
	return normalizeGitLabBaseUrl(absolute);
}

function toGitLabGraphQLNamespaceId(rootNamespaceId: string): string {
	if (/^\d+$/.test(rootNamespaceId)) return `gid://gitlab/Group/${rootNamespaceId}`;
	return rootNamespaceId;
}

function toGitLabRestNamespaceId(rootNamespaceId: string): string {
	const match = rootNamespaceId.match(/^gid:\/\/gitlab\/(?:Group|Namespace)\/(\d+)$/);
	return match?.[1] ?? rootNamespaceId;
}

export function extractGitLabWorkflowToken(payload: GitLabDirectAccessResponse): string | undefined {
	return (
		payload.gitlab_rails?.token ??
		payload.duo_workflow_service?.token ??
		payload.duo_workflow_access_token ??
		payload.workflow_token ??
		payload.token ??
		payload.access_token ??
		payload.jwt
	);
}

export async function resolveGitLabDuoWorkflowNamespaceSelection(
	model: Model<"gitlab-duo-agent">,
	options: GitLabDuoWorkflowOptions,
	apiKey: string,
	baseUrl: string,
	fetchImpl: FetchImpl,
): Promise<GitLabDuoWorkflowNamespaceSelection> {
	void model;
	const configured =
		nonEmptyString(options.rootNamespaceId) ??
		nonEmptyString(options.namespaceId) ??
		nonEmptyString(Bun.env.GITLAB_DUO_NAMESPACE_ID);

	try {
		const projectId =
			nonEmptyString(options.projectId) ??
			nonEmptyString(options.projectPath) ??
			nonEmptyString(Bun.env.GITLAB_DUO_PROJECT_ID) ??
			nonEmptyString(Bun.env.GITLAB_DUO_PROJECT_PATH);
		return await discoverGitLabDuoWorkflowRuntimeNamespace({
			apiKey,
			baseUrl,
			fetch: fetchImpl,
			namespaceId: configured,
			projectId,
			cwd: options.cwd,
			...(options.signal ? { signal: options.signal } : {}),
		});
	} catch (error) {
		throw new AIError.ProviderResponseError(
			`GitLab Duo Workflow runtime namespace resolution failed: ${gitLabDuoWorkflowErrorText(error)}`,
			{ provider: "gitlab-duo-agent", kind: "runtime" },
		);
	}
}

export async function resolveGitLabDuoWorkflowRootNamespaceId(
	model: Model<"gitlab-duo-agent">,
	options: GitLabDuoWorkflowOptions,
	apiKey: string,
	baseUrl: string,
	fetchImpl: FetchImpl,
): Promise<string> {
	const selection = await resolveGitLabDuoWorkflowNamespaceSelection(model, options, apiKey, baseUrl, fetchImpl);
	return selection.rootNamespaceId;
}

function nonEmptyString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function resolveGitLabDuoWorkflowDefinition(
	workflowDefinition: GitLabDuoWorkflowDefinition | undefined,
): GitLabDuoWorkflowDefinition {
	const configured =
		nonEmptyString(workflowDefinition) ??
		nonEmptyString(Bun.env.GITLAB_DUO_WORKFLOW_DEFINITION) ??
		GITLAB_DUO_WORKFLOW_DEFINITION;
	return configured;
}

function isGitLabDuoWorkflowInlineFlow(workflowDefinition: GitLabDuoWorkflowDefinition): boolean {
	void workflowDefinition;
	return true;
}

function parseGitLabDuoWorkflowSocketData(data: unknown): Record<string, unknown> | null {
	if (typeof data === "string") return parseJsonRecord(data);
	if (data instanceof ArrayBuffer) return parseJsonRecord(new TextDecoder().decode(data));
	if (data instanceof Uint8Array) return parseJsonRecord(new TextDecoder().decode(data));
	if (data && typeof data === "object") return data as Record<string, unknown>;
	return null;
}

function parseJsonRecord(text: string): Record<string, unknown> | null {
	const parsed = tryParseJson(text);
	return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
}

function numberField(record: Record<string, unknown>, key: string): number | undefined {
	const value = record[key];
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function extractGitLabDuoWorkflowCheckpoint(
	event: Record<string, unknown>,
): GitLabDuoWorkflowCheckpointContent | undefined {
	const action = getRecord(event, "action");
	const checkpoint =
		getRecord(action, "newCheckpoint") ?? getRecord(event, "newCheckpoint") ?? getRecord(event, "checkpoint");
	if (!checkpoint) return undefined;
	const directText =
		getRecordString(checkpoint, "message") ??
		getRecordString(checkpoint, "text") ??
		getRecordString(checkpoint, "content") ??
		getNestedRecordString(checkpoint, "checkpoint", "message") ??
		getNestedRecordString(checkpoint, "checkpoint", "text");
	const contextUsage = extractGitLabDuoWorkflowContextUsage(event, action, checkpoint);
	if (directText) {
		return {
			entries: [{ kind: "text", messageIndex: 0, messageKey: "direct:text", content: directText }],
			contentLength: directText.length,
			contextUsage,
		};
	}
	const checkpointJson = getRecordString(checkpoint, "checkpoint");
	const content = checkpointJson ? extractGitLabCheckpointEntries(checkpointJson) : undefined;
	if (content) {
		if (contextUsage) content.contextUsage = contextUsage;
		return content;
	}
	if (contextUsage) {
		return { entries: [], contentLength: 0, contextUsage };
	}
	return undefined;
}

// Reads per-agent context usage from checkpoint.
function extractGitLabDuoWorkflowContextUsage(
	...sources: (Record<string, unknown> | undefined)[]
): GitLabDuoWorkflowContextUsage | undefined {
	for (const source of sources) {
		const usageMap = getRecord(source, "agent_context_usage");
		if (!usageMap) continue;
		const selected = selectGitLabDuoWorkflowContextUsageAgent(usageMap);
		if (selected) return selected;
	}
	return undefined;
}

const GITLAB_DUO_WORKFLOW_CONTEXT_AGENT_PRIORITY = ["Chat Agent", "context_builder"];

function selectGitLabDuoWorkflowContextUsageAgent(
	usageMap: Record<string, unknown>,
): GitLabDuoWorkflowContextUsage | undefined {
	for (const preferred of GITLAB_DUO_WORKFLOW_CONTEXT_AGENT_PRIORITY) {
		const usage = readGitLabDuoWorkflowAgentUsage(usageMap[preferred]);
		if (usage) return usage;
	}
	for (const value of Object.values(usageMap)) {
		const usage = readGitLabDuoWorkflowAgentUsage(value);
		if (usage) return usage;
	}
	return undefined;
}

function readGitLabDuoWorkflowAgentUsage(value: unknown): GitLabDuoWorkflowContextUsage | undefined {
	if (!value || typeof value !== "object") return undefined;
	const record = value as Record<string, unknown>;
	const used = numberField(record, "total_tokens");
	const window = numberField(record, "max_tokens");
	if (used === undefined || window === undefined || window <= 0) return undefined;
	return { used, window };
}

function extractGitLabCheckpointEntries(checkpointJson: string): GitLabDuoWorkflowCheckpointContent | undefined {
	const checkpoint = parseJsonRecord(checkpointJson);
	const channelValues = getRecord(checkpoint, "channel_values");
	const chatLog = channelValues?.ui_chat_log;
	if (!Array.isArray(chatLog)) return undefined;
	const entries: GitLabDuoWorkflowCheckpointEntry[] = [];
	for (let index = 0; index < chatLog.length; index++) {
		const entry = chatLog[index];
		if (!entry || typeof entry !== "object") continue;
		const record = entry as Record<string, unknown>;
		const messageType = getRecordString(record, "message_type");
		if (messageType === "agent") {
			const content = getRecordString(record, "content");
			if (!content) continue;
			const messageId = getRecordString(record, "message_id");
			// Map reasoning sub_type to thinking block.
			const isReasoning = getRecordString(record, "message_sub_type") === "reasoning";
			const fallbackKey = isReasoning ? `reasoning:${index}` : `agent:${index}`;
			entries.push({
				kind: isReasoning ? "thinking" : "text",
				messageIndex: index,
				messageKey: messageId ? `agent:${messageId}` : fallbackKey,
				content,
			});
			continue;
		}
		if (messageType === "request" || messageType === "tool") {
			entries.push({ kind: "boundary", messageIndex: index });
		}
	}
	return {
		entries,
		contentLength: checkpointJson.length,
		latestMessageType: getGitLabDuoWorkflowLatestMessageType(chatLog),
	};
}

function getGitLabDuoWorkflowLatestMessageType(chatLog: unknown[]): string | undefined {
	for (let index = chatLog.length - 1; index >= 0; index--) {
		const entry = chatLog[index];
		if (!entry || typeof entry !== "object") continue;
		const messageType = getRecordString(entry, "message_type");
		if (messageType) return messageType;
	}
	return undefined;
}

function extractGitLabDuoWorkflowAction(event: Record<string, unknown>): GitLabDuoWorkflowActionDescriptor | undefined {
	const wrappedAction =
		getRecord(event, "action") ?? getRecord(event, "workflowAction") ?? getRecord(event, "toolCall");
	if (wrappedAction) {
		if (getRecord(wrappedAction, "newCheckpoint")) return undefined;
		const name =
			getRecordString(wrappedAction, "name") ??
			getRecordString(wrappedAction, "action") ??
			getRecordString(wrappedAction, "type") ??
			getRecordString(event, "actionName");
		if (!name) return undefined;
		const requestID =
			getRecordString(wrappedAction, "requestID") ??
			getRecordString(wrappedAction, "requestId") ??
			getRecordString(wrappedAction, "id") ??
			getRecordString(event, "requestID") ??
			getRecordString(event, "requestId");
		const resolvedRequestID = requireGitLabDuoWorkflowRequestID(requestID, name, wrappedAction);
		const args = getRecord(wrappedAction, "args") ?? getRecord(wrappedAction, "arguments") ?? wrappedAction;
		return { requestID: resolvedRequestID, name, args: withGitLabDuoWorkflowToolCallId(args, resolvedRequestID) };
	}
	for (const name of GITLAB_DUO_WORKFLOW_ACTION_NAMES) {
		const args = getRecord(event, name);
		if (args) {
			const requestID = getRecordString(event, "requestID") ?? getRecordString(event, "requestId");
			const resolvedRequestID = requireGitLabDuoWorkflowRequestID(requestID, name, event);
			return { requestID: resolvedRequestID, name, args: withGitLabDuoWorkflowToolCallId(args, resolvedRequestID) };
		}
	}
	return undefined;
}

// Validates action requestID is present (required for DWS action response matching).
function requireGitLabDuoWorkflowRequestID(
	requestID: string | undefined,
	actionName: string,
	source: Record<string, unknown>,
): string {
	if (requestID) return requestID;
	throw new AIError.ValidationError(
		`GitLab Duo Workflow action "${actionName}" missing requestID (keys: ${Object.keys(source).slice(0, 20).join(", ")})`,
	);
}

function withGitLabDuoWorkflowToolCallId(args: unknown, requestID: string): unknown {
	const record = isRecord(args) ? (args as Record<string, unknown>) : {};
	if (typeof record.toolCallId === "string" || typeof record.tool_call_id === "string") {
		return record;
	}
	return { ...record, toolCallId: requestID, tool_call_id: requestID };
}

function getRecord(value: unknown, key: string): Record<string, unknown> | undefined {
	if (!value || typeof value !== "object") return undefined;
	const nested = (value as Record<string, unknown>)[key];
	return nested && typeof nested === "object" ? (nested as Record<string, unknown>) : undefined;
}

function getRecordString(value: unknown, key: string): string | undefined {
	if (!value || typeof value !== "object") return undefined;
	const nested = (value as Record<string, unknown>)[key];
	return typeof nested === "string" || typeof nested === "number" ? String(nested) : undefined;
}

function getNestedRecordString(value: unknown, parentKey: string, key: string): string | undefined {
	return getRecordString(getRecord(value, parentKey), key);
}
