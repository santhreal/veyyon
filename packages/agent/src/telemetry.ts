import {
	type Attributes,
	type AttributeValue,
	context,
	type Span,
	SpanKind,
	SpanStatusCode,
	type Tracer,
	trace,
} from "@opentelemetry/api";
import type { AssistantMessage, Message, Model, ServiceTier, StopReason, ToolChoice, Usage } from "@veyyon/ai";
// Import from types submodule to avoid loading the full ai package entrypoint.
import { shouldSendServiceTier } from "@veyyon/ai/types";
import { stringifyJsonSafe } from "@veyyon/utils/json";
import { AgentRunCollector, type AgentRunCoverage, type AgentRunSummary, type ToolStatus } from "./run-collector";
import type { AgentTool } from "./types";

export const DEFAULT_TRACER_NAME = "@veyyon/agent-core";

const CONTENT_CAPTURE_ENV = "OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT";

const MAX_TELEMETRY_ARRAY_ITEMS = 64;
const MAX_TELEMETRY_MESSAGE_COUNT = 16;
const MAX_TELEMETRY_OBJECT_DEPTH = 3;
const MAX_TELEMETRY_OBJECT_KEYS = 12;
const MAX_TELEMETRY_TEXT_CHARS = 240;

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

export function resolveTelemetry(
	config: AgentTelemetryConfig | undefined,
	sessionId: string | undefined,
): AgentTelemetry | undefined {
	if (!config) return undefined;
	const tracer = config.tracer ?? trace.getTracer(config.tracerName ?? DEFAULT_TRACER_NAME);
	const contentCapture = resolveContentCapture(config.captureMessageContent);
	return {
		config,
		tracer,
		captureMessageContent: contentCapture === "full",
		contentCapture,
		conversationId: config.conversationId ?? sessionId,
		agent: config.agent,
		collector: new AgentRunCollector(),
	};
}

let contentCaptureEnvCache: ResolvedTelemetryContentCapture | undefined;
function readContentCaptureEnv(): ResolvedTelemetryContentCapture {
	if (contentCaptureEnvCache !== undefined) return contentCaptureEnvCache;
	const raw = process.env[CONTENT_CAPTURE_ENV];
	if (!raw) {
		contentCaptureEnvCache = "none";
		return "none";
	}
	const normalized = raw.trim().toLowerCase();
	if (normalized === "summary") {
		contentCaptureEnvCache = "summary";
	} else {
		contentCaptureEnvCache =
			normalized === "true" || normalized === "1" || normalized === "yes" || normalized === "full" ? "full" : "none";
	}
	return contentCaptureEnvCache;
}

function resolveContentCapture(value: TelemetryContentCapture | undefined): ResolvedTelemetryContentCapture {
	const capture = value ?? readContentCaptureEnv();
	if (capture === true || capture === "full") return "full";
	if (capture === "summary") return "summary";
	return "none";
}

function startSpan(
	telemetry: AgentTelemetry | undefined,
	kind: TelemetrySpanKind,
	name: string,
	options: {
		readonly spanKind: SpanKind;
		readonly model?: Model;
		readonly parent?: Span;
		readonly attributes?: Attributes;
		readonly stepNumber?: number;
		readonly toolCallId?: string;
		readonly toolName?: string;
	},
): Span | undefined {
	if (!telemetry) return undefined;
	const attrCtx = buildTelemetryAttributeContext(telemetry, kind, options);
	const attrs: Attributes = {};
	const operation = kindToOperation(kind);
	if (operation) attrs[GenAIAttr.OperationName] = operation;
	if (options.model) {
		attrs[GenAIAttr.RequestModel] = options.model.id;
		const provider = normalizeProviderName(telemetry, options.model.provider);
		if (provider) attrs[GenAIAttr.ProviderName] = provider;
	}
	if (telemetry.conversationId) {
		attrs[GenAIAttr.ConversationId] = telemetry.conversationId;
	}
	if (attrCtx.agent) applyAgentAttributes(attrs, attrCtx.agent);
	if (telemetry.config.attributes) Object.assign(attrs, telemetry.config.attributes);
	const dynamicAttributes = resolveDynamicAttributes(telemetry, attrCtx);
	if (dynamicAttributes) Object.assign(attrs, dynamicAttributes);
	if (options.attributes) Object.assign(attrs, options.attributes);

	const textSanitizer = telemetry.config.textSanitizer ? createTelemetryTextSanitizer(telemetry) : undefined;
	const spanName = textSanitizer ? textSanitizer.sanitizeText(name) || kind : name;
	const initialAttributes = textSanitizer ? textSanitizer.sanitizeSpanAttributes(attrs) : attrs;
	const ctx = options.parent ? trace.setSpan(context.active(), options.parent) : context.active();
	const rawSpan = telemetry.tracer.startSpan(spanName, { kind: options.spanKind, attributes: initialAttributes }, ctx);
	const span = textSanitizer ? wrapSpanWithTextSanitizer(telemetry, rawSpan, textSanitizer) : rawSpan;
	safeOnSpanStart(telemetry, { ...attrCtx, span });
	return span;
}

interface TelemetryTextSanitizer {
	sanitizeText(text: string): string | undefined;
	sanitizeSpanAttributes(attributes: Attributes): Attributes;
	sanitizeException(
		exception: Parameters<Span["recordException"]>[0],
	): Parameters<Span["recordException"]>[0] | undefined;
}

const FIXED_TELEMETRY_ATTRIBUTE_KEYS: Record<string, true> = {
	"gen_ai.provider.name": true,
	"gen_ai.operation.name": true,
	"gen_ai.conversation.id": true,
	"gen_ai.output.type": true,
	"gen_ai.agent.id": true,
	"gen_ai.agent.name": true,
	"gen_ai.agent.description": true,
	"gen_ai.request.model": true,
	"gen_ai.request.max_tokens": true,
	"gen_ai.request.temperature": true,
	"gen_ai.request.top_p": true,
	"gen_ai.request.top_k": true,
	"gen_ai.request.frequency_penalty": true,
	"gen_ai.request.presence_penalty": true,
	"gen_ai.request.stop_sequences": true,
	"gen_ai.request.seed": true,
	"gen_ai.request.choice.count": true,
	"gen_ai.request.stream": true,
	"gen_ai.response.model": true,
	"gen_ai.response.id": true,
	"gen_ai.response.finish_reasons": true,
	"gen_ai.response.time_to_first_chunk": true,
	"gen_ai.usage.input_tokens": true,
	"gen_ai.usage.output_tokens": true,
	"gen_ai.usage.cache_read.input_tokens": true,
	"gen_ai.usage.cache_creation.input_tokens": true,
	"gen_ai.usage.reasoning.output_tokens": true,
	"gen_ai.tool.call.id": true,
	"gen_ai.tool.name": true,
	"gen_ai.tool.description": true,
	"gen_ai.tool.type": true,
	"gen_ai.tool.call.arguments": true,
	"gen_ai.tool.call.result": true,
	"gen_ai.tool.definitions": true,
	"gen_ai.input.messages": true,
	"gen_ai.output.messages": true,
	"gen_ai.system_instructions": true,
	"error.type": true,
	"openai.request.service_tier": true,
	"openai.response.service_tier": true,
	"pi.gen_ai.agent.step.number": true,
	"pi.gen_ai.agent.step.count": true,
	"pi.gen_ai.request.reasoning.effort": true,
	"pi.gen_ai.request.tool.choice": true,
	"pi.gen_ai.request.available_tools": true,
	"pi.gen_ai.request.messages": true,
	"pi.gen_ai.response.text": true,
	"pi.gen_ai.response.tool_calls": true,
	"pi.gen_ai.response.upstream_provider": true,
	"pi.gen_ai.usage.total_tokens": true,
	"pi.gen_ai.usage.server_tool_requests": true,
	"pi.gen_ai.cost.estimated_usd": true,
	"pi.gen_ai.cost.input_usd": true,
	"pi.gen_ai.cost.output_usd": true,
	"pi.gen_ai.cost.unavailable_reason": true,
	"pi.gen_ai.tool.status": true,
	"pi.gen_ai.tool.call.intent": true,
	"pi.gen_ai.handoff.from_agent.name": true,
	"pi.gen_ai.handoff.from_agent.id": true,
	"pi.gen_ai.handoff.to_agent.name": true,
	"pi.gen_ai.handoff.to_agent.id": true,
	"pi.gen_ai.oneshot.kind": true,
	"pi.gen_ai.gateway.name": true,
	"pi.gen_ai.gateway.endpoint": true,
	"pi.gen_ai.gateway.call_id": true,
	"pi.gen_ai.gateway.routed_to": true,
	"pi.gen_ai.agent.chats.count": true,
	"pi.gen_ai.agent.chats.total_latency_ms": true,
	"pi.gen_ai.agent.tools.count": true,
	"pi.gen_ai.agent.tools.ok.count": true,
	"pi.gen_ai.agent.tools.error.count": true,
	"pi.gen_ai.agent.tools.skipped.count": true,
	"pi.gen_ai.agent.tools.blocked.count": true,
	"pi.gen_ai.agent.tools.timeout.count": true,
	"pi.gen_ai.agent.tools.aborted.count": true,
	"pi.gen_ai.agent.tools.total_latency_ms": true,
	"pi.gen_ai.agent.tools.invoked": true,
	"pi.gen_ai.agent.tools.available": true,
	"pi.gen_ai.agent.tools.unused": true,
	"pi.gen_ai.agent.usage.input_tokens.total": true,
	"pi.gen_ai.agent.usage.output_tokens.total": true,
	"pi.gen_ai.agent.usage.cache_read.input_tokens.total": true,
	"pi.gen_ai.agent.usage.cache_creation.input_tokens.total": true,
	"pi.gen_ai.agent.usage.reasoning.output_tokens.total": true,
	"pi.gen_ai.agent.usage.total_tokens.total": true,
	"pi.gen_ai.agent.cost.estimated_usd.total": true,
	"pi.gen_ai.agent.errors.count": true,
};

function emitTextSanitizerFailure(telemetry: AgentTelemetry): void {
	emitTelemetryWarning(telemetry, {
		code: "text_sanitizer_failed",
		message: "textSanitizer threw; omitting dynamic telemetry text",
	});
}

function emitTextSanitizerKeyCollision(telemetry: AgentTelemetry): void {
	emitTelemetryWarning(telemetry, {
		code: "text_sanitizer_key_collision",
		message: "textSanitizer produced a colliding attribute key; omitting dynamic telemetry attribute",
	});
}

function createTelemetryTextSanitizer(telemetry: AgentTelemetry): TelemetryTextSanitizer {
	const sanitize = telemetry.config.textSanitizer;
	const dynamicKeyOwners = new Map<string, string>();

	const sanitizeText = (text: string): string | undefined => {
		if (!sanitize) return text;
		try {
			return sanitize(text);
		} catch {
			emitTextSanitizerFailure(telemetry);
			return undefined;
		}
	};

	const sanitizeAttributeValue = (value: AttributeValue): AttributeValue | undefined => {
		if (typeof value === "string") return sanitizeText(value);
		if (!Array.isArray(value) || value.length === 0 || typeof value[0] !== "string") return value;
		const sanitized: string[] = [];
		for (const item of value as string[]) {
			const text = sanitizeText(item);
			if (text === undefined) return undefined;
			sanitized.push(text);
		}
		return sanitized;
	};

	const sanitizeSpanAttributes = (attributes: Attributes): Attributes => {
		const candidates: Array<{
			readonly originalKey: string;
			readonly sanitizedKey: string;
			readonly value: AttributeValue;
			readonly fixed: boolean;
		}> = [];
		const keysInBatch = new Map<string, string>();
		const collidingKeys = new Set<string>();

		for (const [originalKey, value] of Object.entries(attributes)) {
			if (value == null) continue;
			const fixed = FIXED_TELEMETRY_ATTRIBUTE_KEYS[originalKey] === true;
			const sanitizedKey = fixed ? originalKey : sanitizeText(originalKey);
			if (!sanitizedKey) continue;
			if (!fixed && FIXED_TELEMETRY_ATTRIBUTE_KEYS[sanitizedKey] === true) {
				emitTextSanitizerKeyCollision(telemetry);
				continue;
			}
			const previousKey = keysInBatch.get(sanitizedKey);
			if (previousKey !== undefined && previousKey !== originalKey) {
				collidingKeys.add(sanitizedKey);
				continue;
			}
			const previousOwner = dynamicKeyOwners.get(sanitizedKey);
			if (!fixed && previousOwner !== undefined && previousOwner !== originalKey) {
				emitTextSanitizerKeyCollision(telemetry);
				continue;
			}
			const sanitizedValue = sanitizeAttributeValue(value);
			if (sanitizedValue === undefined) continue;
			keysInBatch.set(sanitizedKey, originalKey);
			candidates.push({ originalKey, sanitizedKey, value: sanitizedValue, fixed });
		}

		const sanitizedAttributes: Attributes = {};
		for (const candidate of candidates) {
			if (collidingKeys.has(candidate.sanitizedKey)) continue;
			sanitizedAttributes[candidate.sanitizedKey] = candidate.value;
			if (!candidate.fixed) dynamicKeyOwners.set(candidate.sanitizedKey, candidate.originalKey);
		}
		for (const _key of collidingKeys) emitTextSanitizerKeyCollision(telemetry);
		return sanitizedAttributes;
	};

	const sanitizeException = (
		exception: Parameters<Span["recordException"]>[0],
	): Parameters<Span["recordException"]>[0] | undefined => {
		if (typeof exception === "string") return sanitizeText(exception);
		const source = exception as {
			readonly code?: string | number;
			readonly message?: string;
			readonly name?: string;
			readonly stack?: string;
		};
		const sanitized: { code?: string | number; message?: string; name?: string; stack?: string } = {};
		if (typeof source.code === "number") {
			sanitized.code = source.code;
		} else if (typeof source.code === "string") {
			const code = sanitizeText(source.code);
			if (code !== undefined) sanitized.code = code;
		}
		if (typeof source.message === "string") {
			const message = sanitizeText(source.message);
			if (message !== undefined) sanitized.message = message;
		}
		if (typeof source.name === "string") {
			const name = sanitizeText(source.name);
			if (name !== undefined) sanitized.name = name;
		}
		if (typeof source.stack === "string") {
			const stack = sanitizeText(source.stack);
			if (stack !== undefined) sanitized.stack = stack;
		}
		return Object.keys(sanitized).length > 0 ? (sanitized as Parameters<Span["recordException"]>[0]) : undefined;
	};

	return { sanitizeText, sanitizeSpanAttributes, sanitizeException };
}

const sanitizedSpanWrappers = new WeakMap<AgentTelemetry, WeakMap<Span, Span>>();

function wrapSpanWithTextSanitizer(
	telemetry: AgentTelemetry,
	rawSpan: Span,
	textSanitizer = createTelemetryTextSanitizer(telemetry),
): Span {
	let wrappers = sanitizedSpanWrappers.get(telemetry);
	if (!wrappers) {
		wrappers = new WeakMap();
		sanitizedSpanWrappers.set(telemetry, wrappers);
	}
	const existing = wrappers.get(rawSpan);
	if (existing) return existing;

	const wrappedSpan: Span = {
		spanContext: () => rawSpan.spanContext(),
		setAttribute(key, value) {
			const attributes = textSanitizer.sanitizeSpanAttributes({ [key]: value });
			if (Object.keys(attributes).length > 0) rawSpan.setAttributes(attributes);
			return wrappedSpan;
		},
		setAttributes(attributes) {
			const sanitized = textSanitizer.sanitizeSpanAttributes(attributes);
			if (Object.keys(sanitized).length > 0) rawSpan.setAttributes(sanitized);
			return wrappedSpan;
		},
		addEvent(name, attributesOrStartTime, startTime) {
			const sanitizedName = textSanitizer.sanitizeText(name);
			if (sanitizedName === undefined) return wrappedSpan;
			if (
				attributesOrStartTime !== null &&
				typeof attributesOrStartTime === "object" &&
				!Array.isArray(attributesOrStartTime) &&
				!(attributesOrStartTime instanceof Date)
			) {
				rawSpan.addEvent(sanitizedName, textSanitizer.sanitizeSpanAttributes(attributesOrStartTime), startTime);
			} else {
				rawSpan.addEvent(sanitizedName, attributesOrStartTime, startTime);
			}
			return wrappedSpan;
		},
		addLink(link) {
			rawSpan.addLink({
				...link,
				attributes: link.attributes ? textSanitizer.sanitizeSpanAttributes(link.attributes) : undefined,
			});
			return wrappedSpan;
		},
		addLinks(links) {
			rawSpan.addLinks(
				links.map(link => ({
					...link,
					attributes: link.attributes ? textSanitizer.sanitizeSpanAttributes(link.attributes) : undefined,
				})),
			);
			return wrappedSpan;
		},
		setStatus(status) {
			if (status.message === undefined) {
				rawSpan.setStatus(status);
				return wrappedSpan;
			}
			const message = textSanitizer.sanitizeText(status.message);
			rawSpan.setStatus(message === undefined ? { code: status.code } : { ...status, message });
			return wrappedSpan;
		},
		updateName(name) {
			const sanitizedName = textSanitizer.sanitizeText(name);
			if (sanitizedName !== undefined) rawSpan.updateName(sanitizedName);
			return wrappedSpan;
		},
		end: endTime => rawSpan.end(endTime),
		isRecording: () => rawSpan.isRecording(),
		recordException(exception, time) {
			const sanitized = textSanitizer.sanitizeException(exception);
			if (sanitized !== undefined) rawSpan.recordException(sanitized, time);
		},
	};
	wrappers.set(rawSpan, wrappedSpan);
	wrappers.set(wrappedSpan, wrappedSpan);
	return wrappedSpan;
}

function buildTelemetryAttributeContext(
	telemetry: AgentTelemetry,
	kind: TelemetrySpanKind,
	options: {
		readonly model?: Model;
		readonly stepNumber?: number;
		readonly toolCallId?: string;
		readonly toolName?: string;
	},
): TelemetryAttributeContext {
	return {
		kind,
		model: options.model,
		agent: normalizedTelemetryAgent(telemetry),
		conversationId: telemetry.conversationId,
		stepNumber: options.stepNumber,
		toolCallId: options.toolCallId,
		toolName: options.toolName,
	};
}

function resolveDynamicAttributes(telemetry: AgentTelemetry, ctx: TelemetryAttributeContext): Attributes | undefined {
	const resolver = telemetry.config.resolveAttributes;
	if (!resolver) return undefined;
	try {
		return resolver(ctx);
	} catch (err) {
		emitTelemetryWarning(telemetry, {
			code: "resolve_attributes_failed",
			message: "resolveAttributes threw; ignoring dynamic telemetry attributes",
			error: err,
		});
		return undefined;
	}
}

function kindToOperation(kind: TelemetrySpanKind): GenAIOperationName | undefined {
	switch (kind) {
		case "invoke_agent":
			return GenAIOperation.InvokeAgent;
		case "chat":
			return GenAIOperation.Chat;
		case "execute_tool":
			return GenAIOperation.ExecuteTool;
		case "handoff":
			return GenAIOperation.Handoff;
	}
}

function applyAgentAttributes(attrs: Attributes, agent: AgentIdentity): void {
	if (agent.id) attrs[GenAIAttr.AgentId] = agent.id;
	if (agent.name) attrs[GenAIAttr.AgentName] = agent.name;
	if (agent.description) attrs[GenAIAttr.AgentDescription] = agent.description;
}

function normalizeProviderName(
	telemetry: AgentTelemetry | undefined,
	provider: string | undefined,
): string | undefined {
	const otelProvider = mapProviderNameToOtel(provider);
	const normalize = telemetry?.config.normalizeProvider;
	if (!normalize) return otelProvider;
	try {
		return normalize(provider) ?? otelProvider;
	} catch (err) {
		emitTelemetryWarning(telemetry, {
			code: "normalize_provider_failed",
			message: "normalizeProvider threw; using the OTEL provider label",
			error: err,
		});
		return otelProvider;
	}
}

function mapProviderNameToOtel(provider: string | undefined): string | undefined {
	switch (provider) {
		case undefined:
		case "":
			return provider;
		case "amazon-bedrock":
			return "aws.bedrock";
		case "google":
		case "google-antigravity":
		case "google-gemini-cli":
			return "gcp.gemini";
		case "google-vertex":
			return "gcp.vertex_ai";
		case "mistral":
			return "mistral_ai";
		case "openai-codex":
			return "openai";
		case "xai":
			return "x_ai";
		default:
			return provider;
	}
}

function normalizeAgentIdentity(telemetry: AgentTelemetry, agent: AgentIdentity): AgentIdentity {
	const normalize = telemetry.config.normalizeAgentName;
	if (!normalize || !agent.name) return agent;
	try {
		const name = normalize(agent.name);
		if (name === agent.name) return agent;
		return {
			...agent,
			name,
		};
	} catch (err) {
		emitTelemetryWarning(telemetry, {
			code: "normalize_agent_name_failed",
			message: "normalizeAgentName threw; using the original agent name",
			error: err,
		});
		return agent;
	}
}

function normalizedTelemetryAgent(telemetry: AgentTelemetry | undefined): AgentIdentity | undefined {
	return telemetry?.agent ? normalizeAgentIdentity(telemetry, telemetry.agent) : undefined;
}

export function recordTelemetryWarning(telemetry: AgentTelemetry | undefined, warning: AgentTelemetryWarning): void {
	emitTelemetryWarning(telemetry, warning);
}

function emitTelemetryWarning(telemetry: AgentTelemetry | undefined, warning: AgentTelemetryWarning): void {
	const hook = telemetry?.config.onTelemetryWarning;
	if (!hook) {
		if (warning.error === undefined) console.warn(`[pi-agent] ${warning.message}`);
		else console.warn(`[pi-agent] ${warning.message}`, warning.error);
		return;
	}
	try {
		hook(warning);
	} catch (err) {
		console.warn("[pi-agent] onTelemetryWarning threw; swallowing:", err);
	}
}

function safeOnSpanStart(telemetry: AgentTelemetry | undefined, ctx: TelemetryHookContext): void {
	const hook = telemetry?.config.onSpanStart;
	if (!hook) return;
	try {
		hook(ctx);
	} catch (err) {
		emitTelemetryWarning(telemetry, {
			code: "on_span_start_failed",
			message: "onSpanStart threw; swallowing telemetry hook failure",
			error: err,
		});
	}
}

function safeOnSpanEnd(telemetry: AgentTelemetry | undefined, ctx: TelemetryHookContext): void {
	const hook = telemetry?.config.onSpanEnd;
	if (!hook) return;
	try {
		hook(ctx);
	} catch (err) {
		emitTelemetryWarning(telemetry, {
			code: "on_span_end_failed",
			message: "onSpanEnd threw; swallowing telemetry hook failure",
			error: err,
		});
	}
}

/** Start the outer `invoke_agent` span that wraps a full `runLoop` invocation. */
export function startInvokeAgentSpan(telemetry: AgentTelemetry | undefined, model: Model): Span | undefined {
	const agentName = telemetry?.agent ? normalizeAgentIdentity(telemetry, telemetry.agent).name : undefined;
	const name = agentName ? `invoke_agent ${agentName}` : "invoke_agent";
	return startSpan(telemetry, "invoke_agent", name, { spanKind: SpanKind.INTERNAL, model });
}

export function applyInvokeAgentFinish(span: Span | undefined, stepCount: number): void {
	if (!span) return;
	span.setAttribute(PiGenAIAttr.AgentStepCount, stepCount);
}

/** Start a `chat` span representing one provider call. */
export function startChatSpan(
	telemetry: AgentTelemetry | undefined,
	model: Model,
	options: {
		readonly parent?: Span;
		readonly stepNumber: number;
		readonly request: ChatRequestSnapshot;
	},
): Span | undefined {
	const span = startSpan(telemetry, "chat", `chat ${model.id}`, {
		spanKind: SpanKind.CLIENT,
		model,
		parent: options.parent,
		stepNumber: options.stepNumber,
		attributes: buildChatRequestAttributes(options.stepNumber, options.request, model.provider),
	});
	if (span) {
		telemetry?.collector.beginChat(span, {
			stepNumber: options.stepNumber,
			model,
			provider: normalizeProviderName(telemetry, model.provider),
		});
		telemetry?.collector.noteAvailableTools(options.request.tools);
		if (telemetry && telemetry.contentCapture !== "none") {
			applyContentCaptureForRequest(telemetry, span, options.request);
		}
	}
	return span;
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

function buildChatRequestAttributes(stepNumber: number, request: ChatRequestSnapshot, provider: string): Attributes {
	const attrs: Attributes = {
		[PiGenAIAttr.AgentStepNumber]: stepNumber,
		[GenAIAttr.OutputType]: "text",
		[GenAIAttr.RequestStream]: true,
	};
	if (request.maxTokens != null) attrs[GenAIAttr.RequestMaxTokens] = request.maxTokens;
	if (request.temperature != null) attrs[GenAIAttr.RequestTemperature] = request.temperature;
	if (request.topP != null) attrs[GenAIAttr.RequestTopP] = request.topP;
	if (request.topK != null) attrs[GenAIAttr.RequestTopK] = request.topK;
	if (request.frequencyPenalty != null) attrs[GenAIAttr.RequestFrequencyPenalty] = request.frequencyPenalty;
	if (request.presencePenalty != null) attrs[GenAIAttr.RequestPresencePenalty] = request.presencePenalty;
	if (request.seed != null) attrs[GenAIAttr.RequestSeed] = request.seed;
	if (request.stopSequences && request.stopSequences.length > 0) {
		attrs[GenAIAttr.RequestStopSequences] = request.stopSequences.slice();
	}
	if (request.serviceTier && shouldSendServiceTier(request.serviceTier, provider)) {
		attrs[OpenAIAttr.RequestServiceTier] = request.serviceTier;
	}
	if (request.reasoningEffort) attrs[PiGenAIAttr.RequestReasoningEffort] = request.reasoningEffort;
	const toolChoice = serializeToolChoice(request.toolChoice);
	if (toolChoice) attrs[PiGenAIAttr.RequestToolChoice] = toolChoice;
	if (request.tools && request.tools.length > 0) {
		attrs[PiGenAIAttr.RequestAvailableTools] = request.tools.map(tool => tool.name);
	}
	return attrs;
}

function serializeToolChoice(toolChoice: ToolChoice | undefined): string | undefined {
	if (toolChoice == null) return undefined;
	if (typeof toolChoice === "string") return toolChoice;
	if (typeof toolChoice === "object") {
		if ("name" in toolChoice && typeof toolChoice.name === "string") return toolChoice.name;
		if ("type" in toolChoice && typeof toolChoice.type === "string") return toolChoice.type;
	}
	return undefined;
}

function applyContentCaptureForRequest(telemetry: AgentTelemetry, span: Span, request: ChatRequestSnapshot): void {
	const requestMessages = serializeRequestMessagesForTelemetry(telemetry, request);
	if (requestMessages) span.setAttribute(PiGenAIAttr.RequestMessages, requestMessages);
	if (telemetry.contentCapture !== "full") return;
	const systemInstructions = serializeFullSystemInstructionsForTelemetry(telemetry, request);
	if (systemInstructions) span.setAttribute(GenAIAttr.SystemInstructions, systemInstructions);
	const inputMessages = serializeFullInputMessagesForTelemetry(telemetry, request);
	if (inputMessages) span.setAttribute(GenAIAttr.InputMessages, inputMessages);
}

function applyContentCaptureForResponse(telemetry: AgentTelemetry, span: Span, message: AssistantMessage): void {
	const responseText = serializeResponseTextForTelemetry(telemetry, message);
	if (responseText) span.setAttribute(PiGenAIAttr.ResponseText, responseText);
	const responseToolCalls = serializeResponseToolCallsForTelemetry(telemetry, message);
	if (responseToolCalls) span.setAttribute(PiGenAIAttr.ResponseToolCalls, responseToolCalls);
	if (telemetry.contentCapture === "full") {
		const outputMessages = serializeFullOutputMessagesForTelemetry(telemetry, message);
		if (outputMessages) span.setAttribute(GenAIAttr.OutputMessages, outputMessages);
	}
}

function normalizeSystemPromptParts(systemPrompt: string | readonly string[] | undefined): readonly string[] {
	if (!systemPrompt) return [];
	return typeof systemPrompt === "string" ? [systemPrompt] : systemPrompt;
}

function serializeRequestMessagesForTelemetry(
	telemetry: AgentTelemetry,
	request: ChatRequestSnapshot,
): string | undefined {
	const serializer = telemetry.config.contentSerializer?.requestMessages;
	let serialized: string | undefined;
	if (serializer) {
		serialized = callContentSerializer(telemetry, "requestMessages", () => serializer(request));
	} else {
		const messages: TelemetryMessageSummary[] = [];
		for (const text of normalizeSystemPromptParts(request.systemPrompt))
			messages.push({ role: "system", content: summarizeTelemetryValue(text) });
		if (request.messages) {
			for (const message of request.messages) {
				messages.push({ role: message.role, content: summarizeTelemetryValue(message.content) });
			}
		}
		serialized = messages.length === 0 ? undefined : stringifyJsonAttribute(limitTelemetryMessages(messages));
	}
	return serialized;
}

function serializeResponseTextForTelemetry(telemetry: AgentTelemetry, message: AssistantMessage): string | undefined {
	const serializer = telemetry.config.contentSerializer?.responseText;
	let serialized: string | undefined;
	if (serializer) {
		serialized = callContentSerializer(telemetry, "responseText", () => serializer(message));
	} else {
		const texts: string[] = [];
		for (const part of message.content) {
			if (part.type === "text") texts.push(part.text);
		}
		serialized = texts.length === 0 ? undefined : stringifyJsonAttribute(summarizeTelemetryTexts(texts));
	}
	return serialized;
}

function serializeResponseToolCallsForTelemetry(
	telemetry: AgentTelemetry,
	message: AssistantMessage,
): string | undefined {
	const serializer = telemetry.config.contentSerializer?.responseToolCalls;
	let serialized: string | undefined;
	if (serializer) {
		serialized = callContentSerializer(telemetry, "responseToolCalls", () => serializer(message));
	} else {
		const toolCalls: TelemetryToolCallSummary[] = [];
		for (const part of message.content) {
			if (part.type === "toolCall") {
				toolCalls.push({
					input: summarizeTelemetryValue(part.arguments),
					toolCallId: part.id,
					toolName: part.name,
				});
			}
		}
		serialized = toolCalls.length === 0 ? undefined : stringifyJsonAttribute(limitTelemetryToolCalls(toolCalls));
	}
	return serialized;
}

interface TelemetryMessageSummary {
	readonly role: string;
	readonly content: unknown;
}

interface TelemetryToolCallSummary {
	readonly toolCallId: string;
	readonly toolName: string;
	readonly input: unknown;
}

type OtelMessagePart =
	| { readonly type: "text"; readonly content: string }
	| { readonly type: "reasoning"; readonly content: string }
	| { readonly type: "blob"; readonly modality: "image"; readonly mime_type: string; readonly content: string }
	| { readonly type: "tool_call"; readonly id?: string; readonly name: string; readonly arguments?: unknown }
	| { readonly type: "tool_call_response"; readonly id?: string; readonly response: unknown }
	| { readonly type: string; readonly [key: string]: unknown };

interface OtelInputMessage {
	readonly role: string;
	readonly parts: readonly OtelMessagePart[];
	readonly name?: string;
}

interface OtelOutputMessage extends OtelInputMessage {
	readonly finish_reason: string;
}

function serializeFullSystemInstructionsForTelemetry(
	_telemetry: AgentTelemetry,
	request: ChatRequestSnapshot,
): string | undefined {
	const systemPrompt = normalizeSystemPromptParts(request.systemPrompt);
	if (systemPrompt.length === 0) return undefined;
	return stringifyJsonAttribute(systemPrompt.map(text => ({ type: "text", content: text }) satisfies OtelMessagePart));
}

function serializeFullInputMessagesForTelemetry(
	_telemetry: AgentTelemetry,
	request: ChatRequestSnapshot,
): string | undefined {
	const messages = request.messages;
	if (!messages || messages.length === 0) return undefined;
	return stringifyJsonAttribute(messages.map(messageToOtelInputMessage));
}

function serializeFullOutputMessagesForTelemetry(
	_telemetry: AgentTelemetry,
	message: AssistantMessage,
): string | undefined {
	return stringifyJsonAttribute([assistantMessageToOtelOutputMessage(message)]);
}

function messageToOtelInputMessage(message: Message): OtelInputMessage {
	switch (message.role) {
		case "assistant":
			return { role: "assistant", parts: assistantContentToOtelParts(message.content) };
		case "toolResult":
			return {
				role: "tool",
				name: message.toolName,
				parts: [
					{
						type: "tool_call_response",
						id: message.toolCallId,
						response: {
							content: textOrImageContentToOtelParts(message.content),
							details: message.details,
							is_error: message.isError,
						},
					},
				],
			};
		default:
			return { role: message.role, parts: textOrImageContentToOtelParts(message.content) };
	}
}

function assistantMessageToOtelOutputMessage(message: AssistantMessage): OtelOutputMessage {
	return {
		role: "assistant",
		parts: assistantContentToOtelParts(message.content),
		finish_reason: mapStopReason(message.stopReason) ?? message.stopReason ?? "stop",
	};
}

function textOrImageContentToOtelParts(content: Message["content"]): OtelMessagePart[] {
	if (typeof content === "string") return [{ type: "text", content }];
	const parts: OtelMessagePart[] = [];
	for (const part of content) {
		switch (part.type) {
			case "text":
				parts.push({ type: "text", content: part.text });
				break;
			case "image":
				parts.push({ type: "blob", modality: "image", mime_type: part.mimeType, content: part.data });
				break;
			case "thinking":
				parts.push({ type: "reasoning", content: part.thinking });
				break;
			case "redactedThinking":
				parts.push({ type: "reasoning", content: part.data });
				break;
			case "toolCall":
				parts.push({ type: "tool_call", id: part.id, name: part.name, arguments: part.arguments });
				break;
			default:
				break;
		}
	}
	return parts;
}

function assistantContentToOtelParts(content: AssistantMessage["content"]): OtelMessagePart[] {
	const parts: OtelMessagePart[] = [];
	for (const part of content) {
		switch (part.type) {
			case "text":
				parts.push({ type: "text", content: part.text });
				break;
			case "thinking":
				parts.push({ type: "reasoning", content: part.thinking });
				break;
			case "redactedThinking":
				parts.push({ type: "reasoning", content: part.data });
				break;
			case "toolCall":
				parts.push({ type: "tool_call", id: part.id, name: part.name, arguments: part.arguments });
				break;
		}
	}
	return parts;
}

function callContentSerializer(
	telemetry: AgentTelemetry,
	name: keyof TelemetryContentSerializer,
	serialize: () => string | undefined,
): string | undefined {
	try {
		return serialize();
	} catch (err) {
		emitTelemetryWarning(telemetry, {
			code: "content_serializer_failed",
			message: `${name} content serializer threw; omitting telemetry content`,
			error: err,
		});
		return undefined;
	}
}

function limitTelemetryMessages(messages: readonly TelemetryMessageSummary[]): TelemetryMessageSummary[] {
	const limited = messages.slice(0, MAX_TELEMETRY_MESSAGE_COUNT);
	if (messages.length > MAX_TELEMETRY_MESSAGE_COUNT) {
		limited.push({
			role: "system",
			content: { kind: "truncated", omittedMessages: messages.length - MAX_TELEMETRY_MESSAGE_COUNT },
		});
	}
	return limited;
}

function limitTelemetryToolCalls(toolCalls: readonly TelemetryToolCallSummary[]): TelemetryToolCallSummary[] {
	const limited = toolCalls.slice(0, MAX_TELEMETRY_ARRAY_ITEMS);
	if (toolCalls.length > MAX_TELEMETRY_ARRAY_ITEMS) {
		limited.push({
			toolCallId: "[truncated]",
			toolName: "[truncated]",
			input: { kind: "truncated", omittedToolCalls: toolCalls.length - MAX_TELEMETRY_ARRAY_ITEMS },
		});
	}
	return limited;
}

function summarizeTelemetryTexts(texts: readonly string[]): string[] {
	const summarized = texts.slice(0, MAX_TELEMETRY_ARRAY_ITEMS).map(text => summarizeTelemetryText(text));
	if (texts.length > MAX_TELEMETRY_ARRAY_ITEMS) {
		summarized.push(`[${texts.length - MAX_TELEMETRY_ARRAY_ITEMS} additional text entries omitted]`);
	}
	return summarized;
}

function summarizeTelemetryText(text: string): string {
	if (text.length <= MAX_TELEMETRY_TEXT_CHARS) return text;
	return `${text.slice(0, MAX_TELEMETRY_TEXT_CHARS)} [${text.length - MAX_TELEMETRY_TEXT_CHARS} chars omitted]`;
}

function summarizeTelemetryValue(value: unknown, depth = 0, seen?: Set<object>): unknown {
	if (typeof value === "string") return summarizeTelemetryText(value);
	if (typeof value === "number" || typeof value === "boolean" || value == null) return value;
	if (typeof value === "bigint") return value.toString();
	if (typeof value === "function") return "[Function]";
	if (value instanceof Error) {
		return { name: value.name, message: summarizeTelemetryText(value.message) };
	}
	if (Array.isArray(value)) {
		if (depth >= MAX_TELEMETRY_OBJECT_DEPTH) {
			return { kind: "array", length: value.length };
		}
		const ancestors = seen ?? new Set<object>();
		if (ancestors.has(value)) return "[Circular]";
		ancestors.add(value);
		const items = value
			.slice(0, MAX_TELEMETRY_ARRAY_ITEMS)
			.map(item => summarizeTelemetryValue(item, depth + 1, ancestors));
		if (value.length > MAX_TELEMETRY_ARRAY_ITEMS) {
			items.push({ kind: "truncated", omittedItems: value.length - MAX_TELEMETRY_ARRAY_ITEMS });
		}
		ancestors.delete(value);
		return items;
	}
	if (!isPlainTelemetryRecord(value)) return String(value);
	const ancestors = seen ?? new Set<object>();
	if (ancestors.has(value)) return "[Circular]";
	const entries = Object.entries(value);
	if (depth >= MAX_TELEMETRY_OBJECT_DEPTH) {
		return summarizeTelemetryObjectKeys(entries);
	}
	ancestors.add(value);
	const summary: Record<string, unknown> = {};
	for (const [key, item] of entries.slice(0, MAX_TELEMETRY_OBJECT_KEYS)) {
		summary[key] = summarizeTelemetryValue(item, depth + 1, ancestors);
	}
	if (entries.length > MAX_TELEMETRY_OBJECT_KEYS) {
		summary.telemetrySummary = { omittedKeys: entries.length - MAX_TELEMETRY_OBJECT_KEYS };
	}
	ancestors.delete(value);
	return summary;
}

function summarizeTelemetryObjectKeys(entries: readonly (readonly [string, unknown])[]): Record<string, unknown> {
	const keys = entries.slice(0, MAX_TELEMETRY_OBJECT_KEYS).map(([key]) => key);
	return entries.length > MAX_TELEMETRY_OBJECT_KEYS
		? { kind: "object", keys, telemetrySummary: { omittedKeys: entries.length - MAX_TELEMETRY_OBJECT_KEYS } }
		: { kind: "object", keys };
}

function isPlainTelemetryRecord(value: unknown): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function stringifyJsonAttribute(value: unknown): string | undefined {
	const serialized = JSON.stringify(value);
	return serialized === undefined ? undefined : serialized;
}

function serializeToolCallArgumentsForTelemetry(telemetry: AgentTelemetry, args: unknown): string | undefined {
	const serializer = telemetry.config.contentSerializer?.toolCallArguments;
	return serializer
		? callContentSerializer(telemetry, "toolCallArguments", () => serializer(args))
		: telemetry.contentCapture === "full"
			? safeJson(args)
			: stringifyJsonAttribute(summarizeTelemetryValue(args));
}

function serializeToolCallResultForTelemetry(telemetry: AgentTelemetry, result: unknown): string | undefined {
	const serializer = telemetry.config.contentSerializer?.toolCallResult;
	return serializer
		? callContentSerializer(telemetry, "toolCallResult", () => serializer(result))
		: telemetry.contentCapture === "full"
			? safeJson(result)
			: stringifyJsonAttribute(summarizeTelemetryValue(result));
}

/** Stamp the final response onto a chat span and fire telemetry hooks. */
export async function finishChatSpan(
	telemetry: AgentTelemetry | undefined,
	span: Span | undefined,
	message: AssistantMessage,
	options: {
		readonly stepNumber: number;
		readonly serviceTier?: ServiceTier;
		readonly responseHeaders?: Readonly<Record<string, string>>;
		readonly baseUrl?: string;
	},
): Promise<void> {
	if (!span) return;
	applyChatResponseAttributes(span, message);
	applyUsageAttributes(span, message.usage);
	applyGatewayAttributes(span, options.responseHeaders, options.baseUrl);
	const cost = applyCostEstimate(telemetry, span, message, options.serviceTier, options.stepNumber);
	if (telemetry) {
		await emitChatUsage(telemetry, span, {
			model: message.model,
			provider: message.provider,
			serviceTier: options.serviceTier,
			stepNumber: options.stepNumber,
			usage: message.usage,
			applied: cost,
			headers: options.responseHeaders,
		}).catch(err => {
			emitTelemetryWarning(telemetry, {
				code: "on_chat_usage_failed",
				message: "onChatUsage rejected; swallowing telemetry callback failure",
				error: err,
			});
		});
	}
	if (telemetry && telemetry.contentCapture !== "none") {
		applyContentCaptureForResponse(telemetry, span, message);
	}
	safeOnSpanEnd(telemetry, {
		span,
		kind: "chat",
		model: undefined,
		agent: normalizedTelemetryAgent(telemetry),
		conversationId: telemetry?.conversationId,
		stepNumber: options.stepNumber,
	});
	applyTerminalStatus(span, message.stopReason, message.errorMessage);
	telemetry?.collector.endChat(span, message, cost);
	span.end();
}

/** Record a chat that failed before producing a final AssistantMessage. */
export function failChatSpan(
	telemetry: AgentTelemetry | undefined,
	span: Span | undefined,
	options: {
		readonly errorObject: unknown;
		readonly errorType?: string;
		readonly responseHeaders?: Readonly<Record<string, string>>;
		readonly baseUrl?: string;
	},
): void {
	if (!span) return;
	applyGatewayAttributes(span, options.responseHeaders, options.baseUrl);
	safeOnSpanEnd(telemetry, {
		span,
		kind: "chat",
		model: undefined,
		agent: normalizedTelemetryAgent(telemetry),
		conversationId: telemetry?.conversationId,
	});
	const err = options.errorObject;
	if (err instanceof Error) {
		span.recordException(err);
		span.setAttribute(GenAIAttr.ErrorType, options.errorType ?? err.name ?? "Error");
		span.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
	} else {
		span.setAttribute(GenAIAttr.ErrorType, options.errorType ?? "Error");
		span.setStatus({ code: SpanStatusCode.ERROR, message: String(err) });
	}
	telemetry?.collector.failChat(span, {
		errorType: options.errorType ?? (err instanceof Error ? err.name || "Error" : "Error"),
	});
	span.end();
}

function applyChatResponseAttributes(span: Span, message: AssistantMessage): void {
	span.setAttribute(GenAIAttr.ResponseModel, message.model);
	if (message.responseId) span.setAttribute(GenAIAttr.ResponseId, message.responseId);
	if (message.upstreamProvider) {
		span.setAttribute(PiGenAIAttr.ResponseUpstreamProvider, message.upstreamProvider);
	}
	if (message.ttft != null) span.setAttribute(GenAIAttr.ResponseTimeToFirstChunk, message.ttft / 1000);
	const finishReason = mapStopReason(message.stopReason);
	if (finishReason) span.setAttribute(GenAIAttr.ResponseFinishReasons, [finishReason]);
}

function applyUsageAttributes(span: Span, usage: Usage | undefined): void {
	if (!usage) return;
	const cacheReadTokens = usage.cacheRead ?? 0;
	const cacheCreationTokens = usage.cacheWrite ?? 0;
	const inputTokens = (usage.input ?? 0) + cacheReadTokens + cacheCreationTokens;
	const outputTokens = usage.output ?? 0;
	span.setAttribute(GenAIAttr.UsageInputTokens, inputTokens);
	span.setAttribute(GenAIAttr.UsageOutputTokens, outputTokens);
	const total = usage.totalTokens ?? inputTokens + outputTokens;
	span.setAttribute(PiGenAIAttr.UsageTotalTokens, total);
	if (usage.cacheRead != null) span.setAttribute(GenAIAttr.UsageCacheReadInputTokens, usage.cacheRead);
	if (usage.cacheWrite != null) span.setAttribute(GenAIAttr.UsageCacheCreationInputTokens, usage.cacheWrite);
	if (usage.reasoningTokens != null) {
		span.setAttribute(GenAIAttr.UsageReasoningOutputTokens, usage.reasoningTokens);
	}
	if (usage.server) {
		const sums = (usage.server.webSearch ?? 0) + (usage.server.webFetch ?? 0);
		if (sums > 0) span.setAttribute(PiGenAIAttr.UsageServerSideTools, sums);
	}
}

export interface GatewayHeaderDetection {
	readonly name: string;
	readonly callId: string | undefined;
	readonly routedTo: string | undefined;
}

/** Identify a known LLM gateway / proxy from response headers. */
export function detectGatewayFromHeaders(
	headers: Readonly<Record<string, string>> | undefined,
): GatewayHeaderDetection | undefined {
	if (!headers) return undefined;
	const normalizedHeaders: Readonly<Record<string, string>> = Object.keys(headers).some(
		key => key !== key.toLowerCase(),
	)
		? Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]))
		: headers;
	const litellmCallId = normalizedHeaders["x-litellm-call-id"];
	if (litellmCallId) {
		return {
			name: "litellm",
			callId: litellmCallId,
			routedTo: normalizedHeaders["x-litellm-model-id"] ?? normalizedHeaders["x-litellm-model-group"],
		};
	}
	const heliconeId = normalizedHeaders["helicone-id"];
	if (heliconeId) {
		return { name: "helicone", callId: heliconeId, routedTo: normalizedHeaders["helicone-target-provider"] };
	}
	const portkeyId = normalizedHeaders["x-portkey-trace-id"] ?? normalizedHeaders["x-portkey-request-id"];
	if (portkeyId) {
		return {
			name: "portkey",
			callId: portkeyId,
			routedTo: normalizedHeaders["x-portkey-llm-provider"] ?? normalizedHeaders["x-portkey-provider"],
		};
	}
	const openRouterGenerationId = normalizedHeaders["x-generation-id"];
	if (openRouterGenerationId?.startsWith("gen-")) {
		// OpenRouter uses gen- prefix on x-generation-id; routedTo is in response body.
		return { name: "openrouter", callId: openRouterGenerationId, routedTo: undefined };
	}
	return undefined;
}

function applyGatewayAttributes(
	span: Span,
	headers: Readonly<Record<string, string>> | undefined,
	baseUrl: string | undefined,
): void {
	const gateway = detectGatewayFromHeaders(headers);
	if (!gateway) return;
	span.setAttribute(PiGenAIAttr.GatewayName, gateway.name);
	if (baseUrl) span.setAttribute(PiGenAIAttr.GatewayEndpoint, baseUrl);
	if (gateway.callId) span.setAttribute(PiGenAIAttr.GatewayCallId, gateway.callId);
	if (gateway.routedTo) span.setAttribute(PiGenAIAttr.GatewayRoutedTo, gateway.routedTo);
}

interface AppliedCostEstimate {
	readonly costUsd: number | undefined;
	readonly inputUsd: number | undefined;
	readonly outputUsd: number | undefined;
	readonly costUnavailableReason: string | undefined;
}

function applyCostEstimate(
	telemetry: AgentTelemetry | undefined,
	span: Span,
	message: AssistantMessage,
	serviceTier: ServiceTier | undefined,
	stepNumber: number | undefined,
): AppliedCostEstimate {
	if (!telemetry) return EMPTY_COST;
	return applyCostEstimateForUsage(telemetry, span, {
		model: message.model,
		provider: message.provider,
		serviceTier,
		stepNumber,
		usage: message.usage,
	});
}

function applyCostEstimateForUsage(
	telemetry: AgentTelemetry,
	span: Span,
	input: {
		readonly model: string;
		readonly provider: string | undefined;
		readonly serviceTier: ServiceTier | undefined;
		readonly stepNumber: number | undefined;
		readonly usage: Usage | undefined;
	},
): AppliedCostEstimate {
	const estimator = telemetry.config.costEstimator;
	if (!estimator || !input.usage) return EMPTY_COST;
	const provider = normalizeProviderName(telemetry, input.provider);
	if (!provider) return EMPTY_COST;
	const usage = buildUsageSnapshot(input.usage);
	let result: CostEstimate | undefined;
	try {
		result = estimator({
			provider,
			model: input.model,
			serviceTier: input.serviceTier,
			usage,
		});
	} catch (err) {
		emitTelemetryWarning(telemetry, {
			code: "cost_estimator_failed",
			message: "costEstimator threw; omitting cost telemetry",
			error: err,
		});
		return EMPTY_COST;
	}
	if (!result) return EMPTY_COST;
	if ("unavailable" in result) {
		span.setAttribute(PiGenAIAttr.CostUnavailableReason, result.unavailable);
		const cost: AppliedCostEstimate = {
			costUsd: undefined,
			inputUsd: undefined,
			outputUsd: undefined,
			costUnavailableReason: result.unavailable,
		};
		emitCostDelta(telemetry, {
			agent: normalizedTelemetryAgent(telemetry),
			conversationId: telemetry.conversationId,
			costUsd: undefined,
			costUnavailableReason: result.unavailable,
			inputUsd: undefined,
			model: input.model,
			outputUsd: undefined,
			provider,
			serviceTier: input.serviceTier,
			stepNumber: input.stepNumber,
			usage,
		});
		return cost;
	}
	span.setAttribute(PiGenAIAttr.CostEstimatedUsd, result.usd);
	if (result.inputUsd != null) span.setAttribute(PiGenAIAttr.CostInputUsd, result.inputUsd);
	if (result.outputUsd != null) span.setAttribute(PiGenAIAttr.CostOutputUsd, result.outputUsd);
	const cost: AppliedCostEstimate = {
		costUsd: result.usd,
		inputUsd: result.inputUsd,
		outputUsd: result.outputUsd,
		costUnavailableReason: undefined,
	};
	emitCostDelta(telemetry, {
		agent: normalizedTelemetryAgent(telemetry),
		conversationId: telemetry.conversationId,
		costUsd: result.usd,
		costUnavailableReason: undefined,
		inputUsd: result.inputUsd,
		model: input.model,
		outputUsd: result.outputUsd,
		provider,
		serviceTier: input.serviceTier,
		stepNumber: input.stepNumber,
		usage,
	});
	return cost;
}

function buildUsageSnapshot(usage: Usage): ChatUsageSnapshot {
	return {
		inputTokens: (usage.input ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0),
		outputTokens: usage.output ?? 0,
		totalTokens:
			usage.totalTokens ??
			(usage.input ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0) + (usage.output ?? 0),
		cachedInputTokens: usage.cacheRead,
		cacheWriteTokens: usage.cacheWrite,
		reasoningOutputTokens: usage.reasoningTokens,
	};
}

function emitCostDelta(telemetry: AgentTelemetry, delta: CostDelta): void {
	const hook = telemetry.config.onCostDelta;
	if (!hook) return;
	try {
		hook(delta);
	} catch (err) {
		emitTelemetryWarning(telemetry, {
			code: "on_cost_delta_failed",
			message: "onCostDelta threw; swallowing telemetry callback failure",
			error: err,
		});
	}
}

async function emitChatUsage(
	telemetry: AgentTelemetry,
	span: Span,
	input: {
		readonly model: string;
		readonly provider: string | undefined;
		readonly serviceTier: ServiceTier | undefined;
		readonly stepNumber: number | undefined;
		readonly usage: Usage | undefined;
		readonly applied: AppliedCostEstimate;
		readonly headers: Readonly<Record<string, string>> | undefined;
	},
): Promise<void> {
	const hook = telemetry.config.onChatUsage;
	if (!hook || !input.usage) return;
	const event: ChatUsageEvent = {
		span,
		agent: normalizedTelemetryAgent(telemetry),
		conversationId: telemetry.conversationId,
		stepNumber: input.stepNumber,
		model: input.model,
		provider: normalizeProviderName(telemetry, input.provider),
		serviceTier: input.serviceTier,
		usage: buildUsageSnapshot(input.usage),
		cost: costEstimateFromApplied(input.applied),
		attributes: resolveDynamicAttributes(
			telemetry,
			buildTelemetryAttributeContext(telemetry, "chat", { stepNumber: input.stepNumber }),
		),
		headers: input.headers,
	};
	try {
		await hook(event);
	} catch (err) {
		emitTelemetryWarning(telemetry, {
			code: "on_chat_usage_failed",
			message: "onChatUsage threw; swallowing telemetry callback failure",
			error: err,
		});
	}
}

function costEstimateFromApplied(applied: AppliedCostEstimate): CostEstimate | undefined {
	if (applied.costUsd != null) {
		return { usd: applied.costUsd, inputUsd: applied.inputUsd, outputUsd: applied.outputUsd };
	}
	if (applied.costUnavailableReason != null) {
		return { unavailable: applied.costUnavailableReason };
	}
	return undefined;
}

const EMPTY_COST: AppliedCostEstimate = Object.freeze({
	costUsd: undefined,
	inputUsd: undefined,
	outputUsd: undefined,
	costUnavailableReason: undefined,
});

function mapStopReason(reason: StopReason | undefined): string | undefined {
	switch (reason) {
		case "stop":
			return "stop";
		case "length":
			return "length";
		case "toolUse":
			return "tool_calls";
		case "error":
		case "aborted":
			return "error";
		default:
			return undefined;
	}
}

function applyTerminalStatus(span: Span, stopReason: StopReason | undefined, errorMessage: string | undefined): void {
	if (stopReason === "error" || stopReason === "aborted") {
		span.setAttribute(GenAIAttr.ErrorType, stopReason);
		span.setStatus({ code: SpanStatusCode.ERROR, message: errorMessage ?? stopReason });
	}
}

export interface ManualChatToolCallTelemetry {
	readonly toolCallId: string;
	readonly toolName: string;
	readonly input?: unknown;
}

export interface ManualChatTelemetryOptions {
	readonly span?: Span;
	readonly parent?: Span;
	readonly model: Model;
	readonly usage?: Usage;
	readonly finishReason?: StopReason;
	readonly serviceTier?: ServiceTier;
	readonly stepNumber?: number;
	readonly responseId?: string;
	readonly responseModel?: string;
	readonly responseText?: string;
	readonly responseToolCalls?: readonly ManualChatToolCallTelemetry[];
	readonly attributes?: Attributes;
	readonly responseHeaders?: Readonly<Record<string, string>>;
	readonly endSpan?: boolean;
}

export async function recordManualChatTelemetry(
	telemetry: AgentTelemetry | undefined,
	options: ManualChatTelemetryOptions,
): Promise<Span | undefined> {
	const candidate =
		options.span ??
		startSpan(telemetry, "chat", `chat ${options.model.id}`, {
			spanKind: SpanKind.CLIENT,
			model: options.model,
			parent: options.parent,
			stepNumber: options.stepNumber,
			attributes: options.attributes,
		});
	const span =
		candidate && telemetry?.config.textSanitizer ? wrapSpanWithTextSanitizer(telemetry, candidate) : candidate;
	if (!span) return undefined;
	if (options.span && options.attributes) span.setAttributes(options.attributes);
	if (options.stepNumber != null) span.setAttribute(PiGenAIAttr.AgentStepNumber, options.stepNumber);
	span.setAttribute(GenAIAttr.ResponseModel, options.responseModel ?? options.model.name);
	if (options.responseId) span.setAttribute(GenAIAttr.ResponseId, options.responseId);
	const finishReason = mapStopReason(options.finishReason);
	if (finishReason) span.setAttribute(GenAIAttr.ResponseFinishReasons, [finishReason]);
	applyUsageAttributes(span, options.usage);
	applyGatewayAttributes(span, options.responseHeaders, options.model.baseUrl);
	if (telemetry) {
		const applied = applyCostEstimateForUsage(telemetry, span, {
			model: options.responseModel ?? options.model.id,
			provider: options.model.provider,
			serviceTier: options.serviceTier,
			stepNumber: options.stepNumber,
			usage: options.usage,
		});
		await emitChatUsage(telemetry, span, {
			model: options.responseModel ?? options.model.id,
			provider: options.model.provider,
			serviceTier: options.serviceTier,
			stepNumber: options.stepNumber,
			usage: options.usage,
			applied,
			headers: options.responseHeaders,
		}).catch(err => {
			emitTelemetryWarning(telemetry, {
				code: "on_chat_usage_failed",
				message: "onChatUsage rejected; swallowing telemetry callback failure",
				error: err,
			});
		});
	}
	if (options.responseText) {
		const responseText = stringifyJsonAttribute(summarizeTelemetryTexts([options.responseText]));
		if (responseText) span.setAttribute(PiGenAIAttr.ResponseText, responseText);
	}
	if (options.responseToolCalls && options.responseToolCalls.length > 0) {
		const calls = options.responseToolCalls.map(call => ({
			toolCallId: call.toolCallId,
			toolName: call.toolName,
			input: summarizeTelemetryValue(call.input),
		}));
		const responseToolCalls = stringifyJsonAttribute(limitTelemetryToolCalls(calls));
		if (responseToolCalls) span.setAttribute(PiGenAIAttr.ResponseToolCalls, responseToolCalls);
	}
	applyTerminalStatus(span, options.finishReason, undefined);
	if (options.endSpan ?? options.span === undefined) {
		safeOnSpanEnd(telemetry, {
			span,
			kind: "chat",
			model: options.model,
			agent: normalizedTelemetryAgent(telemetry),
			conversationId: telemetry?.conversationId,
			stepNumber: options.stepNumber,
		});
		span.end();
	}
	return span;
}

/** Start an `execute_tool` span representing one tool invocation. */
export function startExecuteToolSpan(
	telemetry: AgentTelemetry | undefined,
	options: {
		readonly tool: AgentTool | undefined;
		readonly toolName: string;
		readonly toolCallId: string;
		readonly args: unknown;
		readonly parent?: Span;
	},
): Span | undefined {
	const attrs: Attributes = {
		[GenAIAttr.ToolName]: options.toolName,
		[GenAIAttr.ToolCallId]: options.toolCallId,
		[GenAIAttr.ToolType]: "function",
	};
	if (options.tool?.description) attrs[GenAIAttr.ToolDescription] = options.tool.description;
	const span = startSpan(telemetry, "execute_tool", `execute_tool ${options.toolName}`, {
		spanKind: SpanKind.INTERNAL,
		parent: options.parent,
		toolCallId: options.toolCallId,
		toolName: options.toolName,
		attributes: attrs,
	});
	if (span) {
		telemetry?.collector.beginTool(span, { toolCallId: options.toolCallId, toolName: options.toolName });
		if (telemetry && telemetry.contentCapture !== "none") {
			const args = serializeToolCallArgumentsForTelemetry(telemetry, options.args);
			if (args) span.setAttribute(GenAIAttr.ToolCallArguments, args);
		}
	}
	return span;
}

/** End an `execute_tool` span. */
export function finishExecuteToolSpan(
	telemetry: AgentTelemetry | undefined,
	span: Span | undefined,
	options: {
		readonly result?: unknown;
		readonly isError: boolean;
		readonly status?: ToolStatus;
		readonly errorMessage?: string;
		readonly errorObject?: unknown;
		readonly toolCallId: string;
		readonly toolName: string;
	},
): void {
	if (!span) return;
	if (telemetry && telemetry.contentCapture !== "none" && options.result !== undefined) {
		const result = serializeToolCallResultForTelemetry(telemetry, options.result);
		if (result) span.setAttribute(GenAIAttr.ToolCallResult, result);
	}
	safeOnSpanEnd(telemetry, {
		span,
		kind: "execute_tool",
		model: undefined,
		agent: normalizedTelemetryAgent(telemetry),
		conversationId: telemetry?.conversationId,
		toolCallId: options.toolCallId,
		toolName: options.toolName,
	});
	const status: ToolStatus = options.status ?? (options.isError ? "error" : "ok");
	let errorType: string | undefined;
	// Map status to wire error.type so dashboards can group by category.
	if (status !== "ok") {
		errorType =
			status === "error" && options.errorObject instanceof Error
				? options.errorObject.name || "Error"
				: STATUS_ERROR_TYPE[status];
		span.setAttribute(GenAIAttr.ErrorType, errorType);
		span.setAttribute(EXECUTE_TOOL_STATUS_ATTR, status);
		const msg =
			options.errorObject instanceof Error ? options.errorObject.message : (options.errorMessage ?? errorType);
		span.setStatus({ code: SpanStatusCode.ERROR, message: msg });
	} else {
		span.setAttribute(EXECUTE_TOOL_STATUS_ATTR, status);
	}
	if (options.errorObject instanceof Error) {
		span.recordException(options.errorObject);
	}
	telemetry?.collector.endTool(span, { status, errorType });
	span.end();
}

export const EXECUTE_TOOL_STATUS_ATTR = PiGenAIAttr.ToolStatus;

const STATUS_ERROR_TYPE: Record<Exclude<ToolStatus, "ok">, string> = {
	error: "tool_error",
	skipped: "tool_skipped",
	blocked: "tool_blocked",
	timeout: "tool_timeout",
	aborted: "tool_aborted",
};

export function recordSkippedTool(
	telemetry: AgentTelemetry | undefined,
	options: {
		readonly toolCallId: string;
		readonly toolName: string;
		readonly status: Extract<ToolStatus, "skipped" | "aborted" | "error">;
	},
): void {
	telemetry?.collector.recordOrphanTool(options);
}

/** End an `invoke_agent` span. */
export function finishInvokeAgentSpan(
	telemetry: AgentTelemetry | undefined,
	span: Span | undefined,
	options: { readonly stepCount: number; readonly errorObject?: unknown },
): { readonly summary: AgentRunSummary; readonly coverage: AgentRunCoverage } | undefined {
	if (!span) return undefined;
	applyInvokeAgentFinish(span, options.stepCount);
	let snapshot: { readonly summary: AgentRunSummary; readonly coverage: AgentRunCoverage } | undefined;
	if (telemetry) {
		snapshot = telemetry.collector.snapshot({ stepCount: options.stepCount });
		applyAggregateAttributes(span, snapshot.summary, snapshot.coverage);
	}
	safeOnSpanEnd(telemetry, {
		span,
		kind: "invoke_agent",
		model: undefined,
		agent: normalizedTelemetryAgent(telemetry),
		conversationId: telemetry?.conversationId,
	});
	if (telemetry && snapshot && telemetry.collector.markRunEnded()) {
		fireOnRunEnd(telemetry, snapshot.summary, snapshot.coverage);
	}
	if (options.errorObject instanceof Error) {
		span.recordException(options.errorObject);
		span.setAttribute(GenAIAttr.ErrorType, options.errorObject.name || "Error");
		span.setStatus({ code: SpanStatusCode.ERROR, message: options.errorObject.message });
	}
	span.end();
	return snapshot;
}

export function fireOnRunEnd(telemetry: AgentTelemetry, summary: AgentRunSummary, coverage: AgentRunCoverage): void {
	const hook = telemetry.config.onRunEnd;
	if (!hook) return;
	try {
		hook(summary, coverage);
	} catch (err) {
		emitTelemetryWarning(telemetry, {
			code: "on_run_end_failed",
			message: "onRunEnd threw; swallowing telemetry callback failure",
			error: err,
		});
	}
}

export const enum PiGenAIAggregateAttr {
	ChatsCount = "pi.gen_ai.agent.chats.count",
	ChatsTotalLatencyMs = "pi.gen_ai.agent.chats.total_latency_ms",
	ChatsStopReasonPrefix = "pi.gen_ai.agent.chats.stop_reason.",
	ToolsCount = "pi.gen_ai.agent.tools.count",
	ToolsOkCount = "pi.gen_ai.agent.tools.ok.count",
	ToolsErrorCount = "pi.gen_ai.agent.tools.error.count",
	ToolsSkippedCount = "pi.gen_ai.agent.tools.skipped.count",
	ToolsBlockedCount = "pi.gen_ai.agent.tools.blocked.count",
	ToolsTimeoutCount = "pi.gen_ai.agent.tools.timeout.count",
	ToolsAbortedCount = "pi.gen_ai.agent.tools.aborted.count",
	ToolsTotalLatencyMs = "pi.gen_ai.agent.tools.total_latency_ms",
	ToolsInvoked = "pi.gen_ai.agent.tools.invoked",
	ToolsAvailable = "pi.gen_ai.agent.tools.available",
	ToolsUnused = "pi.gen_ai.agent.tools.unused",
	UsageInputTokensTotal = "pi.gen_ai.agent.usage.input_tokens.total",
	UsageOutputTokensTotal = "pi.gen_ai.agent.usage.output_tokens.total",
	UsageCacheReadInputTokensTotal = "pi.gen_ai.agent.usage.cache_read.input_tokens.total",
	UsageCacheCreationInputTokensTotal = "pi.gen_ai.agent.usage.cache_creation.input_tokens.total",
	UsageReasoningOutputTokensTotal = "pi.gen_ai.agent.usage.reasoning.output_tokens.total",
	UsageTotalTokensTotal = "pi.gen_ai.agent.usage.total_tokens.total",
	CostEstimatedUsdTotal = "pi.gen_ai.agent.cost.estimated_usd.total",
	ErrorsCount = "pi.gen_ai.agent.errors.count",
}

function applyAggregateAttributes(span: Span, summary: AgentRunSummary, coverage: AgentRunCoverage): void {
	span.setAttribute(PiGenAIAggregateAttr.ChatsCount, summary.chats.total);
	span.setAttribute(PiGenAIAggregateAttr.ChatsTotalLatencyMs, summary.chats.totalLatencyMs);
	for (const [reason, count] of Object.entries(summary.chats.byStopReason)) {
		span.setAttribute(`${PiGenAIAggregateAttr.ChatsStopReasonPrefix}${reason}.count`, count);
	}
	span.setAttribute(PiGenAIAggregateAttr.ToolsCount, summary.tools.total);
	span.setAttribute(PiGenAIAggregateAttr.ToolsOkCount, summary.tools.ok);
	span.setAttribute(PiGenAIAggregateAttr.ToolsErrorCount, summary.tools.error);
	span.setAttribute(PiGenAIAggregateAttr.ToolsSkippedCount, summary.tools.skipped);
	span.setAttribute(PiGenAIAggregateAttr.ToolsBlockedCount, summary.tools.blocked);
	span.setAttribute(PiGenAIAggregateAttr.ToolsTimeoutCount, summary.tools.timeout);
	span.setAttribute(PiGenAIAggregateAttr.ToolsAbortedCount, summary.tools.aborted);
	span.setAttribute(PiGenAIAggregateAttr.ToolsTotalLatencyMs, summary.tools.totalLatencyMs);
	if (coverage.toolsInvoked.length > 0) {
		span.setAttribute(PiGenAIAggregateAttr.ToolsInvoked, coverage.toolsInvoked.slice());
	}
	if (coverage.toolsAvailable.length > 0) {
		span.setAttribute(PiGenAIAggregateAttr.ToolsAvailable, coverage.toolsAvailable.slice());
	}
	if (coverage.toolsUnused.length > 0) {
		span.setAttribute(PiGenAIAggregateAttr.ToolsUnused, coverage.toolsUnused.slice());
	}
	span.setAttribute(PiGenAIAggregateAttr.UsageInputTokensTotal, summary.usage.inputTokens);
	span.setAttribute(PiGenAIAggregateAttr.UsageOutputTokensTotal, summary.usage.outputTokens);
	span.setAttribute(PiGenAIAggregateAttr.UsageCacheReadInputTokensTotal, summary.usage.cachedInputTokens);
	span.setAttribute(PiGenAIAggregateAttr.UsageCacheCreationInputTokensTotal, summary.usage.cacheWriteTokens);
	span.setAttribute(PiGenAIAggregateAttr.UsageReasoningOutputTokensTotal, summary.usage.reasoningOutputTokens);
	span.setAttribute(PiGenAIAggregateAttr.UsageTotalTokensTotal, summary.usage.totalTokens);
	if (summary.cost.estimatedUsd > 0) {
		span.setAttribute(PiGenAIAggregateAttr.CostEstimatedUsdTotal, summary.cost.estimatedUsd);
	}
	span.setAttribute(PiGenAIAggregateAttr.ErrorsCount, summary.errors.total);
}

/** Run `fn` with `span` activated on the OTEL context. */
export function runInActiveSpan<T>(span: Span | undefined, fn: () => Promise<T>): Promise<T> {
	if (!span) return fn();
	return context.with(trace.setSpan(context.active(), span), fn);
}

/** Emit a one-shot `handoff` span describing a transition between two named agents. */
export function recordHandoff(
	telemetry: AgentTelemetry | undefined,
	options: {
		readonly fromAgent: AgentIdentity | undefined;
		readonly toAgent: AgentIdentity;
		readonly parent?: Span;
		readonly attributes?: Attributes;
	},
): void {
	if (!telemetry) return;
	const attrs: Attributes = {};
	const fromAgent = options.fromAgent ? normalizeAgentIdentity(telemetry, options.fromAgent) : undefined;
	const toAgent = normalizeAgentIdentity(telemetry, options.toAgent);
	if (fromAgent?.name) attrs[PiGenAIAttr.HandoffFromAgentName] = fromAgent.name;
	if (fromAgent?.id) attrs[PiGenAIAttr.HandoffFromAgentId] = fromAgent.id;
	if (toAgent.name) attrs[PiGenAIAttr.HandoffToAgentName] = toAgent.name;
	if (toAgent.id) attrs[PiGenAIAttr.HandoffToAgentId] = toAgent.id;
	const name = toAgent.name
		? fromAgent?.name
			? `handoff ${fromAgent.name} → ${toAgent.name}`
			: `handoff to ${toAgent.name}`
		: "handoff";
	const span = startSpan(telemetry, "handoff", name, {
		spanKind: SpanKind.INTERNAL,
		parent: options.parent,
		attributes: { ...attrs, ...options.attributes },
	});
	if (!span) return;
	safeOnSpanEnd(telemetry, {
		span,
		kind: "handoff",
		model: undefined,
		agent: toAgent,
		conversationId: telemetry.conversationId,
	});
	span.end();
}

export function setSpanAttribute(span: Span | undefined, key: string, value: AttributeValue): void {
	if (!span) return;
	span.setAttribute(key, value);
}

export { type Attributes, type Span, SpanKind, SpanStatusCode, type Tracer, trace };

function safeJson(value: unknown): string {
	return stringifyJsonSafe(value);
}
