/**
 * Agent loop that works with AgentMessage throughout.
 * Transforms to Message[] only at the LLM call boundary.
 */

import type {
	AssistantMessage,
	AssistantMessageEvent,
	AssistantTurnStatus,
	Context,
	IncompleteToolCall,
	InstrumentationLevel,
	Model,
	ToolCallStatus,
	ToolChoice,
	ToolResultMessage,
	TSchema,
	UserMessage,
} from "@veyyon/ai";
// Eleven runtime names, each from the module that declares it. The package entry point re-exports
// the whole of `@veyyon/ai`; this loop legitimately reaches the streaming engine because it streams,
// but the other ten had been arriving with the catalogue, the providers and the usage backends
// attached. Types stay on the entry point, which is free.
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
// The deep path, not the package entry point: this is one string beside the type it
// fills in, and the entry point re-exports the whole of `@veyyon/ai`.
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
	internString,
	isAbortError,
	isRecord,
	LoopRace,
	logger,
	sanitizeText,
	structuredCloneJSON,
} from "@veyyon/utils";
import { INTENT_FIELD } from "@veyyon/wire";
import { type AgentPauseGate, agentPauseGate } from "./pause";
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
import { toolResultNeverRan } from "./tool-result-never-ran";
import type {
	AgentContext,
	AgentEvent,
	AgentLoopConfig,
	AgentMessage,
	AgentTool,
	AgentToolResult,
	AgentTurnEndContext,
	AnyAgentTool,
	AsideMessage,
	ConfiguredDialect,
	SteeringInterruptSource,
	SteeringQueueState,
	StreamFn,
	ToolCallArgumentTransform,
	ToolCallRepairResult,
} from "./types";
import { isSoftToolRequirement } from "./types";
import { yieldIfDue } from "./utils/yield";

/** Stop-details marker for a provider error after assistant content/tool args already streamed. */
export const STREAM_INTERRUPTED_AFTER_CONTENT_STOP_DETAIL = "stream_interrupted_after_content";

/** Sentinel returned by the abort race in `streamAssistantResponse`. */
const ABORTED: unique symbol = Symbol("agent-loop-aborted");

const EMPTY_STRING_SET: ReadonlySet<string> = new Set<string>();

/**
 * Cap on consecutive re-samples triggered by a non-terminal stop
 * (`stopDetails.type === "pause_turn"`) without an intervening tool call. Each
 * continuation is a full model request, so a backend that never stops pausing
 * must not spin the loop forever. Resets whenever a turn carries tool calls.
 */
const MAX_PAUSED_TURN_CONTINUATIONS = 8;

/**
 * Cap on consecutive forced escalations for a single soft tool requirement.
 * A forced `toolChoice` guarantees the call, so this is purely defensive: if a
 * model somehow never satisfies the requirement, give up forcing rather than
 * spin the loop. Reset whenever the requirement id changes or clears.
 */
const MAX_SOFT_TOOL_ESCALATIONS = 3;

/**
 * Whether a hard `toolChoice` for a turn conflicts with a pending soft tool
 * requirement — i.e. forbids tools (`"none"`) or forces a *different* specific
 * tool. `"auto"`/`"required"`/`"any"` and a same-tool force still let the model
 * satisfy the requirement, so they do not conflict and the soft gate stays active.
 */
function hardToolChoiceBlocks(choice: ToolChoice | undefined, requiredTool: string): boolean {
	if (choice === undefined) return false;
	if (typeof choice === "string") return choice === "none";
	const name = choice.type === "tool" ? choice.name : "function" in choice ? choice.function.name : choice.name;
	return name !== requiredTool;
}

/**
 * Abort reason for a turn-wide interruption where only some tool calls caused
 * the abort and sibling placeholders need neutral messages.
 */
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

/**
 * Marks an abort raised by a completed post-tool hook as terminal for the
 * current run. External/user aborts still synthesize an aborted assistant
 * boundary; this reason stops after persisting the completed tool batch.
 */
export const TERMINAL_TOOL_RESULT_ABORT_REASON = Symbol.for("pi-agent-core.terminal-tool-result");

/**
 * Cadence (ms) for polling queued steering while an `interruptible` tool is in
 * flight, so a steer cuts the wait short instead of sitting idle until the
 * tool's own window elapses. A cheap synchronous queue check; latency-bounded
 * at one tick.
 */
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
/**
 * Resolve the effective owned dialect for a request: the configured value (or
 * per-model resolver) wins, then the `VEYYON_DIALECT` env override, else native
 * tool calling. The single owner of this precedence — both the agent loop and
 * side-channel requests go through here.
 */
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

/**
 * Copy a content block for an immutable subscriber view.
 *
 * `delta` mode serves the per-streaming-event path, where cost scales with
 * event count: a `toolCall` block copies its fields but shares `arguments` by
 * reference. That stays immutable under provider activity because every
 * arguments write across `packages/ai` REPLACES the value wholesale (`parseStreamingJson`,
 * throttle re-parses, object merges, literals) and none mutates an existing
 * arguments object in place, so a reference captured now never changes later.
 * The block itself is still copied because providers do mutate block fields
 * (`text +=`, marker keys) across deltas. `full` mode additionally deep-clones
 * `arguments` with own-enumerable-only semantics; it runs once per message at
 * terminal paths (`done`, `error`, `message_end`, final `toolCall` events),
 * where the sanitized view is authoritative.
 */
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
	return {
		...message,
		content: message.content.map(block => snapshotAssistantContentBlock(block, mode)),
		usage: {
			...message.usage,
			cost: { ...message.usage.cost },
		},
		disabledFeatures: message.disabledFeatures ? message.disabledFeatures.slice() : undefined,
		toolCallAbortMessages: message.toolCallAbortMessages ? { ...message.toolCallAbortMessages } : undefined,
	};
}

/**
 * Copy an assistant streaming event so subscribers get an immutable view.
 *
 * Pass `partialSnapshot` when the caller has already snapshotted
 * `event.partial` (the `message_update` push sites alias it as the event's
 * `message`) so the identical partial is not copied twice per streaming delta.
 * Streaming arms use `delta` mode; terminal events (`done`, `error`, and a
 * `toolcall_end`'s authoritative tool call) keep full sanitizing clones.
 */
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

function hasSubstantiveToolResultContent(content: AgentToolResult["content"]): boolean {
	for (const block of content) {
		if (block.type === "image") return true;
		if (block.type === "text" && block.text.trim().length > 0) return true;
	}
	return false;
}

/** A `content` block a session can persist, or `undefined` for a block of any other shape. */
function coerceToolResultBlock(block: unknown): AgentToolResult["content"][number] | undefined {
	if (!block || typeof block !== "object" || !("type" in block)) return undefined;
	if (block.type === "text") {
		return "text" in block && typeof block.text === "string"
			? { type: "text", text: sanitizeText(block.text) }
			: undefined;
	}
	if (block.type !== "image" || !("data" in block) || typeof block.data !== "string") return undefined;
	return "mimeType" in block && typeof block.mimeType === "string"
		? (block as { type: "image"; data: string; mimeType: string })
		: undefined;
}

/** The persistable blocks of `rawContent`, followed by a note counting the blocks of any other shape. */
function coerceToolResultContent(rawContent: readonly unknown[]): {
	content: AgentToolResult["content"];
	invalidBlocks: number;
} {
	const content: AgentToolResult["content"] = [];
	let invalidBlocks = 0;
	for (const block of rawContent) {
		const coerced = coerceToolResultBlock(block);
		if (coerced) content.push(coerced);
		else invalidBlocks++;
	}
	if (invalidBlocks > 0) {
		content.push({
			type: "text",
			text: `Tool returned an invalid result: ${formatCount("content block", invalidBlocks)} had an unsupported shape.`,
		});
	}
	return { content, invalidBlocks };
}

/**
 * Normalize a value coming back from `tool.execute()` (or its streaming partial-update callback)
 * into a structurally valid {@link AgentToolResult}.
 *
 * The tool interface is typed, but third-party tools (MCP, extensions, user-authored AgentTools)
 * can violate the contract at runtime. Persisting a malformed result corrupts the session file
 * (missing `content` array → crash on reload). We coerce at the single boundary where untyped
 * results enter the agent loop, so every downstream consumer can rely on the type.
 */
function coerceToolResult(raw: unknown): { result: AgentToolResult<unknown>; malformed: boolean } {
	const rawObj = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : undefined;
	const details = rawObj && "details" in rawObj ? rawObj.details : {};
	const rawContent = rawObj?.content;
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
	const { content, invalidBlocks } = coerceToolResultContent(rawContent);
	// Tools may flag a non-throwing failure on the result itself (e.g. an
	// aggregator that catches per-entry errors and synthesizes a combined
	// result). Preserve the flag so agent-loop can surface it on the wire.
	const isError = Boolean(rawObj?.isError) || invalidBlocks > 0;
	// Anthropic rejects tool_result blocks with is_error: true and empty content.
	if (isError && !hasSubstantiveToolResultContent(content)) {
		content.length = 0;
		content.push({ type: "text", text: EMPTY_ERROR_TOOL_RESULT_TEXT });
	}
	// Tools may flag the result contextually useless (zero matches, elapsed
	// wait) so compaction can elide it once consumed. Errors are never useless.
	const useless = !isError && Boolean(rawObj?.useless);
	return {
		result: { content, details, ...(isError ? { isError: true } : {}), ...(useless ? { useless: true } : {}) },
		malformed: invalidBlocks > 0,
	};
}

/**
 * Start an agent loop with a new prompt message.
 * The prompt is added to the context and events are emitted for it.
 */
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

/**
 * Continue an agent loop from the current context without adding a new message.
 * Used for retries - context already has user message or tool results.
 *
 * **Important:** The last message in context must convert to a `user` or `toolResult` message
 * via `convertToLlm`. If it doesn't, the LLM provider will reject the request.
 * This cannot be validated here since `convertToLlm` is only called once per turn.
 */
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

/**
 * Build the `agent_end` event payload. When telemetry is enabled, snapshots
 * the run collector so consumers receive {@link AgentRunSummary} +
 * {@link AgentRunCoverage} alongside the messages without parsing OTEL spans.
 * When telemetry is unset, returns the bare event for backwards compatibility.
 */
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
/**
 * Push a `turn_end` event and run the awaited per-turn hook when the run is
 * still healthy. The hook is skipped for externally aborted or errored turns so
 * a user interrupt does not hang on a background backlog wait.
 */
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

/**
 * Detailed-result handle returned by {@link agentLoopDetailed}. Adds the
 * run-level telemetry/coverage rollup to the existing `AgentMessage[]`
 * payload without changing the resolved type of `stream.result()`.
 */
export interface AgentLoopDetailedResult {
	readonly messages: AgentMessage[];
	readonly telemetry: AgentRunSummary | undefined;
	readonly coverage: AgentRunCoverage | undefined;
}

/**
 * Convenience wrapper over {@link agentLoop} that exposes the run-level
 * summary + coverage alongside the messages. The returned `stream` is the
 * same `EventStream` callers already consume; `detailed()` awaits the
 * stream's `agent_end` event and returns the additive fields.
 *
 * Existing `stream.result()` semantics are preserved — it still resolves to
 * `AgentMessage[]`. Use {@link agentLoopDetailed} when you need the rollup;
 * use {@link agentLoop} when you do not.
 */
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

/**
 * Like {@link agentLoopDetailed} but built on top of
 * {@link agentLoopContinue}.
 */
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

/**
 * Wire an `onRunEnd` telemetry hook onto `config` so the detailed helper can
 * capture the run summary without consuming the event stream. Preserves any
 * existing `onRunEnd` the caller had set.
 */
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

	// Pure union root (anyOf/oneOf with no own properties): push `i` into each
	// alternative branch so each closed shape keeps `additionalProperties: false`
	// honest with intent tracing. Adding a sibling root `properties: { i }` /
	// `required: [i]` would force every input to satisfy both root *and* a
	// branch, leaving no satisfiable shape because each branch's
	// `additionalProperties: false` rejects every other field — and OpenAI
	// strict sanitization later promotes that sibling to a closed root
	// `type: "object"` that rejects every non-`i` key outright. allOf is not
	// alternation (its members are sub-constraints), so we don't recurse into it.
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

/**
 * Cross-request cache for {@link normalizeTools} (P7, BACKLOG perf hotspots).
 * `toolWireSchema`/`stripSchemaDescriptions` are already stamped per-tool (see
 * `@veyyon/ai/utils/schema/stamps`), so the expensive schema conversion
 * itself is not repeated — but every call still re-runs the outer `.map()`
 * (object spreads, `injectIntentIntoSchema`, `renderToolExamples`) even when
 * `tools` and the flags are unchanged. Callers like `takeSnapshot` in
 * `append-only-context.ts` and `Agent#buildSideRequestContext` invoke this
 * with the SAME `tools` array reference on every turn/request, so keying a
 * single-slot cache off that array identity (invalidated whenever the flags
 * change) skips the whole rebuild. Keyed on the array, not the session, since
 * that's the actual stable+shared reference across call sites.
 */
const normalizedToolsCache = new WeakMap<
	NonNullable<AgentContext["tools"]>,
	{ key: string; result: Context["tools"] }
>();

// Overloads: a defined tool list normalizes to a defined tool list (the body only
// returns `undefined` for a falsy input), so callers passing a real array do not
// have to null-check the result.
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
		// When the full catalog is rendered into the system prompt, ship the tool
		// specs without their descriptions (top-level + nested schema annotations)
		// so they are not duplicated on the wire. Strip the STABLE wire schema (the
		// memoized `stripSchemaDescriptions` result is reused across requests), then
		// re-inject `i` (without its hint, which `describeIntent: false` omits) so
		// intent tracing keeps the field while no descriptions ride the wire.
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
		// Every agent normalizes its own tool list, so an appended examples block would otherwise
		// leave one copy of each description per live agent.
		const finalDescription = examplesBlock ? internString(`${description}\n\n${examplesBlock}`) : description;
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

/**
 * Main loop logic shared by agentLoop and agentLoopContinue.
 */
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
			runLoopBody({
				context: currentContext,
				newMessages,
				config,
				signal,
				stream,
				telemetry,
				invokeAgentSpan,
				stepCounter,
				streamFn,
			}),
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

/**
 * Resolve aside entries at the moment the loop is about to inject them. Each entry
 * is either a ready {@link AgentMessage} or a sync thunk evaluated here so the
 * producer can make the final inject-or-drop decision (return null) against
 * up-to-the-injection state — e.g. dropping late diagnostics a newer edit
 * superseded. Kept sync so it can never stall the loop.
 */
function resolveAsides(entries: AsideMessage[] | undefined): AgentMessage[] {
	if (!entries || entries.length === 0) return [];
	const out: AgentMessage[] = [];
	for (const entry of entries) {
		const message = typeof entry === "function" ? entry() : entry;
		if (message) out.push(message);
	}
	return out;
}

type ToolCallContent = Extract<AssistantMessage["content"][number], { type: "toolCall" }>;

/**
 * The turn's tool calls that no one has run. A Cursor exec-channel synthesized `toolCall` block
 * carries `kCursorExecResolved` because the exec channel already dispatched the tool through the
 * caller's `execHandler` and buffered the result for out-of-band emission; running it again would
 * duplicate the same side-effecting call (issue #4348 review by @chatgpt-codex-connector).
 *
 * The marker is provider bookkeeping and can be missed; the transcript cannot. A call that already
 * carries a result RAN, whoever ran it, so it is not runnable either. That is the invariant the
 * marker is one implementation of, and it holds for every provider that answers a call out of band.
 */
function unansweredToolCalls(message: AssistantMessage, messages: ReadonlyArray<AgentMessage>): ToolCallContent[] {
	const answered = executedToolCallIds(messages);
	return message.content.filter(
		(c): c is ToolCallContent =>
			c.type === "toolCall" && (c as CursorExecResolvedCarrier)[kCursorExecResolved] !== true && !answered.has(c.id),
	);
}

/** The fixed inputs of one loop run. */
interface LoopRun {
	readonly context: AgentContext;
	readonly newMessages: AgentMessage[];
	readonly config: AgentLoopConfig;
	readonly signal: AbortSignal | undefined;
	readonly stream: EventStream<AgentEvent, AgentMessage[]>;
	readonly telemetry: AgentTelemetry | undefined;
	readonly invokeAgentSpan: Span | undefined;
	readonly stepCounter: StepCounter;
	readonly streamFn: StreamFn | undefined;
}

/** What the loop carries from one turn to the next. */
interface LoopState {
	firstTurn: boolean;
	hasMoreToolCalls: boolean;
	/** Steering, asides and follow-ups injected before the next assistant response. */
	pendingMessages: AgentMessage[];
	harmonyRetryAttempt: number;
	harmonyTruncateResumeCount: number;
	pausedTurnContinuations: number;
	/**
	 * Soft tool requirement lifecycle (reminder → escalate; see SoftToolRequirement).
	 * `forcedToolChoice` carries a one-turn escalation into the next model call. It overrides the
	 * static toolChoice but NEVER the host's hard getToolChoice().
	 */
	softRequirementId: string | undefined;
	forcedToolChoice: ToolChoice | undefined;
	softEscalations: number;
	/**
	 * Resolved once per logical turn and reused across Harmony-leak re-samples (which re-enter the
	 * same turn) so the consuming getToolChoice is never advanced twice; the flag resets at the
	 * message boundary.
	 */
	hostToolChoice: ToolChoice | undefined;
	softRequiredTool: string | undefined;
	directiveResolvedForTurn: boolean;
}

/** Abort at `deadline`: the signal the run observes, and the timer to clear when the run ends. */
function armDeadline(
	deadline: number | undefined,
	signal: AbortSignal | undefined,
): { signal: AbortSignal | undefined; timer: Timer | undefined } {
	if (deadline === undefined) return { signal, timer: undefined };
	const controller = new AbortController();
	const reason = new DOMException("Deadline exceeded", "TimeoutError");
	const delay = deadline - Date.now();
	let timer: Timer | undefined;
	if (delay <= 0) {
		controller.abort(reason);
	} else {
		timer = setTimeout(() => {
			controller.abort(reason);
		}, delay);
	}
	return { signal: signal ? AbortSignal.any([signal, controller.signal]) : controller.signal, timer };
}

/** Stream a message the loop injects and append it to the context and the run's new messages. */
function injectMessage(run: LoopRun, message: AgentMessage): void {
	run.stream.push({ type: "message_start", message });
	run.stream.push({ type: "message_end", message });
	run.context.messages.push(message);
	run.newMessages.push(message);
}

/** Append a tool result to the context, the run's new messages and the turn's results. */
function appendToolResult(run: LoopRun, toolResults: ToolResultMessage[], result: ToolResultMessage): void {
	run.context.messages.push(result);
	run.newMessages.push(result);
	toolResults.push(result);
}

/** End the run's stream once its deadline has passed. True when it did. */
function endIfDeadlinePassed(run: LoopRun): boolean {
	if (!isDeadlineExceeded(run.config.deadline)) return false;
	endAgentStream(run.stream, run.newMessages, run.telemetry, run.stepCounter.count);
	return true;
}

async function runLoopBody(input: LoopRun): Promise<void> {
	const deadline = armDeadline(input.config.deadline, input.signal);
	try {
		await driveLoop({ ...input, signal: deadline.signal });
	} finally {
		clearTimeout(deadline.timer);
	}
}

async function driveLoop(run: LoopRun): Promise<void> {
	if (endIfDeadlinePassed(run)) return;
	const state: LoopState = {
		firstTurn: true,
		hasMoreToolCalls: true,
		// Check for steering messages at start (user may have typed while waiting). Skip when the
		// run is already externally aborted — dequeuing would strand the messages in a run that is
		// about to die.
		pendingMessages: run.signal?.aborted ? [] : (await run.config.getSteeringMessages?.()) || [],
		harmonyRetryAttempt: 0,
		harmonyTruncateResumeCount: 0,
		pausedTurnContinuations: 0,
		softRequirementId: undefined,
		forcedToolChoice: undefined,
		softEscalations: 0,
		hostToolChoice: undefined,
		softRequiredTool: undefined,
		directiveResolvedForTurn: false,
	};

	// Outer loop: continues when queued follow-up messages arrive after agent would stop
	while (true) {
		state.hasMoreToolCalls = true;
		// Inner loop: process tool calls and steering messages
		while (state.hasMoreToolCalls || state.pendingMessages.length > 0) {
			if (await runTurn(run, state)) return;
		}
		if (endIfDeadlinePassed(run)) return;
		// Agent would stop here. Drain non-interrupting asides + follow-up messages.
		await run.config.onBeforeYield?.();
		if (endIfDeadlinePassed(run)) return;
		// Set as pending so the inner loop processes them before stopping.
		state.pendingMessages = await drainAtYield(run);
		// No more messages, exit
		if (state.pendingMessages.length === 0) break;
	}

	endAgentStream(run.stream, run.newMessages, run.telemetry, run.stepCounter.count);
}

/** One turn: inject pending messages, sample the model, settle its tool calls. True when the run ended. */
async function runTurn(run: LoopRun, state: LoopState): Promise<boolean> {
	if (endIfDeadlinePassed(run)) return true;
	// Yield at the top of each iteration to prevent busy-wait when
	// the agent loop is executing tool calls back-to-back.
	await yieldIfDue();
	if (await parkWhilePaused(run)) return true;
	if (!state.firstTurn) {
		run.stream.push({ type: "turn_start" });
	}
	state.firstTurn = false;

	// Process pending messages (inject before next assistant response)
	if (state.pendingMessages.length > 0) {
		for (const message of state.pendingMessages) injectMessage(run, message);
		state.pendingMessages = [];
	}

	// Refresh prompt/tool context from live state before each model call
	if (run.config.syncContextBeforeModelCall) {
		await run.config.syncContextBeforeModelCall(run.context);
	}

	if (!state.directiveResolvedForTurn) resolveTurnDirective(run, state);

	const message = await sampleTurn(run, state);
	// A Harmony abort-retry re-samples the same turn and keeps the cached directive.
	if (message === undefined) return false;
	run.newMessages.push(message);

	// The escalation choice (if any) applied to the call above; clear it so
	// only the single escalation turn carries the forced choice.
	state.forcedToolChoice = undefined;
	// A fresh logical turn re-resolves the directive next iteration.
	state.directiveResolvedForTurn = false;

	const { stopReason } = message;
	if (stopReason === "error" || stopReason === "aborted") {
		await settleFailedTurn(run, message, stopReason);
		return true;
	}

	const toolResults = await settleTurnToolCalls(run, state, message);
	await emitTurnEnd(run.stream, run.context, message, toolResults, run.config, run.signal, {
		willContinue: state.hasMoreToolCalls && !isDeadlineExceeded(run.config.deadline),
	});
	if (endIfDeadlinePassed(run)) return true;
	state.pendingMessages = await nextTurnMessages(run, state.hasMoreToolCalls);
	return false;
}

/**
 * Park at the turn boundary while the process-wide pause gate is engaged (host /pause). An external
 * abort releases the park so a cancelled run still unwinds while everything else stays frozen.
 * True when the abort ended the run.
 */
async function parkWhilePaused(run: LoopRun): Promise<boolean> {
	const pauseGate = run.config.pauseGate ?? agentPauseGate;
	if (!pauseGate.paused) return false;
	try {
		await pauseGate.waitUntilResumed(run.signal);
		return false;
	} catch (err) {
		if (!isAbortError(err) && !run.signal?.aborted) throw err;
		const message = emitAbortedAssistantMessage(
			null,
			false,
			EMPTY_STRING_SET,
			run.context,
			run.config,
			run.stream,
			run.signal,
		);
		run.newMessages.push(message);
		await emitTurnEnd(run.stream, run.context, message, [], run.config, run.signal, { willContinue: false });
		endAgentStream(run.stream, run.newMessages, run.telemetry, run.stepCounter.count);
		return true;
	}
}

/**
 * Resolve the per-turn tool-choice directive ONCE per logical turn. The host hard-choice path
 * (getToolChoice → nextToolChoice) is CONSUMING — it advances a generator on every call — so
 * Harmony-leak retries, which re-sample the same turn without a turn_end, must reuse the values
 * fetched on the first attempt rather than double-advancing it. Fetched after the pending-message
 * flush and context sync, immediately before the call, so a throw in between cannot wedge an
 * in-flight directive. A hard ToolChoice is applied verbatim; a SoftToolRequirement triggers the
 * remind-then-escalate lifecycle: inject its reminder inline once per new id (toolChoice stays
 * auto), and the gate in {@link settleTurnToolCalls} escalates to a forced choice only if the model
 * declines. The host wrapper already dropped a soft requirement whose tool is inactive.
 */
function resolveTurnDirective(run: LoopRun, state: LoopState): void {
	const directive = run.signal?.aborted ? undefined : run.config.getToolChoice?.();
	const softReq = isSoftToolRequirement(directive) ? directive : undefined;
	state.hostToolChoice = directive === undefined || isSoftToolRequirement(directive) ? undefined : directive;
	state.softRequiredTool = softReq?.toolName;
	if (softReq === undefined) {
		state.softRequirementId = undefined;
		state.softEscalations = 0;
	} else if (softReq.id !== state.softRequirementId) {
		state.softRequirementId = softReq.id;
		state.softEscalations = 0;
		for (const reminder of softReq.reminder) injectMessage(run, reminder);
	}
	state.directiveResolvedForTurn = true;
}

/**
 * Stream the turn's assistant response. A GPT-5 Harmony leak either resumes from the recovered
 * tool call, which completes the turn, or aborts for a re-sample of the same turn, reported as
 * `undefined`. Each recovery has a cap past which the leak is an error.
 */
async function sampleTurn(run: LoopRun, state: LoopState): Promise<AssistantMessage | undefined> {
	try {
		const message = await streamAssistantResponse(
			run.context,
			run.config,
			run.signal,
			run.stream,
			run.telemetry,
			run.invokeAgentSpan,
			run.stepCounter,
			run.streamFn,
			state.harmonyRetryAttempt,
			state.hostToolChoice,
			state.forcedToolChoice,
		);
		state.harmonyRetryAttempt = 0;
		state.harmonyTruncateResumeCount = 0;
		return message;
	} catch (err) {
		if (!(err instanceof HarmonyLeakInterruption)) throw err;
		if (!err.recovered) {
			if (state.harmonyRetryAttempt >= 2) {
				await emitHarmonyAudit(run.config, err, "escalated", state.harmonyRetryAttempt);
				throw new Error(
					`GPT-5 Harmony leak persisted after ${state.harmonyRetryAttempt} retries (${signalListLabel(err.detection.signals)}).`,
				);
			}
			await emitHarmonyAudit(run.config, err, "abort_retry", state.harmonyRetryAttempt);
			state.harmonyRetryAttempt++;
			return undefined;
		}
		if (state.harmonyTruncateResumeCount >= 2) {
			await emitHarmonyAudit(run.config, err, "escalated", state.harmonyRetryAttempt);
			throw new Error(
				`GPT-5 Harmony leak recurred after truncate-and-resume recovery (${signalListLabel(err.detection.signals)}).`,
			);
		}
		state.harmonyTruncateResumeCount++;
		await emitHarmonyAudit(run.config, err, "truncate_resume", state.harmonyRetryAttempt);
		// A recovered message completes the turn, so the abort-retry counter
		// resets like the normal success path (the truncate-resume counter
		// keeps accumulating for its cross-turn cap).
		state.harmonyRetryAttempt = 0;
		const message = snapshotAssistantMessage(err.recovered.message);
		run.context.messages.push(message);
		run.stream.push({ type: "message_start", message: snapshotAssistantMessage(message) });
		run.stream.push({ type: "message_end", message: snapshotAssistantMessage(message) });
		return message;
	}
}

/**
 * Close a turn that errored or aborted: pair each of its tool calls with a placeholder result,
 * which maintains the tool_use/tool_result pairing the API requires, emit turn_end and end the run.
 */
async function settleFailedTurn(
	run: LoopRun,
	message: AssistantMessage,
	stopReason: "error" | "aborted",
): Promise<void> {
	// Cursor exec-resolved blocks already have their toolResult buffered
	// for out-of-band emission; a placeholder aborted result here would
	// pair a duplicate to the same toolCallId (issue #4348 codex review).
	const toolCalls = message.content.filter(
		(c): c is ToolCallContent =>
			c.type === "toolCall" && (c as CursorExecResolvedCarrier)[kCursorExecResolved] !== true,
	);
	// Provider-built aborted messages (stream error events) carry no
	// per-tool labels; derive them from a tool-scoped abort signal so
	// only the matching call is blamed and siblings stay neutral.
	const scopedAbort = toolScopedAbortReason(run.signal);
	const toolCallAbortMessages =
		message.toolCallAbortMessages ?? (scopedAbort ? buildToolCallAbortMessages(message, scopedAbort) : undefined);
	// Everything the harness knows about this batch at abort time. The
	// loop's own dispatch cannot have started: `tool.execute()` has one
	// call site, inside `executeToolCalls`, which is reached only from
	// a runnable stop in `settleTurnToolCalls`, never from here. So every
	// retained call is "never ran".
	//
	// The one exception is a Cursor exec-channel call. Those run through
	// a caller-supplied `execHandler` inside the provider stream, in this
	// process, and their `toolCall` block is synthesized BEFORE the
	// handler is awaited. A reset can land while one is still running, so
	// they are never reported as "never ran": `buildAbortedTurnLedger`
	// resolves them against the transcript and falls back to "started, no
	// result recorded".
	//
	// Emitting the ledger on the first placeholder keeps it to one
	// bounded copy per batch. When the batch left no placeholder at all
	// the ledger travels as a turn-level notice instead; see below.
	const batchLedger = buildAbortedTurnLedger(
		stopReason === "aborted" ? "aborted" : "stream_error",
		message,
		run.context.messages,
	);
	const toolResults: ToolResultMessage[] = [];
	for (const toolCall of toolCalls) {
		const errorMessage = toolCallAbortMessages?.[toolCall.id] ?? message.errorMessage;
		const result = createAbortedToolResult(
			toolCall,
			run.stream,
			stopReason,
			errorMessage,
			toolResults.length === 0 ? batchLedger : undefined,
		);
		appendToolResult(run, toolResults, result);
		// The placeholder result above keeps the API's tool_use/tool_result
		// pairing intact, but no execute_tool span is started for these
		// calls. Mirror the run-collector entry directly so the run
		// summary's tool counters and `coverage.toolsInvoked` reflect
		// what the user actually saw on the wire.
		recordSkippedTool(run.telemetry, { toolCallId: toolCall.id, toolName: toolCall.name, status: stopReason });
	}
	if (batchLedger && toolResults.length === 0) {
		// Every call this turn either had its `toolCall` block deleted by
		// `retainCompletedToolCalls` (arguments still streaming) or was
		// already dispatched out of band by Cursor's exec channel, so no
		// placeholder result exists to carry the ledger. Dropping it here
		// is how the one case it was written for got lost: an incomplete
		// call has no block, no result and no placeholder, so the ledger
		// is the only place it is named at all, and without it the model
		// reads a turn in which it never asked for that tool.
		//
		// The turn-level path is the one the tool-choice reminder uses: a
		// synthetic user message streamed and appended to the context, so
		// it survives into the next request the same way.
		injectMessage(run, {
			role: "user",
			content: renderToolBatchLedger(batchLedger),
			synthetic: true,
			timestamp: Date.now(),
		} satisfies UserMessage);
	}
	await emitTurnEnd(run.stream, run.context, message, toolResults, run.config, run.signal, { willContinue: false });
	endAgentStream(run.stream, run.newMessages, run.telemetry, run.stepCounter.count);
}

/**
 * Run, skip or defer a completed turn's tool calls, set whether the loop samples another turn, and
 * return the turn's tool results.
 *
 * Tools run whenever the turn carries tool_use blocks AND was not truncated. `stop_reason` is
 * provider metadata that never goes back on the wire, so it does not gate continuation validity:
 * replaying a tool_use turn with the tool_results appended is accepted whether the turn ended on
 * `tool_use` or `end_turn` (adaptive/interleaved-thinking Opus routinely emits tool calls under
 * `end_turn`; verified against the live Anthropic API). The only continuation hazard is a thinking
 * block carrying a stale/invalid signature, which `transformMessages` already neutralizes — it
 * strips the signature on non-`toolUse` turns and the encoder downgrades the unsigned block to
 * text, which the API accepts. So `stop` (end_turn/pause_turn) is treated the same as `toolUse`.
 * `length` (max_tokens) is the one reason tools must NOT run: the trailing tool_use may be
 * truncated with incomplete arguments, so those calls are abandoned. (`error`/`aborted` never
 * reach here.)
 */
async function settleTurnToolCalls(
	run: LoopRun,
	state: LoopState,
	message: AssistantMessage,
): Promise<ToolResultMessage[]> {
	const toolCalls = unansweredToolCalls(message, run.context.messages);
	const toolResults: ToolResultMessage[] = [];
	let hasMoreToolCalls = await dispatchTurnToolCalls(run, state, message, toolCalls, toolResults);
	// A tool hook may mark its completed result as terminal (e.g. agent yield).
	// Stop before the next provider call without changing external/user abort semantics.
	if (run.signal?.reason === TERMINAL_TOOL_RESULT_ABORT_REASON) {
		hasMoreToolCalls = false;
	}
	state.hasMoreToolCalls = continuesPausedTurn(state, message, toolCalls.length, hasMoreToolCalls);
	return toolResults;
}

/**
 * Escalates a soft tool requirement the turn violated, runs the turn's tool calls, or pairs each with a placeholder
 * result, appending to `toolResults`; returns whether the loop samples another turn.
 */
async function dispatchTurnToolCalls(
	run: LoopRun,
	state: LoopState,
	message: AssistantMessage,
	toolCalls: readonly ToolCallContent[],
	toolResults: ToolResultMessage[],
): Promise<boolean> {
	const runnableStop = message.stopReason === "toolUse" || message.stopReason === "stop";
	const deadlinePassed = isDeadlineExceeded(run.config.deadline);
	const requiredTool = state.softRequiredTool;
	if (requiredTool !== undefined && violatesSoftRequirement(run.config, requiredTool, toolCalls)) {
		escalateSoftRequirement(run, state, requiredTool, toolCalls, toolResults);
		return true;
	}
	if (toolCalls.length === 0) return false;
	if (runnableStop && !deadlinePassed) {
		for (const result of await executeToolCalls(run, message)) appendToolResult(run, toolResults, result);
		return true;
	}
	// Turn ended on a non-runnable reason (`length` truncation) or deadline was exceeded
	// but left toolCall blocks behind. pair each with a placeholder result.
	const skipReason = deadlinePassed ? "aborted" : message.stopReason === "length" ? "length" : "skipped";
	const skipErrMsg = deadlinePassed ? "Deadline exceeded" : undefined;
	const status = deadlinePassed ? "aborted" : "skipped";
	for (const toolCall of toolCalls) {
		appendToolResult(run, toolResults, createAbortedToolResult(toolCall, run.stream, skipReason, skipErrMsg));
		recordSkippedTool(run.telemetry, { toolCallId: toolCall.id, toolName: toolCall.name, status });
	}
	// A truncated turn re-samples so the model can retry in smaller calls. A passed deadline ends the run at the turn
	// boundary in `runTurn`, before any re-sample.
	return message.stopReason === "length";
}

/**
 * Whether the loop samples another turn once the turn's tool calls are settled. A turn with tool calls resets the
 * paused-turn count. A turn without any that stopped on `pause_turn` is re-sampled, at most
 * {@link MAX_PAUSED_TURN_CONTINUATIONS} times in a row.
 */
function continuesPausedTurn(
	state: LoopState,
	message: AssistantMessage,
	toolCallCount: number,
	hasMoreToolCalls: boolean,
): boolean {
	if (toolCallCount > 0) {
		state.pausedTurnContinuations = 0;
		return hasMoreToolCalls;
	}
	if (
		hasMoreToolCalls ||
		message.stopReason !== "stop" ||
		message.stopDetails?.type !== "pause_turn" ||
		state.pausedTurnContinuations >= MAX_PAUSED_TURN_CONTINUATIONS
	) {
		return hasMoreToolCalls;
	}
	// Non-terminal stop: the provider ended the response but not the turn
	// (e.g. Codex `end_turn: false` on a commentary-only progress update).
	// Re-sample with the assistant message replayed so the model keeps
	// working; the next round folds steering/asides in like any other
	// mid-work turn.
	state.pausedTurnContinuations++;
	return true;
}

/**
 * A turn is compliant ONLY when it calls the required tool and nothing else — mirroring the
 * forced-tool_choice turn, which can emit only that tool. A required+detour batch is non-compliant
 * so detour tools never run side effects while the requirement is still pending.
 */
function violatesSoftRequirement(
	config: AgentLoopConfig,
	requiredTool: string,
	toolCalls: readonly ToolCallContent[],
): boolean {
	if (hardToolChoiceBlocks(config.toolChoice, requiredTool)) return false;
	return toolCalls.length === 0 || !toolCalls.every(toolCall => toolCall.name === requiredTool);
}

/**
 * A soft-required tool is pending but the model called something else (or yielded). Do NOT execute
 * the detour — pair each call with a skipped result and force the required tool next turn. This is
 * the only turn that changes toolChoice; a model that complies with the reminder pays no
 * message-cache invalidation. The caller re-engages so the loop never yields while the requirement
 * is unmet.
 */
function escalateSoftRequirement(
	run: LoopRun,
	state: LoopState,
	requiredTool: string,
	toolCalls: readonly ToolCallContent[],
	toolResults: ToolResultMessage[],
): void {
	if (state.softEscalations >= MAX_SOFT_TOOL_ESCALATIONS) {
		throw new Error(
			`Soft tool requirement '${requiredTool}' was not satisfied after ${MAX_SOFT_TOOL_ESCALATIONS} forced turns; aborting to avoid an unbounded force loop.`,
		);
	}
	for (const toolCall of toolCalls) {
		const result = createAbortedToolResult(
			toolCall,
			run.stream,
			"skipped",
			`Not executed: call the \`${requiredTool}\` tool to resolve the pending action before using other tools.`,
		);
		appendToolResult(run, toolResults, result);
		recordSkippedTool(run.telemetry, { toolCallId: toolCall.id, toolName: toolCall.name, status: "skipped" });
	}
	state.forcedToolChoice = { type: "tool", name: requiredTool };
	state.softEscalations++;
}

/**
 * The messages the next turn opens with.
 *
 * On external abort (user interrupt), leave the steering queue intact: the session aborts then
 * continues, delivering the queue into a fresh run. Draining it here would inject the messages
 * right before a model call that instantly aborts — message lands in history, agent never
 * responds. The mid-batch interrupt poll only peeks (hasSteeringMessages), so the queue still owns
 * every message until this dequeue.
 */
async function nextTurnMessages(run: LoopRun, hasMoreToolCalls: boolean): Promise<AgentMessage[]> {
	const { config, signal } = run;
	const steering = signal?.aborted ? [] : (await config.getSteeringMessages?.()) || [];
	// Stop boundary: only steering (live user input) forces another turn here. Leave
	// asides for the yield drain so a passive aside can't trigger an extra model
	// turn ahead of a queued follow-up — the drain batches asides + follow-ups together.
	if (!hasMoreToolCalls) return steering;
	// Mid-work: fold any non-interrupting asides into the next turn alongside steering.
	const asides = signal?.aborted ? [] : resolveAsides(await config.getAsideMessages?.());
	return asides.length > 0 ? steering.concat(asides) : steering;
}

/**
 * The messages queued when the agent would stop. Skip queue drains when externally aborted (same
 * stranding hazard as {@link nextTurnMessages}). Re-poll steering too: a steer can land between the
 * stop-boundary dequeue and this yield point (e.g. queued while onBeforeYield ran). Without this
 * poll it would strand in the queue until the next manual prompt.
 */
async function drainAtYield(run: LoopRun): Promise<AgentMessage[]> {
	const { config, signal } = run;
	const lateSteering = signal?.aborted ? [] : (await config.getSteeringMessages?.()) || [];
	const asideMessages = signal?.aborted ? [] : resolveAsides(await config.getAsideMessages?.());
	const followUpMessages = signal?.aborted ? [] : (await config.getFollowUpMessages?.()) || [];
	return lateSteering.concat(asideMessages, followUpMessages);
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

/**
 * Stream an assistant response from the LLM.
 * This is where AgentMessage[] gets transformed to Message[] for the LLM.
 */
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
	// Re-resolve the model per provider call (like `getReasoning`): mid-run
	// model switches — context promotion, retry fallback — must apply on the
	// next call instead of the run silently finishing on the stale model
	// captured at run start.
	const model = config.getModel?.() ?? config.model;
	// Apply context transform if configured (AgentMessage[] → AgentMessage[])
	let messages = context.messages;
	if (config.transformContext) {
		messages = await config.transformContext(messages, signal);
	}

	// Convert to LLM-compatible messages (AgentMessage[] → Message[])
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

	// Owned tool calling: take tool calls away from the provider and run them
	// through the selected in-band prompt dialect. `VEYYON_DIALECT=1` still
	// force-enables GLM; `VEYYON_DIALECT=<dialect>` force-enables that dialect.
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
	// `getServiceTier` is authoritative when present (replaces the static tier
	// for both the wire request and telemetry), so callers can scope priority
	// per model without touching the shared session `serviceTier`.
	const effectiveServiceTier = config.getServiceTier ? config.getServiceTier(model) : config.serviceTier;
	const harmonyMitigationEnabled = isHarmonyLeakMitigationTarget(model);
	const harmonyAbortController = harmonyMitigationEnabled ? new AbortController() : undefined;
	const requestSignal = harmonyAbortController
		? signal
			? AbortSignal.any([signal, harmonyAbortController.signal])
			: harmonyAbortController.signal
		: signal;
	// Owned tool calling: aborted by the stream wrapper when the model starts
	// fabricating a `<tool_response>`, so the provider stops generating the rest of
	// the hallucinated turn. Merged into the provider signal ONLY (not
	// `requestSignal`), so it cancels the request without tripping the loop's
	// external-abort handling (`abortRace` / `requestSignal.aborted`).
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

	// Wrap the user-supplied onResponse so we always observe response headers
	// for telemetry (`ChatUsageEvent.headers`, gateway auto-detection) without
	// stealing them from the configured hook.
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
			// Per-turn instrumentation: stamp the request-start wall-clock at the loop
			// boundary (same discipline as tool `startedAt`), so the turn's metrics
			// carry an authoritative request-start the provider's relative ttft/duration
			// cannot supply. `off` skips the clock read entirely.
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
				// Re-materialize in-band tool-call text as native toolCall content blocks
				// so the rest of the loop executes them unchanged. When the model starts
				// fabricating tool results, the abort callback cancels the provider — unless
				// `abortOnFabricatedToolResult` is false, in which case the stream drains and
				// the fabricated continuation is discarded without aborting.
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
			// Both stream endings, the `done`/`error` event and a stream that ends
			// without one, reject a Harmony leak the same way: discard the committed
			// partial, then interrupt the turn with what was recovered from the leak.
			const rejectHarmonyLeak = (message: AssistantMessage): void => {
				if (!harmonyMitigationEnabled) return;
				const detection = detectHarmonyLeakInAssistantMessage(message);
				if (!detection) return;
				const recovered = recoverHarmonyToolCall(message, detection);
				const removed = recovered?.removed ?? extractHarmonyRemoved(message, detection);
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
			};

			const responseIterator = response[Symbol.asyncIterator]();
			const finishAbortedStream = async (): Promise<AssistantMessage> => {
				try {
					const cleanup = responseIterator.return?.();
					// The same reason as the `catch` below, for the ASYNC half of the same call: a provider that
					// fails to acknowledge the cancellation cannot change the aborted message that is already
					// being committed, and the user asked for this stream to stop, not for a report about it.
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
			/**
			 * Applies one event the provider delivered and this loop never processed to the partial and
			 * the set of closed tool calls, as the stream switch below does, without emitting anything.
			 * False on a terminal event, which ends what was delivered ahead of the abort.
			 */
			const absorbDeliveredEvent = (event: AssistantMessageEvent): boolean => {
				switch (event.type) {
					case "done":
					case "error":
						return false;
					case "start":
						completedToolCallIds.clear();
						break;
					case "toolcall_end":
						completedToolCallIds.add(event.toolCall.id);
						break;
				}
				partialMessage = event.partial;
				return true;
			};
			// The events the provider had delivered and this loop had not read when the abort fired,
			// taken off the stream by the abort listener below.
			let deliveredBeforeAbort: AssistantMessageEvent[] | undefined;
			/**
			 * Folds the events delivered ahead of the abort into the turn before it is committed:
			 * `pulled`, the event this pass read and is about to drop, then every event that was
			 * buffered when the abort fired. An event the provider pushes after the abort is not read.
			 *
			 * WHY. Whether a tool call finished is whether the provider delivered its `toolcall_end`
			 * before the abort, not whether this loop reached that event before it observed the abort.
			 * A provider pushes a burst of events from one parsed chunk, so an abort raised by an
			 * earlier event of the burst (a TTSR match on a delta, a streaming-edit stop) fires while
			 * the call's `toolcall_end` is already buffered. The provider clears the call's
			 * streaming-JSON marker before it pushes that event, so {@link completedStreamedArguments}
			 * cannot recover the call either, and the turn dropped a complete call and reported its
			 * arguments as never finished, depending on microtask order alone.
			 */
			const absorbDeliveredEvents = (pulled: AssistantMessageEvent | undefined): void => {
				if (pulled && !absorbDeliveredEvent(pulled)) return;
				if (!deliveredBeforeAbort) return;
				for (const event of deliveredBeforeAbort) {
					if (!absorbDeliveredEvent(event)) return;
				}
			};

			// One race for the whole stream: the abort listener is registered once and settles it once,
			// and each `iterator.next()` waits on a promise of its own. `Promise.race` against one
			// long-lived abort promise attached a reaction to that promise per event, and the pending
			// promise held every event of the stream until the turn ended.
			let abortRace: LoopRace<typeof ABORTED> | undefined;
			let detachAbortListener: (() => void) | undefined;
			if (requestSignal) {
				if (requestSignal.aborted) {
					return await finishAbortedStream();
				}
				const race = new LoopRace<typeof ABORTED>();
				const onAbort = () => {
					deliveredBeforeAbort = response.takeQueued();
					race.resolve(ABORTED);
				};
				requestSignal.addEventListener("abort", onAbort, { once: true });
				abortRace = race;
				detachAbortListener = () => requestSignal.removeEventListener("abort", onAbort);
			}

			try {
				while (true) {
					let next: IteratorResult<AssistantMessageEvent>;
					if (abortRace) {
						// An abort observed between reads ends the stream without another read: an event
						// read now could be one the provider pushed after the abort.
						const result = abortRace.settled ? ABORTED : await abortRace.race(responseIterator.next());
						if (result === ABORTED) {
							absorbDeliveredEvents(undefined);
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
						rejectHarmonyLeak(finalMessage);
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
						// Expand inline macros (and any other registered rewrite) on the
						// finalized message before it reaches the context, the UI, or tool
						// dispatch — so a single mutation is the source of truth for all three.
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
						absorbDeliveredEvents(event);
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
								// `message` and `assistantMessageEvent.partial` intentionally share one
								// immutable snapshot of the streaming partial: every message_update
								// consumer treats both as read-only. Delta mode shares tool-call
								// `arguments` by reference (providers replace, never mutate) so
								// per-delta cost no longer scales with accumulated argument size.
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
								// `message` and `assistantMessageEvent.partial` intentionally share one
								// immutable snapshot of the streaming partial: every message_update
								// consumer treats both as read-only. Delta mode shares tool-call
								// `arguments` by reference (providers replace, never mutate) so
								// per-delta cost no longer scales with accumulated argument size.
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
			rejectHarmonyLeak(trailing);
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

/**
 * Whether a tool-call block the loop never saw a `toolcall_end` for nonetheless
 * carries complete arguments, and if so what they parse to.
 *
 * WHY. A missing `toolcall_end` is not evidence the provider stopped mid
 * argument. An abort is decided HERE: the loop checks `requestSignal.aborted`
 * before it processes the event it just pulled, so a steering interrupt drops
 * every event already delivered, including the `toolcall_end` of a call whose
 * every argument byte had arrived. Judging completeness by that event alone
 * therefore deleted complete calls and told the model, in the batch ledger,
 * that their "arguments never finished" and that "no record of them is left in
 * this transcript. Reconstruct their arguments rather than copying them back" —
 * a false statement about a call it had finished writing, and one that destroys
 * the arguments it is describing. Reported by an operator whose two complete
 * `bash` calls came back exactly that way after one interjection.
 *
 * The block itself knows better. Every provider that streams argument deltas
 * accumulates them in `kStreamingPartialJson` and clears the marker when it
 * closes the call, so a marker still holding text means the loop stopped
 * reading mid-call, and whether the provider had finished is answerable: a
 * truncated JSON payload does not parse, a complete one does. Only a payload
 * that parses to an object counts, and its parse becomes the block's arguments,
 * because the arguments already on a streaming block are a tolerant partial
 * parse and must not be run as-is.
 *
 * An absent marker is deliberately NOT read as complete: a provider that never
 * writes one tells us nothing here, and the conservative answer keeps the
 * pre-existing behaviour for it.
 */
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

/**
 * Drop `toolCall` blocks whose arguments never finished streaming, and record
 * their identity on {@link AssistantMessage.incompleteToolCalls}.
 *
 * The blocks have to go: partial arguments are unsafe to run, and an unpaired
 * `tool_use` block breaks the provider's tool_use/tool_result pairing on
 * replay. Deleting them outright was the residual defect, because the call
 * then had no result, no block, and no mention anywhere, so the model saw a
 * turn in which it had never asked for that tool. The id and name arrive with
 * the provider's block header, before any argument delta, so they are known
 * even here and the ledger can name the call as attempted-and-never-run.
 *
 * A call the loop never closed but whose arguments are provably complete is
 * kept, with those arguments, rather than deleted and misreported: see
 * {@link completedStreamedArguments}.
 */
function retainCompletedToolCalls(
	message: AssistantMessage,
	completedToolCallIds: ReadonlySet<string>,
): AssistantMessage {
	if (message.stopReason !== "error" && message.stopReason !== "aborted") return message;
	const incompleteToolCalls: IncompleteToolCall[] = [];
	const content: AssistantMessage["content"] = [];
	// A block whose arguments were settled here is rewritten, so the rebuilt content
	// has to be kept even when nothing was incomplete. Returning the original message
	// on `incompleteToolCalls.length === 0` alone would throw that rewrite away and
	// replay the tolerant partial parse the streaming block was carrying.
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

/**
 * Give every tool call in one assistant message its own id.
 *
 * WHY. A provider that repeats a block id inside one message produces two
 * `tool_use` blocks sharing that id, and the two results that answer them then
 * also share it. Nothing downstream can pair them: the outbound canonicalizer
 * maps by original id, so both calls collapse onto one handle, and the wire
 * form is rejected by every provider that validates the pairing. Because the
 * malformed pair is stored, it replays on every later request in the session,
 * so one glitched stream ends the conversation rather than one turn. Renaming
 * the repeat here, at the single funnel where a finished message is assembled,
 * keeps stored history unambiguous and leaves every other layer untouched.
 *
 * Scope is the BRANCH, not one message. The reason is the outbound canonicalizer
 * (`canonicalizeToolCallIds`): its handle map is keyed by the original id and
 * lives for the whole session, so two distinct calls that happen to share an id
 * collapse onto one `tc_<n>` handle no matter how many turns apart they are, and
 * the request then carries two `tool_use` blocks and two `tool_result` blocks
 * under that one handle. Providers that hand out ids from a per-message counter
 * (`call_0`, `chatcmpl-tool-0`) produce exactly that on their second tool turn.
 * Ids already stored on the branch are therefore taken, and a first occurrence
 * that collides with one is renamed like an in-message repeat.
 *
 * `takenIds` must exclude the in-flight partial of the message being finalized:
 * it is this same message, so its ids are not history, and counting them would
 * rename every call in the turn. Ids recorded only in `incompleteToolCalls` are
 * not counted either: that ledger names a call that was never run and has no
 * result, so nothing pairs against it.
 */
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

/**
 * Every tool-call id already stored on this branch, for {@link disambiguateToolCallIds}.
 *
 * `skipTrailing` drops the last message, which is the in-flight partial of the
 * message being finalized (the loop appends it and then replaces it in place).
 */
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

/** Resolve the human-readable reason an abort carried. A caller that aborts via
 *  `AbortController.abort(reason)` with a string or a non-`AbortError` `Error`
 *  (e.g. the coding agent's user-interrupt label) gets that text surfaced on the
 *  synthesized assistant message's `errorMessage`; a bare `abort()` (whose
 *  `signal.reason` is the default `AbortError` `DOMException`) falls back to the
 *  generic sentinel that downstream renderers treat as "no specific reason". */
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
	// THIS MESSAGE IS AN ABORT, so it carries the flag whatever the reason said. The flag used to
	// be attached only when the text matched the generic sentinel byte for byte, so a cancellation
	// that carried a reason — the user-interrupt label, a tool-scoped stop — produced an `aborted`
	// message whose id classified as nothing, and every reader of the id (recovery, retry, the
	// renderer) saw an unclassified failure. Whatever the reason itself classifies as rides
	// alongside rather than replacing it.
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
	// Only tool calls that reached `toolcall_end` survive abort/error replay. A
	// labeled user interrupt still surfaces through `errorMessage`, but partial
	// tool arguments are unsafe to keep and can carry incomplete provider IDs.
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

/**
 * Tool-call ids this conversation has already ANSWERED with a real result.
 *
 * WHY. A tool call is answered once. When something outside the loop runs a
 * call and writes its result — Cursor's exec channel dispatches an MCP call
 * through the caller's handler inside the provider stream and answers it there
 * — the loop must not run the same call again. The provider marks such a block
 * `kCursorExecResolved`, but that marker is bookkeeping kept by the code that
 * had the defect: a recorded session shows a `set_cwd` call answered by the
 * exec channel and then executed a second time by the loop, which failed
 * validation and appended a second result under an id that already had one.
 * The transcript is the fact the marker only reports, so read the transcript.
 *
 * A never-ran placeholder is not an answer: the loop writes those for calls it
 * abandoned, and a continuation that reissues them must still be able to run
 * them. {@link toolResultNeverRan} owns that distinction for every subsystem
 * that needs it.
 */
function executedToolCallIds(messages: ReadonlyArray<AgentMessage>): Set<string> {
	const executed = new Set<string>();
	for (const message of messages) {
		if (message.role !== "toolResult") continue;
		if (toolResultNeverRan(message.details)) continue;
		executed.add(message.toolCallId);
	}
	return executed;
}

/** One tool call of a batch, from dispatch to its emitted result. */
interface ToolCallRecord {
	readonly toolCall: ToolCallContent;
	readonly tool: AnyAgentTool | undefined;
	readonly batchIndex: number;
	/** The `display` form of the arguments, which every event, span and record reads. Never the `execution` form. */
	args: Record<string, unknown>;
	readonly interruptible: boolean;
	/** Steering and external aborts, plus peer IRC interrupts when the call is interruptible. */
	readonly signal: AbortSignal;
	/** The UI was told the call is running, which includes the time it spends in `beforeToolCall` (permission prompts). */
	started: boolean;
	/**
	 * Control crossed into `tool.execute()`. The partial-completion ledger needs this one: a call cut off while
	 * awaiting approval had no side effects and is safe to retry verbatim, and telling the model to go check state for
	 * it is a false alarm that costs it a turn.
	 */
	entered: boolean;
	/**
	 * Instrumentation timing (see captureToolCallMetrics). Undefined until `tool.execute()` is about to run, so a call
	 * that erred or was skipped before execution records a zero-duration, never-started span rather than a fabricated
	 * one.
	 */
	startedAt: number | undefined;
	concurrency: "shared" | "exclusive" | undefined;
	isError: boolean;
	skipped: boolean;
	terminalStatus: ToolCallStatus | undefined;
	/** Set once, when the call's result is emitted. */
	toolResultMessage: ToolResultMessage | undefined;
}

/** What running one tool call produced, before it is emitted. */
interface ToolCallOutcome {
	result: AgentToolResult<unknown>;
	isError: boolean;
	caughtError: unknown;
	/** `tool.execute()` returned, so the tool ran its side effects in full. */
	completed: boolean;
}

/** A tool call whose arguments validated, in the form `tool.execute()` receives. */
interface ValidatedToolCall {
	tool: AnyAgentTool;
	execution: Record<string, unknown>;
}

/**
 * Whether a call observes peer IRC interrupts. `interruptible` may be declared per call: a tool where only some
 * operations block (an `irc` wait, a `job` poll) is not interruptible for the rest of them. Resolving it per call
 * matters beyond latency, because a call whose signal aborted before it started is answered with a "skipped"
 * placeholder instead of its own result. Under a blanket flag an unrelated interrupt therefore swallowed a
 * non-blocking call's real result, including the validation error a malformed call was reporting.
 *
 * Resolved from raw pre-validation args. A throwing resolver must not take down the whole batch, so it falls back to
 * the conservative side: an uninterruptible call always keeps its own result.
 */
function resolveInterruptible(tool: AnyAgentTool | undefined, args: Record<string, unknown>): boolean {
	const declared = tool?.interruptible;
	if (typeof declared !== "function") return declared === true;
	try {
		return declared(args) === true;
	} catch (error) {
		logger.warn("tool interruptible resolver threw; treating the call as uninterruptible", {
			tool: tool?.name,
			error: errorMessage(error),
		});
		return false;
	}
}

/**
 * Whether a call may run beside its neighbours. Resolved from raw pre-validation args. A throwing resolver must not
 * take down the whole batch, so it falls back to the safe (serial) mode.
 */
function resolveConcurrency(tool: AnyAgentTool | undefined, args: Record<string, unknown>): "shared" | "exclusive" {
	const mode = tool?.concurrency;
	if (typeof mode !== "function") return mode ?? "shared";
	try {
		return mode(args);
	} catch (error) {
		logger.warn("tool concurrency resolver threw; running the call serially", {
			tool: tool?.name,
			error: errorMessage(error),
		});
		return "exclusive";
	}
}

/** The intent label a tool's own resolver derives from the stripped arguments, if it has one. */
function derivedIntent(
	tool: AnyAgentTool | undefined,
	toolName: string,
	args: Record<string, unknown>,
): string | undefined {
	if (typeof tool?.intent !== "function") return undefined;
	try {
		return tool.intent(args as never)?.trim() || undefined;
	} catch (error) {
		// Must never break tool execution, but a throwing intent resolver is a broken tool feature — surface it.
		logger.warn("tool intent resolver threw; using the default intent label", {
			tool: toolName,
			error: errorMessage(error),
		});
		return undefined;
	}
}

/** The error text for arguments `repairToolCallArguments` could not repair, followed by its hints. */
function unrepairableArgumentsText(outcome: ToolCallRepairResult): string {
	const hints =
		outcome.hints.length > 0 ? `\n\n[Tool argument repair]\n${outcome.hints.map(h => `- ${h}`).join("\n")}` : "";
	return `${outcome.reason ?? "Tool arguments could not be repaired."}${hints}`;
}

/** The source a queued-steering poll reports, or `undefined` when nothing is queued. */
function queuedSteeringSource(queued: boolean | SteeringQueueState): SteeringInterruptSource | undefined {
	if (typeof queued === "boolean") return queued ? "user" : undefined;
	return queued.queued ? (queued.source ?? "unknown") : undefined;
}

/**
 * A call's line in the batch ledger. `entered`, not `started`, separates "cut off inside the tool" from "cut off
 * while waiting for approval": only the first can have applied side effects.
 */
function ledgerEntry(record: ToolCallRecord): ToolBatchCallEntry {
	const cutShort = record.skipped || !record.toolResultMessage;
	return {
		toolCallId: record.toolCall.id,
		toolName: record.toolCall.name,
		outcome: cutShort ? (record.entered ? "interrupted" : "dropped") : record.isError ? "failed" : "ok",
	};
}

/** The tool calls of one assistant message: their scheduling, their interrupts, and the result each one emits. */
class ToolBatch {
	readonly #context: AgentContext;
	/** The tools the batch was dispatched against; a tool registered mid-batch does not answer a call. */
	readonly #tools: AgentContext["tools"];
	readonly #assistantMessage: AssistantMessage;
	readonly #signal: AbortSignal | undefined;
	readonly #stream: EventStream<AgentEvent, AgentMessage[]>;
	readonly #config: AgentLoopConfig;
	readonly #telemetry: AgentTelemetry | undefined;
	readonly #invokeAgentSpan: Span | undefined;
	readonly #instrumentation: InstrumentationLevel;
	readonly #interruptImmediately: boolean;
	readonly #toolCallInfos: Array<{ id: string; name: string }>;
	readonly #batchId: string;
	readonly #steeringAbort = new AbortController();
	readonly #ircAbort = new AbortController();
	/** Instrumentation measures a call's queue wait as the gap between this and its execution start. */
	readonly #dispatchedAt: number;
	readonly #records: ToolCallRecord[];
	readonly #emitted: ToolResultMessage[] = [];
	/** What interrupted the batch; `undefined` until steering or a peer IRC interrupt does. */
	#interruptSource: SteeringInterruptSource | "irc" | undefined;

	constructor(run: LoopRun, assistantMessage: AssistantMessage) {
		this.#context = run.context;
		this.#tools = run.context.tools;
		this.#assistantMessage = assistantMessage;
		this.#signal = run.signal;
		this.#stream = run.stream;
		this.#config = run.config;
		this.#telemetry = run.telemetry;
		this.#invokeAgentSpan = run.invokeAgentSpan;
		this.#instrumentation = run.config.instrumentation ?? "off";
		this.#interruptImmediately = run.config.interruptMode !== "wait";
		// Defensive: the outer loop already filters exec-resolved and already-answered blocks before deciding to
		// invoke `executeToolCalls`, but skip them here too so the guarantee lives with the code that would re-run
		// the tool.
		const toolCalls = unansweredToolCalls(assistantMessage, run.context.messages);
		this.#toolCallInfos = toolCalls.map(call => ({ id: call.id, name: call.name }));
		this.#batchId = `${assistantMessage.timestamp ?? Date.now()}_${toolCalls[0]?.id ?? "batch"}`;
		// Interruptible tools observe steering + external + IRC aborts; every other tool only sees steering +
		// external, so an IRC-only interrupt never kills a partially side-effecting foreground tool (e.g. `bash`)
		// running alongside a pure wait (e.g. `job` poll).
		const steering = this.#steeringAbort.signal;
		const irc = this.#ircAbort.signal;
		const nonInterruptibleSignal = run.signal ? AbortSignal.any([run.signal, steering]) : steering;
		const interruptibleSignal = AbortSignal.any(run.signal ? [run.signal, steering, irc] : [steering, irc]);
		// Stamped once, before scheduling.
		this.#dispatchedAt = this.#instrumentation === "off" ? 0 : Date.now();
		this.#records = toolCalls.map((toolCall, batchIndex) => {
			const args = toolCall.arguments as Record<string, unknown>;
			// Tools emitted via OpenAI's custom-tool path (e.g. `apply_patch` on GPT-5) come back under their
			// wire-level name, which may differ from the harness-internal `name`. Match on either, preferring `name`
			// for determinism if both somehow collide.
			const tool =
				this.#tools?.find(t => t.name === toolCall.name) ??
				this.#tools?.find(t => t.customWireName !== undefined && t.customWireName === toolCall.name);
			const interruptible = resolveInterruptible(tool, args);
			return {
				toolCall,
				tool,
				batchIndex,
				args,
				interruptible,
				signal: interruptible ? interruptibleSignal : nonInterruptibleSignal,
				started: false,
				entered: false,
				startedAt: undefined,
				concurrency: undefined,
				isError: false,
				skipped: false,
				terminalStatus: undefined,
				toolResultMessage: undefined,
			};
		});
	}

	/**
	 * Starts every call and returns one task per call. A shared call runs beside its neighbours; an exclusive call
	 * waits for every call before it and holds back every call after it.
	 */
	schedule(): Promise<void>[] {
		let lastExclusive: Promise<void> = Promise.resolve();
		let sharedTasks: Promise<void>[] = [];
		const tasks: Promise<void>[] = [];
		for (const record of this.#records) {
			const concurrency = resolveConcurrency(record.tool, record.args);
			record.concurrency = concurrency;
			const start = concurrency === "exclusive" ? Promise.all([lastExclusive, ...sharedTasks]) : lastExclusive;
			const task = start.then(() => this.#runTool(record));
			tasks.push(task);
			if (concurrency === "exclusive") {
				lastExclusive = task;
				sharedTasks = [];
			} else {
				sharedTasks.push(task);
			}
		}
		return tasks;
	}

	/** Whether queued steering and IRC are polled while the batch runs. */
	watchesSteering(): boolean {
		return (
			this.#interruptImmediately &&
			(this.#config.hasSteeringMessages !== undefined || this.#config.hasIrcInterrupts !== undefined) &&
			this.#records.some(record => record.interruptible)
		);
	}

	/**
	 * Interrupts the batch when steering is queued or a peer IRC interrupt is pending. Idempotent: a poll after the
	 * interrupt changes nothing.
	 */
	async checkSteering(): Promise<void> {
		// `signal` (external/user abort) is checked separately from the internal abort controllers: once the run is
		// externally aborted it is unwinding and the interrupt would be redundant.
		if (!this.#interruptImmediately || this.#signal?.aborted) return;
		// Mid-batch steering detection must be non-consuming. If a direct integration only provides
		// getSteeringMessages(), the queue drains at the injection boundary; polling it here would strand or drop
		// messages.
		const { hasSteeringMessages, hasIrcInterrupts } = this.#config;
		const steeringSource = hasSteeringMessages ? queuedSteeringSource(await hasSteeringMessages()) : undefined;
		if (steeringSource !== undefined) {
			// Queued steering upgrades an in-flight IRC interrupt: it aborts the shared signal so foreground tools stop
			// as they do for a user Esc. Idempotent — a second steer poll after the abort is a no-op.
			if (!this.#steeringAbort.signal.aborted) {
				this.#interruptSource = steeringSource;
				this.#steeringAbort.abort();
			}
			return;
		}
		// IRC only fires once: a peer interrupt already recorded must not re-abort, and (unlike steering above) never
		// re-consume a queue.
		if (this.#interruptSource !== undefined) return;
		if (hasIrcInterrupts && (await hasIrcInterrupts())) {
			// Peer IRC only aborts interruptible waits: a foreground bash / write mid-execution keeps running so we
			// never leave partial side effects.
			this.#interruptSource = "irc";
			this.#ircAbort.abort();
		}
	}

	/**
	 * Answers every call that never produced a result, which was skipped before dispatch, and returns the batch's
	 * results in the order they were emitted.
	 *
	 * `record.skipped`, not the presence of a result message, is what says a call was cut short: a call whose
	 * `tool.execute()` was aborted mid-flight was already answered with a skipped placeholder, so it HAS a result
	 * message and an `isError` of true. Keying the ledger off the result message reported that call as "ran, failed"
	 * and then told the model its result is already in the transcript and must not be re-run, which is false twice
	 * over: nothing usable ran, and the call may have applied part of its side effects.
	 *
	 * A batch of more than one call carries the ledger: a one-call batch has no siblings to inventory, so a ledger
	 * there is a second copy of what the call's own placeholder already says. The side-effect warning does not depend
	 * on the ledger, because it rides the placeholder text itself (`createSkippedToolResult`'s `entered`).
	 *
	 * The ledger rides one placeholder, so it is only built when there is a placeholder left to carry it. A batch in
	 * which every cut-short call was already answered has nothing to attach it to, and nothing to add: each of those
	 * placeholders already states its own outcome.
	 */
	answerUnresolved(): ToolResultMessage[] {
		const unresolved = this.#records.filter(record => !record.toolResultMessage);
		// A call released from the pause gate by the run's own cancel has no interrupt source: nothing is queued, so
		// its placeholder states the cancel rather than a steering message that does not exist.
		const source = this.#interruptSource ?? (this.#signal?.aborted ? "cancelled-run" : undefined);
		const batchLedger =
			unresolved.length > 0 && this.#records.length > 1
				? buildToolBatchLedger("interrupted", this.#records.map(ledgerEntry))
				: undefined;
		for (const [index, record] of unresolved.entries()) {
			record.skipped = true;
			record.terminalStatus = "skipped";
			recordSkippedTool(this.#telemetry, {
				toolCallId: record.toolCall.id,
				toolName: record.toolCall.name,
				status: "skipped",
			});
			const ledger = index === 0 ? batchLedger : undefined;
			this.#emitToolResult(record, createSkippedToolResult(source, record.entered, ledger), true);
		}
		return this.#emitted;
	}

	async #runTool(record: ToolCallRecord): Promise<void> {
		if (this.#interruptSource !== undefined) {
			// No span and no collector orphan record here: `answerUnresolved` is the single path that handles "no
			// result message was produced", once per record, so any work done here would double-count.
			record.skipped = true;
			return;
		}
		// Park before starting this call while the process-wide pause gate is engaged. Calls already executing are
		// unaffected (pausing never aborts); a batch interrupted mid-pause unwinds via the signal checks below.
		const pauseGate = this.#config.pauseGate ?? agentPauseGate;
		if (pauseGate.paused && !(await this.#resumedFromPause(record, pauseGate))) return;
		const call = this.#validatedCall(record, this.#strippedOfIntent(record));
		if (!call) return;
		const args = this.#transformedArguments(record, call.execution);
		if (!args) return;
		record.args = args.display;
		if (record.signal.aborted) {
			this.#answerAbortedBeforeStart(record);
			return;
		}
		await this.#execute(record, call.tool, args);
	}

	/** False when an abort released the park, which marks the call skipped. */
	async #resumedFromPause(record: ToolCallRecord, pauseGate: AgentPauseGate): Promise<boolean> {
		try {
			await pauseGate.waitUntilResumed(record.signal);
			return true;
		} catch (err) {
			if (!isAbortError(err) && !record.signal.aborted) throw err;
			record.skipped = true;
			return false;
		}
	}

	/** The call's arguments with the intent field stripped, setting the call's intent from it or from the tool. */
	#strippedOfIntent(record: ToolCallRecord): Record<string, unknown> {
		const { toolCall } = record;
		const args = toolCall.arguments as Record<string, unknown>;
		if (!this.#config.intentTracing) return args;
		const { intent, strippedArgs } = extractIntent(args);
		const label = intent ?? derivedIntent(record.tool, toolCall.name, strippedArgs);
		if (label) toolCall.intent = label;
		return strippedArgs;
	}

	/**
	 * The tool and the arguments it receives, repaired and validated; `undefined` once the call was answered with the
	 * error that stopped it. A tool declaring `lenientArgValidation` runs with its arguments as they are.
	 */
	#validatedCall(record: ToolCallRecord, stripped: Record<string, unknown>): ValidatedToolCall | undefined {
		const { tool, toolCall } = record;
		let args = stripped;
		try {
			if (!tool) {
				throw new AIError.ToolNotFoundError(
					toolCall.name,
					this.#tools?.map(t => t.name),
				);
			}
			const repaired = this.#repairedArguments(record, tool, args);
			if (!repaired) return undefined;
			args = repaired;
			return { tool, execution: validateToolArguments(tool, { ...toolCall, arguments: args }) };
		} catch (validationError) {
			if (tool?.lenientArgValidation) {
				const execution = { ...args };
				delete execution.__parseError;
				delete execution.__rawJson;
				return { tool, execution };
			}
			record.args = "__parseError" in args ? { __parseError: args.__parseError } : args;
			this.#emitToolResult(
				record,
				{
					content: [{ type: "text", text: errorMessage(validationError) }],
					details: { isError: true, error: errorMessage(validationError) },
				},
				true,
			);
			return undefined;
		}
	}

	/**
	 * The arguments `repairToolCallArguments` returns, stripped of intent again; `undefined` once a call it could not
	 * repair was answered with its reason and hints.
	 */
	#repairedArguments(
		record: ToolCallRecord,
		tool: AnyAgentTool,
		args: Record<string, unknown>,
	): Record<string, unknown> | undefined {
		const repair = this.#config.repairToolCallArguments;
		if (!repair) return args;
		const outcome = repair(tool, { ...record.toolCall, arguments: args });
		if (outcome.status === "unrepairable") {
			record.args = args;
			const errorText = unrepairableArgumentsText(outcome);
			this.#emitToolResult(
				record,
				{ content: [{ type: "text", text: errorText }], details: { isError: true, error: errorText } },
				true,
			);
			return undefined;
		}
		if (!this.#config.intentTracing) return outcome.arguments;
		const { intent, strippedArgs } = extractIntent(outcome.arguments);
		if (intent) record.toolCall.intent = intent;
		return strippedArgs;
	}

	/**
	 * The arguments rewritten HERE, before anything else observes them, and split by AUDIENCE; `undefined` once a
	 * throwing transform was answered with its error.
	 *
	 * Two different expansions ride this hook and they disagree about display. A codec handle MUST be expanded before
	 * a person sees it: `tool_execution_start` is the event a renderer treats as authoritative ("args are final,
	 * reconcile them"), so leaving it unexpanded overwrote the live preview with `§handle` and left it there. A secret
	 * placeholder is the exact opposite: its expansion is a live credential, and a rendered card, a stream event, a
	 * telemetry span and a session file are precisely where it must never land.
	 *
	 * One form cannot satisfy both, so the transform returns both and the loop routes them. `execution` goes to
	 * `tool.execute` and to `beforeToolCall` — the hook that decides whether the call runs, so it must see what would
	 * actually run, and whose in-place mutations must reach the tool. `display` goes to everything that shows, streams,
	 * traces or records arguments. A sink added here later inherits `display`, so it is safe without knowing that
	 * secrets exist.
	 */
	#transformedArguments(
		record: ToolCallRecord,
		execution: Record<string, unknown>,
	): ToolCallArgumentTransform | undefined {
		const transform = this.#config.transformToolCallArguments;
		if (!transform) return { execution, display: execution };
		try {
			const transformed = transform(execution, record.toolCall.name);
			return { execution: transformed.execution, display: transformed.display };
		} catch (transformError) {
			record.args = execution;
			this.#emitToolResult(
				record,
				{
					content: [{ type: "text", text: errorMessage(transformError) }],
					details: { isError: true, error: errorMessage(transformError) },
				},
				true,
			);
			return undefined;
		}
	}

	/** Answers a call whose own signal fired before it started with the abort placeholder. */
	#answerAbortedBeforeStart(record: ToolCallRecord): void {
		const { toolCall } = record;
		record.skipped = true;
		record.terminalStatus = "aborted";
		recordSkippedTool(this.#telemetry, { toolCallId: toolCall.id, toolName: toolCall.name, status: "aborted" });
		const source = this.#interruptSource ?? "cancelled-run";
		this.#emitToolResult(record, createToolSignalAbortedResult(record.signal, source, record.entered), true);
	}

	/** Runs the call inside its span, emits its result, and polls for steering before the next call starts. */
	async #execute(record: ToolCallRecord, tool: AnyAgentTool, args: ToolCallArgumentTransform): Promise<void> {
		const { toolCall } = record;
		record.started = true;
		this.#stream.push({
			type: "tool_execution_start",
			toolCallId: toolCall.id,
			toolName: toolCall.name,
			args: args.display,
			intent: toolCall.intent,
		});
		const toolSpan = startExecuteToolSpan(this.#telemetry, {
			tool,
			toolName: toolCall.name,
			toolCallId: toolCall.id,
			args: args.display,
			parent: this.#invokeAgentSpan,
		});
		if (toolSpan && toolCall.intent) toolSpan.setAttribute(PiGenAIAttr.ToolCallIntent, toolCall.intent);
		const outcome: ToolCallOutcome = {
			result: { content: [], details: {} },
			isError: false,
			caughtError: undefined,
			completed: false,
		};
		await runInActiveSpan(toolSpan, async () => {
			await this.#invoke(record, tool, args, outcome);
			await this.#applyAfterToolCall(record, outcome);
		});
		const status = this.#settle(record, outcome);
		const firstBlock = outcome.result.content?.[0];
		finishExecuteToolSpan(this.#telemetry, toolSpan, {
			result: outcome.result,
			isError: outcome.isError,
			status,
			errorMessage:
				outcome.caughtError === undefined && outcome.isError && firstBlock?.type === "text"
					? firstBlock.text
					: undefined,
			errorObject: outcome.caughtError,
			toolCallId: toolCall.id,
			toolName: toolCall.name,
		});
		await this.checkSteering();
	}

	/** Runs `beforeToolCall` and `tool.execute()`, recording what they produced on `outcome`. */
	async #invoke(
		record: ToolCallRecord,
		tool: AnyAgentTool,
		args: ToolCallArgumentTransform,
		outcome: ToolCallOutcome,
	): Promise<void> {
		const { toolCall } = record;
		try {
			if (this.#answeredAbort(record, outcome)) return;
			const beforeToolCall = this.#config.beforeToolCall;
			if (beforeToolCall) {
				const verdict = await beforeToolCall(
					{
						assistantMessage: this.#assistantMessage,
						toolCall,
						args: args.execution,
						context: this.#context,
					},
					record.signal,
				);
				if (verdict?.block) throw new ToolCallBlockedError(verdict.reason);
			}
			if (this.#answeredAbort(record, outcome)) return;
			const toolContext = this.#config.getToolContext?.({
				batchId: this.#batchId,
				index: record.batchIndex,
				total: this.#records.length,
				toolCalls: this.#toolCallInfos,
			});
			// Execution start instant for instrumentation: set immediately before the tool runs, so `durationMs`
			// measures the tool body alone and `queuedMs` (start − dispatch) captures the scheduling wait.
			if (this.#instrumentation !== "off") record.startedAt = Date.now();
			record.entered = true;
			const raw = await tool.execute(
				toolCall.id,
				args.execution,
				record.signal,
				partialResult => this.#pushUpdate(record, args.display, partialResult),
				toolContext,
			);
			outcome.completed = true;
			const coerced = coerceToolResult(raw);
			outcome.result = coerced.result;
			outcome.isError = coerced.malformed || coerced.result.isError === true;
		} catch (e) {
			outcome.caughtError = e;
			outcome.result = { content: [{ type: "text", text: errorMessage(e) }], details: {} };
			outcome.isError = true;
		}
	}

	/** Answers `outcome` with the abort placeholder when the call's signal fired before `tool.execute()`; true when it did. */
	#answeredAbort(record: ToolCallRecord, outcome: ToolCallOutcome): boolean {
		if (!record.signal.aborted) return false;
		const source = this.#interruptSource ?? "cancelled-run";
		outcome.result = createToolSignalAbortedResult(record.signal, source, record.entered);
		outcome.isError = true;
		return true;
	}

	#pushUpdate(record: ToolCallRecord, display: Record<string, unknown>, partialResult: unknown): void {
		const update: Extract<AgentEvent, { type: "tool_execution_update" }> = {
			type: "tool_execution_update",
			toolCallId: record.toolCall.id,
			toolName: record.toolCall.name,
			args: display,
			partialResult: coerceToolResult(partialResult).result,
		};
		// Work the call started can outlive the run: the stream drops anything pushed after `agent_end`, so a
		// background job's completion goes to the run's owner.
		if (this.#stream.done) this.#config.onToolUpdateAfterRun?.(update);
		else this.#stream.push(update);
	}

	/**
	 * Lets `afterToolCall` replace the call's result field by field. Skipped for a call its abort cut off before
	 * `tool.execute()` returned.
	 */
	async #applyAfterToolCall(record: ToolCallRecord, outcome: ToolCallOutcome): Promise<void> {
		const afterToolCall = this.#config.afterToolCall;
		if (!afterToolCall || (record.signal.aborted && !outcome.completed)) return;
		try {
			const after = await afterToolCall(
				{
					assistantMessage: this.#assistantMessage,
					toolCall: record.toolCall,
					args: record.args,
					result: outcome.result,
					isError: outcome.isError,
					context: this.#context,
				},
				record.signal,
			);
			if (!after) return;
			// Re-normalize the post-hook result: `afterToolCall` is untyped user/extension code and may return
			// malformed `content` (non-array / invalid blocks), which would otherwise be persisted verbatim and corrupt
			// the session — the same hazard `coerceToolResult` guards on the execute path.
			const coerced = coerceToolResult({
				content: after.content ?? outcome.result.content,
				details: after.details ?? outcome.result.details,
				isError: after.isError ?? outcome.result.isError,
				useless: after.useless ?? outcome.result.useless,
			});
			outcome.result = coerced.result;
			outcome.isError = coerced.malformed || (after.isError ?? outcome.isError);
		} catch (e) {
			outcome.caughtError = e;
			outcome.result = { content: [{ type: "text", text: errorMessage(e) }], details: {} };
			outcome.isError = true;
		}
	}

	/** Emits the call's result, or the skipped placeholder for a call its own abort cut off, and returns its status. */
	#settle(record: ToolCallRecord, outcome: ToolCallOutcome): ToolCallStatus {
		const abortedDuringExecution = record.signal.aborted && outcome.isError && !outcome.completed;
		const status: ToolCallStatus = abortedDuringExecution
			? "aborted"
			: outcome.caughtError instanceof ToolCallBlockedError
				? "blocked"
				: outcome.isError
					? "error"
					: "ok";
		record.terminalStatus = status;
		if (abortedDuringExecution) {
			// This tool's own signal fired AND it failed to produce a result: `tool.execute()` never returned (it threw
			// on the abort), so it was genuinely cut off before producing usable output. Report it as skipped.
			//
			// The predicate is `abortedDuringExecution` and nothing more, the same one `status` is derived from. It
			// used to also require a triggered interrupt, and only a STEERING interrupt sets that. A plain Esc cancels
			// the run without queuing anything, so it fell through to the branch below and the model received the
			// thrown `AbortError`'s own message verbatim, which for an abort is the bare word "aborted". The status
			// field already said "aborted" while the result text said nothing at all, and the interruption an operator
			// performs most often was the one told least.
			//
			// `record.entered` selects WHICH skip this was, and the two call for opposite responses. Cut off before
			// entering `tool.execute()` (still in `beforeToolCall`, e.g. an approval prompt) means nothing ran and the
			// call is safe to retry verbatim. Cut off inside it means the tool was already running and may have applied
			// part of its side effects, so a verbatim retry can double-apply: a half-written file, a `bash` command that
			// got through some of its work. The batch ledger cannot carry this distinction here, because this result is
			// emitted while the batch is still running and the ledger is only assembled once every call has settled; a
			// single-call batch never reaches it at all.
			record.skipped = true;
			const source = this.#interruptSource ?? "cancelled-run";
			this.#emitToolResult(record, createSkippedToolResult(source, record.entered), true);
		} else {
			// No interrupt on this signal, or the tool finished before the interrupt landed (`completed`) — even if
			// the signal aborted around completion. Keep its real result: a completed tool already ran its side
			// effects, so the model must see what actually happened (a genuine non-zero exit / error result) rather
			// than a false "skipped" that discards work the tool performed (#4752). A peer-IRC interrupt on the batch
			// leaves non-interruptible tools' signals untouched — their genuine errors survive here too.
			const { result, isError } = outcome;
			this.#emitToolResult(record, result, isError);
		}
		return status;
	}

	/** Emits the call's end events and its result message, once; a second result for the same call is dropped. */
	#emitToolResult(record: ToolCallRecord, result: AgentToolResult<unknown>, isError: boolean): void {
		if (record.toolResultMessage) return;
		const { toolCall } = record;
		if (!record.started) {
			this.#stream.push({
				type: "tool_execution_start",
				toolCallId: toolCall.id,
				toolName: toolCall.name,
				args: record.args,
				intent: toolCall.intent,
			});
		}
		this.#stream.push({
			type: "tool_execution_end",
			toolCallId: toolCall.id,
			toolName: toolCall.name,
			result,
			isError,
		});
		const endedAt = Date.now();
		// Last line of defence on request size. Measure the content that is actually persisted and replayed, not an
		// uncapped payload the model never sees.
		const content = capToolResultContent(result.content, toolCall.name).content;
		const metrics = this.#metrics(record, result, isError, content, endedAt);
		const message: ToolResultMessage = {
			role: "toolResult",
			toolCallId: toolCall.id,
			toolName: toolCall.name,
			content,
			details: result.details,
			isError,
			...(result.useless && !isError ? { useless: true } : {}),
			...(metrics ? { metrics } : {}),
			timestamp: endedAt,
		};
		record.isError = isError;
		record.toolResultMessage = message;
		this.#emitted.push(message);
		this.#stream.push({ type: "message_start", message });
		this.#stream.push({ type: "message_end", message });
	}

	/** The study record `instrumentation` asks for on the call's result message; `undefined` while it is off. */
	#metrics(
		record: ToolCallRecord,
		result: AgentToolResult<unknown>,
		isError: boolean,
		content: ToolResultMessage["content"],
		endedAt: number,
	): ToolResultMessage["metrics"] {
		if (this.#instrumentation === "off") return undefined;
		return captureToolCallMetrics({
			level: this.#instrumentation,
			// A call that emitted a result without ever starting execution (early error / skip) has no real start;
			// treat the end instant as the start so its duration reads as 0, not a negative span.
			startedAt: record.startedAt ?? endedAt,
			endedAt,
			queuedAt: this.#dispatchedAt,
			concurrency: record.concurrency,
			batchId: this.#batchId,
			batchIndex: record.batchIndex,
			batchSize: this.#records.length,
			status: record.terminalStatus ?? (record.skipped ? "skipped" : isError ? "error" : "ok"),
			interruptible: record.interruptible,
			signalAborted: record.signal.aborted,
			resultContent: content,
			useless: result.useless === true,
			args: record.args,
			countTokens: estimateTokensFromText,
		});
	}
}

/**
 * Execute tool calls from an assistant message, returning their results in the order they were emitted.
 */
async function executeToolCalls(run: LoopRun, assistantMessage: AssistantMessage): Promise<ToolResultMessage[]> {
	const batch = new ToolBatch(run, assistantMessage);
	const tasks = batch.schedule();
	// While an interruptible tool is in flight (e.g. a `job`/`irc` wait blocking on external work), queued steering or
	// interrupting IRC would otherwise wait out the tool's own window. Poll only non-consuming queues and abort the
	// shared tool signal so the boundary dequeue injects the message promptly.
	const steeringWatch = batch.watchesSteering()
		? setInterval(() => void batch.checkSteering(), STEERING_INTERRUPT_POLL_MS)
		: undefined;
	try {
		await Promise.allSettled(tasks);
	} finally {
		clearInterval(steeringWatch);
	}
	// Yield after batch tool execution to let GC and I/O catch up, especially when tool results are large (e.g. bash
	// output).
	await yieldIfDue();
	return batch.answerUnresolved();
}

/**
 * Discriminator embedded in {@link AgentToolResult.details} and
 * {@link ToolResultMessage.details} for tool calls that were emitted by the
 * assistant but never actually invoked locally.
 *
 * The synthetic result exists only to preserve the tool_use / tool_result
 * pairing the provider API requires; no `tool.execute()` ran. UI, telemetry,
 * and history consumers can key on `__synthetic === true` to render or
 * classify these as "call emitted, not executed" instead of a real local
 * tool failure — the mislabeling this discriminator was introduced to fix
 * (#4321): a provider-side stream error after tool-call emission (e.g. Codex
 * websocket close) was surfaced by the CLI as if the local tool had failed.
 *
 * `source` names the assistant-side termination state that prevented
 * execution; `upstreamError` is the provider-reported message when the turn
 * ended with `stopReason === "error"`. `batchLedger` is present on exactly one
 * result per cut-short batch and inventories the sibling calls, so a consumer
 * can tell "ran and failed" from "never ran" without replaying the transcript.
 */
export interface SyntheticToolResultDetails {
	__synthetic: true;
	source: "assistant_stop_aborted" | "assistant_stop_error" | "assistant_stop_skipped" | "assistant_stop_length";
	executed: false;
	upstreamError?: string;
	batchLedger?: ToolBatchLedger;
}

/**
 * Details for a call an interrupt cut short.
 *
 * Distinct from {@link SyntheticToolResultDetails}, which means the call was
 * never invoked at all. Here the batch was real and the interrupt arrived
 * partway through it, so `entered` carries the part a consumer cannot guess:
 * whether `tool.execute()` had been reached.
 *
 * The discriminator exists for the same reason as the synthetic one (#4321).
 * The headline text is fixed per source, so a consumer that classifies these by
 * reading the message sees two unrelated interrupts as the same failure
 * repeating, and anything that reacts to a repeat then reacts to an event that
 * never happened.
 */
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

/**
 * Inventory a turn whose stream ended before the tool batch could be
 * dispatched.
 *
 * What is actually knowable here, and nothing beyond it:
 * - A `toolCall` block that survived `retainCompletedToolCalls` has complete
 *   arguments and was never handed to `tool.execute()`: the runnable dispatch
 *   at `executeToolCalls` is reached only on a `toolUse`/`stop` turn, and this
 *   branch returns first. So it is `dropped`, with no side effects.
 * - A block stamped `kCursorExecResolved` was dispatched by Cursor's exec
 *   channel, which runs the tool through a caller-supplied `execHandler` in
 *   this process, inside the provider stream. The block is synthesized before
 *   the handler is awaited, so the call may have finished, may still be
 *   running, or may have applied part of its side effects. Its outcome is
 *   `ok`/`failed` once the buffered result is in the transcript, and
 *   `interrupted` while that result is still pending, because "it ran but you
 *   cannot see the result" is not the same claim as "it never ran".
 * - A call whose arguments were still streaming was deleted from the message
 *   by `retainCompletedToolCalls`, which records its id and name on
 *   `incompleteToolCalls`. It never reached dispatch either, so it is
 *   `dropped` too, flagged `argumentsIncomplete` because there is no block
 *   left in the transcript for the model to copy its arguments back from.
 *
 * Returns `undefined` only when the ledger would restate what the transcript
 * already says; see the lone-entry rule at the end.
 */
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
	// One call whose story the transcript already tells in full needs no
	// inventory. That is a lone `dropped` call with complete arguments (its
	// `toolCall` block survived and it gets its own placeholder result) and a
	// lone exec-channel call that finished (block plus its real result).
	//
	// The other two lone shapes keep the ledger, because nothing else states
	// them: a call whose arguments never finished has no block at all, and an
	// exec-channel call still in flight has a block but no result, so "started,
	// no result recorded" appears nowhere else.
	const lone = entries.length === 1 ? entries[0] : undefined;
	if (lone) {
		if (lone.outcome === "ok" || lone.outcome === "failed") return undefined;
		if (lone.outcome === "dropped" && lone.argumentsIncomplete !== true) return undefined;
	}
	return buildToolBatchLedger(cause, entries);
}

/**
 * Create a tool result for a tool call that was emitted by the assistant but
 * never invoked locally. Maintains the tool_use / tool_result pairing the
 * provider API requires, and tags {@link SyntheticToolResultDetails} so
 * consumers can distinguish this from a real local tool failure without
 * string-matching the content (#4321).
 */
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

/**
 * Placeholder for a call whose signal had already aborted when dispatch reached
 * it: the siblings queued behind the call that cancelled the run.
 *
 * It carries {@link SkippedToolResultDetails} for the same reason
 * {@link createSkippedToolResult} does. The text here is fixed per abort reason,
 * so a whole batch of siblings reaches the model as one byte-identical line
 * repeated, and a consumer that classifies by reading it counts one failure
 * happening over and over. This shipped with an empty details bag, which made it
 * the one skip shape the discriminator could not describe, on the path that
 * produces the longest runs of it.
 *
 * `entered` is always false here (control has not reached `tool.execute()`), but
 * it is read from the record rather than asserted, so the field keeps meaning
 * what it says if the dispatch order ever changes.
 */
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

/**
 * Placeholder for a call the interrupt cut short.
 *
 * `entered` is the difference between two skips that read the same and call for
 * opposite responses. `false`: control never crossed into `tool.execute()` (the
 * call was dropped before dispatch, or was still in `beforeToolCall` waiting on
 * approval), so nothing happened and a verbatim retry is safe. `true`: the tool
 * was running when the abort landed, so it may have applied part of its side
 * effects and a verbatim retry can double-apply them. Telling a model to
 * "retry the skipped tool" for a half-run `bash` is the dangerous direction, so
 * the second case replaces the retry advice with a state check.
 *
 * `"cancelled-run"` is the source with no blocker behind it: the operator hit
 * Esc and the whole run is unwinding, so there is no queued message that gets
 * "handled on the next step" and nothing to retry against. It is also the most
 * common interruption there is, and it used to be the only one that reached the
 * model as the raw thrown `AbortError` message, which is the bare word
 * "aborted": no statement that a command may have half-run, on the exact path
 * where a half-run command is likeliest.
 */
function createSkippedToolResult(
	source: SteeringInterruptSource | "irc" | "cancelled-run" | undefined,
	entered: boolean,
	batchLedger?: ToolBatchLedger,
): AgentToolResult<SkippedToolResultDetails> {
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
