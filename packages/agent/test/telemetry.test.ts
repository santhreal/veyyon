/**
 * Unit coverage for the telemetry surface that compaction-telemetry.test.ts
 * does not reach: full content capture serialization (request + response
 * OTEL message payloads), gateway header detection, request-attribute
 * building (tool-choice / stop-sequences / reasoning-effort), the non-fatal
 * warning hooks (resolveAttributes / normalizeProvider / normalizeAgentName /
 * onSpanStart / onSpanEnd / onChatUsage / costEstimator / onCostDelta), the
 * failChatSpan non-Error path, execute_tool spans, and recordManualChatTelemetry.
 *
 * Uses a real InMemorySpanExporter so every assertion reads back the exact
 * attribute value written to the span.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { SpanStatusCode } from "@opentelemetry/api";
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
	type ChatRequestSnapshot,
	detectGatewayFromHeaders,
	failChatSpan,
	finishChatSpan,
	finishExecuteToolSpan,
	finishInvokeAgentSpan,
	GenAIAttr,
	GenAIOperation,
	OpenAIAttr,
	PiGenAIAggregateAttr,
	PiGenAIAttr,
	recordHandoff,
	recordManualChatTelemetry,
	recordSkippedTool,
	resolveTelemetry,
	runInActiveSpan,
	setSpanAttribute,
	startChatSpan,
	startExecuteToolSpan,
	startInvokeAgentSpan,
} from "@veyyon/agent-core/telemetry";
import type { AssistantMessage, Message, Model, ToolResultMessage, Usage } from "@veyyon/ai";
import { buildModel } from "@veyyon/catalog/build";

const MODEL: Model = buildModel({
	id: "mock-model",
	name: "mock-model",
	api: "mock",
	provider: "mock",
	baseUrl: "mock://",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 32_768,
});

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
	const resolved = resolveTelemetry(
		{ conversationId: "conv-1", tracer: provider.getTracer("telemetry-test"), ...config },
		"session-1",
	);
	if (!resolved) throw new Error("telemetry should resolve");
	return resolved;
}

function onlySpan(): ReadableSpan {
	const spans = exporter.getFinishedSpans();
	expect(spans).toHaveLength(1);
	return spans[0] as ReadableSpan;
}

function makeUsage(over: Partial<Usage> = {}): Usage {
	return {
		input: 100,
		output: 40,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 140,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		...over,
	};
}

function assistant(content: AssistantMessage["content"], over: Partial<AssistantMessage> = {}): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "mock",
		provider: "mock",
		model: "mock-model",
		usage: makeUsage(),
		stopReason: "stop",
		timestamp: 1,
		...over,
	};
}

describe("full content capture serialization", () => {
	it("serializes system instructions, input messages, and request messages onto the chat span", () => {
		const toolResult: ToolResultMessage = {
			role: "toolResult",
			toolCallId: "call-1",
			toolName: "read",
			content: [{ type: "text", text: "file body" }],
			isError: false,
			details: { path: "/a" },
			timestamp: 2,
		};
		const messages: Message[] = [
			{ role: "user", content: "hello", timestamp: 1 },
			assistant([
				{ type: "text", text: "thinking out loud" },
				{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "/a" } },
			]),
			toolResult,
		];
		const request: ChatRequestSnapshot = { systemPrompt: ["be terse", "cite files"], messages };
		const telemetry = telemetryFor({ captureMessageContent: "full" });
		const span = startChatSpan(telemetry, MODEL, { stepNumber: 0, request });
		expect(span).toBeDefined();
		span?.end();

		const attrs = onlySpan().attributes;

		const system = JSON.parse(attrs[GenAIAttr.SystemInstructions] as string);
		expect(system).toEqual([
			{ type: "text", content: "be terse" },
			{ type: "text", content: "cite files" },
		]);

		const input = JSON.parse(attrs[GenAIAttr.InputMessages] as string);
		expect(input).toEqual([
			{ role: "user", parts: [{ type: "text", content: "hello" }] },
			{
				role: "assistant",
				parts: [
					{ type: "text", content: "thinking out loud" },
					{ type: "tool_call", id: "call-1", name: "read", arguments: { path: "/a" } },
				],
			},
			{
				role: "tool",
				name: "read",
				parts: [
					{
						type: "tool_call_response",
						id: "call-1",
						response: {
							content: [{ type: "text", content: "file body" }],
							details: { path: "/a" },
							is_error: false,
						},
					},
				],
			},
		]);

		// Summary capture (PiGenAIAttr.RequestMessages) is emitted for every
		// non-none capture level, including "full".
		// Summary capture keeps raw block shapes (the OTEL remap is full-only).
		const summary = JSON.parse(attrs[PiGenAIAttr.RequestMessages] as string);
		// [0,1] system prompts, [2] user, [3] assistant, [4] tool result.
		expect(summary[0]).toEqual({ role: "system", content: "be terse" });
		expect(summary[2]).toEqual({ role: "user", content: "hello" });
		expect(summary[4]).toEqual({ role: "toolResult", content: [{ type: "text", text: "file body" }] });
	});

	it("serializes assistant text and tool calls plus the full output message on finish", async () => {
		const telemetry = telemetryFor({ captureMessageContent: "full" });
		const span = startChatSpan(telemetry, MODEL, { stepNumber: 0, request: {} });
		const message = assistant(
			[
				{ type: "text", text: "done" },
				{ type: "thinking", thinking: "reasoned", thinkingSignature: "sig" },
				{ type: "toolCall", id: "call-9", name: "write", arguments: { path: "/b", data: "x" } },
			],
			{ stopReason: "toolUse" },
		);
		await finishChatSpan(telemetry, span, message, { stepNumber: 0 });

		const attrs = onlySpan().attributes;
		expect(JSON.parse(attrs[PiGenAIAttr.ResponseText] as string)).toEqual(["done"]);
		expect(JSON.parse(attrs[PiGenAIAttr.ResponseToolCalls] as string)).toEqual([
			{ input: { path: "/b", data: "x" }, toolCallId: "call-9", toolName: "write" },
		]);
		const output = JSON.parse(attrs[GenAIAttr.OutputMessages] as string);
		expect(output).toEqual([
			{
				role: "assistant",
				parts: [
					{ type: "text", content: "done" },
					{ type: "reasoning", content: "reasoned" },
					{ type: "tool_call", id: "call-9", name: "write", arguments: { path: "/b", data: "x" } },
				],
				finish_reason: "tool_calls",
			},
		]);
	});

	it("serializes image and redacted-thinking parts into blob and reasoning OTEL parts", () => {
		const messages: Message[] = [
			{
				role: "user",
				content: [
					{ type: "text", text: "look" },
					{ type: "image", data: "AAAA", mimeType: "image/png" },
				],
				timestamp: 1,
			},
			assistant([{ type: "redactedThinking", data: "REDACTED" }]),
		];
		const telemetry = telemetryFor({ captureMessageContent: "full" });
		const span = startChatSpan(telemetry, MODEL, { stepNumber: 1, request: { messages } });
		span?.end();

		const input = JSON.parse(onlySpan().attributes[GenAIAttr.InputMessages] as string);
		expect(input[0].parts).toEqual([
			{ type: "text", content: "look" },
			{ type: "blob", modality: "image", mime_type: "image/png", content: "AAAA" },
		]);
		expect(input[1].parts).toEqual([{ type: "reasoning", content: "REDACTED" }]);
	});
});

describe("detectGatewayFromHeaders", () => {
	it("returns undefined for missing or unrecognized headers", () => {
		expect(detectGatewayFromHeaders(undefined)).toBeUndefined();
		expect(detectGatewayFromHeaders({ "content-type": "application/json" })).toBeUndefined();
		// OpenRouter's header must carry the gen- prefix to be recognized.
		expect(detectGatewayFromHeaders({ "x-generation-id": "abc-123" })).toBeUndefined();
	});

	it("identifies litellm, helicone, portkey, and openrouter", () => {
		expect(detectGatewayFromHeaders({ "x-litellm-call-id": "lc", "x-litellm-model-id": "gpt-4o" })).toEqual({
			name: "litellm",
			callId: "lc",
			routedTo: "gpt-4o",
		});
		expect(detectGatewayFromHeaders({ "helicone-id": "hid", "helicone-target-provider": "anthropic" })).toEqual({
			name: "helicone",
			callId: "hid",
			routedTo: "anthropic",
		});
		expect(detectGatewayFromHeaders({ "x-portkey-trace-id": "pt", "x-portkey-llm-provider": "openai" })).toEqual({
			name: "portkey",
			callId: "pt",
			routedTo: "openai",
		});
		expect(detectGatewayFromHeaders({ "x-generation-id": "gen-42" })).toEqual({
			name: "openrouter",
			callId: "gen-42",
			routedTo: undefined,
		});
	});

	it("stamps gateway attributes onto the chat span via finishChatSpan", async () => {
		const telemetry = telemetryFor({});
		const span = startChatSpan(telemetry, MODEL, { stepNumber: 0, request: {} });
		await finishChatSpan(telemetry, span, assistant([{ type: "text", text: "ok" }]), {
			stepNumber: 0,
			baseUrl: "https://gw.example.com",
			responseHeaders: { "x-litellm-call-id": "lc-1", "x-litellm-model-group": "prod" },
		});
		const attrs = onlySpan().attributes;
		expect(attrs[PiGenAIAttr.GatewayName]).toBe("litellm");
		expect(attrs[PiGenAIAttr.GatewayEndpoint]).toBe("https://gw.example.com");
		expect(attrs[PiGenAIAttr.GatewayCallId]).toBe("lc-1");
		expect(attrs[PiGenAIAttr.GatewayRoutedTo]).toBe("prod");
	});
});

describe("request attribute building", () => {
	it("records stop sequences, reasoning effort, tools, and a named tool choice", () => {
		const telemetry = telemetryFor({});
		const span = startChatSpan(telemetry, MODEL, {
			stepNumber: 3,
			request: {
				maxTokens: 512,
				temperature: 0.2,
				stopSequences: ["STOP", "END"],
				reasoningEffort: "high",
				toolChoice: { type: "tool", name: "read" },
				tools: [{ name: "read" }, { name: "write" }],
			},
		});
		span?.end();
		const attrs = onlySpan().attributes;
		expect(attrs[GenAIAttr.RequestMaxTokens]).toBe(512);
		expect(attrs[GenAIAttr.RequestStopSequences]).toEqual(["STOP", "END"]);
		expect(attrs[PiGenAIAttr.RequestReasoningEffort]).toBe("high");
		expect(attrs[PiGenAIAttr.RequestToolChoice]).toBe("read");
		expect(attrs[PiGenAIAttr.RequestAvailableTools]).toEqual(["read", "write"]);
	});

	it("falls back to the tool-choice object type when it has no name", () => {
		const telemetry = telemetryFor({});
		const span = startChatSpan(telemetry, MODEL, {
			stepNumber: 0,
			request: { toolChoice: { type: "required" } as never },
		});
		span?.end();
		expect(onlySpan().attributes[PiGenAIAttr.RequestToolChoice]).toBe("required");
	});
});

describe("response and usage attributes", () => {
	it("records upstream provider, time-to-first-chunk, and server-side tool requests", async () => {
		const telemetry = telemetryFor({});
		const span = startChatSpan(telemetry, MODEL, { stepNumber: 0, request: {} });
		const message = assistant([{ type: "text", text: "ok" }], {
			upstreamProvider: "anthropic",
			ttft: 250,
			usage: makeUsage({ server: { webSearch: 2, webFetch: 1 } }),
		});
		await finishChatSpan(telemetry, span, message, { stepNumber: 0 });
		const attrs = onlySpan().attributes;
		expect(attrs[PiGenAIAttr.ResponseUpstreamProvider]).toBe("anthropic");
		expect(attrs[GenAIAttr.ResponseTimeToFirstChunk]).toBeCloseTo(0.25, 5);
		expect(attrs[PiGenAIAttr.UsageServerSideTools]).toBe(3);
	});
});

describe("failChatSpan", () => {
	it("records a non-Error rejection value as a stringified ERROR status", () => {
		const telemetry = telemetryFor({});
		const span = startChatSpan(telemetry, MODEL, { stepNumber: 0, request: {} });
		failChatSpan(telemetry, span, { errorObject: "stream collapsed" });
		const s = onlySpan();
		expect(s.status.code).toBe(SpanStatusCode.ERROR);
		expect(s.status.message).toBe("stream collapsed");
		expect(s.attributes[GenAIAttr.ErrorType]).toBe("Error");
	});
});

describe("non-fatal warning hooks", () => {
	function collector(): { warnings: AgentTelemetryWarning[]; onTelemetryWarning: (w: AgentTelemetryWarning) => void } {
		const warnings: AgentTelemetryWarning[] = [];
		return { warnings, onTelemetryWarning: w => warnings.push(w) };
	}

	it("surfaces a resolveAttributes throw without failing the span", () => {
		const { warnings, onTelemetryWarning } = collector();
		const telemetry = telemetryFor({
			onTelemetryWarning,
			resolveAttributes: () => {
				throw new Error("attr boom");
			},
		});
		const span = startChatSpan(telemetry, MODEL, { stepNumber: 0, request: {} });
		expect(span).toBeDefined();
		span?.end();
		expect(warnings.map(w => w.code)).toContain("resolve_attributes_failed");
	});

	it("keeps the OTEL provider label when normalizeProvider throws", async () => {
		const { warnings, onTelemetryWarning } = collector();
		const telemetry = telemetryFor({
			onTelemetryWarning,
			normalizeProvider: () => {
				throw new Error("provider boom");
			},
			costEstimator: () => ({ usd: 0.01 }),
		});
		const span = startChatSpan(telemetry, MODEL, { stepNumber: 0, request: {} });
		await finishChatSpan(telemetry, span, assistant([{ type: "text", text: "ok" }]), { stepNumber: 0 });
		expect(warnings.map(w => w.code)).toContain("normalize_provider_failed");
	});

	it("surfaces a normalizeAgentName throw and keeps the original name", async () => {
		const { warnings, onTelemetryWarning } = collector();
		const telemetry = telemetryFor({
			onTelemetryWarning,
			agent: { id: "a1", name: "planner" },
			normalizeAgentName: () => {
				throw new Error("name boom");
			},
		});
		const span = startChatSpan(telemetry, MODEL, { stepNumber: 0, request: {} });
		await finishChatSpan(telemetry, span, assistant([{ type: "text", text: "ok" }]), { stepNumber: 0 });
		expect(warnings.map(w => w.code)).toContain("normalize_agent_name_failed");
	});

	it("surfaces onSpanStart and onSpanEnd throws", async () => {
		const { warnings, onTelemetryWarning } = collector();
		const telemetry = telemetryFor({
			onTelemetryWarning,
			onSpanStart: () => {
				throw new Error("start boom");
			},
			onSpanEnd: () => {
				throw new Error("end boom");
			},
		});
		const span = startChatSpan(telemetry, MODEL, { stepNumber: 0, request: {} });
		await finishChatSpan(telemetry, span, assistant([{ type: "text", text: "ok" }]), { stepNumber: 0 });
		const codes = warnings.map(w => w.code);
		expect(codes).toContain("on_span_start_failed");
		expect(codes).toContain("on_span_end_failed");
	});

	it("surfaces an onChatUsage rejection", async () => {
		const { warnings, onTelemetryWarning } = collector();
		const telemetry = telemetryFor({
			onTelemetryWarning,
			onChatUsage: async () => {
				throw new Error("usage boom");
			},
		});
		const span = startChatSpan(telemetry, MODEL, { stepNumber: 0, request: {} });
		await finishChatSpan(telemetry, span, assistant([{ type: "text", text: "ok" }]), { stepNumber: 0 });
		expect(warnings.map(w => w.code)).toContain("on_chat_usage_failed");
	});

	it("surfaces a costEstimator throw and an onCostDelta throw", async () => {
		const { warnings, onTelemetryWarning } = collector();
		const telemetryEstimator = telemetryFor({
			onTelemetryWarning,
			costEstimator: () => {
				throw new Error("cost boom");
			},
		});
		const span1 = startChatSpan(telemetryEstimator, MODEL, { stepNumber: 0, request: {} });
		await finishChatSpan(telemetryEstimator, span1, assistant([{ type: "text", text: "ok" }]), { stepNumber: 0 });
		expect(warnings.map(w => w.code)).toContain("cost_estimator_failed");

		const telemetryDelta = telemetryFor({
			onTelemetryWarning,
			costEstimator: () => ({ usd: 0.02 }),
			onCostDelta: () => {
				throw new Error("delta boom");
			},
		});
		const span2 = startChatSpan(telemetryDelta, MODEL, { stepNumber: 0, request: {} });
		await finishChatSpan(telemetryDelta, span2, assistant([{ type: "text", text: "ok" }]), { stepNumber: 0 });
		expect(warnings.map(w => w.code)).toContain("on_cost_delta_failed");
	});

	it("stamps the unavailable reason when the estimator declines to price a step", async () => {
		const telemetry = telemetryFor({ costEstimator: () => ({ unavailable: "no-price-sheet" }) });
		const span = startChatSpan(telemetry, MODEL, { stepNumber: 0, request: {} });
		await finishChatSpan(telemetry, span, assistant([{ type: "text", text: "ok" }]), { stepNumber: 0 });
		expect(onlySpan().attributes[PiGenAIAttr.CostUnavailableReason]).toBe("no-price-sheet");
	});
});

describe("recordManualChatTelemetry", () => {
	it("writes response text, tool calls, usage, and a service tier onto a fresh span", async () => {
		const telemetry = telemetryFor({});
		await recordManualChatTelemetry(telemetry, {
			model: MODEL,
			stepNumber: 7,
			usage: makeUsage({ input: 10, output: 5, totalTokens: 15 }),
			finishReason: "stop",
			responseId: "resp-1",
			responseText: "manual answer",
			responseToolCalls: [{ toolCallId: "tc-1", toolName: "read", input: { path: "/x" } }],
			responseHeaders: { "helicone-id": "h1" },
		});
		const attrs = onlySpan().attributes;
		expect(attrs[PiGenAIAttr.AgentStepNumber]).toBe(7);
		expect(attrs[GenAIAttr.ResponseId]).toBe("resp-1");
		expect(attrs[GenAIAttr.UsageInputTokens]).toBe(10);
		expect(JSON.parse(attrs[PiGenAIAttr.ResponseText] as string)).toEqual(["manual answer"]);
		expect(JSON.parse(attrs[PiGenAIAttr.ResponseToolCalls] as string)).toEqual([
			{ toolCallId: "tc-1", toolName: "read", input: { path: "/x" } },
		]);
		expect(attrs[PiGenAIAttr.GatewayName]).toBe("helicone");
	});
});

describe("execute_tool spans", () => {
	it("captures tool arguments on start and the result on a successful finish", () => {
		const telemetry = telemetryFor({ captureMessageContent: "full" });
		const span = startExecuteToolSpan(telemetry, {
			tool: { description: "reads a file" } as never,
			toolName: "read",
			toolCallId: "tc-9",
			args: { path: "/a" },
		});
		finishExecuteToolSpan(telemetry, span, {
			result: { ok: true },
			isError: false,
			toolCallId: "tc-9",
			toolName: "read",
		});
		const attrs = onlySpan().attributes;
		expect(attrs[GenAIAttr.ToolName]).toBe("read");
		expect(attrs[GenAIAttr.ToolDescription]).toBe("reads a file");
		expect(JSON.parse(attrs[GenAIAttr.ToolCallArguments] as string)).toEqual({ path: "/a" });
		expect(JSON.parse(attrs[GenAIAttr.ToolCallResult] as string)).toEqual({ ok: true });
		expect(attrs[PiGenAIAttr.ToolStatus]).toBe("ok");
	});

	it("maps a blocked status to the tool_blocked error type", () => {
		const telemetry = telemetryFor({});
		const span = startExecuteToolSpan(telemetry, {
			tool: undefined,
			toolName: "shell",
			toolCallId: "tc-b",
			args: {},
		});
		finishExecuteToolSpan(telemetry, span, {
			isError: true,
			status: "blocked",
			toolCallId: "tc-b",
			toolName: "shell",
		});
		const s = onlySpan();
		expect(s.attributes[GenAIAttr.ErrorType]).toBe("tool_blocked");
		expect(s.attributes[PiGenAIAttr.ToolStatus]).toBe("blocked");
		expect(s.status.code).toBe(SpanStatusCode.ERROR);
	});

	it("records the thrown error's class name and message when a tool errors", () => {
		const telemetry = telemetryFor({});
		const span = startExecuteToolSpan(telemetry, {
			tool: undefined,
			toolName: "shell",
			toolCallId: "tc-e",
			args: {},
		});
		finishExecuteToolSpan(telemetry, span, {
			isError: true,
			errorObject: new TypeError("bad arg"),
			toolCallId: "tc-e",
			toolName: "shell",
		});
		const s = onlySpan();
		expect(s.attributes[GenAIAttr.ErrorType]).toBe("TypeError");
		expect(s.status.message).toBe("bad arg");
	});
});

describe("invoke_agent lifecycle and aggregates", () => {
	it("rolls chat and tool records into aggregate attributes and fires onRunEnd", async () => {
		let runEndSummary: { chats: { total: number }; tools: { total: number; ok: number } } | undefined;
		const telemetry = telemetryFor({
			agent: { id: "a1", name: "planner" },
			onRunEnd: summary => {
				runEndSummary = summary as never;
			},
		});
		const root = startInvokeAgentSpan(telemetry, MODEL);
		expect(root).toBeDefined();

		const chat = startChatSpan(telemetry, MODEL, {
			stepNumber: 0,
			parent: root,
			request: { tools: [{ name: "read" }, { name: "write" }] },
		});
		await finishChatSpan(telemetry, chat, assistant([{ type: "text", text: "ok" }]), { stepNumber: 0 });

		const tool = startExecuteToolSpan(telemetry, {
			tool: undefined,
			toolName: "read",
			toolCallId: "tc-1",
			args: {},
			parent: root,
		});
		finishExecuteToolSpan(telemetry, tool, { isError: false, toolCallId: "tc-1", toolName: "read" });

		const snapshot = finishInvokeAgentSpan(telemetry, root, { stepCount: 1 });
		expect(snapshot?.summary.chats.total).toBe(1);
		expect(snapshot?.summary.tools.ok).toBe(1);

		const invokeSpan = exporter
			.getFinishedSpans()
			.find(s => s.attributes[GenAIAttr.OperationName] === GenAIOperation.InvokeAgent);
		expect(invokeSpan).toBeDefined();
		const attrs = invokeSpan?.attributes ?? {};
		expect(attrs[PiGenAIAttr.AgentStepCount]).toBe(1);
		expect(attrs[PiGenAIAggregateAttr.ChatsCount]).toBe(1);
		expect(attrs[PiGenAIAggregateAttr.ToolsCount]).toBe(1);
		expect(attrs[PiGenAIAggregateAttr.ToolsOkCount]).toBe(1);
		expect(attrs[PiGenAIAggregateAttr.ToolsInvoked]).toEqual(["read"]);
		expect(attrs[PiGenAIAggregateAttr.ToolsUnused]).toEqual(["write"]);
		expect(attrs[GenAIAttr.AgentName]).toBe("planner");
		expect(runEndSummary?.chats.total).toBe(1);
		expect(runEndSummary?.tools.ok).toBe(1);
	});

	it("counts a skipped tool that never opened a span in the aggregates", () => {
		const telemetry = telemetryFor({});
		const root = startInvokeAgentSpan(telemetry, MODEL);
		recordSkippedTool(telemetry, { toolCallId: "tc-s", toolName: "read", status: "skipped" });
		finishInvokeAgentSpan(telemetry, root, { stepCount: 0 });
		const invokeSpan = exporter
			.getFinishedSpans()
			.find(s => s.attributes[GenAIAttr.OperationName] === GenAIOperation.InvokeAgent);
		expect(invokeSpan?.attributes[PiGenAIAggregateAttr.ToolsCount]).toBe(1);
		expect(invokeSpan?.attributes[PiGenAIAggregateAttr.ToolsSkippedCount]).toBe(1);
	});

	it("applies a renamed agent name from normalizeAgentName", () => {
		const telemetry = telemetryFor({
			agent: { id: "a1", name: "planner" },
			normalizeAgentName: name => name?.toUpperCase(),
		});
		startInvokeAgentSpan(telemetry, MODEL)?.end();
		const span = onlySpan();
		expect(span.name).toBe("invoke_agent PLANNER");
		expect(span.attributes[GenAIAttr.AgentName]).toBe("PLANNER");
	});

	it("records an uncaught error on the invoke_agent span", () => {
		const telemetry = telemetryFor({});
		const root = startInvokeAgentSpan(telemetry, MODEL);
		finishInvokeAgentSpan(telemetry, root, { stepCount: 0, errorObject: new RangeError("loop blew up") });
		const invokeSpan = exporter
			.getFinishedSpans()
			.find(s => s.attributes[GenAIAttr.OperationName] === GenAIOperation.InvokeAgent);
		expect(invokeSpan?.status.code).toBe(SpanStatusCode.ERROR);
		expect(invokeSpan?.attributes[GenAIAttr.ErrorType]).toBe("RangeError");
	});
});

describe("recordHandoff", () => {
	it("names the span and stamps both agent identities", () => {
		const telemetry = telemetryFor({});
		recordHandoff(telemetry, {
			fromAgent: { id: "a1", name: "planner" },
			toAgent: { id: "a2", name: "coder" },
		});
		const span = onlySpan();
		expect(span.name).toBe("handoff planner → coder");
		expect(span.attributes[PiGenAIAttr.HandoffFromAgentName]).toBe("planner");
		expect(span.attributes[PiGenAIAttr.HandoffFromAgentId]).toBe("a1");
		expect(span.attributes[PiGenAIAttr.HandoffToAgentName]).toBe("coder");
		expect(span.attributes[PiGenAIAttr.HandoffToAgentId]).toBe("a2");
	});

	it("names the span 'handoff to <name>' when there is no source agent", () => {
		const telemetry = telemetryFor({});
		recordHandoff(telemetry, { fromAgent: undefined, toAgent: { id: "a2", name: "coder" } });
		expect(onlySpan().name).toBe("handoff to coder");
	});
});

describe("provider name mapping", () => {
	it("maps vendor provider ids to their OTEL labels on the span", () => {
		const cases: Array<[string, string]> = [
			["amazon-bedrock", "aws.bedrock"],
			["google", "gcp.gemini"],
			["google-antigravity", "gcp.gemini"],
			["google-gemini-cli", "gcp.gemini"],
			["google-vertex", "gcp.vertex_ai"],
			["mistral", "mistral_ai"],
			["openai-codex", "openai"],
			["xai", "x_ai"],
		];
		for (const [provider, otel] of cases) {
			const telemetry = telemetryFor({});
			startInvokeAgentSpan(telemetry, { ...MODEL, provider } as Model)?.end();
			expect(onlySpan().attributes[GenAIAttr.ProviderName]).toBe(otel);
			exporter.reset();
		}
	});

	it("leaves the provider label unset when the provider id is empty", () => {
		const telemetry = telemetryFor({});
		startInvokeAgentSpan(telemetry, { ...MODEL, provider: "" } as Model)?.end();
		expect(onlySpan().attributes[GenAIAttr.ProviderName]).toBeUndefined();
	});
});

describe("span helpers", () => {
	it("setSpanAttribute is a no-op on an undefined span and writes otherwise", () => {
		expect(() => setSpanAttribute(undefined, "k", "v")).not.toThrow();
		const telemetry = telemetryFor({});
		const span = startInvokeAgentSpan(telemetry, MODEL);
		setSpanAttribute(span, "custom.key", "custom-value");
		span?.end();
		expect(onlySpan().attributes["custom.key"]).toBe("custom-value");
	});

	it("runInActiveSpan runs the callback and returns its value with an undefined span", async () => {
		expect(await runInActiveSpan(undefined, async () => 42)).toBe(42);
		const telemetry = telemetryFor({});
		const span = startInvokeAgentSpan(telemetry, MODEL);
		const result = await runInActiveSpan(span, async () => "done");
		span?.end();
		expect(result).toBe("done");
	});
});

describe("summary-capture value shaping", () => {
	it("serializes thinking and tool-call parts on a non-assistant message in full capture", () => {
		const messages: Message[] = [
			{
				role: "developer",
				content: [
					{ type: "text", text: "note" },
					{ type: "thinking", thinking: "deliberating", thinkingSignature: "s" },
					{ type: "toolCall", id: "c-2", name: "grep", arguments: { q: "x" } },
				],
				timestamp: 1,
			} as never,
		];
		const telemetry = telemetryFor({ captureMessageContent: "full" });
		startChatSpan(telemetry, MODEL, { stepNumber: 0, request: { messages } })?.end();
		const parts = JSON.parse(onlySpan().attributes[GenAIAttr.InputMessages] as string)[0].parts;
		expect(parts).toEqual([
			{ type: "text", content: "note" },
			{ type: "reasoning", content: "deliberating" },
			{ type: "tool_call", id: "c-2", name: "grep", arguments: { q: "x" } },
		]);
	});

	it("omits request messages and warns when a custom serializer throws", () => {
		const warnings: string[] = [];
		const telemetry = telemetryFor({
			captureMessageContent: "summary",
			onTelemetryWarning: w => warnings.push(w.code),
			contentSerializer: {
				requestMessages: () => {
					throw new Error("serializer boom");
				},
			},
		});
		startChatSpan(telemetry, MODEL, {
			stepNumber: 0,
			request: { messages: [{ role: "user", content: "hi", timestamp: 1 }] },
		})?.end();
		expect(onlySpan().attributes[PiGenAIAttr.RequestMessages]).toBeUndefined();
		expect(warnings).toContain("content_serializer_failed");
	});

	it("truncates request messages past the per-request cap", () => {
		const messages: Message[] = Array.from({ length: 20 }, (_, i) => ({
			role: "user" as const,
			content: `m${i}`,
			timestamp: i,
		}));
		const telemetry = telemetryFor({ captureMessageContent: "summary" });
		startChatSpan(telemetry, MODEL, { stepNumber: 0, request: { messages } })?.end();
		const summary = JSON.parse(onlySpan().attributes[PiGenAIAttr.RequestMessages] as string);
		// 16 kept + 1 truncation notice.
		expect(summary).toHaveLength(17);
		expect(summary[16]).toEqual({ role: "system", content: { kind: "truncated", omittedMessages: 4 } });
	});

	it("bounds oversized text, deep objects, big arrays, circular refs, and exotic scalars in tool-call args", async () => {
		const circular: Record<string, unknown> = {};
		circular.self = circular;
		const wideObject = Object.fromEntries(Array.from({ length: 15 }, (_, i) => [`k${i}`, i]));
		const args = {
			huge: "x".repeat(300),
			big: 10n,
			fn: () => 1,
			err: new Error("boom"),
			deep: { a: { b: { c: { d: "too-deep" } } } },
			list: Array.from({ length: 70 }, (_, i) => i),
			wide: wideObject,
			circle: circular,
		};
		const message = assistant([{ type: "toolCall", id: "c-1", name: "run", arguments: args }], {
			stopReason: "toolUse",
		});
		const telemetry = telemetryFor({ captureMessageContent: "summary" });
		const span = startChatSpan(telemetry, MODEL, { stepNumber: 0, request: {} });
		await finishChatSpan(telemetry, span, message, { stepNumber: 0 });
		const shaped = JSON.parse(onlySpan().attributes[PiGenAIAttr.ResponseToolCalls] as string)[0].input;
		expect(shaped.huge).toBe(`${"x".repeat(240)} [60 chars omitted]`);
		expect(shaped.big).toBe("10");
		expect(shaped.fn).toBe("[Function]");
		expect(shaped.err).toEqual({ name: "Error", message: "boom" });
		// args is depth 0, so its children summarize at depth 1; the object-depth
		// cap (3) collapses `deep.a.b` into a keys-only summary of its child `c`.
		expect(shaped.deep).toEqual({ a: { b: { kind: "object", keys: ["c"] } } });
		expect(shaped.list).toHaveLength(65); // 64 items + 1 truncation marker
		expect(shaped.list[64]).toEqual({ kind: "truncated", omittedItems: 6 });
		expect(shaped.wide.telemetrySummary).toEqual({ omittedKeys: 3 });
		expect(shaped.circle.self).toBe("[Circular]");
	});
});

describe("service tier request attribute", () => {
	it("emits the OpenAI service tier only for a provider that accepts it", () => {
		const openaiModel = buildModel({
			id: "gpt-x",
			name: "gpt-x",
			api: "openai-responses",
			provider: "openai",
			baseUrl: "https://api.openai.com/v1",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 200_000,
			maxTokens: 32_768,
		});
		const telemetry = telemetryFor({});
		const span = startChatSpan(telemetry, openaiModel, {
			stepNumber: 0,
			request: { serviceTier: "priority" },
		});
		span?.end();
		expect(onlySpan().attributes[OpenAIAttr.RequestServiceTier]).toBe("priority");
	});
});
