import type { AssistantMessage, ToolCallStatus, ToolChoice, ToolResultMessage, UserMessage } from "@veyyon/ai";
import * as AIError from "@veyyon/ai/error";
import { captureToolCallMetrics } from "@veyyon/ai/instrumentation";
import { type CursorExecResolvedCarrier, kCursorExecResolved } from "@veyyon/ai/utils/block-symbols";
import { EventStream } from "@veyyon/ai/utils/event-stream";
import { type HarmonyRecoveredToolCall, signalListLabel } from "@veyyon/ai/utils/harmony-leak";
import { validateToolArguments } from "@veyyon/ai/utils/validation";
import { errorMessage, estimateTokensFromText, isAbortError, isRecord, logger } from "@veyyon/utils";
import {
	extractIntent,
	normalizeMessagesForProvider,
	normalizeTools,
	resolveAsides,
	resolveConfiguredDialect,
	resolveOwnedDialectFromEnv,
} from "./agent-loop-context";
import { coerceToolResult, snapshotAssistantMessage } from "./agent-loop-snapshots";
import {
	abortReasonText,
	buildToolCallAbortMessages,
	createToolScopedAbortReason,
	emitAbortedAssistantMessage,
	emitHarmonyAudit,
	HarmonyLeakInterruption,
	STREAM_INTERRUPTED_AFTER_CONTENT_STOP_DETAIL,
	streamAssistantResponse,
	TERMINAL_TOOL_RESULT_ABORT_REASON,
	type ToolScopedAbortReason,
	toolScopedAbortReason,
} from "./agent-loop-stream";
import { agentPauseGate } from "./pause";
import { type AgentRunCoverage, type AgentRunSummary, ToolCallBlockedError } from "./run-collector";
import {
	type AgentTelemetry,
	finishExecuteToolSpan,
	finishInvokeAgentSpan,
	fireOnRunEnd,
	PiGenAIAttr,
	recordSkippedTool,
	resolveTelemetry,
	runInActiveSpan,
	type Span,
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
import {
	type AgentContext,
	type AgentEvent,
	type AgentLoopConfig,
	type AgentMessage,
	type AgentToolResult,
	type AgentTurnEndContext,
	isSoftToolRequirement,
	type SteeringInterruptSource,
	type SteeringQueueState,
	type StreamFn,
} from "./types";
import { yieldIfDue } from "./utils/yield";

export {
	abortReasonText,
	createToolScopedAbortReason,
	normalizeMessagesForProvider,
	normalizeTools,
	resolveConfiguredDialect,
	resolveOwnedDialectFromEnv,
	STREAM_INTERRUPTED_AFTER_CONTENT_STOP_DETAIL,
	TERMINAL_TOOL_RESULT_ABORT_REASON,
	type ToolScopedAbortReason,
};

const EMPTY_STRING_SET: ReadonlySet<string> = new Set<string>();
const MAX_PAUSED_TURN_CONTINUATIONS = 8;
const MAX_SOFT_TOOL_ESCALATIONS = 3;
const STEERING_INTERRUPT_POLL_MS = 250;

function hardToolChoiceBlocks(choice: ToolChoice | undefined, requiredTool: string): boolean {
	if (choice === undefined) return false;
	if (typeof choice === "string") return choice === "none";
	const name = choice.type === "tool" ? choice.name : "function" in choice ? choice.function.name : choice.name;
	return name !== requiredTool;
}

function createAgentStream(): EventStream<AgentEvent, AgentMessage[]> {
	return new EventStream<AgentEvent, AgentMessage[]>(
		(event: AgentEvent) => event.type === "agent_end",
		(event: AgentEvent) => (event.type === "agent_end" ? event.messages : []),
	);
}

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

export interface AgentLoopDetailedResult {
	readonly messages: AgentMessage[];
	readonly telemetry: AgentRunSummary | undefined;
	readonly coverage: AgentRunCoverage | undefined;
}

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

async function runLoopBody(
	currentContext: AgentContext,
	newMessages: AgentMessage[],
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	stream: EventStream<AgentEvent, AgentMessage[]>,
	telemetry: AgentTelemetry | undefined,
	invokeAgentSpan: Span | undefined,
	stepCounter: { count: number },
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

				forcedToolChoice = undefined;
				directiveResolvedForTurn = false;

				if (message.stopReason === "error" || message.stopReason === "aborted") {
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

	const dispatchedAt = instrumentationLevel === "off" ? 0 : Date.now();
	const records = toolCalls.map((toolCall, batchIndex) => {
		const tool =
			tools?.find(t => t.name === toolCall.name) ??
			tools?.find(t => t.customWireName !== undefined && t.customWireName === toolCall.name);
		const declaredInterruptible = tool?.interruptible;
		let interruptible: boolean;
		const callArgs = isRecord(toolCall.arguments) ? (toolCall.arguments as Record<string, unknown>) : {};
		if (typeof declaredInterruptible === "function") {
			try {
				interruptible = declaredInterruptible(callArgs) === true;
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
			args: callArgs,
			interruptible,
			signal: interruptible ? interruptibleSignal : nonInterruptibleSignal,
			started: false,
			entered: false,
			startedAt: undefined as number | undefined,
			concurrency: undefined as "shared" | "exclusive" | undefined,
			result: undefined as AgentToolResult<unknown> | undefined,
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
		if (interruptState.triggered) return;
		if (hasIrcInterrupts && (await hasIrcInterrupts())) {
			interruptState.triggered = true;
			interruptState.source = "irc";
			ircAbortController.abort();
		}
	};

	const emitToolResult = (
		record: (typeof records)[number],
		result: AgentToolResult<unknown>,
		isError: boolean,
	): void => {
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
		let argsForExecution = record.args;
		if (intentTracing) {
			const { intent, strippedArgs } = extractIntent(argsForExecution);
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

		let result: AgentToolResult<unknown> = { content: [], details: {} };
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

export interface SyntheticToolResultDetails {
	__synthetic: true;
	source: "assistant_stop_aborted" | "assistant_stop_error" | "assistant_stop_skipped" | "assistant_stop_length";
	executed: false;
	upstreamError?: string;
	batchLedger?: ToolBatchLedger;
}

export interface SkippedToolResultDetails {
	__skipped: true;
	source: SteeringInterruptSource | "irc" | "cancelled-run" | "steering";
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

function createSkippedToolResult(
	source: SteeringInterruptSource | "irc" | "cancelled-run" | undefined,
	entered: boolean,
	batchLedger?: ToolBatchLedger,
): AgentToolResult<unknown> {
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
