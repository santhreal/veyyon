import type {
	AssistantMessage,
	AssistantMessageEvent,
	AssistantTurnStatus,
	Context,
	IncompleteToolCall,
	ToolChoice,
} from "@veyyon/ai";
import { isApiKeyResolver, resolveApiKeyOnce, seedApiKeyResolver } from "@veyyon/ai/auth-retry";
import {
	type Dialect,
	encodeInbandToolHistory,
	renderInbandToolPrompt,
	wrapInbandToolStream,
} from "@veyyon/ai/dialect";
import * as AIError from "@veyyon/ai/error";
import { captureAssistantTurnMetrics, captureAssistantTurnRequest } from "@veyyon/ai/instrumentation";
import { streamSimple } from "@veyyon/ai/stream";
import {
	clearStreamingPartialJson,
	getStreamingPartialJson,
	type StreamingPartialJsonCarrier,
} from "@veyyon/ai/utils/block-symbols";
import type { EventStream } from "@veyyon/ai/utils/event-stream";
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
import { preferredDialect } from "@veyyon/catalog/identity";
import { emptyUsage } from "@veyyon/catalog/models";
import { isAbortError, isRecord } from "@veyyon/utils";
import { STREAM_INTERRUPTED_AFTER_CONTENT_STOP_DETAIL, TERMINAL_TOOL_RESULT_ABORT_REASON } from "./agent-loop";
import { normalizeMessagesForProvider, normalizeTools, resolveConfiguredDialect } from "./agent-loop-context";
import { snapshotAssistantMessage, snapshotAssistantMessageEvent } from "./agent-loop-snapshots";
import {
	type AgentTelemetry,
	failChatSpan,
	finishChatSpan,
	runInActiveSpan,
	type Span,
	startChatSpan,
} from "./telemetry";
import type { AgentContext, AgentEvent, AgentLoopConfig, AgentMessage, AgentTool, StreamFn } from "./types";
import { yieldIfDue } from "./utils/yield";

export { STREAM_INTERRUPTED_AFTER_CONTENT_STOP_DETAIL, TERMINAL_TOOL_RESULT_ABORT_REASON };

const ABORTED: unique symbol = Symbol("agent-loop-aborted");

export interface StepCounter {
	count: number;
}

export interface ToolScopedAbortReason {
	readonly kind: "tool-scoped-abort";
	readonly message: string;
	readonly toolCallMessages: Record<string, string>;
	readonly defaultToolCallMessage: string;
}

export function createToolScopedAbortReason(
	message: string,
	toolCallMessages: Record<string, string>,
	defaultToolCallMessage: string,
): ToolScopedAbortReason {
	return { kind: "tool-scoped-abort", message, toolCallMessages, defaultToolCallMessage };
}

export class HarmonyLeakInterruption extends Error {
	constructor(
		readonly detection: HarmonyDetection,
		readonly removed: string,
		readonly recovered?: HarmonyRecoveredToolCall,
	) {
		super(`Detected GPT-5 Harmony protocol leakage (${signalListLabel(detection.signals)})`);
		this.name = "HarmonyLeakInterruption";
	}
}

export async function emitHarmonyAudit(
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

function isStringRecord(value: unknown): value is Record<string, string> {
	if (!isRecord(value)) return false;
	return Object.values(value).every(child => typeof child === "string");
}

export function toolScopedAbortReason(signal: AbortSignal | undefined): ToolScopedAbortReason | undefined {
	const reason = signal?.reason;
	if (!isRecord(reason)) return undefined;
	if (reason.kind !== "tool-scoped-abort") return undefined;
	if (typeof reason.message !== "string") return undefined;
	if (typeof reason.defaultToolCallMessage !== "string") return undefined;
	return isStringRecord(reason.toolCallMessages) ? (reason as unknown as ToolScopedAbortReason) : undefined;
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

export function retainCompletedToolCalls(
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
		content ??= message.content.slice();
		content[index] = { ...block, id: unique };
	}
	return content ? { ...message, content } : message;
}

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

export async function streamAssistantResponse(
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
	const pruneToolDescriptions = !!config.pruneToolDescriptions && !ownedDialect;
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

	const resolvedMetadata = config.metadataResolver ? config.metadataResolver(model.provider) : config.metadata;
	const effectiveTemperature =
		harmonyRetryAttempt > 0 && config.temperature !== undefined ? config.temperature + 0.05 : config.temperature;
	const effectiveToolChoice = ownedDialect ? undefined : (hostToolChoice ?? forcedToolChoice ?? config.toolChoice);
	const effectiveReasoning = dynamicReasoning ?? config.reasoning;
	const effectiveDisableReasoning = dynamicDisableReasoning ?? config.disableReasoning;
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
					// Cancellation failures do not change the committed message.
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
