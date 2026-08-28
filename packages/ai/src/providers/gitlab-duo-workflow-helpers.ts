import * as path from "node:path";
import type { AssistantMessage, ProviderSessionState, StreamOptions, ToolChoice } from "../types";
import type { AssistantMessageEventStream } from "../utils/event-stream";

export const GITLAB_DUO_WORKFLOW_PROVIDER_ID = "gitlab-duo-agent";
export const GITLAB_DUO_WORKFLOW_API = "gitlab-duo-agent";
export const GITLAB_DUO_WORKFLOW_DEFINITION = "ambient";
export type GitLabDuoWorkflowDefinition = "ambient" | (string & {});

export const GITLAB_DUO_WORKFLOW_TRACE_ENV = "GITLAB_DUO_WORKFLOW_TRACE";
export const GITLAB_DUO_WORKFLOW_TRACE_FILE_ENV = "GITLAB_DUO_WORKFLOW_TRACE_FILE";
export const DEFAULT_GITLAB_DUO_WORKFLOW_TRACE_FILE = path.resolve(
	import.meta.dir,
	"../../../../.tmp/gitlab-duo-workflow-trace.log",
);
export const GITLAB_DUO_WORKFLOW_CLIENT_TYPE = "node-websocket";
export const GITLAB_DUO_WORKFLOW_IDLE_TIMEOUT_MS = 90_000;
export const GITLAB_DUO_WORKFLOW_REST_TIMEOUT_MS = 30_000;
export const GITLAB_DUO_WORKFLOW_SETUP_TIMEOUT_MS = 3 * GITLAB_DUO_WORKFLOW_REST_TIMEOUT_MS;
export const GITLAB_DUO_WORKFLOW_MAX_STEP_LIMIT_RESTARTS = 4;
export const GITLAB_DUO_WORKFLOW_MAX_GENERIC_ERROR_RETRIES = 1;
export const GITLAB_DUO_WORKFLOW_MAX_STALL_RESTARTS = 2;
export const GITLAB_DUO_WORKFLOW_STALL_ERROR_MESSAGE =
	"GitLab Duo Agent stopped making progress (the workflow's visible history did not advance after multiple restarts).";
export const GITLAB_DUO_WORKFLOW_GOAL_SOFT_OVERFLOW_BYTES = 1_048_576;
export const GITLAB_DUO_WORKFLOW_GOAL_HARD_OVERFLOW_BYTES = 2_000_000;

export function buildGitLabDuoWorkflowGoalOverflowMessage(goalBytes: number): string {
	return `prompt is too long: ${goalBytes} bytes exceeds the GitLab Duo Agent goal byte budget (soft ${GITLAB_DUO_WORKFLOW_GOAL_SOFT_OVERFLOW_BYTES}, hard ${GITLAB_DUO_WORKFLOW_GOAL_HARD_OVERFLOW_BYTES})`;
}
export const GITLAB_DUO_WORKFLOW_LANGUAGE_SERVER_VERSION = "8.104.0";
export const GITLAB_DUO_WORKFLOW_AVAILABLE_MODELS_QUERY = `query veyyon_gitlabDuoWorkflowAvailableModels($rootNamespaceId: GroupID!) {
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

export const GITLAB_DUO_WORKFLOW_INLINE_AGENT_NAME = "veyyon_agent";
export const GITLAB_DUO_WORKFLOW_INLINE_PROMPT_ID = "veyyon_inline_prompt";
export const GITLAB_DUO_WORKFLOW_INLINE_UI_LOG_EVENTS = [
	"on_agent_reasoning",
	"on_agent_final_answer",
	"on_tool_execution_success",
	"on_tool_execution_failed",
] as const;

export const GITLAB_DUO_WORKFLOW_ACTION_NAMES = ["runMCPTool", "run_mcp_tool"] as const;

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
	idleTimeoutMs?: number;
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

export interface GitLabDuoWorkflowDirectAccessConnection {
	token: string;
	baseUrl?: string;
	headers: Record<string, string>;
	serviceEndpoint: boolean;
}

export interface GitLabCreateWorkflowResponse {
	id?: string | number;
	workflow_id?: string | number;
	workflowId?: string | number;
	[key: string]: unknown;
}

export interface GitLabDuoWorkflowCreateBodyOptions {
	projectId?: string;
	goal?: string;
	workflowDefinition?: GitLabDuoWorkflowDefinition;
}

export interface GitLabDuoWorkflowStartMetadataOptions {
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

export interface GitLabDuoWorkflowActionDescriptor {
	requestID: string;
	name: string;
	args: unknown;
}

export interface GitLabDuoWorkflowActiveSession {
	workflowId: string;
	startPayload: GitLabDuoWorkflowStartRequest;
	ws: GitLabDuoWorkflowWebSocketLike;
	stop?: () => void;
	pendingActions?: GitLabDuoWorkflowActionDescriptor[];
	checkpointAgentContentByKey?: Record<string, string>;
	checkpointAgentContentSignatures?: Record<string, true>;
	paused?: boolean;
	pauseBuffer?: unknown[];
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
	lastCheckpointContentLength?: number;
	stalledRequested?: boolean;
	providerSessionState?: GitLabDuoWorkflowProviderSessionState;
	lastApprovalStatus?: string;
	goalOverflowMessage?: string;
}

export type GitLabDuoWorkflowSocketResult =
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
