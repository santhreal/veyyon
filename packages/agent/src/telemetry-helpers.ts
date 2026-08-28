import type { Attributes, Span, Tracer } from "@opentelemetry/api";
import type { AssistantMessage, Message, Model, ServiceTier, ToolChoice } from "@veyyon/ai";
import type { AgentRunCollector, AgentRunCoverage, AgentRunSummary } from "./run-collector";

export const DEFAULT_TRACER_NAME = "@veyyon/agent-core";

export const CONTENT_CAPTURE_ENV = "OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT";

export const MAX_TELEMETRY_ARRAY_ITEMS = 64;
export const MAX_TELEMETRY_MESSAGE_COUNT = 16;
export const MAX_TELEMETRY_OBJECT_DEPTH = 3;
export const MAX_TELEMETRY_OBJECT_KEYS = 12;
export const MAX_TELEMETRY_TEXT_CHARS = 240;

export const enum GenAIAttr {
	ProviderName = "gen_ai.provider.name",
	OperationName = "gen_ai.operation.name",
	ConversationId = "gen_ai.conversation.id",
	OutputType = "gen_ai.output.type",
	AgentId = "gen_ai.agent.id",
	AgentName = "gen_ai.agent.name",
	AgentDescription = "gen_ai.agent.description",
	RequestModel = "gen_ai.request.model",
	RequestMaxTokens = "gen_ai.request.max_tokens",
	RequestTemperature = "gen_ai.request.temperature",
	RequestTopP = "gen_ai.request.top_p",
	RequestTopK = "gen_ai.request.top_k",
	RequestFrequencyPenalty = "gen_ai.request.frequency_penalty",
	RequestPresencePenalty = "gen_ai.request.presence_penalty",
	RequestStopSequences = "gen_ai.request.stop_sequences",
	RequestSeed = "gen_ai.request.seed",
	RequestChoiceCount = "gen_ai.request.choice.count",
	RequestStream = "gen_ai.request.stream",
	ResponseModel = "gen_ai.response.model",
	ResponseId = "gen_ai.response.id",
	ResponseFinishReasons = "gen_ai.response.finish_reasons",
	ResponseTimeToFirstChunk = "gen_ai.response.time_to_first_chunk",
	UsageInputTokens = "gen_ai.usage.input_tokens",
	UsageOutputTokens = "gen_ai.usage.output_tokens",
	UsageCacheReadInputTokens = "gen_ai.usage.cache_read.input_tokens",
	UsageCacheCreationInputTokens = "gen_ai.usage.cache_creation.input_tokens",
	UsageReasoningOutputTokens = "gen_ai.usage.reasoning.output_tokens",
	ToolCallId = "gen_ai.tool.call.id",
	ToolName = "gen_ai.tool.name",
	ToolDescription = "gen_ai.tool.description",
	ToolType = "gen_ai.tool.type",
	ToolCallArguments = "gen_ai.tool.call.arguments",
	ToolCallResult = "gen_ai.tool.call.result",
	ToolDefinitions = "gen_ai.tool.definitions",
	InputMessages = "gen_ai.input.messages",
	OutputMessages = "gen_ai.output.messages",
	SystemInstructions = "gen_ai.system_instructions",
	ErrorType = "error.type",
}

export const enum OpenAIAttr {
	RequestServiceTier = "openai.request.service_tier",
	ResponseServiceTier = "openai.response.service_tier",
}

export const enum PiGenAIAttr {
	AgentStepNumber = "pi.gen_ai.agent.step.number",
	AgentStepCount = "pi.gen_ai.agent.step.count",
	RequestReasoningEffort = "pi.gen_ai.request.reasoning.effort",
	RequestToolChoice = "pi.gen_ai.request.tool.choice",
	RequestAvailableTools = "pi.gen_ai.request.available_tools",
	RequestMessages = "pi.gen_ai.request.messages",
	ResponseText = "pi.gen_ai.response.text",
	ResponseToolCalls = "pi.gen_ai.response.tool_calls",
	ResponseUpstreamProvider = "pi.gen_ai.response.upstream_provider",
	UsageTotalTokens = "pi.gen_ai.usage.total_tokens",
	UsageServerSideTools = "pi.gen_ai.usage.server_tool_requests",
	CostEstimatedUsd = "pi.gen_ai.cost.estimated_usd",
	CostInputUsd = "pi.gen_ai.cost.input_usd",
	CostOutputUsd = "pi.gen_ai.cost.output_usd",
	CostUnavailableReason = "pi.gen_ai.cost.unavailable_reason",
	ToolStatus = "pi.gen_ai.tool.status",
	ToolCallIntent = "pi.gen_ai.tool.call.intent",
	HandoffFromAgentName = "pi.gen_ai.handoff.from_agent.name",
	HandoffFromAgentId = "pi.gen_ai.handoff.from_agent.id",
	HandoffToAgentName = "pi.gen_ai.handoff.to_agent.name",
	HandoffToAgentId = "pi.gen_ai.handoff.to_agent.id",
	OneshotKind = "pi.gen_ai.oneshot.kind",
	GatewayName = "pi.gen_ai.gateway.name",
	GatewayEndpoint = "pi.gen_ai.gateway.endpoint",
	GatewayCallId = "pi.gen_ai.gateway.call_id",
	GatewayRoutedTo = "pi.gen_ai.gateway.routed_to",
}

export const GenAIOperation = {
	Chat: "chat",
	ExecuteTool: "execute_tool",
	InvokeAgent: "invoke_agent",
	Handoff: "handoff",
	GenerateContent: "generate_content",
	TextCompletion: "text_completion",
	CreateAgent: "create_agent",
	Embeddings: "embeddings",
} as const;

export type GenAIOperationName = (typeof GenAIOperation)[keyof typeof GenAIOperation];

export type TelemetrySpanKind = "invoke_agent" | "chat" | "execute_tool" | "handoff";

export interface ChatUsageSnapshot {
	readonly inputTokens: number;
	readonly outputTokens: number;
	readonly totalTokens: number;
	readonly cachedInputTokens: number | undefined;
	readonly cacheWriteTokens: number | undefined;
	readonly reasoningOutputTokens: number | undefined;
}

export interface CostEstimatorContext {
	readonly provider: string;
	readonly model: string;
	readonly serviceTier: ServiceTier | undefined;
	readonly usage: ChatUsageSnapshot;
}

export type CostEstimate =
	| { readonly usd: number; readonly inputUsd?: number; readonly outputUsd?: number }
	| { readonly unavailable: string };

export interface CostDelta {
	readonly conversationId: string | undefined;
	readonly agent: AgentIdentity | undefined;
	readonly stepNumber: number | undefined;
	readonly provider: string;
	readonly model: string;
	readonly serviceTier: ServiceTier | undefined;
	readonly usage: ChatUsageSnapshot;
	readonly costUsd: number | undefined;
	readonly inputUsd: number | undefined;
	readonly outputUsd: number | undefined;
	readonly costUnavailableReason: string | undefined;
}

export interface ChatUsageEvent {
	readonly span: Span;
	readonly agent: AgentIdentity | undefined;
	readonly conversationId: string | undefined;
	readonly stepNumber: number | undefined;
	readonly model: string;
	readonly provider: string | undefined;
	readonly serviceTier: ServiceTier | undefined;
	readonly usage: ChatUsageSnapshot;
	readonly cost: CostEstimate | undefined;
	readonly attributes: Attributes | undefined;
	readonly headers: Readonly<Record<string, string>> | undefined;
}

export type TelemetryContentCapture = boolean | "none" | "summary" | "full";

export type ResolvedTelemetryContentCapture = "none" | "summary" | "full";

export interface TelemetryContentSerializer {
	readonly requestMessages?: (request: ChatRequestSnapshot) => string | undefined;
	readonly responseText?: (message: AssistantMessage) => string | undefined;
	readonly responseToolCalls?: (message: AssistantMessage) => string | undefined;
	readonly toolCallArguments?: (args: unknown) => string | undefined;
	readonly toolCallResult?: (result: unknown) => string | undefined;
}

export interface AgentIdentity {
	readonly id?: string;
	readonly name?: string;
	readonly description?: string;
}

export interface AgentTelemetryWarning {
	readonly code:
		| "resolve_attributes_failed"
		| "content_serializer_failed"
		| "text_sanitizer_failed"
		| "text_sanitizer_key_collision"
		| "on_cost_delta_failed"
		| "on_chat_usage_failed"
		| "cost_estimator_failed"
		| "on_run_end_failed"
		| "on_span_start_failed"
		| "on_span_end_failed"
		| "normalize_agent_name_failed"
		| "normalize_provider_failed"
		| "on_telemetry_warning_failed";
	readonly message: string;
	readonly error?: unknown;
}

export interface TelemetryAttributeContext {
	readonly kind: TelemetrySpanKind;
	readonly model: Model | undefined;
	readonly agent: AgentIdentity | undefined;
	readonly conversationId: string | undefined;
	readonly stepNumber?: number;
	readonly toolCallId?: string;
	readonly toolName?: string;
}

export interface TelemetryHookContext extends TelemetryAttributeContext {
	readonly span: Span;
}

export interface AgentTelemetryConfig {
	readonly tracer?: Tracer;
	readonly tracerName?: string;
	readonly captureMessageContent?: TelemetryContentCapture;
	readonly attributes?: Attributes;
	readonly resolveAttributes?: (ctx: TelemetryAttributeContext) => Attributes | undefined;
	readonly agent?: AgentIdentity;
	readonly conversationId?: string;
	readonly costEstimator?: (input: CostEstimatorContext) => CostEstimate | undefined;
	readonly onCostDelta?: (delta: CostDelta) => void;
	readonly onChatUsage?: (event: ChatUsageEvent) => void | Promise<void>;
	readonly normalizeProvider?: (provider: string | undefined) => string | undefined;
	readonly normalizeAgentName?: (name: string | undefined) => string | undefined;
	readonly contentSerializer?: TelemetryContentSerializer;
	readonly textSanitizer?: (text: string) => string;
	readonly onSpanStart?: (ctx: TelemetryHookContext) => void;
	readonly onSpanEnd?: (ctx: TelemetryHookContext) => void;
	readonly onRunEnd?: (summary: AgentRunSummary, coverage: AgentRunCoverage) => void;
	readonly onTelemetryWarning?: (warning: AgentTelemetryWarning) => void;
}

export interface AgentTelemetry {
	readonly config: AgentTelemetryConfig;
	readonly tracer: Tracer;
	readonly captureMessageContent: boolean;
	readonly contentCapture: ResolvedTelemetryContentCapture;
	readonly conversationId: string | undefined;
	readonly agent: AgentIdentity | undefined;
	readonly collector: AgentRunCollector;
}

export interface ChatRequestSnapshot {
	readonly maxTokens?: number;
	readonly temperature?: number;
	readonly topP?: number;
	readonly topK?: number;
	readonly frequencyPenalty?: number;
	readonly presencePenalty?: number;
	readonly stopSequences?: readonly string[];
	readonly seed?: number;
	readonly serviceTier?: ServiceTier;
	readonly reasoningEffort?: string;
	readonly toolChoice?: ToolChoice;
	readonly tools?: readonly { readonly name: string }[];
	readonly systemPrompt?: string | readonly string[];
	readonly messages?: readonly Message[];
}
