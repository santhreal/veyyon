/** Agent loop that works with AgentMessage throughout. */

import type {
	AssistantMessage,
	AssistantMessageEvent,
	AssistantTurnStatus,
	Context,
	IncompleteToolCall,
	Model,
	ToolCallStatus,
	ToolChoice,
	ToolResultMessage,
	TSchema,
	UserMessage,
} from "@veyyon/ai";
import { isApiKeyResolver, resolveApiKeyOnce, seedApiKeyResolver } from "@veyyon/ai/auth-retry";
import {
	type Dialect,
	encodeInbandToolHistory,
	renderInbandToolPrompt,
	renderToolExamples,
	wrapInbandToolStream,
} from "@veyyon/ai/dialect";
import * as AIError from "@veyyon/ai/error";
import {
	captureAssistantTurnMetrics,
	captureAssistantTurnRequest,
	captureToolCallMetrics,
} from "@veyyon/ai/instrumentation";
import { streamSimple } from "@veyyon/ai/stream";
import { EMPTY_ERROR_TOOL_RESULT_TEXT } from "@veyyon/ai/types";
import {
	type CursorExecResolvedCarrier,
	clearStreamingPartialJson,
	getStreamingPartialJson,
	kCursorExecResolved,
	type StreamingPartialJsonCarrier,
} from "@veyyon/ai/utils/block-symbols";
import { EventStream } from "@veyyon/ai/utils/event-stream";
import {
	createHarmonyAuditEvent,
	detectHarmonyLeakInAssistantMessage,
	extractHarmonyRemoved,
	type HarmonyDetection,
	type HarmonyRecoveredToolCall,
	isHarmonyLeakMitigationTarget,
	recoverHarmonyToolCall,
	signalListLabel,
} from "@veyyon/ai/utils/harmony-leak";
import { stripSchemaDescriptions, toolWireSchema } from "@veyyon/ai/utils/schema/wire";
import { validateToolArguments } from "@veyyon/ai/utils/validation";
import { preferredDialect } from "@veyyon/catalog/identity";
import { emptyUsage } from "@veyyon/catalog/models";
import {
	errorMessage,
	estimateTokensFromText,
	formatCount,
	isAbortError,
	isRecord,
	logger,
	sanitizeText,
	structuredCloneJSON,
} from "@veyyon/utils";
import { INTENT_FIELD } from "@veyyon/wire";
import { agentPauseGate } from "./pause";
import { type AgentRunCoverage, type AgentRunSummary, ToolCallBlockedError } from "./run-collector";
import {
	type AgentTelemetry,
	failChatSpan,
	finishChatSpan,
	finishExecuteToolSpan,
	finishInvokeAgentSpan,
	fireOnRunEnd,
	PiGenAIAttr,
	recordSkippedTool,
	resolveTelemetry,
	runInActiveSpan,
	type Span,
	startChatSpan,
	startExecuteToolSpan,
	startInvokeAgentSpan,
} from "./telemetry";
import {
	buildToolBatchLedger,
	renderToolBatchLedger,
	type ToolBatchCallEntry,
	type ToolBatchLedger,
	type ToolBatchLedgerCause,
} from "./tool-batch-ledger";
import { capToolResultContent } from "./tool-result-cap";
import type {
	AgentContext,
	AgentEvent,
	AgentLoopConfig,
	AgentMessage,
	AgentTool,
	AgentToolResult,
	AgentTurnEndContext,
	AsideMessage,
	ConfiguredDialect,
	SteeringInterruptSource,
	SteeringQueueState,
	StreamFn,
} from "./types";
import { isSoftToolRequirement } from "./types";
import { yieldIfDue } from "./utils/yield";

/** Stop-details marker for a provider error after assistant content/tool args already streamed. */
export const STREAM_INTERRUPTED_AFTER_CONTENT_STOP_DETAIL = "stream_interrupted_after_content";

/** Sentinel returned by the abort race in `streamAssistantResponse`. */
const ABORTED: unique symbol = Symbol("agent-loop-aborted");

const EMPTY_STRING_SET: ReadonlySet<string> = new Set<string>();

/** Max consecutive re-samples triggered by non-terminal stops. */
const MAX_PAUSED_TURN_CONTINUATIONS = 8;

/** Max consecutive forced escalations for a soft tool requirement. */
const MAX_SOFT_TOOL_ESCALATIONS = 3;

/** Whether a toolChoice conflicts with a pending soft tool requirement. */
function hardToolChoiceBlocks(choice: ToolChoice | undefined, requiredTool: string): boolean {
	if (choice === undefined) return false;
	if (typeof choice === "string") return choice === "none";
	const name = choice.type === "tool" ? choice.name : "function" in choice ? choice.function.name : choice.name;
	return name !== requiredTool;
}

/** Polling interval (ms) for queued steering during interruptible tools. */
/** Abort reason for a turn-wide interruption where only some tool calls caused */
export interface ToolScopedAbortReason {
	readonly kind: "tool-scoped-abort";
	readonly message: string;
	readonly toolCallMessages: Record<string, string>;
	readonly defaultToolCallMessage: string;
}

/** Creates an abort reason that labels matching tool calls separately from siblings. */
export function createToolScopedAbortReason(
	message: string,
	toolCallMessages: Record<string, string>,
	defaultToolCallMessage: string,
): ToolScopedAbortReason {
	return { kind: "tool-scoped-abort", message, toolCallMessages, defaultToolCallMessage };
}

/** Error indicating a post-tool hook requested run termination. */
export const TERMINAL_TOOL_RESULT_ABORT_REASON = Symbol.for("pi-agent-core.terminal-tool-result");

const STEERING_INTERRUPT_POLL_MS = 250;

class HarmonyLeakInterruption extends Error {
	constructor(
		readonly detection: HarmonyDetection,
		readonly removed: string,
		readonly recovered?: HarmonyRecoveredToolCall,
	) {
		super(`Detected GPT-5 Harmony protocol leakage (${signalListLabel(detection.signals)})`);
		this.name = "HarmonyLeakInterruption";
	}
}
/** Resolve the effective tool calling dialect for a request. */
export function resolveConfiguredDialect(configured: ConfiguredDialect | undefined, model: Model): Dialect | undefined {
	const resolved = typeof configured === "function" ? configured(model) : configured;
	return resolved ?? resolveOwnedDialectFromEnv(Bun.env.VEYYON_DIALECT);
}

export function resolveOwnedDialectFromEnv(value: string | undefined): Dialect | undefined {
	switch (value) {
		case "1":
		case "true":
			return "glm";
		case "glm":
		case "hermes":
		case "kimi":
		case "xml":
		case "anthropic":
		case "deepseek":
		case "harmony":
		case "qwen3":
		case "gemini":
		case "gemma":
		case "minimax":
		case "pi-native":
			return value;
		default:
			return undefined;
	}
}

type AssistantContentBlock = AssistantMessage["content"][number];
type AssistantToolCallBlock = Extract<AssistantContentBlock, { type: "toolCall" }>;

type SnapshotMode = "full" | "delta";

/** Clone a content block for immutable event emission. */
function snapshotAssistantContentBlock(block: AssistantContentBlock, mode: SnapshotMode): AssistantContentBlock {
	switch (block.type) {
		case "text":
			return { ...block };
		case "thinking":
			return { ...block };
		case "redactedThinking":
			return { ...block };
		case "fallback":
			return { ...block, from: { ...block.from }, to: { ...block.to } };
		case "toolCall":
			return mode === "delta" ? { ...block } : { ...block, arguments: structuredCloneJSON(block.arguments) };
	}
}

function snapshotAssistantMessage(message: AssistantMessage, mode: SnapshotMode = "full"): AssistantMessage {
	const content = new Array<AssistantContentBlock>(message.content.length);
	for (let i = 0; i < message.content.length; i++) {
		content[i] = snapshotAssistantContentBlock(message.content[i]!, mode);
	}
	return {
		...message,
		content,
		usage: {
			...message.usage,
			cost: { ...message.usage.cost },
		},
		disabledFeatures: message.disabledFeatures ? message.disabledFeatures.slice() : undefined,
		toolCallAbortMessages: message.toolCallAbortMessages ? { ...message.toolCallAbortMessages } : undefined,
	};
}

/** Clone an assistant streaming event for immutable event emission. */
function snapshotAssistantMessageEvent(
	event: AssistantMessageEvent,
	partialSnapshot?: AssistantMessage,
): AssistantMessageEvent {
	switch (event.type) {
		case "start":
			return { ...event, partial: partialSnapshot ?? snapshotAssistantMessage(event.partial, "delta") };
		case "text_start":
		case "text_delta":
		case "text_end":
		case "thinking_start":
		case "thinking_delta":
		case "thinking_end":
		case "toolcall_start":
		case "toolcall_delta":
			return { ...event, partial: partialSnapshot ?? snapshotAssistantMessage(event.partial, "delta") };
		case "toolcall_end":
			return {
				...event,
				toolCall: snapshotAssistantContentBlock(event.toolCall, "full") as AssistantToolCallBlock,
				partial: partialSnapshot ?? snapshotAssistantMessage(event.partial, "delta"),
			};
		case "done":
			return { ...event, message: snapshotAssistantMessage(event.message) };
		case "error":
			return { ...event, error: snapshotAssistantMessage(event.error) };
	}
}

/** Normalize tool return value into an AgentToolResult. */

function hasSubstantiveToolResultContent(content: AgentToolResult["content"]): boolean {
	for (const block of content) {
		if (block.type === "image") return true;
		if (block.type === "text" && block.text.trim().length > 0) return true;
	}
	return false;
}

function coerceToolResult(raw: unknown): { result: AgentToolResult<unknown>; malformed: boolean } {
	const rawObj = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : null;
	const rawContent = rawObj?.content;
	const details = rawObj && "details" in rawObj ? rawObj.details : {};
	// Tools may flag a non-throwing failure on the result itself (e.g. an
	// aggregator that catches per-entry errors and synthesizes a combined
	// result). Preserve the flag so agent-loop can surface it on the wire.
	const explicitError = Boolean(rawObj && "isError" in rawObj && rawObj.isError);
	// Tools may flag the result contextually useless (zero matches, elapsed
	// wait) so compaction can elide it once consumed. Errors are never useless.
	const useless = Boolean(rawObj && "useless" in rawObj && rawObj.useless);

	if (!Array.isArray(rawContent)) {
		return {
			result: {
				content: [{ type: "text", text: "Tool returned an invalid result: missing content array." }],
				details,
				isError: true,
			},
			malformed: true,
		};
	}

	const content: AgentToolResult["content"] = [];
	let invalidBlocks = 0;
	for (const block of rawContent) {
		if (!block || typeof block !== "object" || !("type" in block)) {
			invalidBlocks++;
			continue;
		}
		if (block.type === "text" && typeof (block as { text?: unknown }).text === "string") {
			content.push({ type: "text", text: sanitizeText((block as { text: string }).text) });
		} else if (
			block.type === "image" &&
			typeof (block as { data?: unknown }).data === "string" &&
			typeof (block as { mimeType?: unknown }).mimeType === "string"
		) {
			content.push(block as { type: "image"; data: string; mimeType: string });
		} else {
			invalidBlocks++;
		}
	}
	if (invalidBlocks > 0) {
		content.push({
			type: "text",
			text: `Tool returned an invalid result: ${formatCount("content block", invalidBlocks)} had an unsupported shape.`,
		});
	}
	const isError = explicitError || invalidBlocks > 0;
	// Anthropic rejects tool_result blocks with is_error: true and empty content.
	if (isError && !hasSubstantiveToolResultContent(content)) {
		content.length = 0;
		content.push({ type: "text", text: EMPTY_ERROR_TOOL_RESULT_TEXT });
	}
	return {
		result: {
			content,
			details,
			...(isError ? { isError: true } : {}),
			...(useless && !isError ? { useless: true } : {}),
		},
		malformed: invalidBlocks > 0,
	};
}

/** Start an agent loop with a new prompt message. */
export function agentLoop(
	prompts: AgentMessage[],
	context: AgentContext,
	config: AgentLoopConfig,
	signal?: AbortSignal,
	streamFn?: StreamFn,
): EventStream<AgentEvent, AgentMessage[]> {
	const stream = createAgentStream();

	(async () => {
		const newMessages: AgentMessage[] = prompts.slice();
		const currentContext: AgentContext = {
			...context,
			messages: context.messages.concat(prompts),
		};

		stream.push({ type: "agent_start" });
		stream.push({ type: "turn_start" });
		for (const prompt of prompts) {
			stream.push({ type: "message_start", message: prompt });
			stream.push({ type: "message_end", message: prompt });
		}

		try {
			await runLoop(currentContext, newMessages, config, signal, stream, streamFn);
		} catch (err) {
			stream.fail(err);
		}
	})();

	return stream;
}

/** Continue an agent loop from the current context. */
export function agentLoopContinue(
	context: AgentContext,
	config: AgentLoopConfig,
	signal?: AbortSignal,
	streamFn?: StreamFn,
): EventStream<AgentEvent, AgentMessage[]> {
	if (context.messages.length === 0) {
		throw new Error("Cannot continue: no messages in context");
	}

	if (context.messages[context.messages.length - 1].role === "assistant") {
		throw new Error("Cannot continue from message role: assistant");
	}

	const stream = createAgentStream();

	(async () => {
		const newMessages: AgentMessage[] = [];
		const currentContext: AgentContext = { ...context, messages: context.messages.slice() };

		stream.push({ type: "agent_start" });
		stream.push({ type: "turn_start" });

		try {
			await runLoop(currentContext, newMessages, config, signal, stream, streamFn);
		} catch (err) {
			stream.fail(err);
		}
	})();

	return stream;
}

function createAgentStream(): EventStream<AgentEvent, AgentMessage[]> {
	return new EventStream<AgentEvent, AgentMessage[]>(
		(event: AgentEvent) => event.type === "agent_end",
		(event: AgentEvent) => (event.type === "agent_end" ? event.messages : []),
	);
}

/** Build agent_end event payload. */
function buildAgentEndEvent(
	messages: AgentMessage[],
	telemetry: AgentTelemetry | undefined,
	stepCount: number,
): Extract<AgentEvent, { type: "agent_end" }> {
	if (!telemetry) return { type: "agent_end", messages };
	const snapshot = telemetry.collector.snapshot({ stepCount });
	if (telemetry.collector.markRunEnded()) {
		fireOnRunEnd(telemetry, snapshot.summary, snapshot.coverage);
	}
	return { type: "agent_end", messages, telemetry: snapshot.summary, coverage: snapshot.coverage };
}
/** Emit turn_end event and execute turn hook. */
async function emitTurnEnd(
	stream: EventStream<AgentEvent, AgentMessage[]>,
	currentContext: AgentContext,
	message: AgentMessage,
	toolResults: ToolResultMessage[],
	config: AgentLoopConfig,
	signal?: AbortSignal,
	context?: Omit<AgentTurnEndContext, "message" | "toolResults">,
): Promise<void> {
	stream.push({ type: "turn_end", message, toolResults });
	const isAbortedOrError =
		message.role === "assistant" && (message.stopReason === "aborted" || message.stopReason === "error");
	if (signal?.aborted || isAbortedOrError) return;
	await config.onTurnEnd?.(currentContext.messages, signal, { message, toolResults, willContinue: false, ...context });
}

/** Result handle returned by agentLoopDetailed. */
export interface AgentLoopDetailedResult {
	readonly messages: AgentMessage[];
	readonly telemetry: AgentRunSummary | undefined;
	readonly coverage: AgentRunCoverage | undefined;
}

/** Wrapper over agentLoop that captures run-level telemetry. */
export function agentLoopDetailed(
	prompts: AgentMessage[],
	context: AgentContext,
	config: AgentLoopConfig,
	signal?: AbortSignal,
	streamFn?: StreamFn,
): {
	readonly stream: EventStream<AgentEvent, AgentMessage[]>;
	readonly detailed: () => Promise<AgentLoopDetailedResult>;
} {
	const capture = createDetailedCapture(config);
	const stream = agentLoop(prompts, context, capture.config, signal, streamFn);
	return { stream, detailed: () => capture.detailed(stream) };
}

/** Wrapper over agentLoopContinue that captures run-level telemetry. */
export function agentLoopContinueDetailed(
	context: AgentContext,
	config: AgentLoopConfig,
	signal?: AbortSignal,
	streamFn?: StreamFn,
): {
	readonly stream: EventStream<AgentEvent, AgentMessage[]>;
	readonly detailed: () => Promise<AgentLoopDetailedResult>;
} {
	const capture = createDetailedCapture(config);
	const stream = agentLoopContinue(context, capture.config, signal, streamFn);
	return { stream, detailed: () => capture.detailed(stream) };
}

/** Attach run summary hook to config. */
function createDetailedCapture(config: AgentLoopConfig): {
	readonly config: AgentLoopConfig;
	readonly detailed: (stream: EventStream<AgentEvent, AgentMessage[]>) => Promise<AgentLoopDetailedResult>;
} {
	let captured: { summary: AgentRunSummary; coverage: AgentRunCoverage } | undefined;
	const userHook = config.telemetry?.onRunEnd;
	const wired: AgentLoopConfig = {
		...config,
		telemetry: {
			...(config.telemetry ?? {}),
			onRunEnd: (summary, coverage) => {
				captured = { summary, coverage };
				userHook?.(summary, coverage);
			},
		},
	};
	return {
		config: wired,
		detailed: async stream => {
			const messages = await stream.result();
			return {
				messages,
				telemetry: captured?.summary,
				coverage: captured?.coverage,
			};
		},
	};
}

export function normalizeMessagesForProvider(
	messages: Context["messages"],
	model: AgentLoopConfig["model"],
): Context["messages"] {
	if (model.provider !== "cerebras") {
		return messages;
	}

	let hasThinking = false;
	for (const message of messages) {
		if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
		for (const block of message.content) {
			if (block.type === "thinking") {
				hasThinking = true;
				break;
			}
		}
		if (hasThinking) break;
	}
	if (!hasThinking) return messages;

	return messages.map(message => {
		if (message.role !== "assistant" || !Array.isArray(message.content)) {
			return message;
		}
		const filtered = message.content.filter(block => block.type !== "thinking");
		return filtered.length === message.content.length ? message : { ...message, content: filtered };
	});
}

const INTENT_FIELD_DESCRIPTION = "concise intent";
const INTENT_SCHEMA_UNION_KEYS = ["anyOf", "oneOf"] as const;

function injectIntentIntoSchema(
	schema: unknown,
	mode: "require" | "optional" = "require",
	describeIntent = true,
): unknown {
	if (!isRecord(schema)) return schema;
	const schemaRecord = schema as Record<string, unknown>;
	const propertiesValue = schemaRecord.properties;
	const hasOwnProperties = isRecord(propertiesValue);

	if (!hasOwnProperties) {
		for (const key of INTENT_SCHEMA_UNION_KEYS) {
			const variants = schemaRecord[key];
			if (!Array.isArray(variants)) continue;
			return {
				...schemaRecord,
				[key]: variants.map(variant => injectIntentIntoSchema(variant, mode, describeIntent)),
			};
		}
	}

	const properties = hasOwnProperties ? (propertiesValue as Record<string, unknown>) : {};
	const requiredValue = schemaRecord.required;
	const required = Array.isArray(requiredValue)
		? requiredValue.filter((item): item is string => typeof item === "string")
		: [];
	if (INTENT_FIELD in properties) {
		const { [INTENT_FIELD]: intentProp, ...rest } = properties;
		const needsReorder = Object.keys(properties)[0] !== INTENT_FIELD;
		const needsRequired = mode === "require" && !required.includes(INTENT_FIELD);
		if (!needsReorder && !needsRequired) return schema;
		return {
			...schemaRecord,
			...(needsReorder ? { properties: { [INTENT_FIELD]: intentProp, ...rest } } : {}),
			...(needsRequired ? { required: required.concat(INTENT_FIELD) } : {}),
		};
	}
	return {
		...schemaRecord,
		properties: {
			[INTENT_FIELD]: describeIntent
				? { type: "string", description: INTENT_FIELD_DESCRIPTION }
				: { type: "string" },
			...properties,
		},
		...(mode === "require" ? { required: required.concat(INTENT_FIELD) } : {}),
	};
}

/** Cache normalized tool schemas across requests. */
const normalizedToolsCache = new WeakMap<
	NonNullable<AgentContext["tools"]>,
	{ key: string; result: Context["tools"] }
>();

export function normalizeTools(
	tools: NonNullable<AgentContext["tools"]>,
	injectIntent: boolean,
	exampleDialect?: Dialect,
	pruneDescriptions?: boolean,
): NonNullable<Context["tools"]>;
export function normalizeTools(
	tools: AgentContext["tools"],
	injectIntent: boolean,
	exampleDialect?: Dialect,
	pruneDescriptions?: boolean,
): Context["tools"];
export function normalizeTools(
	tools: AgentContext["tools"],
	injectIntent: boolean,
	exampleDialect?: Dialect,
	pruneDescriptions = false,
): Context["tools"] {
	if (!tools) return tools;
	// Drop null/undefined/non-object slots so a bad registry entry cannot
	// TypeError mid-map (adversarial / partial tool lists).
	const valid = tools.filter(
		(t): t is NonNullable<(typeof tools)[number]> =>
			t !== null && t !== undefined && typeof t === "object" && typeof (t as { name?: unknown }).name === "string",
	);
	injectIntent = injectIntent && Bun.env.VEYYON_NO_INTENT !== "1";
	const cacheKey = `${injectIntent}|${exampleDialect ?? ""}|${pruneDescriptions}`;
	const cached = normalizedToolsCache.get(tools);
	if (cached && cached.key === cacheKey) return cached.result;
	const result = valid.map(t => {
		const intentMode = resolveIntentMode(t.intent);
		const doInjectIntent = injectIntent && intentMode !== "omit";
		if (pruneDescriptions) {
			let parameters = stripSchemaDescriptions(toolWireSchema(t)) as TSchema;
			if (doInjectIntent) parameters = injectIntentIntoSchema(parameters, intentMode, false) as TSchema;
			return { ...t, parameters, description: "" };
		}
		let parameters = toolWireSchema(t) as TSchema;
		if (doInjectIntent) parameters = injectIntentIntoSchema(parameters, intentMode) as TSchema;
		const description = t.description ?? "";
		const examplesBlock = exampleDialect
			? renderToolExamples({ ...t, parameters }, exampleDialect, doInjectIntent ? INTENT_FIELD : undefined)
			: "";
		const finalDescription = examplesBlock ? `${description}\n\n${examplesBlock}` : description;
		return { ...t, parameters, description: finalDescription };
	});
	normalizedToolsCache.set(tools, { key: cacheKey, result });
	return result;
}

function resolveIntentMode(intent: AgentTool["intent"]): "require" | "optional" | "omit" {
	if (typeof intent === "function") return "omit";
	if (intent === "optional" || intent === "omit") return intent;
	return "require";
}

function extractIntent(args: Record<string, unknown>): { intent?: string; strippedArgs: Record<string, unknown> } {
	const { [INTENT_FIELD]: intent, ...strippedArgs } = args;
	if (typeof intent !== "string") {
		return { strippedArgs };
	}
	const trimmed = intent.trim();
	return { intent: trimmed.length > 0 ? trimmed : undefined, strippedArgs };
}

/** Main agent loop execution logic. */
async function runLoop(
	currentContext: AgentContext,
	newMessages: AgentMessage[],
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	stream: EventStream<AgentEvent, AgentMessage[]>,
	streamFn?: StreamFn,
): Promise<void> {
	const telemetry = resolveTelemetry(config.telemetry, config.sessionId);
	const invokeAgentSpan = startInvokeAgentSpan(telemetry, config.model);
	const stepCounter = { count: 0 };
	let caughtError: unknown;
	try {
		await runInActiveSpan(invokeAgentSpan, () =>
			runLoopBody(
				currentContext,
				newMessages,
				config,
				signal,
				stream,
				telemetry,
				invokeAgentSpan,
				stepCounter,
				streamFn,
			),
		);
	} catch (err) {
		caughtError = err;
		throw err;
	} finally {
		finishInvokeAgentSpan(telemetry, invokeAgentSpan, {
			stepCount: stepCounter.count,
			errorObject: caughtError,
		});
	}
}

interface StepCounter {
	count: number;
}

function isDeadlineExceeded(deadline: number | undefined): boolean {
	return deadline !== undefined && Date.now() >= deadline;
}

function endAgentStream(
	stream: EventStream<AgentEvent, AgentMessage[]>,
	newMessages: AgentMessage[],
	telemetry: AgentTelemetry | undefined,
	stepCount: number,
): void {
	stream.push(buildAgentEndEvent(newMessages, telemetry, stepCount));
	stream.end(newMessages);
}

/** Evaluate aside entries before injection into context. */
function resolveAsides(entries: AsideMessage[] | undefined): AgentMessage[] {
	if (!entries || entries.length === 0) return [];
	const out: AgentMessage[] = [];
	for (const entry of entries) {
		const message = typeof entry === "function" ? entry() : entry;
		if (message) out.push(message);
	}
	return out;
}

async function runLoopBody(
	currentContext: AgentContext,
	newMessages: AgentMessage[],
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	stream: EventStream<AgentEvent, AgentMessage[]>,
	telemetry: AgentTelemetry | undefined,
	invokeAgentSpan: Span | undefined,
	stepCounter: StepCounter,
	streamFn?: StreamFn,
): Promise<void> {
	let deadlineTimer: Timer | undefined;
	if (config.deadline !== undefined) {
		const deadlineAbortController = new AbortController();
		const deadlineReason = new DOMException("Deadline exceeded", "TimeoutError");
		const delay = config.deadline - Date.now();
		if (delay <= 0) {
			deadlineAbortController.abort(deadlineReason);
		} else {
			deadlineTimer = setTimeout(() => {
				deadlineAbortController.abort(deadlineReason);
			}, delay);
		}
		signal = signal ? AbortSignal.any([signal, deadlineAbortController.signal]) : deadlineAbortController.signal;
	}

	try {
		let firstTurn = true;
		if (isDeadlineExceeded(config.deadline)) {
			endAgentStream(stream, newMessages, telemetry, stepCounter.count);
			return;
		}
		let pendingMessages: AgentMessage[] = signal?.aborted ? [] : (await config.getSteeringMessages?.()) || [];
		let harmonyRetryAttempt = 0;
		let harmonyTruncateResumeCount = 0;
		let pausedTurnContinuations = 0;

		let softRequirementId: string | undefined;
		let forcedToolChoice: ToolChoice | undefined;
		let softEscalations = 0;
		let hostToolChoice: ToolChoice | undefined;
		let softRequiredTool: string | undefined;
		let directiveResolvedForTurn = false;

		while (true) {
			let hasMoreToolCalls = true;

			while (hasMoreToolCalls || pendingMessages.length > 0) {
				if (isDeadlineExceeded(config.deadline)) {
					endAgentStream(stream, newMessages, telemetry, stepCounter.count);
					return;
				}
				// Yield at the top of each iteration to prevent busy-wait when
				// the agent loop is executing tool calls back-to-back.
				await yieldIfDue();
				const pauseGate = config.pauseGate ?? agentPauseGate;
				if (pauseGate.paused) {
					try {
						await pauseGate.waitUntilResumed(signal);
					} catch (err) {
						if (isAbortError(err) || signal?.aborted) {
							const message = emitAbortedAssistantMessage(
								null,
								false,
								EMPTY_STRING_SET,
								currentContext,
								config,
								stream,
								signal,
							);
							newMessages.push(message);
							await emitTurnEnd(stream, currentContext, message, [], config, signal, { willContinue: false });
							endAgentStream(stream, newMessages, telemetry, stepCounter.count);
							return;
						}
						throw err;
					}
				}
				if (!firstTurn) {
					stream.push({ type: "turn_start" });
				} else {
					firstTurn = false;
				}

				if (pendingMessages.length > 0) {
					for (const message of pendingMessages) {
						stream.push({ type: "message_start", message });
						stream.push({ type: "message_end", message });
						currentContext.messages.push(message);
						newMessages.push(message);
					}
					pendingMessages = [];
				}

				if (config.syncContextBeforeModelCall) {
					await config.syncContextBeforeModelCall(currentContext);
				}

				if (!directiveResolvedForTurn) {
					const directive = signal?.aborted ? undefined : config.getToolChoice?.();
					const softReq = isSoftToolRequirement(directive) ? directive : undefined;
					hostToolChoice = directive === undefined || isSoftToolRequirement(directive) ? undefined : directive;
					softRequiredTool = softReq?.toolName;
					if (softReq !== undefined) {
						if (softReq.id !== softRequirementId) {
							softRequirementId = softReq.id;
							softEscalations = 0;
							for (const reminder of softReq.reminder) {
								stream.push({ type: "message_start", message: reminder });
								stream.push({ type: "message_end", message: reminder });
								currentContext.messages.push(reminder);
								newMessages.push(reminder);
							}
						}
					} else {
						softRequirementId = undefined;
						softEscalations = 0;
					}
					directiveResolvedForTurn = true;
				}

				let recovered: HarmonyRecoveredToolCall | undefined;
				let message: AssistantMessage;
				try {
					message = await streamAssistantResponse(
						currentContext,
						config,
						signal,
						stream,
						telemetry,
						invokeAgentSpan,
						stepCounter,
						streamFn,
						harmonyRetryAttempt,
						hostToolChoice,
						forcedToolChoice,
					);
					harmonyRetryAttempt = 0;
					harmonyTruncateResumeCount = 0;
				} catch (err) {
					if (!(err instanceof HarmonyLeakInterruption)) throw err;
					if (err.recovered) {
						if (harmonyTruncateResumeCount >= 2) {
							await emitHarmonyAudit(config, err, "escalated", harmonyRetryAttempt);
							throw new Error(
								`GPT-5 Harmony leak recurred after truncate-and-resume recovery (${signalListLabel(err.detection.signals)}).`,
							);
						}
						harmonyTruncateResumeCount++;
						recovered = err.recovered;
						message = recovered.message;
						await emitHarmonyAudit(config, err, "truncate_resume", harmonyRetryAttempt);
						harmonyRetryAttempt = 0;
					} else {
						if (harmonyRetryAttempt >= 2) {
							await emitHarmonyAudit(config, err, "escalated", harmonyRetryAttempt);
							throw new Error(
								`GPT-5 Harmony leak persisted after ${harmonyRetryAttempt} retries (${signalListLabel(err.detection.signals)}).`,
							);
						}
						await emitHarmonyAudit(config, err, "abort_retry", harmonyRetryAttempt);
						harmonyRetryAttempt++;
						continue;
					}
				}
				if (recovered) {
					message = snapshotAssistantMessage(message);
					currentContext.messages.push(message);
					stream.push({ type: "message_start", message: snapshotAssistantMessage(message) });
					stream.push({ type: "message_end", message: snapshotAssistantMessage(message) });
				}
				newMessages.push(message);

				// The escalation choice (if any) applied to the call above; clear it so
				// only the single escalation turn carries the forced choice.
				forcedToolChoice = undefined;

				// A fresh logical turn re-resolves the directive next iteration; a Harmony
				// retry `continue`s before this line and keeps the cached value.
				directiveResolvedForTurn = false;

				if (message.stopReason === "error" || message.stopReason === "aborted") {
					// Create placeholder tool results for any tool calls in the aborted message
					// This maintains the tool_use/tool_result pairing that the API requires
					type ToolCallContent = Extract<AssistantMessage["content"][number], { type: "toolCall" }>;
					const toolCalls = message.content.filter(
						(c): c is ToolCallContent =>
							c.type === "toolCall" && (c as CursorExecResolvedCarrier)[kCursorExecResolved] !== true,
					);
					const scopedAbort = toolScopedAbortReason(signal);
					const toolCallAbortMessages =
						message.toolCallAbortMessages ??
						(scopedAbort ? buildToolCallAbortMessages(message, scopedAbort) : undefined);
					const batchLedger = buildAbortedTurnLedger(
						message.stopReason === "aborted" ? "aborted" : "stream_error",
						message,
						currentContext.messages,
					);
					const toolResults: ToolResultMessage[] = [];
					for (const toolCall of toolCalls) {
						const errorMessage = toolCallAbortMessages?.[toolCall.id] ?? message.errorMessage;
						const result = createAbortedToolResult(
							toolCall,
							stream,
							message.stopReason,
							errorMessage,
							toolResults.length === 0 ? batchLedger : undefined,
						);
						currentContext.messages.push(result);
						newMessages.push(result);
						toolResults.push(result);
						recordSkippedTool(telemetry, {
							toolCallId: toolCall.id,
							toolName: toolCall.name,
							status: message.stopReason === "aborted" ? "aborted" : "error",
						});
					}
					if (batchLedger && toolResults.length === 0) {
						const notice: UserMessage = {
							role: "user",
							content: renderToolBatchLedger(batchLedger),
							synthetic: true,
							timestamp: Date.now(),
						};
						stream.push({ type: "message_start", message: notice });
						stream.push({ type: "message_end", message: notice });
						currentContext.messages.push(notice);
						newMessages.push(notice);
					}
					await emitTurnEnd(stream, currentContext, message, toolResults, config, signal, { willContinue: false });

					stream.push(buildAgentEndEvent(newMessages, telemetry, stepCounter.count));
					stream.end(newMessages);
					return;
				}

				type ToolCallContent = Extract<AssistantMessage["content"][number], { type: "toolCall" }>;
				const toolCalls = message.content.filter(
					(c): c is ToolCallContent =>
						c.type === "toolCall" && (c as CursorExecResolvedCarrier)[kCursorExecResolved] !== true,
				);
				const runnableStop = message.stopReason === "toolUse" || message.stopReason === "stop";
				hasMoreToolCalls = runnableStop && toolCalls.length > 0;

				const deadlinePassed = isDeadlineExceeded(config.deadline);
				if (hasMoreToolCalls && deadlinePassed) {
					hasMoreToolCalls = false;
				}

				const calledOnlyRequiredTool =
					softRequiredTool !== undefined &&
					toolCalls.length > 0 &&
					toolCalls.every(toolCall => toolCall.name === softRequiredTool);
				const softGateActive =
					softRequiredTool !== undefined && !hardToolChoiceBlocks(config.toolChoice, softRequiredTool);
				const softNonCompliant = softGateActive && !calledOnlyRequiredTool;

				const toolResults: ToolResultMessage[] = [];
				if (softNonCompliant && softRequiredTool !== undefined) {
					if (softEscalations >= MAX_SOFT_TOOL_ESCALATIONS) {
						throw new Error(
							`Soft tool requirement '${softRequiredTool}' was not satisfied after ${MAX_SOFT_TOOL_ESCALATIONS} forced turns; aborting to avoid an unbounded force loop.`,
						);
					}
					for (const toolCall of toolCalls) {
						const result = createAbortedToolResult(
							toolCall,
							stream,
							"skipped",
							`Not executed: call the \`${softRequiredTool}\` tool to resolve the pending action before using other tools.`,
						);
						currentContext.messages.push(result);
						newMessages.push(result);
						toolResults.push(result);
						recordSkippedTool(telemetry, {
							toolCallId: toolCall.id,
							toolName: toolCall.name,
							status: "skipped",
						});
					}
					forcedToolChoice = { type: "tool", name: softRequiredTool };
					softEscalations++;
					hasMoreToolCalls = true;
				} else if (hasMoreToolCalls) {
					const executionResult = await executeToolCalls(
						currentContext,
						message,
						signal,
						stream,
						config,
						telemetry,
						invokeAgentSpan,
					);

					for (let tr = 0; tr < executionResult.toolResults.length; tr++) {
						toolResults.push(executionResult.toolResults[tr]!);
					}

					for (const result of toolResults) {
						currentContext.messages.push(result);
						newMessages.push(result);
					}
				} else if (toolCalls.length > 0) {
					// Turn ended on a non-runnable reason (`length` truncation) or deadline was exceeded
					// but left toolCall blocks behind. pair each with a placeholder result.
					const skipReason = deadlinePassed ? "aborted" : message.stopReason === "length" ? "length" : "skipped";
					const skipErrMsg = deadlinePassed ? "Deadline exceeded" : undefined;
					for (const toolCall of toolCalls) {
						const result = createAbortedToolResult(toolCall, stream, skipReason, skipErrMsg);
						currentContext.messages.push(result);
						newMessages.push(result);
						toolResults.push(result);
						recordSkippedTool(telemetry, {
							toolCallId: toolCall.id,
							toolName: toolCall.name,
							status: deadlinePassed ? "aborted" : "skipped",
						});
					}
					if (message.stopReason === "length" && toolResults.length > 0 && !deadlinePassed) {
						hasMoreToolCalls = true;
					}
				}

				// A tool hook may mark its completed result as terminal (e.g. subagent yield).
				// Stop before the next provider call without changing external/user abort semantics.
				if (signal?.reason === TERMINAL_TOOL_RESULT_ABORT_REASON) {
					hasMoreToolCalls = false;
				}

				if (toolCalls.length > 0) {
					pausedTurnContinuations = 0;
				} else if (
					!hasMoreToolCalls &&
					message.stopReason === "stop" &&
					message.stopDetails?.type === "pause_turn" &&
					pausedTurnContinuations < MAX_PAUSED_TURN_CONTINUATIONS
				) {
					pausedTurnContinuations++;
					hasMoreToolCalls = true;
				}

				await emitTurnEnd(stream, currentContext, message, toolResults, config, signal, {
					willContinue: hasMoreToolCalls && !isDeadlineExceeded(config.deadline),
				});

				if (isDeadlineExceeded(config.deadline)) {
					endAgentStream(stream, newMessages, telemetry, stepCounter.count);
					return;
				}
				const steering = signal?.aborted ? [] : (await config.getSteeringMessages?.()) || [];
				if (hasMoreToolCalls) {
					// Mid-work: fold any non-interrupting asides into the next turn alongside steering.
					const asides = signal?.aborted ? [] : resolveAsides(await config.getAsideMessages?.());
					pendingMessages = asides.length > 0 ? steering.concat(asides) : steering;
				} else {
					pendingMessages = steering;
				}
			}

			if (isDeadlineExceeded(config.deadline)) {
				endAgentStream(stream, newMessages, telemetry, stepCounter.count);
				return;
			}

			// Agent would stop here. Drain non-interrupting asides + follow-up messages.
			await config.onBeforeYield?.();

			if (isDeadlineExceeded(config.deadline)) {
				endAgentStream(stream, newMessages, telemetry, stepCounter.count);
				return;
			}
			const lateSteering = signal?.aborted ? [] : (await config.getSteeringMessages?.()) || [];
			const asideMessages = signal?.aborted ? [] : resolveAsides(await config.getAsideMessages?.());
			const followUpMessages = signal?.aborted ? [] : (await config.getFollowUpMessages?.()) || [];
			if (lateSteering.length > 0 || asideMessages.length > 0 || followUpMessages.length > 0) {
				pendingMessages = lateSteering.concat(asideMessages, followUpMessages);
				continue;
			}

			break;
		}

		endAgentStream(stream, newMessages, telemetry, stepCounter.count);
	} finally {
		if (deadlineTimer) {
			clearTimeout(deadlineTimer);
		}
	}
}

async function emitHarmonyAudit(
	config: AgentLoopConfig,
	interruption: HarmonyLeakInterruption,
	action: "truncate_resume" | "abort_retry" | "escalated",
	retryN: number,
): Promise<void> {
	await config.onHarmonyLeak?.(
		createHarmonyAuditEvent({
			action,
			detection: interruption.detection,
			model: config.getModel?.() ?? config.model,
			retryN,
			removed: interruption.removed,
		}),
	);
}

/** Stream assistant response from LLM and transform messages. */
async function streamAssistantResponse(
	context: AgentContext,
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	stream: EventStream<AgentEvent, AgentMessage[]>,
	telemetry: AgentTelemetry | undefined,
	invokeAgentSpan: Span | undefined,
	stepCounter: StepCounter,
	streamFn?: StreamFn,
	harmonyRetryAttempt = 0,
	hostToolChoice?: ToolChoice,
	forcedToolChoice?: ToolChoice,
): Promise<AssistantMessage> {
	const model = config.getModel?.() ?? config.model;
	let messages = context.messages;
	if (config.transformContext) {
		messages = await config.transformContext(messages, signal);
	}

	const llmMessages = await config.convertToLlm(messages);
	const normalizedMessages = normalizeMessagesForProvider(llmMessages, model);

	const ownedDialect: Dialect | undefined = resolveConfiguredDialect(config.dialect, model);
	const exampleDialect = ownedDialect ?? preferredDialect(model.id);
	// Owned/in-band dialects carry the catalog in the prompt as text and send no
	// native `tools`, so description pruning only applies to native tool calling.
	const pruneToolDescriptions = !!config.pruneToolDescriptions && !ownedDialect;
	// Build LLM context — append-only mode caches system prompt + tools
	// AND keeps an append-only message log so prior-turn bytes are stable.
	let llmContext: Context;
	if (config.appendOnlyContext) {
		config.appendOnlyContext.syncMessages(normalizedMessages);
		llmContext = config.appendOnlyContext.build(context, {
			intentTracing: !!config.intentTracing,
			exampleDialect,
			pruneToolDescriptions,
		});
	} else {
		llmContext = {
			systemPrompt: context.systemPrompt,
			messages: normalizedMessages,
			tools: normalizeTools(context.tools, !!config.intentTracing, exampleDialect, pruneToolDescriptions),
		};
	}
	if (config.transformProviderContext) {
		llmContext = await config.transformProviderContext(llmContext, model);
	}

	let promptToolWireTools: Context["tools"];
	if (ownedDialect && llmContext.tools && llmContext.tools.length > 0) {
		promptToolWireTools = llmContext.tools;
		llmContext = {
			...llmContext,
			systemPrompt: (llmContext.systemPrompt ?? []).concat(
				renderInbandToolPrompt(promptToolWireTools, ownedDialect),
			),
			messages: encodeInbandToolHistory(llmContext.messages, ownedDialect, promptToolWireTools),
			tools: undefined,
		};
	}

	const streamFunction = streamFn || streamSimple;

	const dynamicReasoning = config.getReasoning?.();
	const dynamicDisableReasoning = config.getDisableReasoning?.();
	const effectiveServiceTier = config.getServiceTier ? config.getServiceTier(model) : config.serviceTier;
	const harmonyMitigationEnabled = isHarmonyLeakMitigationTarget(model);
	const harmonyAbortController = harmonyMitigationEnabled ? new AbortController() : undefined;
	const requestSignal = harmonyAbortController
		? signal
			? AbortSignal.any([signal, harmonyAbortController.signal])
			: harmonyAbortController.signal
		: signal;
	const promptToolAbortController = ownedDialect ? new AbortController() : undefined;
	const providerAbortSignals: AbortSignal[] = [];
	if (requestSignal) providerAbortSignals.push(requestSignal);
	if (promptToolAbortController) providerAbortSignals.push(promptToolAbortController.signal);
	const finalRequestSignal =
		providerAbortSignals.length === 0
			? undefined
			: providerAbortSignals.length === 1
				? providerAbortSignals[0]!
				: AbortSignal.any(providerAbortSignals);
	const requestApiKey = (config.getApiKey ? await config.getApiKey(model) : undefined) ?? config.apiKey;
	const resolvedApiKey = await resolveApiKeyOnce(requestApiKey, finalRequestSignal);
	const apiKey = isApiKeyResolver(requestApiKey) ? seedApiKeyResolver(resolvedApiKey, requestApiKey) : requestApiKey;

	// Re-resolve metadata after credential selection so the per-request value
	// reflects the credential actually used, not the snapshot from AgentLoopConfig construction.
	const resolvedMetadata = config.metadataResolver ? config.metadataResolver(model.provider) : config.metadata;
	const effectiveTemperature =
		harmonyRetryAttempt > 0 && config.temperature !== undefined ? config.temperature + 0.05 : config.temperature;
	// Owned tool calling sends no native tools, so any tool_choice would error.
	const effectiveToolChoice = ownedDialect ? undefined : (hostToolChoice ?? forcedToolChoice ?? config.toolChoice);
	const effectiveReasoning = dynamicReasoning ?? config.reasoning;
	const effectiveDisableReasoning = dynamicDisableReasoning ?? config.disableReasoning;
	// `getCwd` is read once per LLM call so a mid-run session move (`/move`) reaches
	// workspace-scoped provider discovery; falls back to the static `cwd` when unset.
	const effectiveCwd = config.getCwd?.() ?? config.cwd;

	const chatStepNumber = stepCounter.count;
	stepCounter.count += 1;
	const chatSpan = startChatSpan(telemetry, model, {
		parent: invokeAgentSpan,
		stepNumber: chatStepNumber,
		request: {
			maxTokens: config.maxTokens,
			temperature: effectiveTemperature,
			topP: config.topP,
			topK: config.topK,
			presencePenalty: config.presencePenalty,
			serviceTier: effectiveServiceTier,
			reasoningEffort: typeof effectiveReasoning === "string" ? effectiveReasoning : undefined,
			toolChoice: effectiveToolChoice,
			tools: llmContext.tools,
			systemPrompt: llmContext.systemPrompt,
			messages: llmContext.messages,
		},
	});

	let capturedHeaders: Readonly<Record<string, string>> | undefined;
	const userOnResponse = config.onResponse;
	const captureOnResponse: AgentLoopConfig["onResponse"] = (response, modelInfo) => {
		capturedHeaders = response.headers;
		return userOnResponse?.(response, modelInfo);
	};

	const finishChat = async (message: AssistantMessage): Promise<void> => {
		await finishChatSpan(telemetry, chatSpan, message, {
			stepNumber: chatStepNumber,
			serviceTier: effectiveServiceTier,
			responseHeaders: capturedHeaders,
			baseUrl: model.baseUrl,
		});
	};

	try {
		return await runInActiveSpan(chatSpan, async () => {
			const turnInstrumentation = config.instrumentation ?? "off";
			const requestStartedAt = turnInstrumentation === "off" ? 0 : Date.now();
			let response = await streamFunction(model, llmContext, {
				...config,
				apiKey,
				metadata: resolvedMetadata,
				toolChoice: effectiveToolChoice,
				reasoning: effectiveReasoning,
				disableReasoning: effectiveDisableReasoning,
				temperature: effectiveTemperature,
				serviceTier: effectiveServiceTier,
				cwd: effectiveCwd,
				signal: finalRequestSignal,
				onResponse: captureOnResponse,
			});
			if (promptToolWireTools && ownedDialect) {
				response = wrapInbandToolStream(
					response,
					promptToolWireTools,
					ownedDialect,
					() => promptToolAbortController?.abort(),
					config.abortOnFabricatedToolResult ?? true,
				);
			}

			let partialMessage: AssistantMessage | null = null;
			let addedPartial = false;
			const completedToolCallIds = new Set<string>();

			const responseIterator = response[Symbol.asyncIterator]();
			const finishAbortedStream = async (): Promise<AssistantMessage> => {
				try {
					const cleanup = responseIterator.return?.();
					if (cleanup) void cleanup.catch(() => {});
				} catch {
					// Provider cancellation failures cannot change the committed aborted message.
				}
				const aborted = emitAbortedAssistantMessage(
					partialMessage,
					addedPartial,
					completedToolCallIds,
					context,
					config,
					stream,
					requestSignal,
				);
				if (turnInstrumentation !== "off") {
					// The returned object IS the context/persisted message, so metrics set
					// here reach the durable record even though the stream events already flushed.
					aborted.turnMetrics = captureAssistantTurnMetrics({
						level: turnInstrumentation,
						startedAt: requestStartedAt,
						endedAt: aborted.timestamp ?? Date.now(),
						status: "aborted",
						ttftMs: aborted.ttft,
						usage: aborted.usage,
						upstreamProvider: aborted.upstreamProvider,
					});
					aborted.request = captureAssistantTurnRequest({
						level: turnInstrumentation,
						temperature: effectiveTemperature,
						topP: config.topP,
						topK: config.topK,
						maxTokens: config.maxTokens,
						presencePenalty: config.presencePenalty,
						reasoningEffort: effectiveReasoning,
						disableReasoning: effectiveDisableReasoning,
						toolChoice: effectiveToolChoice,
						serviceTier: effectiveServiceTier,
					});
				}
				await finishChat(aborted);
				return aborted;
			};

			let abortRacePromise: Promise<typeof ABORTED> | undefined;
			let detachAbortListener: (() => void) | undefined;
			if (requestSignal) {
				if (requestSignal.aborted) {
					return await finishAbortedStream();
				}
				const { promise, resolve } = Promise.withResolvers<typeof ABORTED>();
				const onAbort = () => resolve(ABORTED);
				requestSignal.addEventListener("abort", onAbort, { once: true });
				abortRacePromise = promise;
				detachAbortListener = () => requestSignal.removeEventListener("abort", onAbort);
			}

			try {
				while (true) {
					let next: IteratorResult<AssistantMessageEvent>;
					if (abortRacePromise) {
						const result = await Promise.race([responseIterator.next(), abortRacePromise]);
						if (result === ABORTED) {
							return await finishAbortedStream();
						}
						next = result;
					} else {
						next = await responseIterator.next();
					}
					if (next.done) break;

					const event = next.value;
					if (event.type === "done" || event.type === "error") {
						let finalMessage = disambiguateToolCallIds(
							recoverTransientErrorToolTurn(
								retainCompletedToolCalls(await response.result(), completedToolCallIds),
								context.tools ?? [],
							),
							storedToolCallIds(context.messages, addedPartial),
						);
						if (harmonyMitigationEnabled) {
							const detection = detectHarmonyLeakInAssistantMessage(finalMessage);
							if (detection) {
								const recovered = recoverHarmonyToolCall(finalMessage, detection);
								const removed = recovered?.removed ?? extractHarmonyRemoved(finalMessage, detection);
								if (addedPartial) {
									emitDiscardedHarmonyPartial(
										partialMessage,
										stream,
										`Discarded after GPT-5 Harmony protocol leakage (${signalListLabel(detection.signals)})`,
									);
									context.messages.pop();
									addedPartial = false;
								}
								throw new HarmonyLeakInterruption(detection, removed, recovered);
							}
						}
						finalMessage = snapshotAssistantMessage(finalMessage);
						if (turnInstrumentation !== "off") {
							const status: AssistantTurnStatus =
								event.type === "error" || finalMessage.errorMessage ? "error" : "ok";
							finalMessage.turnMetrics = captureAssistantTurnMetrics({
								level: turnInstrumentation,
								startedAt: requestStartedAt,
								endedAt: finalMessage.timestamp ?? Date.now(),
								status,
								ttftMs: finalMessage.ttft,
								usage: finalMessage.usage,
								upstreamProvider: finalMessage.upstreamProvider,
							});
							finalMessage.request = captureAssistantTurnRequest({
								level: turnInstrumentation,
								temperature: effectiveTemperature,
								topP: config.topP,
								topK: config.topK,
								maxTokens: config.maxTokens,
								presencePenalty: config.presencePenalty,
								reasoningEffort: effectiveReasoning,
								disableReasoning: effectiveDisableReasoning,
								toolChoice: effectiveToolChoice,
								serviceTier: effectiveServiceTier,
							});
						}
						if (config.transformAssistantMessage) {
							await config.transformAssistantMessage(finalMessage, requestSignal);
						}
						if (addedPartial) {
							context.messages[context.messages.length - 1] = finalMessage;
						} else {
							context.messages.push(finalMessage);
						}
						if (!addedPartial) {
							stream.push({ type: "message_start", message: snapshotAssistantMessage(finalMessage) });
						}
						stream.push({ type: "message_end", message: snapshotAssistantMessage(finalMessage) });
						await finishChat(finalMessage);
						return finalMessage;
					}
					if (requestSignal?.aborted) {
						return await finishAbortedStream();
					}

					// Yield to the event loop periodically to prevent busy-wait
					// when the LLM is streaming chunks faster than the loop can rest.
					await yieldIfDue();

					switch (event.type) {
						case "start":
							partialMessage = event.partial;
							if (addedPartial) {
								context.messages[context.messages.length - 1] = partialMessage;
								completedToolCallIds.clear();
								const messageSnapshot = snapshotAssistantMessage(partialMessage, "delta");
								stream.push({
									type: "message_update",
									assistantMessageEvent: snapshotAssistantMessageEvent(event, messageSnapshot),
									message: messageSnapshot,
								});
							} else {
								context.messages.push(partialMessage);
								addedPartial = true;
								stream.push({ type: "message_start", message: snapshotAssistantMessage(partialMessage) });
							}
							break;

						case "text_start":
						case "text_delta":
						case "text_end":
						case "thinking_start":
						case "thinking_delta":
						case "thinking_end":
						case "toolcall_start":
						case "toolcall_delta":
						case "toolcall_end":
							if (partialMessage) {
								if (event.type === "toolcall_end") {
									completedToolCallIds.add(event.toolCall.id);
								}
								partialMessage = event.partial;
								context.messages[context.messages.length - 1] = partialMessage;
								config.onAssistantMessageEvent?.(partialMessage, event);
								const messageSnapshot = snapshotAssistantMessage(partialMessage, "delta");
								stream.push({
									type: "message_update",
									assistantMessageEvent: snapshotAssistantMessageEvent(event, messageSnapshot),
									message: messageSnapshot,
								});
							}
							break;
					}
				}
			} finally {
				detachAbortListener?.();
			}

			let trailing = await response.result();
			if (harmonyMitigationEnabled) {
				const detection = detectHarmonyLeakInAssistantMessage(trailing);
				if (detection) {
					const recovered = recoverHarmonyToolCall(trailing, detection);
					const removed = recovered?.removed ?? extractHarmonyRemoved(trailing, detection);
					if (addedPartial) {
						emitDiscardedHarmonyPartial(
							partialMessage,
							stream,
							`Discarded after GPT-5 Harmony protocol leakage (${signalListLabel(detection.signals)})`,
						);
						context.messages.pop();
						addedPartial = false;
					}
					throw new HarmonyLeakInterruption(detection, removed, recovered);
				}
			}
			trailing = snapshotAssistantMessage(trailing);
			if (addedPartial) {
				context.messages[context.messages.length - 1] = trailing;
				stream.push({ type: "message_end", message: snapshotAssistantMessage(trailing) });
			}
			await finishChat(trailing);
			return trailing;
		});
	} catch (err) {
		failChatSpan(telemetry, chatSpan, {
			errorObject: err,
			responseHeaders: capturedHeaders,
			baseUrl: model.baseUrl,
		});
		throw err;
	}
}

/** Check if an incomplete tool call has parseable JSON arguments. */
function completedStreamedArguments(block: StreamingPartialJsonCarrier): Record<string, unknown> | undefined {
	const accumulated = getStreamingPartialJson(block)?.trim();
	if (!accumulated) return undefined;
	try {
		const parsed: unknown = JSON.parse(accumulated);
		return isRecord(parsed) ? parsed : undefined;
	} catch {
		return undefined;
	}
}

/** Drop toolCall blocks whose arguments never finished streaming. */
function retainCompletedToolCalls(
	message: AssistantMessage,
	completedToolCallIds: ReadonlySet<string>,
): AssistantMessage {
	if (message.stopReason !== "error" && message.stopReason !== "aborted") return message;
	const incompleteToolCalls: IncompleteToolCall[] = [];
	const content: AssistantMessage["content"] = [];
	let settledAny = false;
	for (const block of message.content) {
		if (block.type !== "toolCall") {
			content.push(block);
			continue;
		}
		if (completedToolCallIds.has(block.id)) {
			content.push(block);
			continue;
		}
		const settled = completedStreamedArguments(block);
		if (settled) {
			const retained = { ...block, arguments: settled };
			clearStreamingPartialJson(retained);
			content.push(retained);
			settledAny = true;
			continue;
		}
		incompleteToolCalls.push({ id: block.id, name: block.name });
	}
	if (incompleteToolCalls.length === 0) return settledAny ? { ...message, content } : message;
	return {
		...message,
		content,
		incompleteToolCalls,
		stopDetails:
			message.stopDetails?.type === STREAM_INTERRUPTED_AFTER_CONTENT_STOP_DETAIL
				? message.stopDetails
				: {
						type: STREAM_INTERRUPTED_AFTER_CONTENT_STOP_DETAIL,
						category: message.stopDetails?.type ?? null,
						explanation: message.stopDetails?.explanation ?? message.errorMessage ?? null,
					},
	};
}

/** Assign unique IDs to duplicate tool calls within an assistant message. */
function disambiguateToolCallIds(message: AssistantMessage, takenIds: ReadonlySet<string>): AssistantMessage {
	const seen = new Set<string>();
	let content: AssistantMessage["content"] | undefined;
	for (const [index, block] of message.content.entries()) {
		if (block.type !== "toolCall") continue;
		if (!seen.has(block.id) && !takenIds.has(block.id)) {
			seen.add(block.id);
			continue;
		}
		const taken = (candidate: string): boolean =>
			seen.has(candidate) ||
			takenIds.has(candidate) ||
			message.content.some(other => other.type === "toolCall" && other.id === candidate);
		let suffix = 2;
		while (taken(`${block.id}_${suffix}`)) suffix += 1;
		const unique = `${block.id}_${suffix}`;
		seen.add(unique);
		content ??= message.content.slice();
		content[index] = { ...block, id: unique };
	}
	return content ? { ...message, content } : message;
}

/** Collect all tool-call IDs already present on this branch. */
function storedToolCallIds(messages: readonly AgentMessage[], skipTrailing: boolean): Set<string> {
	const ids = new Set<string>();
	const end = skipTrailing ? messages.length - 1 : messages.length;
	for (let index = 0; index < end; index++) {
		const message = messages[index];
		if (message.role !== "assistant") continue;
		for (const block of message.content) {
			if (block.type === "toolCall") ids.add(block.id);
		}
	}
	return ids;
}

function recoverTransientErrorToolTurn(
	message: AssistantMessage,
	availableTools: ReadonlyArray<Pick<AgentTool, "name" | "customWireName">>,
): AssistantMessage {
	if (message.stopReason !== "error") return message;
	const toolCalls = message.content.filter(block => block.type === "toolCall");
	if (toolCalls.length === 0) return message;
	const availableToolNames = new Set<string>();
	for (const tool of availableTools) {
		availableToolNames.add(tool.name);
		if (tool.customWireName !== undefined) availableToolNames.add(tool.customWireName);
	}
	if (!toolCalls.every(toolCall => availableToolNames.has(toolCall.name))) return message;
	if (!AIError.isStreamReadErrorText(`${message.errorMessage ?? ""}\n${message.stopDetails?.explanation ?? ""}`))
		return message;
	return {
		...message,
		stopReason: "toolUse",
		stopDetails:
			message.stopDetails?.type === STREAM_INTERRUPTED_AFTER_CONTENT_STOP_DETAIL
				? message.stopDetails
				: {
						type: STREAM_INTERRUPTED_AFTER_CONTENT_STOP_DETAIL,
						category: message.stopDetails?.type ?? null,
						explanation: message.stopDetails?.explanation ?? message.errorMessage ?? null,
					},
		errorMessage: undefined,
		errorId: undefined,
		errorStatus: undefined,
	};
}

function emitDiscardedHarmonyPartial(
	partialMessage: AssistantMessage | null,
	stream: EventStream<AgentEvent, AgentMessage[]>,
	errorMessage: string,
): void {
	if (!partialMessage) return;
	stream.push({
		type: "message_end",
		message: snapshotAssistantMessage({ ...partialMessage, stopReason: "error", errorMessage }),
	});
}

function isStringRecord(value: unknown): value is Record<string, string> {
	if (!isRecord(value)) return false;
	return Object.values(value).every(child => typeof child === "string");
}

function toolScopedAbortReason(signal: AbortSignal | undefined): ToolScopedAbortReason | undefined {
	const reason = signal?.reason;
	if (!reason || typeof reason !== "object") return undefined;
	if (Reflect.get(reason, "kind") !== "tool-scoped-abort") return undefined;
	if (typeof Reflect.get(reason, "message") !== "string") return undefined;
	if (typeof Reflect.get(reason, "defaultToolCallMessage") !== "string") return undefined;
	return isStringRecord(Reflect.get(reason, "toolCallMessages")) ? reason : undefined;
}

function buildToolCallAbortMessages(
	message: AssistantMessage,
	reason: ToolScopedAbortReason,
): Record<string, string> | undefined {
	let hasToolCall = false;
	const messages: Record<string, string> = {};
	for (const block of message.content) {
		if (block.type !== "toolCall") continue;
		hasToolCall = true;
		messages[block.id] = reason.toolCallMessages[block.id] ?? reason.defaultToolCallMessage;
	}
	return hasToolCall ? messages : undefined;
}

/** Resolve human-readable abort reason. */
export function abortReasonText(signal: AbortSignal | undefined): string {
	const scopedReason = toolScopedAbortReason(signal);
	if (scopedReason) return scopedReason.message;
	const reason = signal?.reason;
	if (typeof reason === "string" && reason.trim().length > 0) return reason;
	if (reason instanceof Error && !isAbortError(reason) && reason.message.trim().length > 0) {
		return reason.message;
	}
	return "Request was aborted";
}

function emitAbortedAssistantMessage(
	partialMessage: AssistantMessage | null,
	addedPartial: boolean,
	completedToolCallIds: ReadonlySet<string>,
	context: AgentContext,
	config: AgentLoopConfig,
	stream: EventStream<AgentEvent, AgentMessage[]>,
	requestSignal: AbortSignal | undefined,
): AssistantMessage {
	const model = config.getModel?.() ?? config.model;
	const errorMessage = abortReasonText(requestSignal);
	// Mark message as abort and combine with classified reason flag.
	const errorId = AIError.create(AIError.Flag.Abort) | (AIError.classify(requestSignal?.reason) || 0);
	const base: AssistantMessage = partialMessage
		? { ...partialMessage, stopReason: "aborted", errorMessage, errorId }
		: {
				role: "assistant",
				content: [],
				api: model.api,
				provider: model.provider,
				model: model.id,
				usage: emptyUsage(),
				stopReason: "aborted",
				errorMessage,
				errorId,
				timestamp: Date.now(),
			};
	const retained = disambiguateToolCallIds(
		retainCompletedToolCalls(base, completedToolCallIds),
		storedToolCallIds(context.messages, addedPartial),
	);
	const scopedAbort = toolScopedAbortReason(requestSignal);
	const toolCallAbortMessages = scopedAbort ? buildToolCallAbortMessages(retained, scopedAbort) : undefined;
	if (toolCallAbortMessages) {
		retained.toolCallAbortMessages = toolCallAbortMessages;
	}
	const abortedMessage = snapshotAssistantMessage(retained);
	if (addedPartial) {
		context.messages[context.messages.length - 1] = abortedMessage;
	} else {
		context.messages.push(abortedMessage);
		stream.push({ type: "message_start", message: snapshotAssistantMessage(abortedMessage) });
	}
	stream.push({ type: "message_end", message: snapshotAssistantMessage(abortedMessage) });
	return abortedMessage;
}

/** Execute tool calls from an assistant message. */
async function executeToolCalls(
	currentContext: AgentContext,
	assistantMessage: AssistantMessage,
	signal: AbortSignal | undefined,
	stream: EventStream<AgentEvent, AgentMessage[]>,
	config: AgentLoopConfig,
	telemetry: AgentTelemetry | undefined,
	invokeAgentSpan: Span | undefined,
): Promise<{ toolResults: ToolResultMessage[] }> {
	const tools = currentContext.tools;
	const {
		hasSteeringMessages,
		hasIrcInterrupts,
		interruptMode = "immediate",
		getToolContext,
		transformToolCallArguments,
		intentTracing,
		instrumentation,
		beforeToolCall,
		afterToolCall,
	} = config;
	const instrumentationLevel = instrumentation ?? "off";
	type ToolCallContent = Extract<AssistantMessage["content"][number], { type: "toolCall" }>;
	const toolCalls = assistantMessage.content.filter(
		(c): c is ToolCallContent =>
			c.type === "toolCall" && (c as CursorExecResolvedCarrier)[kCursorExecResolved] !== true,
	);
	const emittedToolResults: ToolResultMessage[] = [];
	const toolCallInfos = toolCalls.map(call => ({ id: call.id, name: call.name }));
	const batchId = `${assistantMessage.timestamp ?? Date.now()}_${toolCalls[0]?.id ?? "batch"}`;
	const shouldInterruptImmediately = interruptMode !== "wait";
	const steeringAbortController = new AbortController();
	const ircAbortController = new AbortController();
	const nonInterruptibleSignal: AbortSignal = signal
		? AbortSignal.any([signal, steeringAbortController.signal])
		: steeringAbortController.signal;
	const interruptibleSignal: AbortSignal = signal
		? AbortSignal.any([signal, steeringAbortController.signal, ircAbortController.signal])
		: AbortSignal.any([steeringAbortController.signal, ircAbortController.signal]);
	const interruptState: { triggered: boolean; source?: SteeringInterruptSource | "irc" } = { triggered: false };

	// Dispatch instant: instrumentation measures a call's queue wait as the gap
	// between this and its execution start, so stamp it once, before scheduling.
	const dispatchedAt = instrumentationLevel === "off" ? 0 : Date.now();
	const records = toolCalls.map((toolCall, batchIndex) => {
		const tool =
			tools?.find(t => t.name === toolCall.name) ??
			tools?.find(t => t.customWireName !== undefined && t.customWireName === toolCall.name);
		const declaredInterruptible = tool?.interruptible;
		let interruptible: boolean;
		if (typeof declaredInterruptible === "function") {
			try {
				interruptible = declaredInterruptible(toolCall.arguments as Record<string, unknown>) === true;
			} catch (error) {
				interruptible = false;
				logger.warn("tool interruptible resolver threw; treating the call as uninterruptible", {
					tool: tool?.name,
					error: errorMessage(error),
				});
			}
		} else {
			interruptible = declaredInterruptible === true;
		}
		return {
			toolCall,
			tool,
			batchIndex,
			args: toolCall.arguments as Record<string, unknown>,
			interruptible,
			signal: interruptible ? interruptibleSignal : nonInterruptibleSignal,
			started: false,
			entered: false,
			startedAt: undefined as number | undefined,
			concurrency: undefined as "shared" | "exclusive" | undefined,
			result: undefined as AgentToolResult<any> | undefined,
			isError: false,
			skipped: false,
			terminalStatus: undefined as ToolCallStatus | undefined,
			toolResultMessage: undefined as ToolResultMessage | undefined,
			resultEmitted: false,
		};
	});

	const checkSteering = async (): Promise<void> => {
		if (!shouldInterruptImmediately || signal?.aborted) {
			return;
		}
		let steeringQueued = false;
		let steeringSource: SteeringInterruptSource | undefined;
		if (hasSteeringMessages) {
			const queuedState = await hasSteeringMessages();
			if (typeof queuedState === "boolean") {
				steeringQueued = queuedState;
				steeringSource = queuedState ? "user" : undefined;
			} else {
				const state: SteeringQueueState = queuedState;
				steeringQueued = state.queued;
				steeringSource = state.source ?? (state.queued ? "unknown" : undefined);
			}
		}
		if (steeringQueued) {
			if (!steeringAbortController.signal.aborted) {
				interruptState.triggered = true;
				interruptState.source = steeringSource ?? "unknown";
				steeringAbortController.abort();
			}
			return;
		}
		// IRC only fires once: a peer interrupt already recorded on interruptState
		// must not re-abort, and (unlike steering above) never re-consume a queue.
		if (interruptState.triggered) return;
		if (hasIrcInterrupts && (await hasIrcInterrupts())) {
			// Peer IRC only aborts interruptible waits: a foreground bash / write
			// mid-execution keeps running so we never leave partial side effects.
			interruptState.triggered = true;
			interruptState.source = "irc";
			ircAbortController.abort();
		}
	};

	const emitToolResult = (record: (typeof records)[number], result: AgentToolResult<any>, isError: boolean): void => {
		if (record.resultEmitted) return;
		const { toolCall } = record;
		if (!record.started) {
			stream.push({
				type: "tool_execution_start",
				toolCallId: toolCall.id,
				toolName: toolCall.name,
				args: record.args,
				intent: toolCall.intent,
			});
		}
		stream.push({
			type: "tool_execution_end",
			toolCallId: toolCall.id,
			toolName: toolCall.name,
			result,
			isError,
		});

		const endedAt = Date.now();
		const status: ToolCallStatus = record.terminalStatus ?? (record.skipped ? "skipped" : isError ? "error" : "ok");
		const cappedContent = capToolResultContent(result.content, toolCall.name).content;
		const metrics =
			instrumentationLevel === "off"
				? undefined
				: captureToolCallMetrics({
						level: instrumentationLevel,
						startedAt: record.startedAt ?? endedAt,
						endedAt,
						queuedAt: dispatchedAt,
						concurrency: record.concurrency,
						batchId,
						batchIndex: record.batchIndex,
						batchSize: toolCalls.length,
						status,
						interruptible: record.interruptible,
						signalAborted: record.signal.aborted,
						resultContent: cappedContent,
						useless: result.useless === true,
						args: record.args,
						countTokens: estimateTokensFromText,
					});
		const toolResultMessage: ToolResultMessage = {
			role: "toolResult",
			toolCallId: toolCall.id,
			toolName: toolCall.name,
			content: cappedContent,
			details: result.details,
			isError,
			...(result.useless && !isError ? { useless: true } : {}),
			...(metrics ? { metrics } : {}),
			timestamp: endedAt,
		};
		record.result = result;
		record.isError = isError;
		record.toolResultMessage = toolResultMessage;
		record.resultEmitted = true;
		emittedToolResults.push(toolResultMessage);

		stream.push({ type: "message_start", message: toolResultMessage });
		stream.push({ type: "message_end", message: toolResultMessage });
	};

	const runTool = async (record: (typeof records)[number], index: number): Promise<void> => {
		if (interruptState.triggered) {
			// Skip both span emission and the collector orphan record here. The
			// tail sweep below (after `Promise.allSettled`) is the single path
			// that handles "no result message was produced" — it calls
			// `recordSkippedTool` and `emitToolResult` once per record, so any
			// work we did here would double-count.
			record.skipped = true;
			return;
		}
		const pauseGate = config.pauseGate ?? agentPauseGate;
		if (pauseGate.paused) {
			try {
				await pauseGate.waitUntilResumed(record.signal);
			} catch (err) {
				if (isAbortError(err) || record.signal.aborted) {
					record.skipped = true;
					return;
				}
				throw err;
			}
		}

		const { toolCall, tool } = record;
		let argsForExecution = toolCall.arguments as Record<string, unknown>;
		if (intentTracing) {
			const { intent, strippedArgs } = extractIntent(toolCall.arguments);
			argsForExecution = strippedArgs;
			if (intent) {
				toolCall.intent = intent;
			} else if (typeof tool?.intent === "function") {
				try {
					const derived = tool.intent(strippedArgs as never)?.trim();
					if (derived) {
						toolCall.intent = derived;
					}
				} catch (error) {
					// Must never break tool execution, but a throwing intent
					// resolver is a broken tool feature — surface it.
					logger.warn("tool intent resolver threw; using the default intent label", {
						tool: toolCall.name,
						error: errorMessage(error),
					});
				}
			}
		}
		let effectiveArgs: Record<string, unknown>;
		try {
			if (!tool)
				throw new AIError.ToolNotFoundError(
					toolCall.name,
					tools?.map(t => t.name),
				);
			if (config.repairToolCallArguments) {
				const repairOutcome = config.repairToolCallArguments(tool, {
					...toolCall,
					arguments: argsForExecution,
				});
				if (repairOutcome.status === "unrepairable") {
					const hintSuffix =
						repairOutcome.hints.length > 0
							? `\n\n[Tool argument repair]\n${repairOutcome.hints.map(h => `- ${h}`).join("\n")}`
							: "";
					const errorText = `${repairOutcome.reason ?? "Tool arguments could not be repaired."}${hintSuffix}`;
					record.args = argsForExecution;
					emitToolResult(
						record,
						{
							content: [{ type: "text" as const, text: errorText }],
							details: { isError: true, error: errorText },
						},
						true,
					);
					return;
				}
				argsForExecution = repairOutcome.arguments;
				if (intentTracing) {
					const { intent, strippedArgs } = extractIntent(argsForExecution);
					argsForExecution = strippedArgs;
					if (intent) {
						toolCall.intent = intent;
					}
				}
			}
			effectiveArgs = validateToolArguments(tool, { ...toolCall, arguments: argsForExecution });
		} catch (validationError) {
			if (tool?.lenientArgValidation) {
				effectiveArgs = { ...argsForExecution };
				delete effectiveArgs.__parseError;
				delete effectiveArgs.__rawJson;
			} else {
				if ("__parseError" in argsForExecution) {
					record.args = {
						__parseError: argsForExecution.__parseError,
					};
				} else {
					record.args = argsForExecution;
				}
				emitToolResult(
					record,
					{
						content: [
							{
								type: "text" as const,
								text: errorMessage(validationError),
							},
						],
						details: {
							isError: true,
							error: errorMessage(validationError),
						},
					},
					true,
				);
				return;
			}
		}

		let displayArgs = effectiveArgs;
		if (transformToolCallArguments) {
			try {
				const transformed = transformToolCallArguments(effectiveArgs, toolCall.name);
				effectiveArgs = transformed.execution;
				displayArgs = transformed.display;
			} catch (transformError) {
				record.args = effectiveArgs;
				emitToolResult(
					record,
					{
						content: [{ type: "text" as const, text: errorMessage(transformError) }],
						details: {
							isError: true,
							error: errorMessage(transformError),
						},
					},
					true,
				);
				return;
			}
		}

		record.args = displayArgs;
		if (record.signal.aborted) {
			record.skipped = true;
			record.terminalStatus = "aborted";
			recordSkippedTool(telemetry, {
				toolCallId: toolCall.id,
				toolName: toolCall.name,
				status: "aborted",
			});
			emitToolResult(
				record,
				createToolSignalAbortedResult(
					record.signal,
					interruptState.triggered ? interruptState.source : "cancelled-run",
					record.entered,
				),
				true,
			);
			return;
		}
		record.started = true;
		stream.push({
			type: "tool_execution_start",
			toolCallId: toolCall.id,
			toolName: toolCall.name,
			args: displayArgs,
			intent: toolCall.intent,
		});

		const toolSpan = startExecuteToolSpan(telemetry, {
			tool,
			toolName: toolCall.name,
			toolCallId: toolCall.id,
			args: displayArgs,
			parent: invokeAgentSpan,
		});
		if (toolSpan && toolCall.intent) {
			toolSpan.setAttribute(PiGenAIAttr.ToolCallIntent, toolCall.intent);
		}

		let result: AgentToolResult<any> = { content: [], details: {} };
		let isError = false;
		let caughtError: unknown;
		let completedToolExecution = false;

		await runInActiveSpan(toolSpan, async () => {
			try {
				if (!tool)
					throw new AIError.ToolNotFoundError(
						toolCall.name,
						tools?.map(t => t.name),
					);
				if (record.signal.aborted) {
					result = createToolSignalAbortedResult(
						record.signal,
						interruptState.triggered ? interruptState.source : "cancelled-run",
						record.entered,
					);
					isError = true;
					return;
				}

				if (beforeToolCall) {
					const beforeResult = await beforeToolCall(
						{
							assistantMessage,
							toolCall,
							args: effectiveArgs,
							context: currentContext,
						},
						record.signal,
					);
					if (beforeResult?.block) {
						throw new ToolCallBlockedError(beforeResult.reason);
					}
				}
				if (record.signal.aborted) {
					result = createToolSignalAbortedResult(
						record.signal,
						interruptState.triggered ? interruptState.source : "cancelled-run",
						record.entered,
					);
					isError = true;
					return;
				}
				const toolContext = getToolContext
					? getToolContext({
							batchId,
							index,
							total: toolCalls.length,
							toolCalls: toolCallInfos,
						})
					: undefined;
				if (instrumentationLevel !== "off") record.startedAt = Date.now();
				record.entered = true;
				const rawResult = await tool.execute(
					toolCall.id,
					effectiveArgs,
					record.signal,
					partialResult => {
						stream.push({
							type: "tool_execution_update",
							toolCallId: toolCall.id,
							toolName: toolCall.name,
							args: displayArgs,
							partialResult: coerceToolResult(partialResult).result,
						});
					},
					toolContext,
				);
				completedToolExecution = true;
				const coerced = coerceToolResult(rawResult);
				result = coerced.result;
				if (coerced.malformed || result.isError) isError = true;
			} catch (e) {
				caughtError = e;
				result = {
					content: [{ type: "text", text: errorMessage(e) }],
					details: {},
				};
				isError = true;
			}

			if (afterToolCall && (!record.signal.aborted || completedToolExecution)) {
				try {
					const after = await afterToolCall(
						{
							assistantMessage,
							toolCall,
							args: record.args,
							result,
							isError,
							context: currentContext,
						},
						record.signal,
					);
					if (after) {
						const coerced = coerceToolResult({
							content: after.content ?? result.content,
							details: after.details ?? result.details,
							isError: after.isError ?? result.isError,
							useless: after.useless ?? result.useless,
						});
						result = coerced.result;
						isError = coerced.malformed || (after.isError ?? isError);
					}
				} catch (e) {
					caughtError = e;
					result = {
						content: [{ type: "text", text: errorMessage(e) }],
						details: {},
					};
					isError = true;
				}
			}
		});

		const interrupted = interruptState.triggered;
		const perToolAborted = record.signal.aborted;
		const abortedDuringExecution = perToolAborted && isError && !completedToolExecution;
		const status: ToolCallStatus = abortedDuringExecution
			? "aborted"
			: caughtError instanceof ToolCallBlockedError
				? "blocked"
				: isError
					? "error"
					: "ok";
		record.terminalStatus = status;
		if (abortedDuringExecution) {
			record.skipped = true;
			emitToolResult(
				record,
				createSkippedToolResult(interrupted ? interruptState.source : "cancelled-run", record.entered),
				true,
			);
		} else {
			emitToolResult(record, result, isError);
		}

		const firstTextBlock = result.content?.[0];
		const errorMessageForSpan =
			caughtError === undefined && isError && firstTextBlock?.type === "text" ? firstTextBlock.text : undefined;
		finishExecuteToolSpan(telemetry, toolSpan, {
			result,
			isError,
			status,
			errorMessage: errorMessageForSpan,
			errorObject: caughtError,
			toolCallId: toolCall.id,
			toolName: toolCall.name,
		});

		await checkSteering();
	};

	let lastExclusive: Promise<void> = Promise.resolve();
	let sharedTasks: Promise<void>[] = [];
	const tasks: Promise<void>[] = [];

	for (let index = 0; index < records.length; index++) {
		const record = records[index];
		const concurrencyMode = record.tool?.concurrency;
		let concurrency: "shared" | "exclusive";
		if (typeof concurrencyMode === "function") {
			// Resolved from raw pre-validation args; a throwing resolver must not
			// take down the whole batch, so fall back to the safe (serial) mode.
			try {
				concurrency = concurrencyMode(record.args);
			} catch (error) {
				concurrency = "exclusive";
				logger.warn("tool concurrency resolver threw; running the call serially", {
					tool: record.tool?.name,
					error: errorMessage(error),
				});
			}
		} else {
			concurrency = concurrencyMode ?? "shared";
		}
		record.concurrency = concurrency;
		const start = concurrency === "exclusive" ? Promise.all([lastExclusive, ...sharedTasks]) : lastExclusive;
		const task = start.then(() => runTool(record, index));
		tasks.push(task);
		if (concurrency === "exclusive") {
			lastExclusive = task;
			sharedTasks = [];
		} else {
			sharedTasks.push(task);
		}
	}

	const watchSteeringWhileRunning =
		shouldInterruptImmediately &&
		(hasSteeringMessages !== undefined || hasIrcInterrupts !== undefined) &&
		records.some(r => r.interruptible);
	const steeringWatchTimer = watchSteeringWhileRunning
		? setInterval(() => void checkSteering(), STEERING_INTERRUPT_POLL_MS)
		: undefined;
	try {
		await Promise.allSettled(tasks);
	} finally {
		if (steeringWatchTimer !== undefined) clearInterval(steeringWatchTimer);
	}
	// Yield after batch tool execution to let GC and I/O catch up,
	// especially when tool results are large (e.g. bash output).
	await yieldIfDue();

	const unresolved = records.filter(record => !record.toolResultMessage);
	const batchLedger =
		unresolved.length > 0 && records.length > 1
			? buildToolBatchLedger(
					"interrupted",
					records.map(record => ({
						toolCallId: record.toolCall.id,
						toolName: record.toolCall.name,
						outcome:
							record.skipped || !record.toolResultMessage
								? record.entered
									? ("interrupted" as const)
									: ("dropped" as const)
								: record.isError
									? ("failed" as const)
									: ("ok" as const),
					})),
				)
			: undefined;
	let ledgerAttached = false;
	for (const record of unresolved) {
		record.skipped = true;
		record.terminalStatus = "skipped";
		recordSkippedTool(telemetry, {
			toolCallId: record.toolCall.id,
			toolName: record.toolCall.name,
			status: "skipped",
		});
		const ledger = ledgerAttached ? undefined : batchLedger;
		ledgerAttached = true;
		emitToolResult(record, createSkippedToolResult(interruptState.source, record.entered, ledger), true);
	}

	return { toolResults: emittedToolResults };
}

/** Discriminator for tool calls never executed locally. */
export interface SyntheticToolResultDetails {
	__synthetic: true;
	source: "assistant_stop_aborted" | "assistant_stop_error" | "assistant_stop_skipped" | "assistant_stop_length";
	executed: false;
	upstreamError?: string;
	batchLedger?: ToolBatchLedger;
}

/** Details for a tool call interrupted during execution. */
export interface SkippedToolResultDetails {
	__skipped: true;
	source: SteeringInterruptSource | "irc" | "cancelled-run" | "steering";
	/** True when `tool.execute()` had been entered, so side effects may be partial. */
	entered: boolean;
	batchLedger?: ToolBatchLedger;
}

function syntheticDetailsFor(
	reason: "aborted" | "error" | "skipped" | "length",
	errorMessage: string | undefined,
	batchLedger: ToolBatchLedger | undefined,
): SyntheticToolResultDetails {
	const source: SyntheticToolResultDetails["source"] =
		reason === "aborted"
			? "assistant_stop_aborted"
			: reason === "error"
				? "assistant_stop_error"
				: reason === "length"
					? "assistant_stop_length"
					: "assistant_stop_skipped";
	return {
		__synthetic: true,
		source,
		executed: false,
		...(reason === "error" && errorMessage ? { upstreamError: errorMessage } : {}),
		...(batchLedger ? { batchLedger } : {}),
	};
}

/** Create placeholder results for tools emitted before stream termination. */
function buildAbortedTurnLedger(
	cause: ToolBatchLedgerCause,
	message: AssistantMessage,
	contextMessages: ReadonlyArray<AgentMessage>,
): ToolBatchLedger | undefined {
	const entries: ToolBatchCallEntry[] = [];
	let resolvedOutcomes: Map<string, boolean> | undefined;
	for (const block of message.content) {
		if (block.type !== "toolCall") continue;
		if ((block as CursorExecResolvedCarrier)[kCursorExecResolved] !== true) {
			entries.push({ toolCallId: block.id, toolName: block.name, outcome: "dropped" });
			continue;
		}
		if (!resolvedOutcomes) {
			resolvedOutcomes = new Map<string, boolean>();
			for (const prior of contextMessages) {
				if (prior.role === "toolResult") resolvedOutcomes.set(prior.toolCallId, prior.isError === true);
			}
		}
		const isError = resolvedOutcomes.get(block.id);
		entries.push({
			toolCallId: block.id,
			toolName: block.name,
			outcome: isError === undefined ? "interrupted" : isError ? "failed" : "ok",
		});
	}
	for (const incomplete of message.incompleteToolCalls ?? []) {
		entries.push({
			toolCallId: incomplete.id,
			toolName: incomplete.name,
			outcome: "dropped",
			argumentsIncomplete: true,
		});
	}
	if (entries.length === 0) return undefined;
	const lone = entries.length === 1 ? entries[0] : undefined;
	if (lone) {
		if (lone.outcome === "ok" || lone.outcome === "failed") return undefined;
		if (lone.outcome === "dropped" && lone.argumentsIncomplete !== true) return undefined;
	}
	return buildToolBatchLedger(cause, entries);
}

/** Create placeholder result for an unexecuted tool call. */
function createAbortedToolResult(
	toolCall: Extract<AssistantMessage["content"][number], { type: "toolCall" }>,
	stream: EventStream<AgentEvent, AgentMessage[]>,
	reason: "aborted" | "error" | "skipped" | "length",
	errorMessage?: string,
	batchLedger?: ToolBatchLedger,
): ToolResultMessage {
	const message =
		reason === "aborted"
			? "Tool execution was aborted"
			: reason === "length"
				? "Tool call was not executed because the assistant hit its output token limit (stop_reason: length) before the arguments could complete; the recorded arguments are truncated and unsafe to run. Do NOT retry by re-emitting the same large payload — split the work into several smaller tool calls (e.g. for `write`/`edit`, write the first chunk then append the rest with subsequent `edit` insert ops, or break the file into multiple `write` targets)"
				: reason === "skipped"
					? "Tool call was not executed because the assistant ended its turn"
					: "Tool call was not executed because the provider stream ended with an error before the tool could run";
	const details = syntheticDetailsFor(reason, errorMessage, batchLedger);
	const headline = errorMessage ? `${message}: ${errorMessage}` : `${message}.`;
	const result: AgentToolResult<SyntheticToolResultDetails> = {
		content: [
			{ type: "text", text: batchLedger ? `${headline}\n\n${renderToolBatchLedger(batchLedger)}` : headline },
		],
		details,
	};

	stream.push({
		type: "tool_execution_start",
		toolCallId: toolCall.id,
		toolName: toolCall.name,
		args: toolCall.arguments,
		intent: toolCall.intent,
	});
	stream.push({
		type: "tool_execution_end",
		toolCallId: toolCall.id,
		toolName: toolCall.name,
		result,
		isError: true,
	});

	const toolResultMessage: ToolResultMessage<SyntheticToolResultDetails> = {
		role: "toolResult",
		toolCallId: toolCall.id,
		toolName: toolCall.name,
		content: result.content,
		details,
		isError: true,
		timestamp: Date.now(),
	};

	stream.push({ type: "message_start", message: toolResultMessage });
	stream.push({ type: "message_end", message: toolResultMessage });

	return toolResultMessage;
}

/** Create placeholder result for a call aborted before execution started. */
function createToolSignalAbortedResult(
	signal: AbortSignal,
	source: SteeringInterruptSource | "irc" | "cancelled-run" | undefined,
	entered: boolean,
): AgentToolResult<SkippedToolResultDetails> {
	const reason = abortReasonText(signal);
	return {
		content: [{ type: "text", text: `Tool was not executed because the run was aborted: ${reason}.` }],
		details: { __skipped: true, source: source ?? "steering", entered },
	};
}

/** Create placeholder result for an interrupted tool call. */
function createSkippedToolResult(
	source: SteeringInterruptSource | "irc" | "cancelled-run" | undefined,
	entered: boolean,
	batchLedger?: ToolBatchLedger,
): AgentToolResult<any> {
	let reason = "pending steering message";
	let blocker = "queued message";
	if (source === "user") {
		reason = "queued user message";
		blocker = "queued message";
	} else if (source === "system") {
		reason = "pending system advisory";
		blocker = "advisory";
	} else if (source === "irc") {
		reason = "pending peer interrupt";
		blocker = "interrupt";
	} else if (source === "cancelled-run") {
		reason = "the run being cancelled";
	}
	const advice =
		source === "cancelled-run"
			? entered
				? "This tool had already started running when the run was cancelled, so it may have applied partial side effects. Check state before assuming it did or did not take effect."
				: "It never started, so nothing was applied."
			: entered
				? `This tool had already started running when it was cut off, so it may have applied partial side effects. Check state before retrying it. After the ${blocker} is handled on the next step, decide from that state whether a retry is still needed.`
				: `After the ${blocker} is handled on the next step, retry the skipped tool if it is still needed.`;
	const headline = `Skipped due to ${reason}. Do not count this skipped result as completed work or verification. ${advice}`;
	const details: SkippedToolResultDetails = {
		__skipped: true,
		source: source ?? "steering",
		entered,
		...(batchLedger ? { batchLedger } : {}),
	};
	return {
		content: [
			{
				type: "text",
				text: batchLedger ? `${headline}\n\n${renderToolBatchLedger(batchLedger)}` : headline,
			},
		],
		details,
	};
}
