/**
 * Agent loop that works with AgentMessage throughout.
 * Transforms to Message[] only at the LLM call boundary.
 */

import type { AssistantMessage, IncompleteToolCall, ToolCallStatus, ToolResultMessage } from "@veyyon/ai";
import * as AIError from "@veyyon/ai/error";
import { captureToolCallMetrics } from "@veyyon/ai/instrumentation";
import {
	type CursorExecResolvedCarrier,
	clearStreamingPartialJson,
	getStreamingPartialJson,
	kCursorExecResolved,
	type StreamingPartialJsonCarrier,
} from "@veyyon/ai/utils/block-symbols";
import type { EventStream } from "@veyyon/ai/utils/event-stream";
import { validateToolArguments } from "@veyyon/ai/utils/validation";
import { emptyUsage } from "@veyyon/catalog/models";
import { errorMessage, estimateTokensFromText, isAbortError, isRecord, logger } from "@veyyon/utils";
/** Stop-details marker for a provider error after assistant content/tool args already streamed. */
import {
	coerceToolResult,
	extractIntent,
	STEERING_INTERRUPT_POLL_MS,
	STREAM_INTERRUPTED_AFTER_CONTENT_STOP_DETAIL,
	snapshotAssistantMessage,
	type ToolScopedAbortReason,
} from "./agent-loop";
import { agentPauseGate } from "./pause";
import { ToolCallBlockedError } from "./run-collector";
import {
	type AgentTelemetry,
	finishExecuteToolSpan,
	PiGenAIAttr,
	recordSkippedTool,
	runInActiveSpan,
	type Span,
	startExecuteToolSpan,
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
	SteeringInterruptSource,
	SteeringQueueState,
} from "./types";
import { yieldIfDue } from "./utils/yield";

export function completedStreamedArguments(block: StreamingPartialJsonCarrier): Record<string, unknown> | undefined {
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
export function retainCompletedToolCalls(
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
export function disambiguateToolCallIds(message: AssistantMessage, takenIds: ReadonlySet<string>): AssistantMessage {
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
		content ??= [...message.content];
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
export function storedToolCallIds(messages: readonly AgentMessage[], skipTrailing: boolean): Set<string> {
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

export function recoverTransientErrorToolTurn(
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

export function emitDiscardedHarmonyPartial(
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

export function isStringRecord(value: unknown): value is Record<string, string> {
	if (!isRecord(value)) return false;
	return Object.values(value).every(child => typeof child === "string");
}

export function toolScopedAbortReason(signal: AbortSignal | undefined): ToolScopedAbortReason | undefined {
	const reason = signal?.reason;
	if (!reason || typeof reason !== "object") return undefined;
	if (Reflect.get(reason, "kind") !== "tool-scoped-abort") return undefined;
	if (typeof Reflect.get(reason, "message") !== "string") return undefined;
	if (typeof Reflect.get(reason, "defaultToolCallMessage") !== "string") return undefined;
	return isStringRecord(Reflect.get(reason, "toolCallMessages")) ? reason : undefined;
}

export function buildToolCallAbortMessages(
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

export function emitAbortedAssistantMessage(
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
export function executedToolCallIds(messages: ReadonlyArray<AgentMessage>): Set<string> {
	const executed = new Set<string>();
	for (const message of messages) {
		if (message.role !== "toolResult") continue;
		if (toolResultNeverRan(message.details)) continue;
		executed.add(message.toolCallId);
	}
	return executed;
}

/**
 * Execute tool calls from an assistant message.
 */
export async function executeToolCalls(
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
	// Defensive: the outer loop already filters exec-resolved and already-answered
	// blocks before deciding to invoke `executeToolCalls`, but skip them here too
	// so the guarantee lives with the code that would re-run the tool.
	const alreadyAnswered = executedToolCallIds(currentContext.messages);
	const toolCalls = assistantMessage.content.filter(
		(c): c is ToolCallContent =>
			c.type === "toolCall" &&
			(c as CursorExecResolvedCarrier)[kCursorExecResolved] !== true &&
			!alreadyAnswered.has(c.id),
	);
	const emittedToolResults: ToolResultMessage[] = [];
	const toolCallInfos = toolCalls.map(call => ({ id: call.id, name: call.name }));
	const batchId = `${assistantMessage.timestamp ?? Date.now()}_${toolCalls[0]?.id ?? "batch"}`;
	const shouldInterruptImmediately = interruptMode !== "wait";
	const steeringAbortController = new AbortController();
	const ircAbortController = new AbortController();
	// Interruptible tools observe steering + external + IRC aborts; every other
	// tool only sees steering + external, so an IRC-only interrupt never kills a
	// partially side-effecting foreground tool (e.g. `bash`) running alongside a
	// pure wait (e.g. `job` poll).
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
		// Tools emitted via OpenAI's custom-tool path (e.g. `apply_patch` on GPT-5)
		// come back under their wire-level name, which may differ from the
		// harness-internal `name`. Match on either, preferring `name` for
		// determinism if both somehow collide.
		const tool =
			tools?.find(t => t.name === toolCall.name) ??
			tools?.find(t => t.customWireName !== undefined && t.customWireName === toolCall.name);
		// `interruptible` may be declared per call: a tool where only some
		// operations block (an `irc` wait, a `job` poll) is not interruptible for
		// the rest of them. Resolving it per call matters beyond latency, because
		// a call whose signal aborted before it started is answered below with a
		// "skipped" placeholder instead of its own result. Under a blanket flag an
		// unrelated interrupt therefore swallowed a non-blocking call's real
		// result, including the validation error a malformed call was reporting.
		const declaredInterruptible = tool?.interruptible;
		let interruptible: boolean;
		if (typeof declaredInterruptible === "function") {
			// Resolved from raw pre-validation args; a throwing resolver must not
			// take down the whole batch, so fall back to the conservative side —
			// an uninterruptible call always keeps its own result.
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
			// `started` means the UI was told the call is running, which includes the
			// time it spends in `beforeToolCall` (permission prompts). `entered` means
			// control actually crossed into `tool.execute()`. The partial-completion
			// ledger needs the second one: a call cut off while awaiting approval had
			// no side effects and is safe to retry verbatim, and telling the model to
			// go check state for it is a false alarm that costs it a turn.
			entered: false,
			// Instrumentation timing (see captureToolCallMetrics). `startedAt` stays
			// undefined until `tool.execute()` is about to run, so a call that erred
			// or was skipped before execution records a zero-duration, never-started
			// span rather than a fabricated one.
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
		// `signal` (external/user abort) is checked separately from the internal
		// abort controllers: once the run is externally aborted it is unwinding
		// and the interrupt would be redundant.
		if (!shouldInterruptImmediately || signal?.aborted) {
			return;
		}
		// Mid-batch steering detection must be non-consuming. If a direct
		// integration only provides getSteeringMessages(), the queue drains at the
		// injection boundary below; polling it here would strand or drop messages.
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
			// Queued steering upgrades an in-flight IRC interrupt: it aborts the
			// shared signal so foreground tools stop as they do for a user Esc.
			// Idempotent — a second steer poll after the abort is a no-op.
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
		// Last line of defence on request size. Measure the content that is
		// actually persisted and replayed, not an uncapped payload the model
		// never sees.
		const cappedContent = capToolResultContent(result.content, toolCall.name).content;
		const metrics =
			instrumentationLevel === "off"
				? undefined
				: captureToolCallMetrics({
						level: instrumentationLevel,
						// A call that emitted a result without ever starting execution
						// (early error / skip) has no real start; treat the end instant as
						// the start so its duration reads as 0, not a negative span.
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
		// Park before starting this tool while the process-wide pause gate is
		// engaged. Tools already executing are unaffected (pausing never aborts);
		// a batch interrupted mid-pause unwinds via the signal checks below.
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

		// Rewrite the arguments HERE, before anything else observes them, and split the
		// result by AUDIENCE.
		//
		// Two different expansions ride this hook and they disagree about display. A
		// codec handle MUST be expanded before a person sees it: `tool_execution_start`
		// is the event a renderer treats as authoritative ("args are final, reconcile
		// them"), so leaving it unexpanded overwrote the live preview with `§handle` and
		// left it there. A secret placeholder is the exact opposite: its expansion is a
		// live credential, and a rendered card, a stream event, a telemetry span and a
		// session file are precisely where it must never land.
		//
		// One form cannot satisfy both, so the transform returns both and the loop routes
		// them. `execution` goes to `tool.execute` and to `beforeToolCall` — the hook that
		// decides whether the call runs, so it must see what would actually run, and whose
		// in-place mutations must reach the tool. `display` goes to everything that shows,
		// streams, traces or records arguments. A sink added here later inherits `display`,
		// so it is safe without knowing that secrets exist.
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
				// Execution start instant for instrumentation: set immediately before
				// the tool runs, so `durationMs` measures the tool body alone and
				// `queuedMs` (start − dispatch) captures the scheduling wait.
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
						// Re-normalize the post-hook result: `afterToolCall` is untyped user/extension
						// code and may return malformed `content` (non-array / invalid blocks), which
						// would otherwise be persisted verbatim and corrupt the session — the same
						// hazard `coerceToolResult` guards on the execute path.
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
			// This tool's own signal fired AND it failed to produce a result: `tool.execute()`
			// never returned (it threw on the abort), so it was genuinely cut off before
			// producing usable output. Report it as skipped.
			//
			// The gate is `abortedDuringExecution` and nothing more, which is the same
			// predicate `status` above is already derived from. It used to also require
			// `interruptState.triggered`, and only a STEERING interrupt sets that. A plain
			// Esc cancels the run without queuing anything, so it fell through to the
			// branch below and the model received the thrown `AbortError`'s own message
			// verbatim, which for an abort is the bare word "aborted". The status field
			// already said "aborted" while the result text said nothing at all, and the
			// interruption an operator performs most often was the one told least.
			//
			// `record.entered` decides WHICH skip this was, and the two call for
			// opposite responses. Cut off before entering `tool.execute()` (still in
			// `beforeToolCall`, e.g. an approval prompt) means nothing ran and the
			// call is safe to retry verbatim. Cut off inside it means the tool was
			// already running and may have applied part of its side effects, so a
			// verbatim retry can double-apply: a half-written file, a `bash` command
			// that got through some of its work. The batch ledger cannot carry this
			// distinction for us here, because this result is emitted while the
			// batch is still running and the ledger is only assembled once every
			// call has settled; a single-call batch never reaches it at all.
			record.skipped = true;
			emitToolResult(
				record,
				createSkippedToolResult(interrupted ? interruptState.source : "cancelled-run", record.entered),
				true,
			);
		} else {
			// No interrupt on this signal, or the tool finished before the interrupt landed
			// (`completedToolExecution`) — even if the signal aborted around completion. Keep
			// its real result: a completed tool already ran its side effects, so the model must
			// see what actually happened (a genuine non-zero exit / error result) rather than a
			// false "skipped" that discards work the tool performed (#4752). A peer-IRC interrupt
			// on the batch leaves non-interruptible tools' signals untouched — their genuine
			// errors survive here too.
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

	// While an interruptible tool is in flight (e.g. a `job`/`irc` wait
	// blocking on external work), queued steering or interrupting IRC would
	// otherwise wait out the tool's own window. Poll only non-consuming queues
	// and abort the shared tool signal so the boundary dequeue below injects
	// the message promptly. Gated on immediate-interrupt mode + an
	// interruptible tool; checkSteering is idempotent (no-op once triggered).
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

	// A record with no result message never produced one: it was skipped before
	// dispatch. `record.skipped`, not the presence of a result message, is what
	// says a call was cut short: a call whose `tool.execute()` was aborted
	// mid-flight was already answered above with a skipped placeholder, so it
	// HAS a result message and an `isError` of true. Keying the ledger off the
	// result message reported that call as "ran, failed" and then told the
	// model its result is already in the transcript and must not be re-run,
	// which is false twice over: nothing usable ran, and the call may have
	// applied part of its side effects.
	//
	// `entered`, not `started`, is what separates "cut off inside the tool"
	// from "cut off while waiting for approval": only the first can have
	// applied side effects.
	//
	// `records.length > 1` is the noise guard: a one-call batch has no
	// siblings to inventory, so a ledger there is a second copy of what the
	// call's own placeholder already says. It stays, and it no longer costs the
	// side-effect warning, because that warning now rides the placeholder text
	// itself (`createSkippedToolResult`'s `entered`) rather than only the
	// ledger.
	//
	// The ledger rides one placeholder, so it is only built when there is a
	// placeholder left to carry it. A batch in which every cut-short call was
	// already answered above has nothing to attach it to, and nothing to add:
	// each of those placeholders already states its own outcome.
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

export function syntheticDetailsFor(
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
export function buildAbortedTurnLedger(
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
export function createAbortedToolResult(
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
export function createToolSignalAbortedResult(
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
export function createSkippedToolResult(
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
