import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
	BasicTracerProvider,
	InMemorySpanExporter,
	type ReadableSpan,
	SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import {
	type AgentTelemetry,
	type AgentTelemetryConfig,
	type AgentTelemetryWarning,
	finishChatSpan,
	finishExecuteToolSpan,
	finishInvokeAgentSpan,
	GenAIAttr,
	OpenAIAttr,
	PiGenAIAttr,
	recordHandoff,
	recordManualChatTelemetry,
	resolveTelemetry,
	startChatSpan,
	startExecuteToolSpan,
	startInvokeAgentSpan,
} from "@veyyon/agent-core/telemetry";
import type { AgentTool } from "@veyyon/agent-core/types";
import type { AssistantMessage, Model, ServiceTier, ToolChoice, Usage } from "@veyyon/ai";
import { buildModel } from "@veyyon/catalog/build";

const RAW_SENTINEL = "RAW_TELEMETRY_SECRET_7f31";
const REPLACEMENT = "[SANITIZED]";

const MODEL: Model = buildModel({
	id: "sanitizer-model",
	name: "sanitizer-model",
	api: "mock",
	provider: "openai",
	baseUrl: "mock://",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 32_768,
});

const CONTENT_ATTRIBUTES = [
	GenAIAttr.SystemInstructions,
	GenAIAttr.InputMessages,
	GenAIAttr.OutputMessages,
	GenAIAttr.ToolCallArguments,
	GenAIAttr.ToolCallResult,
	PiGenAIAttr.RequestMessages,
	PiGenAIAttr.ResponseText,
	PiGenAIAttr.ResponseToolCalls,
] as const;

let exporter: InMemorySpanExporter;
let provider: BasicTracerProvider;

beforeEach(() => {
	exporter = new InMemorySpanExporter();
	provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
});

afterEach(async () => {
	exporter.reset();
	await provider.shutdown();
});

function telemetryFor(config: Partial<AgentTelemetryConfig>): AgentTelemetry {
	const telemetry = resolveTelemetry(
		{ tracer: provider.getTracer("text-sanitizer-test"), ...config },
		`session-${RAW_SENTINEL}`,
	);
	if (!telemetry) throw new Error("telemetry should resolve");
	return telemetry;
}

function usage(): Usage {
	return {
		input: 11,
		output: 5,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 16,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function assistant(content: AssistantMessage["content"], overrides: Partial<AssistantMessage> = {}): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "mock",
		provider: "openai",
		model: MODEL.id,
		usage: usage(),
		stopReason: "stop",
		timestamp: 1,
		...overrides,
	};
}

function replaceSentinel(text: string): string {
	return text.replaceAll(RAW_SENTINEL, REPLACEMENT);
}

function readablePayload(spans: readonly ReadableSpan[]): string {
	return JSON.stringify(
		spans.map(span => ({
			name: span.name,
			attributes: span.attributes,
			status: span.status,
			events: span.events,
			links: span.links,
		})),
	);
}

async function emitEveryTelemetrySurface(captureMessageContent: "none" | "full"): Promise<ReadableSpan[]> {
	const dynamicModel: Model = {
		...MODEL,
		id: `model-id-${RAW_SENTINEL}`,
		name: `model-name-${RAW_SENTINEL}`,
		baseUrl: `https://gateway.invalid/${RAW_SENTINEL}`,
	};
	const telemetry = telemetryFor({
		captureMessageContent,
		textSanitizer: replaceSentinel,
		agent: {
			id: `agent-id-${RAW_SENTINEL}`,
			name: `agent-name-${RAW_SENTINEL}`,
			description: `agent-description-${RAW_SENTINEL}`,
		},
		normalizeProvider: () => `provider-${RAW_SENTINEL}`,
		attributes: {
			[`user.key-${RAW_SENTINEL}`]: `user-value-${RAW_SENTINEL}`,
			"user.roles": [`role-${RAW_SENTINEL}`, `role-two-${RAW_SENTINEL}`],
			"test.number": 73,
			"test.boolean": true,
		},
		resolveAttributes: () => ({
			[`resolved.key-${RAW_SENTINEL}`]: `resolved-value-${RAW_SENTINEL}`,
		}),
		costEstimator: () => ({ unavailable: `cost-unavailable-${RAW_SENTINEL}` }),
		onSpanStart: ({ kind, span }) => {
			span.updateName(`updated-${kind}-${RAW_SENTINEL}`);
			span.setAttributes({
				[`hook.key-${RAW_SENTINEL}`]: `hook-value-${RAW_SENTINEL}`,
			});
			span.addEvent(`event-${RAW_SENTINEL}`, {
				[`event.key-${RAW_SENTINEL}`]: `event-value-${RAW_SENTINEL}`,
			});
			span.addLink({
				context: span.spanContext(),
				attributes: { [`link.key-${RAW_SENTINEL}`]: `link-value-${RAW_SENTINEL}` },
			});
			span.addLinks([
				{
					context: span.spanContext(),
					attributes: { [`links.key-${RAW_SENTINEL}`]: [`links-value-${RAW_SENTINEL}`] },
				},
			]);
		},
		onSpanEnd: ({ span }) => {
			span.setAttributes({
				[OpenAIAttr.RequestServiceTier]: `request-tier-${RAW_SENTINEL}`,
				[OpenAIAttr.ResponseServiceTier]: `response-tier-${RAW_SENTINEL}`,
				[GenAIAttr.ResponseFinishReasons]: [`finish-${RAW_SENTINEL}`],
			});
			span.setStatus({ code: 2, message: `status-${RAW_SENTINEL}` });
			span.recordException({
				code: `exception-code-${RAW_SENTINEL}`,
				name: `exception-name-${RAW_SENTINEL}`,
				message: `exception-message-${RAW_SENTINEL}`,
				stack: `exception-stack-${RAW_SENTINEL}`,
			});
		},
	});

	const invoke = startInvokeAgentSpan(telemetry, dynamicModel);
	const chat = startChatSpan(telemetry, dynamicModel, {
		parent: invoke,
		stepNumber: 3,
		request: {
			maxTokens: 321,
			stopSequences: [`stop-${RAW_SENTINEL}`],
			serviceTier: "priority" as ServiceTier,
			reasoningEffort: `reasoning-${RAW_SENTINEL}`,
			toolChoice: { type: "tool", name: `choice-${RAW_SENTINEL}` } as ToolChoice,
			tools: [{ name: `available-tool-${RAW_SENTINEL}` }],
			systemPrompt: `system-${RAW_SENTINEL}`,
			messages: [{ role: "user", content: `message-${RAW_SENTINEL}`, timestamp: 1 }],
		},
	});
	await finishChatSpan(
		telemetry,
		chat,
		assistant([{ type: "text", text: `response-${RAW_SENTINEL}` }], {
			model: `response-model-${RAW_SENTINEL}`,
			provider: `response-provider-${RAW_SENTINEL}` as AssistantMessage["provider"],
			upstreamProvider: `upstream-${RAW_SENTINEL}`,
			responseId: `response-id-${RAW_SENTINEL}`,
			stopReason: "error",
			errorMessage: `response-error-${RAW_SENTINEL}`,
		}),
		{
			stepNumber: 3,
			serviceTier: "priority" as ServiceTier,
			responseHeaders: {
				"x-litellm-call-id": `gateway-call-${RAW_SENTINEL}`,
				"x-litellm-model-id": `gateway-route-${RAW_SENTINEL}`,
			},
			baseUrl: `https://gateway.invalid/${RAW_SENTINEL}`,
		},
	);

	const tool = startExecuteToolSpan(telemetry, {
		tool: { description: `tool-description-${RAW_SENTINEL}` } as AgentTool,
		toolName: `tool-name-${RAW_SENTINEL}`,
		toolCallId: `tool-call-${RAW_SENTINEL}`,
		args: { [`arg-${RAW_SENTINEL}`]: `arg-value-${RAW_SENTINEL}` },
		parent: invoke,
	});
	const toolError = new Error(`tool-error-message-${RAW_SENTINEL}`);
	toolError.name = `tool-error-name-${RAW_SENTINEL}`;
	toolError.stack = `tool-error-stack-${RAW_SENTINEL}`;
	finishExecuteToolSpan(telemetry, tool, {
		result: { [`result-${RAW_SENTINEL}`]: `result-value-${RAW_SENTINEL}` },
		isError: true,
		errorObject: toolError,
		toolCallId: `tool-call-${RAW_SENTINEL}`,
		toolName: `tool-name-${RAW_SENTINEL}`,
	});

	recordHandoff(telemetry, {
		fromAgent: { id: `from-id-${RAW_SENTINEL}`, name: `from-name-${RAW_SENTINEL}` },
		toAgent: { id: `to-id-${RAW_SENTINEL}`, name: `to-name-${RAW_SENTINEL}` },
		parent: invoke,
		attributes: { [`handoff.key-${RAW_SENTINEL}`]: `handoff-value-${RAW_SENTINEL}` },
	});

	const invokeError = new Error(`invoke-message-${RAW_SENTINEL}`);
	invokeError.name = `invoke-name-${RAW_SENTINEL}`;
	invokeError.stack = `invoke-stack-${RAW_SENTINEL}`;
	finishInvokeAgentSpan(telemetry, invoke, { stepCount: 1, errorObject: invokeError });
	return exporter.getFinishedSpans();
}

describe("telemetry final text sanitizer", () => {
	for (const captureMessageContent of ["none", "full"] as const) {
		it(`sanitizes every outbound string surface with capture ${captureMessageContent}`, async () => {
			const spans = await emitEveryTelemetrySurface(captureMessageContent);
			expect(spans).toHaveLength(4);
			const serialized = readablePayload(spans);
			expect(serialized).not.toContain(RAW_SENTINEL);
			expect(serialized).toContain(REPLACEMENT);

			const chat = spans.find(span => span.attributes[GenAIAttr.OperationName] === "chat") as ReadableSpan;
			expect(chat.name).toContain(REPLACEMENT);
			expect(chat.attributes[GenAIAttr.RequestModel]).toContain(REPLACEMENT);
			expect(chat.attributes[GenAIAttr.ProviderName]).toContain(REPLACEMENT);
			expect(chat.attributes[GenAIAttr.ConversationId]).toContain(REPLACEMENT);
			expect(chat.attributes[GenAIAttr.AgentDescription]).toContain(REPLACEMENT);
			expect(chat.attributes[GenAIAttr.RequestStopSequences]).toEqual([`stop-${REPLACEMENT}`]);
			expect(chat.attributes[PiGenAIAttr.RequestToolChoice]).toContain(REPLACEMENT);
			expect(chat.attributes[OpenAIAttr.RequestServiceTier]).toContain(REPLACEMENT);
			expect(chat.attributes[OpenAIAttr.ResponseServiceTier]).toContain(REPLACEMENT);
			expect(chat.attributes[GenAIAttr.ResponseId]).toContain(REPLACEMENT);
			expect(chat.attributes[GenAIAttr.ResponseFinishReasons]).toEqual([`finish-${REPLACEMENT}`]);
			expect(chat.attributes[PiGenAIAttr.CostUnavailableReason]).toContain(REPLACEMENT);
			expect(chat.attributes[`user.key-${REPLACEMENT}`]).toContain(REPLACEMENT);
			expect(chat.attributes["user.roles"]).toEqual([`role-${REPLACEMENT}`, `role-two-${REPLACEMENT}`]);
			expect(chat.attributes["test.number"]).toBe(73);
			expect(chat.attributes["test.boolean"]).toBe(true);
			expect(chat.attributes[PiGenAIAttr.AgentStepNumber]).toBe(3);
			expect(chat.attributes[GenAIAttr.RequestStream]).toBe(true);
			expect(chat.status.message).toContain(REPLACEMENT);
			expect(chat.events.some(event => event.name.includes(REPLACEMENT))).toBe(true);
			expect(
				chat.events.some(event => event.name === "exception" && JSON.stringify(event).includes(REPLACEMENT)),
			).toBe(true);
			expect(chat.links.some(link => JSON.stringify(link.attributes).includes(REPLACEMENT))).toBe(true);

			const tool = spans.find(span => span.attributes[GenAIAttr.OperationName] === "execute_tool") as ReadableSpan;
			expect(tool.attributes[GenAIAttr.ToolName]).toContain(REPLACEMENT);
			expect(tool.attributes[GenAIAttr.ToolDescription]).toContain(REPLACEMENT);
			const handoff = spans.find(span => span.attributes[GenAIAttr.OperationName] === "handoff") as ReadableSpan;
			expect(handoff.attributes[PiGenAIAttr.HandoffFromAgentName]).toContain(REPLACEMENT);
			expect(handoff.attributes[PiGenAIAttr.HandoffToAgentId]).toContain(REPLACEMENT);

			if (captureMessageContent === "none") {
				for (const span of spans) {
					for (const key of CONTENT_ATTRIBUTES) expect(span.attributes[key]).toBeUndefined();
				}
			} else {
				expect(chat.attributes[GenAIAttr.InputMessages]).toContain(REPLACEMENT);
				expect(chat.attributes[GenAIAttr.OutputMessages]).toContain(REPLACEMENT);
				expect(tool.attributes[GenAIAttr.ToolCallArguments]).toContain(REPLACEMENT);
				expect(tool.attributes[GenAIAttr.ToolCallResult]).toContain(REPLACEMENT);
			}
		});
	}

	it("runs after custom content serializers", async () => {
		const inputs: string[] = [];
		const telemetry = telemetryFor({
			captureMessageContent: "full",
			contentSerializer: {
				requestMessages: () => `request-${RAW_SENTINEL}`,
				responseText: () => `response-${RAW_SENTINEL}`,
				responseToolCalls: () => `calls-${RAW_SENTINEL}`,
				toolCallArguments: () => `arguments-${RAW_SENTINEL}`,
				toolCallResult: () => `result-${RAW_SENTINEL}`,
			},
			textSanitizer: text => {
				inputs.push(text);
				return replaceSentinel(text);
			},
		});
		const chat = startChatSpan(telemetry, MODEL, {
			stepNumber: 0,
			request: { messages: [{ role: "user", content: "clean", timestamp: 1 }] },
		});
		await finishChatSpan(
			telemetry,
			chat,
			assistant([
				{ type: "text", text: "clean" },
				{ type: "toolCall", id: "call", name: "tool", arguments: {} },
			]),
			{ stepNumber: 0 },
		);
		const tool = startExecuteToolSpan(telemetry, {
			tool: undefined,
			toolName: "tool",
			toolCallId: "call",
			args: {},
		});
		finishExecuteToolSpan(telemetry, tool, {
			result: {},
			isError: false,
			toolCallId: "call",
			toolName: "tool",
		});
		const serialized = readablePayload(exporter.getFinishedSpans());
		expect(serialized).not.toContain(RAW_SENTINEL);
		for (const prefix of ["request", "response", "calls", "arguments", "result"]) {
			const rawSerializedValue = `${prefix}-${RAW_SENTINEL}`;
			expect(inputs).toContain(rawSerializedValue);
			expect(serialized).toContain(`${prefix}-${REPLACEMENT}`);
		}
	});

	it("refuses arbitrary sanitized-key collisions and reserved-key generation", async () => {
		const warnings: AgentTelemetryWarning[] = [];
		const telemetry = telemetryFor({
			captureMessageContent: "none",
			attributes: {
				[`collision-a-${RAW_SENTINEL}`]: `first-${RAW_SENTINEL}`,
				[`collision-b-${RAW_SENTINEL}`]: `second-${RAW_SENTINEL}`,
				[`reserved-${RAW_SENTINEL}`]: `reserved-value-${RAW_SENTINEL}`,
			},
			textSanitizer: text => {
				if (text.startsWith("collision-")) return "same.sanitized.key";
				if (text.startsWith("reserved-")) return GenAIAttr.RequestModel;
				return replaceSentinel(text);
			},
			onTelemetryWarning: warning => warnings.push(warning),
		});
		const span = startChatSpan(telemetry, MODEL, { stepNumber: 1, request: {} });
		await finishChatSpan(telemetry, span, assistant([]), { stepNumber: 1 });
		const readable = exporter.getFinishedSpans()[0] as ReadableSpan;
		expect(readable.attributes["same.sanitized.key"]).toBeUndefined();
		expect(readable.attributes[GenAIAttr.RequestModel]).toBe(MODEL.id);
		expect(warnings).toHaveLength(2);
		expect(warnings.every(warning => warning.code === "text_sanitizer_key_collision")).toBe(true);
		expect(warnings.every(warning => warning.error === undefined)).toBe(true);
		expect(JSON.stringify(warnings)).not.toContain(RAW_SENTINEL);
	});

	it("fails closed for names, status, exceptions, and attributes with fixed warnings only", async () => {
		const warnings: AgentTelemetryWarning[] = [];
		const dynamicModel: Model = { ...MODEL, id: `model-${RAW_SENTINEL}` };
		const telemetry = telemetryFor({
			captureMessageContent: "none",
			textSanitizer: text => {
				if (text.includes(RAW_SENTINEL)) throw new Error(`sanitizer-error-${RAW_SENTINEL}`);
				return text;
			},
			onTelemetryWarning: warning => warnings.push(warning),
			onSpanStart: ({ span }) => {
				span.setAttributes({
					[`secret-key-${RAW_SENTINEL}`]: "clean",
					"clean.value": `secret-value-${RAW_SENTINEL}`,
				});
				span.addEvent(`secret-event-${RAW_SENTINEL}`);
				span.setStatus({ code: 2, message: `secret-status-${RAW_SENTINEL}` });
				span.recordException({
					name: `secret-name-${RAW_SENTINEL}`,
					message: `secret-message-${RAW_SENTINEL}`,
					stack: `secret-stack-${RAW_SENTINEL}`,
				});
			},
		});
		const span = startChatSpan(telemetry, dynamicModel, {
			stepNumber: 9,
			request: { seed: 7, maxTokens: 99 },
		});
		await finishChatSpan(telemetry, span, assistant([], { model: "clean-response-model" }), { stepNumber: 9 });

		const readable = exporter.getFinishedSpans()[0] as ReadableSpan;
		expect(readable.name).toBe("chat");
		expect(readable.attributes[GenAIAttr.RequestModel]).toBeUndefined();
		expect(readable.attributes["clean.value"]).toBeUndefined();
		expect(readable.attributes[GenAIAttr.RequestSeed]).toBe(7);
		expect(readable.attributes[GenAIAttr.RequestMaxTokens]).toBe(99);
		expect(readable.attributes[GenAIAttr.RequestStream]).toBe(true);
		expect(readable.attributes[PiGenAIAttr.AgentStepNumber]).toBe(9);
		expect(readable.status).toEqual({ code: 2 });
		expect(readable.events).toHaveLength(0);
		expect(readablePayload([readable])).not.toContain(RAW_SENTINEL);
		expect(warnings.length).toBeGreaterThanOrEqual(6);
		expect(warnings.every(warning => warning.code === "text_sanitizer_failed")).toBe(true);
		expect(
			warnings.every(warning => warning.message === "textSanitizer threw; omitting dynamic telemetry text"),
		).toBe(true);
		expect(warnings.every(warning => warning.error === undefined)).toBe(true);
		expect(JSON.stringify(warnings)).not.toContain(RAW_SENTINEL);
		expect(JSON.stringify(warnings)).not.toContain("sanitizer-error");
	});

	it("queues only sanitized readable bytes for an exporter retry", async () => {
		class RetryingFakeExporter extends InMemorySpanExporter {
			readonly transmissions: string[] = [];

			override export(spans: ReadableSpan[], resultCallback: Parameters<InMemorySpanExporter["export"]>[1]): void {
				const queuedBytes = readablePayload(spans);
				this.transmissions.push(queuedBytes, queuedBytes);
				super.export(spans, resultCallback);
			}
		}

		await provider.shutdown();
		const retryingExporter = new RetryingFakeExporter();
		exporter = retryingExporter;
		provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(retryingExporter)] });
		const telemetry = telemetryFor({
			captureMessageContent: "none",
			textSanitizer: replaceSentinel,
			onSpanStart: ({ span }) => span.addEvent(`retry-event-${RAW_SENTINEL}`),
		});
		const span = startChatSpan(
			telemetry,
			{ ...MODEL, id: `retry-model-${RAW_SENTINEL}` },
			{
				stepNumber: 0,
				request: {},
			},
		);
		await finishChatSpan(telemetry, span, assistant([], { responseId: `retry-id-${RAW_SENTINEL}` }), {
			stepNumber: 0,
		});

		expect(retryingExporter.transmissions).toHaveLength(2);
		expect(retryingExporter.transmissions[1]).toBe(retryingExporter.transmissions[0]);
		for (const transmission of retryingExporter.transmissions) {
			expect(transmission).not.toContain(RAW_SENTINEL);
			expect(transmission).toContain(REPLACEMENT);
		}
	});

	it("does not call a sanitizer when telemetry is disabled", async () => {
		let sanitizerCalls = 0;
		const unusedConfig: AgentTelemetryConfig = {
			textSanitizer: text => {
				sanitizerCalls++;
				return text;
			},
		};
		expect(unusedConfig.textSanitizer).toBeDefined();
		const telemetry = resolveTelemetry(undefined, `session-${RAW_SENTINEL}`);
		expect(telemetry).toBeUndefined();
		expect(
			startChatSpan(telemetry, { ...MODEL, id: `model-${RAW_SENTINEL}` }, { stepNumber: 0, request: {} }),
		).toBeUndefined();
		recordHandoff(telemetry, {
			fromAgent: undefined,
			toAgent: { name: `agent-${RAW_SENTINEL}` },
		});
		expect(
			await recordManualChatTelemetry(telemetry, {
				model: { ...MODEL, id: `manual-${RAW_SENTINEL}` },
				responseText: RAW_SENTINEL,
			}),
		).toBeUndefined();
		expect(sanitizerCalls).toBe(0);
	});
});
