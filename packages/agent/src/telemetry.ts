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
import type { AssistantMessage, Message, Model, ToolChoice } from "@veyyon/ai";
import { shouldSendServiceTier } from "@veyyon/ai/types";
import { AgentRunCollector } from "./run-collector";
import {
	type AgentIdentity,
	type AgentTelemetry,
	type AgentTelemetryConfig,
	type AgentTelemetryWarning,
	type ChatRequestSnapshot,
	CONTENT_CAPTURE_ENV,
	DEFAULT_TRACER_NAME,
	GenAIAttr,
	GenAIOperation,
	type GenAIOperationName,
	OpenAIAttr,
	PiGenAIAttr,
	type ResolvedTelemetryContentCapture,
	type TelemetryAttributeContext,
	type TelemetryContentCapture,
	type TelemetryHookContext,
	type TelemetrySpanKind,
} from "./telemetry-helpers";

export {
	type AgentIdentity,
	type AgentTelemetry,
	type AgentTelemetryConfig,
	type AgentTelemetryWarning,
	type ChatRequestSnapshot,
	type ChatUsageEvent,
	type ChatUsageSnapshot,
	type CostDelta,
	type CostEstimate,
	type CostEstimatorContext,
	DEFAULT_TRACER_NAME,
	GenAIAttr,
	GenAIOperation,
	type GenAIOperationName,
	OpenAIAttr,
	PiGenAIAttr,
	type ResolvedTelemetryContentCapture,
	type TelemetryAttributeContext,
	type TelemetryContentCapture,
	type TelemetryContentSerializer,
	type TelemetryHookContext,
	type TelemetrySpanKind,
} from "./telemetry-helpers";

import {
	assistantContentToOtelParts,
	callContentSerializer,
	limitTelemetryMessages,
	limitTelemetryToolCalls,
	mapStopReason,
	stringifyJsonAttribute,
	summarizeTelemetryTexts,
	summarizeTelemetryValue,
} from "./telemetry-helpers";

export {
	detectGatewayFromHeaders,
	EXECUTE_TOOL_STATUS_ATTR,
	failChatSpan,
	finishChatSpan,
	finishExecuteToolSpan,
	finishInvokeAgentSpan,
	fireOnRunEnd,
	type GatewayHeaderDetection,
	type ManualChatTelemetryOptions,
	type ManualChatToolCallTelemetry,
	PiGenAIAggregateAttr,
	recordHandoff,
	recordManualChatTelemetry,
	recordSkippedTool,
	runInActiveSpan,
	setSpanAttribute,
	startExecuteToolSpan,
} from "./telemetry-helpers";

export { type Attributes, type Span, SpanKind, SpanStatusCode, type Tracer, trace };

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

export function startSpan(
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

export function wrapSpanWithTextSanitizer(
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

export function buildTelemetryAttributeContext(
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

export function resolveDynamicAttributes(
	telemetry: AgentTelemetry,
	ctx: TelemetryAttributeContext,
): Attributes | undefined {
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

export function normalizeProviderName(
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

export function normalizeAgentIdentity(telemetry: AgentTelemetry, agent: AgentIdentity): AgentIdentity {
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

export function normalizedTelemetryAgent(telemetry: AgentTelemetry | undefined): AgentIdentity | undefined {
	return telemetry?.agent ? normalizeAgentIdentity(telemetry, telemetry.agent) : undefined;
}

export function emitTelemetryWarning(telemetry: AgentTelemetry | undefined, warning: AgentTelemetryWarning): void {
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

export function safeOnSpanEnd(telemetry: AgentTelemetry | undefined, ctx: TelemetryHookContext): void {
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

export function startInvokeAgentSpan(telemetry: AgentTelemetry | undefined, model: Model): Span | undefined {
	const agentName = telemetry?.agent ? normalizeAgentIdentity(telemetry, telemetry.agent).name : undefined;
	const name = agentName ? `invoke_agent ${agentName}` : "invoke_agent";
	return startSpan(telemetry, "invoke_agent", name, { spanKind: SpanKind.INTERNAL, model });
}

export function applyInvokeAgentFinish(span: Span | undefined, stepCount: number): void {
	if (!span) return;
	span.setAttribute(PiGenAIAttr.AgentStepCount, stepCount);
}

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

export function applyContentCaptureForResponse(telemetry: AgentTelemetry, span: Span, message: AssistantMessage): void {
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

export interface TelemetryMessageSummary {
	readonly role: string;
	readonly content: unknown;
}

export interface TelemetryToolCallSummary {
	readonly toolCallId: string;
	readonly toolName: string;
	readonly input: unknown;
}

export type OtelMessagePart =
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
