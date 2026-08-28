import { calculateCost, emptyCost, emptyUsage, inheritUsageCarryovers } from "@veyyon/catalog/models";
import { structuredCloneJSON } from "@veyyon/utils/json";
import { classifyJsonPrefix, parseStreamingJson, parseStreamingJsonThrottled } from "@veyyon/utils/json-parse";
import * as logger from "@veyyon/utils/logger";
import * as AIError from "../error";
import {
	type Api,
	type AssistantMessage,
	type Model,
	OPENAI_MAX_OUTPUT_TOKENS,
	type ServiceTier,
	type StopReason,
	type StreamOptions,
	type TextContent,
	type ThinkingContent,
	type ToolCall,
} from "../types";
import {
	clearStreamingPartialJson,
	kStreamingArgumentsDone,
	kStreamingLastParseLen,
	kStreamingPartialJson,
} from "../utils/block-symbols";
import type { AssistantMessageEventStream } from "../utils/event-stream";
import type { InputItem } from "./openai-codex/request-transformer";
import {
	appendReasoningSummaryPart,
	encodeResponsesToolCallId,
	encodeTextSignatureV1,
	finalizeReasoningThinking,
	foldReasoningSummary,
	type ResponsesToolCallBlock,
	type SequentialCutoffSummaryState,
} from "./openai-responses-codec-helpers";
import type {
	Response as OpenAIResponse,
	ResponseContentPartAddedEvent,
	ResponseCreateParamsStreaming,
	ResponseCustomToolCall,
	ResponseFunctionToolCall,
	ResponseInputItem,
	ResponseOutputItem,
	ResponseOutputMessage,
	ResponseReasoningItem,
	ResponseStatus,
	ResponseStreamEvent,
} from "./openai-responses-wire";
import {
	applyOpenAIResponsesServiceTierCost,
	applyOpenAIServiceTier,
	calculateOpenAIUsageAccounting,
	type OpenAICompatPolicy,
	resolveOpenAICompatPolicy,
} from "./openai-shared";

export {
	appendReasoningSummaryPart,
	appendResponsesToolResultMessages,
	type BuildResponsesInputOptions,
	buildResponsesInput,
	collectCustomCallIds,
	collectKnownCallIds,
	convertResponsesAssistantMessage,
	convertResponsesInputContent,
	createSequentialCutoffSummaryState,
	encodeResponsesToolCallId,
	encodeTextSignatureV1,
	finalizeReasoningThinking,
	isOpenAIResponsesProgressEvent,
	normalizeResponsesToolCallIdForTransform,
	OPENAI_RESPONSES_PROGRESS_EVENT_TYPES,
	ORPHAN_TOOL_CALL_PLACEHOLDER,
	parseTextSignature,
	repairOrphanResponsesToolCalls,
	repairOrphanResponsesToolOutputs,
	type SequentialCutoffSummaryState,
} from "./openai-responses-codec-helpers";

export function appendReasoningSummaryTextDelta(
	item: ResponseReasoningItem,
	block: ThinkingContent,
	delta: string,
	stream: AssistantMessageEventStream,
	output: AssistantMessage,
	contentIndex: number,
): void {
	item.summary = item.summary || [];
	const lastPart = item.summary[item.summary.length - 1];
	if (!lastPart) return;
	block.thinking += delta;
	lastPart.text += delta;
	stream.push({ type: "thinking_delta", contentIndex, delta, partial: output });
}

export function appendReasoningSummaryPartDone(
	item: ResponseReasoningItem,
	block: ThinkingContent,
	stream: AssistantMessageEventStream,
	output: AssistantMessage,
	contentIndex: number,
): void {
	item.summary = item.summary || [];
	const lastPart = item.summary[item.summary.length - 1];
	if (!lastPart) return;
	block.thinking += "\n\n";
	lastPart.text += "\n\n";
	stream.push({ type: "thinking_delta", contentIndex, delta: "\n\n", partial: output });
}

export function applyReasoningSummaryDone(
	state: SequentialCutoffSummaryState,
	block: ThinkingContent,
	text: string,
	summaryIndex: number,
	stream: AssistantMessageEventStream,
	output: AssistantMessage,
	contentIndex: number,
): void {
	while (state.summary.length <= summaryIndex) {
		state.summary.push({ type: "summary_text", text: "" });
	}
	state.summary[summaryIndex].text = text;
	const after = foldReasoningSummary(state.summary);
	if (!after.startsWith(state.emitted)) return;
	let delta = after.slice(state.emitted.length);
	if (!delta) return;
	state.emitted = after;
	if (!block.thinking) delta = delta.replace(/^\n+/, "");
	if (!delta) return;
	block.thinking += delta;
	stream.push({ type: "thinking_delta", contentIndex, delta, partial: output });
}

export function appendMessageContentPart(
	item: ResponseOutputMessage,
	part: ResponseContentPartAddedEvent["part"] | undefined,
): void {
	item.content = item.content || [];
	if (part && (part.type === "output_text" || part.type === "refusal")) {
		item.content.push(part);
	}
}

export function appendMessageTextDelta(
	item: ResponseOutputMessage,
	block: TextContent,
	delta: string,
	stream: AssistantMessageEventStream,
	output: AssistantMessage,
	contentIndex: number,
	partType: "output_text" | "refusal",
): void {
	item.content = item.content || [];
	let lastPart = item.content[item.content.length - 1];
	if (lastPart?.type !== partType) {
		lastPart =
			partType === "output_text"
				? { type: "output_text", text: "", annotations: [] }
				: { type: "refusal", refusal: "" };
		item.content.push(lastPart);
	}
	block.text += delta;
	if (lastPart.type === "output_text") {
		lastPart.text += delta;
	} else {
		lastPart.refusal += delta;
	}
	stream.push({ type: "text_delta", contentIndex, delta, partial: output });
}

export function finalizeMessageText(item: ResponseOutputMessage, streamedText: string): string {
	if (!item.content?.length) return streamedText || "";
	return item.content.map(part => (part.type === "output_text" ? (part.text ?? "") : (part.refusal ?? ""))).join("");
}

export type ToolCallArgumentsDeltaShape = "incremental" | "cumulative";

export const RESPONSES_PROVIDER_TOOL_CALL_DELTA_SHAPES: Readonly<Record<string, ToolCallArgumentsDeltaShape>> = {
	azure: "incremental",
	"github-copilot": "incremental",
	"gitlab-duo": "incremental",
	ollama: "incremental",
	openai: "incremental",
	"openai-codex": "cumulative",
	opencode: "incremental",
	"opencode-go": "incremental",
	"opencode-zen": "incremental",
	openrouter: "incremental",
	sakana: "incremental",
	"xai-oauth": "incremental",
};

export const RESPONSES_API_TOOL_CALL_DELTA_SHAPES: Readonly<Record<string, ToolCallArgumentsDeltaShape>> = {
	"openai-responses": "incremental",
	"azure-openai-responses": "incremental",
	"openai-codex-responses": "cumulative",
	openrouter: "incremental",
};

export function resolveResponsesToolCallDeltaShape(
	providerOrModel: string | { provider?: string; api?: string },
	api?: string,
): ToolCallArgumentsDeltaShape {
	const provider = typeof providerOrModel === "string" ? providerOrModel : (providerOrModel.provider ?? "");
	const resolvedApi = typeof providerOrModel === "object" ? (providerOrModel.api ?? api) : api;

	const providerShape = provider ? RESPONSES_PROVIDER_TOOL_CALL_DELTA_SHAPES[provider] : undefined;
	if (providerShape) return providerShape;

	const apiShape = resolvedApi ? RESPONSES_API_TOOL_CALL_DELTA_SHAPES[resolvedApi] : undefined;
	if (apiShape) return apiShape;

	throw new Error(
		`Undeclared tool-call argument delta wire shape for provider "${provider}" (api: "${resolvedApi}"). Explicitly declare its shape in RESPONSES_PROVIDER_TOOL_CALL_DELTA_SHAPES before routing through the Responses accumulator.`,
	);
}

export function accumulateToolCallArgumentsDelta(
	block: ResponsesToolCallBlock,
	delta: string,
	stream: AssistantMessageEventStream,
	output: AssistantMessage,
	contentIndex: number,
	shape: ToolCallArgumentsDeltaShape,
): void {
	if (shape === "cumulative") {
		const previous = block[kStreamingPartialJson] ?? "";
		const accumulated = delta.startsWith(previous) ? delta : previous + delta;
		const incrementalDelta = accumulated.slice(previous.length);
		block[kStreamingPartialJson] = accumulated;
		const throttled = parseStreamingJsonThrottled(block[kStreamingPartialJson], block[kStreamingLastParseLen] ?? 0);
		if (throttled) {
			block.arguments = throttled.value;
			block[kStreamingLastParseLen] = throttled.parsedLen;
		}
		if (incrementalDelta) {
			stream.push({ type: "toolcall_delta", contentIndex, delta: incrementalDelta, partial: output });
		}
	} else {
		block[kStreamingPartialJson] = (block[kStreamingPartialJson] ?? "") + delta;
		const throttled = parseStreamingJsonThrottled(block[kStreamingPartialJson], block[kStreamingLastParseLen] ?? 0);
		if (throttled) {
			block.arguments = throttled.value;
			block[kStreamingLastParseLen] = throttled.parsedLen;
		}
		if (delta) {
			stream.push({ type: "toolcall_delta", contentIndex, delta, partial: output });
		}
	}
}

export function finalizeToolCallArgumentsDone(block: ResponsesToolCallBlock, args: string): void {
	block[kStreamingPartialJson] = args;
	block.arguments = parseStreamingJson(block[kStreamingPartialJson]);
	clearStreamingPartialJson(block);
}

export function accumulateCustomToolCallInputDelta(
	block: ResponsesToolCallBlock,
	delta: string,
	stream: AssistantMessageEventStream,
	output: AssistantMessage,
	contentIndex: number,
): void {
	block[kStreamingPartialJson] += delta;
	block.arguments = { input: block[kStreamingPartialJson] };
	stream.push({ type: "toolcall_delta", contentIndex, delta, partial: output });
}

export function finalizeCustomToolCallInputDone(block: ResponsesToolCallBlock, input: string): void {
	block[kStreamingPartialJson] = input;
	block.arguments = { input };
}

type OpenAIResponsesTerminalStreamEvent =
	| Extract<ResponseStreamEvent, { type: "response.completed" | "response.incomplete" }>
	| { type: "response.done"; response?: Partial<OpenAIResponse> };

interface ResponsesStatusDetailsView {
	status_details?: { error?: { code?: string; message?: string }; reason?: unknown };
}

function getOpenAIResponsesTerminalEvent(event: ResponseStreamEvent): OpenAIResponsesTerminalStreamEvent | undefined {
	const eventObj = event as { type?: unknown };
	const type = eventObj.type;
	return type === "response.completed" || type === "response.incomplete" || type === "response.done"
		? (event as OpenAIResponsesTerminalStreamEvent)
		: undefined;
}

export interface ProcessResponsesStreamOptions {
	onFirstToken?: () => void;
	onOutputItemDone?: (item: ResponseOutputItem) => void;
	onCompleted?: () => void;
	requestServiceTier?: ServiceTier;
}

export async function processResponsesStream<TApi extends Api>(
	openaiStream: AsyncIterable<ResponseStreamEvent>,
	output: AssistantMessage,
	stream: AssistantMessageEventStream,
	model: Model<TApi>,
	options?: ProcessResponsesStreamOptions,
): Promise<void> {
	const deltaShape = resolveResponsesToolCallDeltaShape(model);
	type StreamingToolCallBlock = ToolCall & {
		[kStreamingPartialJson]: string;
		[kStreamingLastParseLen]?: number;
		[kStreamingArgumentsDone]?: boolean;
	};
	interface StreamingItem {
		item: ResponseReasoningItem | ResponseOutputMessage | ResponseFunctionToolCall | ResponseCustomToolCall;
		block: ThinkingContent | TextContent | StreamingToolCallBlock;
	}

	// time. OpenAI's spec routes every per-item event by `output_index`/`item_id`.
	// llama.cpp emits parallel function_call deltas interleaved, and a singleton
	// `output_index` on `output_item.added` while routing later argument deltas to
	const openItemsByOutputIndex = new Map<number, StreamingItem>();
	const openItemsByItemId = new Map<string, StreamingItem>();
	const openItemsByPrefixedCallId = new Map<string, StreamingItem>();
	let lastOpenItem: StreamingItem | null = null;
	const openItemsInOrder: StreamingItem[] = [];

	const prefixedFunctionCallItemKey = (callId: string | undefined): string | undefined =>
		callId ? `fc_${callId}` : undefined;

	const registerOpenItem = (
		outputIndex: number | undefined,
		itemId: string | undefined,
		entry: StreamingItem,
		alternateItemKey?: string,
		prefixedAlternateItemKey?: string,
	): void => {
		if (typeof outputIndex === "number") openItemsByOutputIndex.set(outputIndex, entry);
		if (itemId) openItemsByItemId.set(itemId, entry);
		if (alternateItemKey && alternateItemKey !== itemId) openItemsByItemId.set(alternateItemKey, entry);
		if (
			prefixedAlternateItemKey &&
			prefixedAlternateItemKey !== itemId &&
			prefixedAlternateItemKey !== alternateItemKey
		) {
			openItemsByPrefixedCallId.set(prefixedAlternateItemKey, entry);
		}
		openItemsInOrder.push(entry);
		lastOpenItem = entry;
	};
	const lookupOpenItem = (event: { output_index?: number; item_id?: string }): StreamingItem | undefined => {
		const hasKey = typeof event.output_index === "number" || event.item_id !== undefined;
		if (typeof event.output_index === "number") {
			const found = openItemsByOutputIndex.get(event.output_index);
			if (found) return found;
		}
		if (event.item_id) {
			const found = openItemsByItemId.get(event.item_id);
			if (found) return found;
		}
		return hasKey ? undefined : (lastOpenItem ?? undefined);
	};
	const hasOpenItemKey = (event: { output_index?: number; item_id?: string }): boolean =>
		typeof event.output_index === "number" || event.item_id !== undefined;
	const startsJsonObjectDelta = (delta: unknown): boolean => {
		if (typeof delta !== "string") return false;
		for (let index = 0; index < delta.length; index++) {
			const code = delta.charCodeAt(index);
			if (code === 0x09 || code === 0x0a || code === 0x0d || code === 0x20) continue;
			return code === 0x7b;
		}
		return false;
	};
	const shouldAdvanceIdentifierlessFunctionDelta = (
		event: { output_index?: number; item_id?: string; delta?: unknown },
		candidate: StreamingItem,
	): boolean => {
		const delta = event.delta;
		if (
			hasOpenItemKey(event) ||
			typeof delta !== "string" ||
			!startsJsonObjectDelta(delta) ||
			candidate.item.type !== "function_call" ||
			candidate.block.type !== "toolCall"
		) {
			return false;
		}
		const partial = candidate.block[kStreamingPartialJson];
		if (partial.trim().length === 0) return false;
		const state = classifyJsonPrefix(partial);
		if (state !== "prefix") return true;
		return classifyJsonPrefix(partial + delta) === "invalid";
	};
	const hasLaterUnfinishedFunctionCall = (start: number): boolean => {
		for (let index = start + 1; index < openItemsInOrder.length; index++) {
			const candidate = openItemsInOrder[index];
			if (
				candidate?.item.type === "function_call" &&
				candidate.block.type === "toolCall" &&
				!candidate.block[kStreamingArgumentsDone]
			) {
				return true;
			}
		}
		return false;
	};

	let identifierlessFunctionDeltaTarget: StreamingItem | undefined;

	const lookupOpenToolCallAlias = (
		event: { output_index?: number; item_id?: string },
		type: "function_call" | "custom_tool_call",
	): StreamingItem | undefined => {
		if (typeof event.output_index === "number") {
			const byOutputIndex = openItemsByOutputIndex.get(event.output_index);
			if (byOutputIndex) return byOutputIndex;
			// A lossy host (llama.cpp/Ollama, issue #2015) can omit `output_index` on
		}
		if (event.item_id) {
			const alias = openItemsByPrefixedCallId.get(event.item_id);
			if (alias?.item.type === type) return alias;
			const exact = openItemsByItemId.get(event.item_id);
			if (exact) return exact;
		}
		return lookupOpenItem(event);
	};
	const lookupOpenFunctionCallItem = (event: {
		output_index?: number;
		item_id?: string;
		delta?: unknown;
	}): StreamingItem | undefined => {
		if (hasOpenItemKey(event)) return lookupOpenToolCallAlias(event, "function_call");
		const canContinuePreviousIdentifierlessDelta = typeof event.delta === "string";
		if (canContinuePreviousIdentifierlessDelta && identifierlessFunctionDeltaTarget) {
			const targetIndex = openItemsInOrder.indexOf(identifierlessFunctionDeltaTarget);
			const target = targetIndex >= 0 ? openItemsInOrder[targetIndex] : undefined;
			if (
				target?.item.type === "function_call" &&
				target.block.type === "toolCall" &&
				!target.block[kStreamingArgumentsDone]
			) {
				const shouldAdvanceFromTarget =
					shouldAdvanceIdentifierlessFunctionDelta(event, target) && hasLaterUnfinishedFunctionCall(targetIndex);
				if (!shouldAdvanceFromTarget) return target;
			} else {
				identifierlessFunctionDeltaTarget = undefined;
			}
		}
		let skippedStartedCandidate = false;
		for (let index = 0; index < openItemsInOrder.length; index++) {
			const candidate = openItemsInOrder[index]!;
			if (
				candidate.item.type === "function_call" &&
				candidate.block.type === "toolCall" &&
				!candidate.block[kStreamingArgumentsDone]
			) {
				if (shouldAdvanceIdentifierlessFunctionDelta(event, candidate) && hasLaterUnfinishedFunctionCall(index)) {
					skippedStartedCandidate = true;
					continue;
				}
				if (canContinuePreviousIdentifierlessDelta) identifierlessFunctionDeltaTarget = candidate;
				return candidate;
			}
		}
		if (skippedStartedCandidate && startsJsonObjectDelta(event.delta)) return undefined;
		return lastOpenItem?.item.type === "function_call" ? lastOpenItem : undefined;
	};
	const closeOpenItem = (
		outputIndex: number | undefined,
		itemId: string | undefined,
		entry: StreamingItem | undefined,
		alternateItemKey?: string,
		prefixedAlternateItemKey?: string,
	): void => {
		if (typeof outputIndex === "number") openItemsByOutputIndex.delete(outputIndex);
		if (itemId) openItemsByItemId.delete(itemId);
		if (alternateItemKey && alternateItemKey !== itemId) openItemsByItemId.delete(alternateItemKey);
		if (
			prefixedAlternateItemKey &&
			prefixedAlternateItemKey !== itemId &&
			prefixedAlternateItemKey !== alternateItemKey &&
			openItemsByPrefixedCallId.get(prefixedAlternateItemKey) === entry
		) {
			openItemsByPrefixedCallId.delete(prefixedAlternateItemKey);
		}
		if (entry) {
			const index = openItemsInOrder.indexOf(entry);
			if (index >= 0) openItemsInOrder.splice(index, 1);
		}
		if (entry && identifierlessFunctionDeltaTarget === entry) identifierlessFunctionDeltaTarget = undefined;
		if (entry && lastOpenItem === entry) lastOpenItem = null;
	};
	const contentIndexOf = (block: ThinkingContent | TextContent | StreamingToolCallBlock): number =>
		output.content.indexOf(block);

	let sawFirstToken = false;

	for await (const event of openaiStream) {
		const terminalEvent = getOpenAIResponsesTerminalEvent(event);
		if (event.type === "response.created") {
			output.responseId = event.response.id;
		} else if (event.type === "response.output_item.added") {
			if (!sawFirstToken) {
				sawFirstToken = true;
				options?.onFirstToken?.();
			}
			const item = event.item;
			if (item.type === "reasoning") {
				const block: ThinkingContent = { type: "thinking", thinking: "", itemId: item.id };
				output.content.push(block);
				registerOpenItem(event.output_index, item.id, { item, block });
				stream.push({ type: "thinking_start", contentIndex: contentIndexOf(block), partial: output });
			} else if (item.type === "message") {
				const block: TextContent = {
					type: "text",
					text: "",
					textSignature: encodeTextSignatureV1(item.id, item.phase ?? undefined),
				};
				output.content.push(block);
				registerOpenItem(event.output_index, item.id, { item, block });
				stream.push({ type: "text_start", contentIndex: contentIndexOf(block), partial: output });
			} else if (item.type === "function_call") {
				const block: StreamingToolCallBlock = {
					type: "toolCall",
					id: encodeResponsesToolCallId(item.call_id, item.id),
					name: item.name,
					arguments: {},
					[kStreamingPartialJson]: item.arguments || "",
				};
				output.content.push(block);
				registerOpenItem(
					event.output_index,
					item.id,
					{ item, block },
					item.call_id,
					prefixedFunctionCallItemKey(item.call_id),
				);
				stream.push({ type: "toolcall_start", contentIndex: contentIndexOf(block), partial: output });
			} else if (item.type === "custom_tool_call") {
				const block: StreamingToolCallBlock = {
					type: "toolCall",
					id: encodeResponsesToolCallId(item.call_id, item.id),
					name: item.name,
					arguments: { input: item.input ?? "" },
					customWireName: item.name,
					[kStreamingPartialJson]: item.input ?? "",
				};
				output.content.push(block);
				registerOpenItem(
					event.output_index,
					item.id,
					{ item, block },
					item.call_id,
					prefixedFunctionCallItemKey(item.call_id),
				);
				stream.push({ type: "toolcall_start", contentIndex: contentIndexOf(block), partial: output });
			}
		} else if (event.type === "response.reasoning_summary_part.added") {
			const entry = lookupOpenItem(event);
			if (entry?.item.type === "reasoning") appendReasoningSummaryPart(entry.item, event.part);
		} else if (event.type === "response.reasoning_summary_text.delta") {
			const entry = lookupOpenItem(event);
			if (entry?.item.type === "reasoning" && entry.block.type === "thinking") {
				appendReasoningSummaryTextDelta(
					entry.item,
					entry.block,
					event.delta,
					stream,
					output,
					contentIndexOf(entry.block),
				);
			}
		} else if (event.type === "response.reasoning_summary_part.done") {
			const entry = lookupOpenItem(event);
			if (entry?.item.type === "reasoning" && entry.block.type === "thinking") {
				appendReasoningSummaryPartDone(entry.item, entry.block, stream, output, contentIndexOf(entry.block));
			}
		} else if (event.type === "response.reasoning_text.delta") {
			const entry = lookupOpenItem(event);
			if (entry?.item.type === "reasoning" && entry.block.type === "thinking") {
				entry.block.thinking += event.delta;
				stream.push({
					type: "thinking_delta",
					contentIndex: contentIndexOf(entry.block),
					delta: event.delta,
					partial: output,
				});
			}
		} else if (event.type === "response.content_part.added") {
			const entry = lookupOpenItem(event);
			if (entry?.item.type === "message") appendMessageContentPart(entry.item, event.part);
		} else if (event.type === "response.output_text.delta") {
			const entry = lookupOpenItem(event);
			if (entry?.item.type === "message" && entry.block.type === "text") {
				appendMessageTextDelta(
					entry.item,
					entry.block,
					event.delta,
					stream,
					output,
					contentIndexOf(entry.block),
					"output_text",
				);
			}
		} else if (event.type === "response.refusal.delta") {
			const entry = lookupOpenItem(event);
			if (entry?.item.type === "message" && entry.block.type === "text") {
				appendMessageTextDelta(
					entry.item,
					entry.block,
					event.delta,
					stream,
					output,
					contentIndexOf(entry.block),
					"refusal",
				);
			}
		} else if (event.type === "response.function_call_arguments.delta") {
			const entry = lookupOpenFunctionCallItem(event);
			if (entry?.item.type === "function_call" && entry.block.type === "toolCall") {
				accumulateToolCallArgumentsDelta(
					entry.block,
					event.delta,
					stream,
					output,
					contentIndexOf(entry.block),
					deltaShape,
				);
			}
		} else if (event.type === "response.function_call_arguments.done") {
			const entry = lookupOpenFunctionCallItem(event);
			if (entry?.item.type === "function_call" && entry.block.type === "toolCall") {
				finalizeToolCallArgumentsDone(entry.block, event.arguments);
				entry.block[kStreamingArgumentsDone] = true;
			}
		} else if (event.type === "response.custom_tool_call_input.delta") {
			const entry = lookupOpenToolCallAlias(event, "custom_tool_call");
			if (entry?.item.type === "custom_tool_call" && entry.block.type === "toolCall") {
				accumulateCustomToolCallInputDelta(entry.block, event.delta, stream, output, contentIndexOf(entry.block));
			}
		} else if (event.type === "response.custom_tool_call_input.done") {
			const entry = lookupOpenToolCallAlias(event, "custom_tool_call");
			if (entry?.item.type === "custom_tool_call" && entry.block.type === "toolCall") {
				finalizeCustomToolCallInputDone(entry.block, event.input);
			}
		} else if (event.type === "response.output_item.done") {
			const item = structuredCloneJSON(event.item);
			options?.onOutputItemDone?.(item);
			const entry =
				item.type === "function_call" || item.type === "custom_tool_call"
					? lookupOpenItem({ output_index: event.output_index, item_id: item.id ?? item.call_id })
					: lookupOpenItem({ output_index: event.output_index, item_id: item.id });
			if (item.type === "reasoning") {
				let reasoningBlock: ThinkingContent | undefined;
				if (entry?.block.type === "thinking") {
					reasoningBlock = entry.block;
				} else {
					const candidate = output.content.find(
						b => b.type === "thinking" && (b as ThinkingContent).itemId === item.id,
					);
					if (candidate && candidate.type === "thinking") {
						reasoningBlock = candidate;
					}
				}
				if (reasoningBlock) {
					reasoningBlock.thinking = finalizeReasoningThinking(item, reasoningBlock.thinking);
					reasoningBlock.thinkingSignature = JSON.stringify(item);
					stream.push({
						type: "thinking_end",
						contentIndex: contentIndexOf(reasoningBlock),
						content: reasoningBlock.thinking,
						partial: output,
					});
				}
				closeOpenItem(event.output_index, item.id, entry);
			} else if (item.type === "message") {
				const block = entry?.block.type === "text" ? entry.block : undefined;
				const text = finalizeMessageText(item, block?.text ?? "");
				const textSignature = encodeTextSignatureV1(item.id, item.phase ?? undefined);
				let contentIndex: number;
				if (block) {
					block.text = text;
					block.textSignature = textSignature;
					contentIndex = contentIndexOf(block);
				} else {
					const synthesized: TextContent = { type: "text", text, textSignature };
					output.content.push(synthesized);
					contentIndex = output.content.length - 1;
				}
				stream.push({ type: "text_end", contentIndex, content: text, partial: output });
				closeOpenItem(event.output_index, item.id, entry);
			} else if (item.type === "function_call") {
				const block = entry?.block.type === "toolCall" ? entry.block : undefined;
				const args = block?.[kStreamingArgumentsDone]
					? block.arguments
					: item.arguments
						? parseStreamingJson(item.arguments)
						: block?.[kStreamingPartialJson]
							? parseStreamingJson(block[kStreamingPartialJson])
							: parseStreamingJson("{}");
				const toolCall: ToolCall = {
					type: "toolCall",
					id: encodeResponsesToolCallId(item.call_id, item.id),
					name: item.name,
					arguments: args,
				};
				let contentIndex: number;
				if (block) {
					block.arguments = args;
					clearStreamingPartialJson(block);
					contentIndex = contentIndexOf(block);
				} else {
					output.content.push(toolCall);
					contentIndex = output.content.length - 1;
				}
				closeOpenItem(event.output_index, item.id, entry, item.call_id, prefixedFunctionCallItemKey(item.call_id));
				stream.push({ type: "toolcall_end", contentIndex, toolCall, partial: output });
			} else if (item.type === "custom_tool_call") {
				const block = entry?.block.type === "toolCall" ? entry.block : undefined;
				const rawInput = block?.[kStreamingPartialJson] ? block[kStreamingPartialJson] : (item.input ?? "");
				const toolCall: ToolCall = {
					type: "toolCall",
					id: encodeResponsesToolCallId(item.call_id, item.id),
					name: item.name,
					arguments: { input: rawInput },
					customWireName: item.name,
				};
				let contentIndex: number;
				if (block) {
					block.arguments = { input: rawInput };
					clearStreamingPartialJson(block);
					contentIndex = contentIndexOf(block);
				} else {
					output.content.push(toolCall);
					contentIndex = output.content.length - 1;
				}
				closeOpenItem(event.output_index, item.id, entry, item.call_id, prefixedFunctionCallItemKey(item.call_id));
				stream.push({ type: "toolcall_end", contentIndex, toolCall, partial: output });
			}
		} else if (terminalEvent) {
			const response = terminalEvent.response;
			finalizePendingResponsesToolCalls(output);
			if (response?.id) {
				output.responseId = response.id;
			}
			populateResponsesUsageFromResponse(output, response?.usage);
			calculateCost(model, output.usage);
			const responseWithTier = response as { service_tier?: unknown } | undefined;
			applyOpenAIResponsesServiceTierCost(
				model,
				output.usage,
				responseWithTier?.service_tier,
				options?.requestServiceTier,
			);
			output.stopReason = mapOpenAIResponsesStopReason(response?.status);
			if (response?.status === "failed" || response?.status === "cancelled") {
				const statusDetails = (response as ResponsesStatusDetailsView | undefined)?.status_details;
				const error = response?.error ?? statusDetails?.error;
				const details = response?.incomplete_details;
				const statusDetailsReason = statusDetails?.reason;
				const message = error
					? `${error.code || "unknown"}: ${error.message || "no message"}`
					: details?.reason
						? `incomplete: ${details.reason}`
						: typeof statusDetailsReason === "string" && statusDetailsReason.length > 0
							? `status_details: ${statusDetailsReason}`
							: "Unknown error (no error details in response)";
				throw new AIError.ProviderResponseError(message, { provider: model.provider, kind: "output" });
			}
			if (response?.status === "incomplete" && response.incomplete_details?.reason === "content_filter") {
				throw new AIError.ProviderResponseError("incomplete: content_filter", {
					provider: model.provider,
					kind: "content-blocked",
				});
			}
			const responseWithEndTurn = response as { end_turn?: boolean } | undefined;
			promoteResponsesToolUseStopReason(output, responseWithEndTurn?.end_turn);
			options?.onCompleted?.();
			break;
		} else if (event.type === "error") {
			const errorEvent = event as {
				error?: { code?: unknown; message?: unknown };
				code?: unknown;
				message?: unknown;
			};
			const err = errorEvent.error ?? errorEvent;
			const code = err.code ?? "unknown";
			const message = err.message ?? "no message";
			throw new AIError.ProviderResponseError(`Error Code ${code}: ${message}`, {
				provider: model.provider,
				kind: "output",
			});
		} else if (event.type === "response.failed") {
			populateResponsesUsageFromResponse(output, event.response?.usage);
			const error =
				event.response?.error ?? (event.response as ResponsesStatusDetailsView | undefined)?.status_details?.error;
			const details = event.response?.incomplete_details;
			const message = error
				? `${error.code || "unknown"}: ${error.message || "no message"}`
				: details?.reason
					? `incomplete: ${details.reason}`
					: "Unknown error (no error details in response)";
			throw new AIError.ProviderResponseError(message, { provider: model.provider, kind: "output" });
		}
	}
}

export function mapOpenAIResponsesStopReason(status: ResponseStatus | undefined): StopReason {
	if (!status) return "stop";
	switch (status) {
		case "completed":
			return "stop";
		case "incomplete":
			return "length";
		case "failed":
		case "cancelled":
			return "error";
		case "in_progress":
		case "queued":
			return "stop";
		default: {
			const exhaustive: never = status;
			logger.warn("Unhandled OpenAI Responses stop reason", { status: exhaustive });
			return "stop";
		}
	}
}

export function finalizePendingResponsesToolCalls(output: AssistantMessage): void {
	for (const block of output.content) {
		if (block.type !== "toolCall") continue;
		const pending = block as ToolCall & {
			[kStreamingPartialJson]?: string;
			[kStreamingLastParseLen]?: number;
			[kStreamingArgumentsDone]?: boolean;
		};
		if (pending[kStreamingPartialJson] && !pending[kStreamingArgumentsDone]) {
			pending.arguments =
				pending.customWireName !== undefined
					? { input: pending[kStreamingPartialJson] }
					: parseStreamingJson(pending[kStreamingPartialJson]);
		}
		clearStreamingPartialJson(pending);
	}
}

export function promoteResponsesToolUseStopReason(output: AssistantMessage, endTurn: boolean | undefined): void {
	if (output.content.some(block => block.type === "toolCall") && output.stopReason === "stop") {
		output.stopReason = "toolUse";
	}
	if (endTurn === false && output.stopReason === "stop") {
		output.stopDetails = { type: "pause_turn" };
	}
}

export function createInitialResponsesAssistantMessage(api: Api, provider: string, modelId: string): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api,
		provider,
		model: modelId,
		usage: emptyUsage(),
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

export type ResponsesSamplingParamsExtras = {
	top_p?: number;
	top_k?: number;
	min_p?: number;
	presence_penalty?: number;
	repetition_penalty?: number;
};

type CommonResponsesParams = ResponseCreateParamsStreaming & ResponsesSamplingParamsExtras;

type CommonSamplingOptions = Pick<
	StreamOptions,
	"temperature" | "topP" | "topK" | "minP" | "presencePenalty" | "repetitionPenalty" | "maxTokens"
> & { serviceTier?: ServiceTier };

export function applyCommonResponsesSamplingParams<P extends CommonResponsesParams>(
	params: P,
	options: CommonSamplingOptions | undefined,
	model: Pick<Model, "provider" | "api" | "id" | "omitMaxOutputTokens" | "maxTokens">,
): void {
	if (options?.maxTokens && !model.omitMaxOutputTokens) {
		params.max_output_tokens = Math.min(
			options.maxTokens,
			model.maxTokens ?? Number.POSITIVE_INFINITY,
			OPENAI_MAX_OUTPUT_TOKENS,
		);
	}
	if (options?.temperature !== undefined) params.temperature = options.temperature;
	if (options?.topP !== undefined) params.top_p = options.topP;
	if (options?.topK !== undefined) params.top_k = options.topK;
	if (options?.minP !== undefined) params.min_p = options.minP;
	if (options?.presencePenalty !== undefined) params.presence_penalty = options.presencePenalty;
	if (options?.repetitionPenalty !== undefined) params.repetition_penalty = options.repetitionPenalty;
	applyOpenAIServiceTier(params, options?.serviceTier, model);
}

type ReasoningOptions = {
	reasoning?: string;
	reasoningSummary?: "auto" | "detailed" | "concise" | null;
	disableReasoning?: boolean;
	toolChoice?: unknown;
};

export interface ApplyResponsesCompatPolicyOptions {
	reasoningSummary?: "auto" | "detailed" | "concise" | null;
	mapEffort?: (effort: string) => string;
}

export function applyResponsesCompatPolicy<P extends ResponseCreateParamsStreaming>(
	params: P,
	policy: OpenAICompatPolicy,
	options: ApplyResponsesCompatPolicyOptions | undefined,
): void {
	const reasoning = policy.reasoning;
	if (!reasoning.modelSupported) return;
	if (reasoning.includeEncryptedReasoning) {
		const include = params.include ?? [];
		if (!include.includes("reasoning.encrypted_content")) include.push("reasoning.encrypted_content");
		params.include = include;
	}

	if (reasoning.disabled) {
		if (reasoning.disableMode === "openrouter-enabled-false") {
			params.reasoning = { enabled: false } as P["reasoning"];
			return;
		}
		if (
			reasoning.disableMode === "lowest-effort" &&
			reasoning.wireEffort !== undefined &&
			!reasoning.omitReasoningEffort
		) {
			type ReasoningParam = NonNullable<ResponseCreateParamsStreaming["reasoning"]>;
			params.reasoning = { effort: reasoning.wireEffort as ReasoningParam["effort"] } as P["reasoning"] &
				ReasoningParam;
			return;
		}
		return;
	}

	if (reasoning.requestedEffort !== undefined || options?.reasoningSummary !== undefined) {
		if (reasoning.omitReasoningEffort) {
			if (options?.reasoningSummary !== undefined && options.reasoningSummary !== null) {
				type ReasoningParam = NonNullable<ResponseCreateParamsStreaming["reasoning"]>;
				params.reasoning = { summary: options.reasoningSummary || "auto" } as P["reasoning"] & ReasoningParam;
			}
			return;
		}

		const requested = reasoning.requestedEffort ?? "medium";
		const wireEffort = reasoning.wireEffort ?? options?.mapEffort?.(requested) ?? requested;
		type ReasoningParam = NonNullable<ResponseCreateParamsStreaming["reasoning"]>;
		const reasoningParams: ReasoningParam = {
			effort: wireEffort as ReasoningParam["effort"],
		};
		if (options?.reasoningSummary !== null) {
			reasoningParams.summary = options?.reasoningSummary || "auto";
		}
		params.reasoning = reasoningParams as P["reasoning"];
		return;
	}
}

export function applyResponsesReasoningParams<P extends ResponseCreateParamsStreaming>(
	params: P,
	model: Model<"openai-responses" | "azure-openai-responses" | "openai-codex-responses">,
	options: ReasoningOptions | undefined,
	mapEffort?: (effort: string) => string,
	includeEncryptedReasoning?: boolean,
	omitReasoningEffort?: boolean,
): void {
	return applyResponsesCompatPolicy(
		params,
		resolveOpenAICompatPolicy(model, {
			endpoint: "responses",
			reasoning: options?.reasoning,
			disableReasoning: options?.disableReasoning,
			toolChoice: options?.toolChoice,
			includeEncryptedReasoning,
			omitReasoningEffort,
		}),
		{ reasoningSummary: options?.reasoningSummary, mapEffort },
	);
}

export function populateResponsesUsageFromResponse(
	output: AssistantMessage,
	usage:
		| {
				input_tokens?: number | null;
				output_tokens?: number | null;
				total_tokens?: number | null;
				prompt_cache_hit_tokens?: number | null;
				prompt_cache_miss_tokens?: number | null;
				input_tokens_details?: {
					cached_tokens?: number | null;
					cache_write_tokens?: number | null;
					orchestration_input_tokens?: number | null;
					orchestration_input_cached_tokens?: number | null;
				} | null;
				output_tokens_details?: {
					reasoning_tokens?: number | null;
					orchestration_output_tokens?: number | null;
				} | null;
		  }
		| null
		| undefined,
): void {
	if (!usage) return;
	const details = usage.input_tokens_details;
	const outputDetails = usage.output_tokens_details;
	const reportedInputTokens = usage.input_tokens ?? 0;
	const reportedOutputTokens = usage.output_tokens ?? 0;
	const reportedCachedTokens = details?.cached_tokens ?? usage.prompt_cache_hit_tokens ?? 0;
	const orchestrationInputTokens = details?.orchestration_input_tokens ?? 0;
	const orchestrationInputCachedTokens = details?.orchestration_input_cached_tokens ?? 0;
	const orchestrationOutputTokens = outputDetails?.orchestration_output_tokens ?? 0;
	const reportedTotalTokens = typeof usage.total_tokens === "number" ? usage.total_tokens : undefined;
	const reportedPrimaryTokens = reportedInputTokens + reportedOutputTokens;
	const reportedWithSeparateOrchestration =
		reportedPrimaryTokens + orchestrationInputTokens + orchestrationOutputTokens;
	const primaryIncludesOrchestration =
		reportedTotalTokens !== undefined &&
		orchestrationInputTokens + orchestrationOutputTokens > 0 &&
		Math.abs(reportedTotalTokens - reportedPrimaryTokens) <=
			Math.abs(reportedTotalTokens - reportedWithSeparateOrchestration);
	const orchestrationInputCached = Math.min(orchestrationInputTokens, orchestrationInputCachedTokens);
	const orchestrationInput = Math.max(0, orchestrationInputTokens - orchestrationInputCached);
	const accounting = calculateOpenAIUsageAccounting({
		promptTokens: Math.max(0, reportedInputTokens - (primaryIncludesOrchestration ? orchestrationInputTokens : 0)),
		outputTokens: Math.max(0, reportedOutputTokens - (primaryIncludesOrchestration ? orchestrationOutputTokens : 0)),
		cachedTokens: Math.max(0, reportedCachedTokens - (primaryIncludesOrchestration ? orchestrationInputCached : 0)),
		reasoningTokens: outputDetails?.reasoning_tokens ?? 0,
		cacheWriteOpenRouter: details?.cache_write_tokens ?? undefined,
		cacheWriteDeepSeek: usage.prompt_cache_miss_tokens ?? undefined,
		hasDeepSeekCacheHitAndMiss:
			usage.prompt_cache_hit_tokens !== undefined && usage.prompt_cache_miss_tokens !== undefined,
	});
	const orchestrationTotal = orchestrationInput + orchestrationInputCached + orchestrationOutputTokens;
	if (orchestrationTotal > 0) {
		accounting.orchestration = {
			...(orchestrationInput > 0 ? { input: orchestrationInput } : {}),
			...(orchestrationInputCached > 0 ? { cacheRead: orchestrationInputCached } : {}),
			...(orchestrationOutputTokens > 0 ? { output: orchestrationOutputTokens } : {}),
		};
		accounting.totalTokens = reportedTotalTokens ?? accounting.totalTokens + orchestrationTotal;
	}

	output.usage = inheritUsageCarryovers(output.usage, {
		...accounting,
		cost: emptyCost(),
	});
}

function deepEqualsWithout(a: unknown, b: unknown, omitKeys?: Record<string, boolean>): boolean {
	if (!a || !b || typeof a !== "object" || typeof b !== "object") return Bun.deepEquals(a, b);
	const ao = a as Record<string, unknown>;
	const bo = b as Record<string, unknown>;
	for (const key in ao) {
		if (omitKeys && Object.hasOwn(omitKeys, key) && omitKeys[key]) continue;
		const av = ao[key];
		const bv = bo[key];
		if (av !== bv && !Bun.deepEquals(av, bv)) return false;
	}
	for (const key in bo) {
		if (omitKeys && Object.hasOwn(omitKeys, key) && omitKeys[key]) continue;
		if (bo[key] !== undefined && !Object.hasOwn(ao, key)) return false;
	}
	return true;
}

const TOP_LEVEL_EXCLUDE_MAP = {
	input: true,
	client_metadata: true,
};

export function buildResponsesDeltaInput<TItem extends ResponseInputItem | InputItem>(
	previous: { input?: TItem[] } | undefined,
	previousResponseItems: readonly TItem[] | undefined,
	current: { input?: TItem[] },
): TItem[] | null {
	if (!previous) return null;
	if (!Array.isArray(previous.input) || !Array.isArray(current.input)) return null;
	if (!deepEqualsWithout(previous, current, TOP_LEVEL_EXCLUDE_MAP)) {
		return null;
	}

	const baselineLen = (previous.input?.length ?? 0) + (previousResponseItems?.length ?? 0);
	if (current.input.length <= baselineLen) return null;

	let index = 0;
	for (const series of [previous.input, previousResponseItems]) {
		if (!series) continue;
		for (const item of series) {
			if (deepEqualsWithout(item, current.input[index])) {
				index++;
			} else {
				return null;
			}
		}
	}
	return current.input.slice(index) as TItem[];
}
