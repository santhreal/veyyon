import { stringifyJson } from "@veyyon/utils/json";
import type {
	Api,
	AssistantMessage,
	Context,
	ImageContent,
	Model,
	TextContent,
	TextSignatureV1,
	Tool,
	ToolCall,
	ToolResultMessage,
} from "../types";
import {
	getOpenAIResponsesHistoryItems,
	getOpenAIResponsesHistoryPayload,
	normalizeResponsesToolCallId,
	normalizeSystemPrompts,
	sanitizeOpenAIResponsesAssistantFallbackItemsForReplay,
	sanitizeOpenAIResponsesAssistantHistoryItemsForReplay,
	sanitizeOpenAIResponsesHistoryItemsForReplay,
} from "../utils";
import { kStreamingLastParseLen, kStreamingPartialJson } from "../utils/block-symbols";
import type {
	ResponseInput,
	ResponseInputContent,
	ResponseInputImage,
	ResponseInputText,
	ResponseOutputMessage,
	ResponseReasoningItem,
} from "./openai-responses-wire";
import { transformMessages } from "./transform-messages";
import { joinTextWithImagePlaceholder, NON_VISION_IMAGE_PLACEHOLDER, partitionVisionContent } from "./vision-guard";

export const OPENAI_RESPONSES_PROGRESS_EVENT_TYPES: ReadonlySet<string> = new Set([
	"response.created",
	"response.output_item.added",
	"response.reasoning_summary_part.added",
	"response.reasoning_summary_text.delta",
	"response.reasoning_summary_text.done",
	"response.reasoning_summary_part.done",
	"response.reasoning_text.delta",
	"response.content_part.added",
	"response.output_text.delta",
	"response.refusal.delta",
	"response.function_call_arguments.delta",
	"response.function_call_arguments.done",
	"response.custom_tool_call_input.delta",
	"response.custom_tool_call_input.done",
	"response.output_item.done",
	"response.completed",
	"response.incomplete",
	"response.failed",
	"error",
]);

export function isOpenAIResponsesProgressEvent(event: unknown): boolean {
	if (!event || typeof event !== "object") return false;
	const eventObj = event as { type?: unknown };
	const type = eventObj.type;
	return typeof type === "string" && OPENAI_RESPONSES_PROGRESS_EVENT_TYPES.has(type);
}

export function encodeTextSignatureV1(id: string, phase?: TextSignatureV1["phase"]): string {
	const payload: TextSignatureV1 = { v: 1, id };
	if (phase) payload.phase = phase;
	return JSON.stringify(payload);
}

export function parseTextSignature(
	signature: string | undefined,
): { id: string; phase?: TextSignatureV1["phase"] } | undefined {
	if (!signature) return undefined;
	if (signature.startsWith("{")) {
		try {
			const parsed = JSON.parse(signature) as Partial<TextSignatureV1>;
			if (parsed.v === 1 && typeof parsed.id === "string") {
				if (parsed.phase === "commentary" || parsed.phase === "final_answer") {
					return { id: parsed.id, phase: parsed.phase };
				}
				return { id: parsed.id };
			}
		} catch {}
	}
	return { id: signature };
}

export function encodeResponsesToolCallId(callId: string, itemId: string | null | undefined): string {
	const stableItemId = itemId && itemId.length > 0 ? itemId : `fc_${Bun.hash(callId).toString(36)}`;
	return `${callId}|${stableItemId}`;
}

export function normalizeResponsesToolCallIdForTransform(
	id: string,
	model?: Model<Api>,
	source?: AssistantMessage,
): string {
	if (!id.includes("|")) return id;
	const isForeignToolCall =
		source != null && model != null && (source.provider !== model.provider || source.api !== model.api);
	if (isForeignToolCall) {
		const [callId, itemId] = id.split("|");
		const normalizeIdPart = (part: string): string => {
			const sanitized = part.replace(/[^a-zA-Z0-9_-]/g, "_");
			const truncated = sanitized.length > 64 ? sanitized.slice(0, 64) : sanitized;
			return truncated.replace(/_+$/, "");
		};
		const normalizedCallId = normalizeIdPart(callId);
		let normalizedItemId = `fc_${Bun.hash(itemId).toString(36)}`;
		if (normalizedItemId.length > 64) normalizedItemId = normalizedItemId.slice(0, 64);
		return `${normalizedCallId}|${normalizedItemId}`;
	}
	const normalized = normalizeResponsesToolCallId(id);
	return `${normalized.callId}|${normalized.itemId}`;
}

export function collectKnownCallIds(messages: ResponseInput): Set<string> {
	const knownCallIds = new Set<string>();
	for (const item of messages) {
		if (item.type === "function_call" && typeof item.call_id === "string") {
			knownCallIds.add(item.call_id);
		} else {
			const customItem = item as { type?: string; call_id?: string };
			if (customItem.type === "custom_tool_call" && typeof customItem.call_id === "string") {
				knownCallIds.add(customItem.call_id);
			}
		}
	}
	return knownCallIds;
}

export function collectCustomCallIds(messages: ResponseInput): Set<string> {
	const customCallIds = new Set<string>();
	for (const item of messages) {
		const customItem = item as { type?: string; call_id?: string };
		if (customItem.type === "custom_tool_call" && typeof customItem.call_id === "string") {
			customCallIds.add(customItem.call_id);
		}
	}
	return customCallIds;
}

export function repairOrphanResponsesToolOutputs(input: ResponseInput): ResponseInput {
	const knownCallIds = new Set<string>();
	for (const item of input) {
		const record = item as { type?: string; call_id?: unknown };
		const t = record.type;
		const callId = record.call_id;
		if (typeof callId !== "string") continue;
		if (t === "function_call" || t === "custom_tool_call") knownCallIds.add(callId);
	}
	let hasOrphan = false;
	for (const item of input) {
		const record = item as { type?: string; call_id?: unknown };
		const t = record.type;
		if (t !== "function_call_output" && t !== "custom_tool_call_output") continue;
		const callId = record.call_id;
		if (typeof callId === "string" && !knownCallIds.has(callId)) {
			hasOrphan = true;
			break;
		}
	}
	if (!hasOrphan) return input;
	return input.map(item => {
		const record = item as { type?: string; call_id?: unknown; output?: unknown; name?: unknown };
		const t = record.type;
		if (t !== "function_call_output" && t !== "custom_tool_call_output") return item;
		const callId = record.call_id;
		if (typeof callId !== "string" || knownCallIds.has(callId)) return item;
		const toolName = typeof record.name === "string" && record.name.length > 0 ? record.name : "tool";
		const rawOutput = record.output;
		let text: string;
		if (typeof rawOutput === "string") text = rawOutput;
		else if (rawOutput == null) text = "";
		else {
			try {
				text = JSON.stringify(rawOutput);
			} catch {
				text = String(rawOutput);
			}
		}
		const ORPHAN_OUTPUT_LIMIT = 16_000;
		if (text.length > ORPHAN_OUTPUT_LIMIT) text = `${text.slice(0, ORPHAN_OUTPUT_LIMIT)}\n...[truncated]`;
		return {
			type: "message",
			role: "assistant",
			content: `[Orphan ${toolName} result; call_id=${callId}]: ${text}`,
		} as ResponseInput[number];
	});
}

export const ORPHAN_TOOL_CALL_PLACEHOLDER =
	"[No tool output recorded: the tool call was interrupted before it produced a result.]";

export function repairOrphanResponsesToolCalls(input: ResponseInput): ResponseInput {
	const outputCallIds = new Set<string>();
	for (const item of input) {
		const record = item as { type?: string; call_id?: unknown };
		const t = record.type;
		if (t !== "function_call_output" && t !== "custom_tool_call_output") continue;
		const callId = record.call_id;
		if (typeof callId === "string") outputCallIds.add(callId);
	}
	let hasOrphan = false;
	for (const item of input) {
		const record = item as { type?: string; call_id?: unknown };
		const t = record.type;
		if (t !== "function_call" && t !== "custom_tool_call") continue;
		const callId = record.call_id;
		if (typeof callId === "string" && !outputCallIds.has(callId)) {
			hasOrphan = true;
			break;
		}
	}
	if (!hasOrphan) return input;
	const repaired: ResponseInput = [];
	for (const item of input) {
		repaired.push(item);
		const record = item as { type?: string; call_id?: unknown };
		const t = record.type;
		if (t !== "function_call" && t !== "custom_tool_call") continue;
		const callId = record.call_id;
		if (typeof callId !== "string" || outputCallIds.has(callId)) continue;
		repaired.push({
			type: t === "custom_tool_call" ? "custom_tool_call_output" : "function_call_output",
			call_id: callId,
			output: ORPHAN_TOOL_CALL_PLACEHOLDER,
		} as ResponseInput[number]);
	}
	return repaired;
}

export function clampResponsesImageDetail(
	detail: ImageContent["detail"],
	supportsImageDetailOriginal: boolean,
): ResponseInputImage["detail"] {
	const resolved = detail ?? "auto";
	return resolved === "original" && !supportsImageDetailOriginal ? "auto" : resolved;
}

export function convertResponsesInputContent(
	content: string | Array<TextContent | ImageContent>,
	supportsImages: boolean,
	supportsImageDetailOriginal: boolean,
): ResponseInputContent[] | undefined {
	if (typeof content === "string") {
		if (content.trim().length === 0) return undefined;
		return [{ type: "input_text", text: content.toWellFormed() } satisfies ResponseInputText];
	}

	const { textBlocks, imageBlocks, omittedImages } = partitionVisionContent(content, supportsImages);
	const normalizedContent: ResponseInputContent[] = [];
	for (const item of textBlocks) {
		const text = item.text.toWellFormed();
		if (text.trim().length === 0) continue;
		normalizedContent.push({
			type: "input_text",
			text,
		} satisfies ResponseInputText);
	}
	for (const item of imageBlocks) {
		normalizedContent.push({
			type: "input_image",
			detail: clampResponsesImageDetail(item.detail, supportsImageDetailOriginal),
			image_url: `data:${item.mimeType};base64,${item.data}`,
		} satisfies ResponseInputImage);
	}
	if (omittedImages) {
		normalizedContent.push({
			type: "input_text",
			text: NON_VISION_IMAGE_PLACEHOLDER,
		} satisfies ResponseInputText);
	}
	return normalizedContent.length > 0 ? normalizedContent : undefined;
}

export function buildCustomToolWireNameMap(
	tools: readonly Tool[] | undefined,
): ReadonlyMap<string, string> | undefined {
	if (!tools?.length) return undefined;
	const map = new Map<string, string>();
	for (const tool of tools) {
		if (tool.customWireName) map.set(tool.customWireName, tool.name);
	}
	return map.size > 0 ? map : undefined;
}

export function resolveReplayCustomToolName(
	wireName: string,
	wireNameMap: ReadonlyMap<string, string> | undefined,
): string {
	return wireNameMap?.get(wireName) ?? (wireName === "apply_patch" ? "edit" : wireName);
}

export function adaptResponsesReplayItemsForModel(
	input: ResponseInput,
	supportsCustomToolCalls: boolean,
	wireNameMap: ReadonlyMap<string, string> | undefined,
): ResponseInput {
	if (supportsCustomToolCalls) return input;

	let changed = false;
	const adapted: ResponseInput = [];
	for (const item of input) {
		if (item.type === "custom_tool_call") {
			changed = true;
			adapted.push({
				type: "function_call",
				...(item.id ? { id: item.id } : {}),
				call_id: item.call_id,
				name: resolveReplayCustomToolName(item.name, wireNameMap),
				arguments: JSON.stringify({ input: item.input }),
				...(item.namespace ? { namespace: item.namespace } : {}),
			});
			continue;
		}
		if (item.type === "custom_tool_call_output") {
			changed = true;
			adapted.push({
				type: "function_call_output",
				call_id: item.call_id,
				output: item.output,
			});
			continue;
		}
		adapted.push(item);
	}
	return changed ? adapted : input;
}

export interface BuildResponsesInputOptions<TApi extends Api> {
	model: Model<TApi>;
	context: Context;
	strictResponsesPairing: boolean;
	supportsImageDetailOriginal: boolean;
	systemRole?: "system" | "developer";
	nativeHistory?: {
		replay: boolean;
		filterReasoning: boolean;
	};
	includeThinkingSignatures?: boolean;
	developerStringContent?: boolean;
	supportsDeveloperRole?: boolean;
	repairOrphanOutputs?: boolean;
	preserveAssistantMessageIds?: boolean;
}

export function buildResponsesInput<TApi extends Api>(options: BuildResponsesInputOptions<TApi>): ResponseInput {
	const messages: ResponseInput = [];
	const systemPrompts = options.systemRole ? normalizeSystemPrompts(options.context.systemPrompt) : [];
	for (const systemPrompt of systemPrompts) {
		messages.push({ role: options.systemRole as "system" | "developer", content: systemPrompt });
	}

	const supportsImageDetailOriginal = options.supportsImageDetailOriginal;
	// Freeform custom tools (`custom_tool_call`) only when the catalog says so;
	const supportsCustomToolCalls = options.model.applyPatchToolType === "freeform";
	const customToolWireNameMap = supportsCustomToolCalls
		? undefined
		: buildCustomToolWireNameMap(options.context.tools);
	let knownCallIds = new Set<string>();
	const customCallIds = new Set<string>();
	const transformedMessages = transformMessages(
		options.context.messages,
		options.model,
		normalizeResponsesToolCallIdForTransform,
	);
	const filterReasoning = <T extends { type?: string }>(items: T[]): T[] =>
		options.nativeHistory?.filterReasoning ? items.filter(item => item?.type !== "reasoning") : items;
	const includeThinkingSignatures = options.includeThinkingSignatures ?? options.nativeHistory?.replay ?? true;

	let msgIndex = 0;
	for (const msg of transformedMessages) {
		if (msg.role === "user" || msg.role === "developer") {
			const msgWithPayload = msg as { providerPayload?: AssistantMessage["providerPayload"] };
			const providerPayload = msgWithPayload.providerPayload;
			const historyItems = options.nativeHistory
				? getOpenAIResponsesHistoryItems(providerPayload, options.model.provider)
				: undefined;
			const shouldReplayPayloadItems =
				options.nativeHistory?.replay ||
				(historyItems?.some(item => {
					if (!item || typeof item !== "object") return false;
					const candidate = item as { type?: unknown };
					return candidate.type === "compaction" || candidate.type === "compaction_summary";
				}) ??
					false);
			if (historyItems && shouldReplayPayloadItems) {
				const sanitizedItems = sanitizeOpenAIResponsesHistoryItemsForReplay(filterReasoning(historyItems), {
					supportsImageDetailOriginal,
				});
				messages.push(
					...adaptResponsesReplayItemsForModel(sanitizedItems, supportsCustomToolCalls, customToolWireNameMap),
				);
				knownCallIds = collectKnownCallIds(messages);
				for (const id of collectCustomCallIds(messages)) customCallIds.add(id);
				msgIndex++;
				continue;
			}
			if (
				msg.role === "developer" &&
				options.supportsDeveloperRole &&
				Array.isArray(msg.content) &&
				msg.content.some(item => item.type === "image")
			) {
				const textContent = convertResponsesInputContent(
					msg.content.filter((item): item is TextContent => item.type === "text"),
					false,
					supportsImageDetailOriginal,
				);
				const imageContent = convertResponsesInputContent(
					msg.content.filter((item): item is ImageContent => item.type === "image"),
					options.model.input.includes("image"),
					supportsImageDetailOriginal,
				);
				if (textContent) messages.push({ role: "developer", content: textContent });
				if (imageContent) messages.push({ role: "user", content: imageContent });
				continue;
			}
			const content = convertResponsesInputContent(
				msg.content,
				options.model.input.includes("image"),
				supportsImageDetailOriginal,
			);
			if (!content) continue;
			messages.push({
				role: msg.role === "developer" && options.supportsDeveloperRole ? "developer" : "user",
				content:
					options.developerStringContent && msg.role === "developer" && typeof msg.content === "string"
						? msg.content.toWellFormed()
						: content,
			});
		} else if (msg.role === "assistant") {
			const assistantMsg = msg as AssistantMessage;
			const providerPayload =
				assistantMsg.api === options.model.api && assistantMsg.model === options.model.id
					? getOpenAIResponsesHistoryPayload(
							assistantMsg.providerPayload,
							options.model.provider,
							assistantMsg.provider,
						)
					: undefined;
			const nativeReplayEnabled = options.nativeHistory?.replay === true;
			const historyItems = providerPayload?.items;
			let suppressHiddenEmptyFallback = false;
			if (historyItems) {
				const rawSanitizedHistoryItems = sanitizeOpenAIResponsesAssistantHistoryItemsForReplay(
					filterReasoning(historyItems),
					{ supportsImageDetailOriginal },
				);
				const sanitizedHistoryItems = rawSanitizedHistoryItems
					? adaptResponsesReplayItemsForModel(
							rawSanitizedHistoryItems,
							supportsCustomToolCalls,
							customToolWireNameMap,
						)
					: undefined;
				if (nativeReplayEnabled && sanitizedHistoryItems) {
					if (providerPayload?.dt) {
						for (let hi = 0; hi < sanitizedHistoryItems.length; hi++) messages.push(sanitizedHistoryItems[hi]!);
					} else {
						messages.splice(0, messages.length, ...sanitizedHistoryItems);
					}
					knownCallIds = collectKnownCallIds(messages);
					for (const id of collectCustomCallIds(messages)) customCallIds.add(id);
					msgIndex++;
					continue;
				}
				if (!sanitizedHistoryItems) suppressHiddenEmptyFallback = true;
			}

			const convertedOutputItems = convertResponsesAssistantMessage(
				assistantMsg,
				options.model,
				msgIndex,
				knownCallIds,
				suppressHiddenEmptyFallback ? false : includeThinkingSignatures,
				customCallIds,
				options.preserveAssistantMessageIds,
				supportsCustomToolCalls,
				customToolWireNameMap,
			);
			const outputItems = suppressHiddenEmptyFallback
				? sanitizeOpenAIResponsesAssistantFallbackItemsForReplay(convertedOutputItems)
				: convertedOutputItems;
			if (outputItems.length === 0) continue;
			for (let oi = 0; oi < outputItems.length; oi++) messages.push(outputItems[oi]!);
		} else if (msg.role === "toolResult") {
			appendResponsesToolResultMessages(
				messages,
				msg,
				options.model,
				options.strictResponsesPairing,
				supportsImageDetailOriginal,
				knownCallIds,
				customCallIds,
				supportsCustomToolCalls,
			);
		}
		msgIndex++;
	}

	const withRepairedOutputs = options.repairOrphanOutputs ? repairOrphanResponsesToolOutputs(messages) : messages;
	return repairOrphanResponsesToolCalls(withRepairedOutputs);
}

export type ResponsesReplayAssistantMessage = Omit<ResponseOutputMessage, "id"> & { id?: string };

export function parseResponseReasoningReplayItem(signature: string | undefined): ResponseReasoningItem | undefined {
	if (!signature) return undefined;
	try {
		const parsed = JSON.parse(signature) as unknown;
		if (!parsed || typeof parsed !== "object") return undefined;
		if (!("type" in parsed) || parsed.type !== "reasoning") return undefined;
		if (!("id" in parsed) || typeof parsed.id !== "string") return undefined;
		return parsed as ResponseReasoningItem;
	} catch {
		return undefined;
	}
}

export function convertResponsesAssistantMessage<TApi extends Api>(
	assistantMsg: AssistantMessage,
	model: Model<TApi>,
	msgIndex: number,
	knownCallIds: Set<string>,
	includeThinkingSignatures = true,
	customCallIds?: Set<string>,
	preserveMessageIds = false,
	supportsCustomToolCalls = true,
	customToolWireNameMap?: ReadonlyMap<string, string>,
): ResponseInput {
	const outputItems: ResponseInput = [];
	let unsignedTextBlocks = 0;
	const hasReplayableReasoningItem =
		includeThinkingSignatures &&
		assistantMsg.stopReason !== "error" &&
		assistantMsg.content.some(
			block => block.type === "thinking" && parseResponseReasoningReplayItem(block.thinkingSignature) !== undefined,
		);
	const isDifferentModel =
		assistantMsg.model !== model.id && assistantMsg.provider === model.provider && assistantMsg.api === model.api;

	for (const block of assistantMsg.content) {
		if (block.type === "thinking" && assistantMsg.stopReason !== "error") {
			if (!includeThinkingSignatures) {
				continue;
			}
			const reasoningItem = parseResponseReasoningReplayItem(block.thinkingSignature);
			if (reasoningItem) outputItems.push(reasoningItem);
			continue;
		}

		if (block.type === "text") {
			const parsedSignature = parseTextSignature(block.textSignature);
			let msgId = parsedSignature?.id;
			if (!msgId) {
				if (hasReplayableReasoningItem) {
					msgId = unsignedTextBlocks === 0 ? `msg_${msgIndex}` : `msg_${msgIndex}_${unsignedTextBlocks}`;
					unsignedTextBlocks += 1;
				}
			} else if (!preserveMessageIds && !hasReplayableReasoningItem) {
				msgId = undefined;
			} else if (msgId.length > 64) {
				msgId = `msg_${Bun.hash(msgId).toString(36)}`;
			}
			const messageItem: ResponsesReplayAssistantMessage = {
				type: "message",
				role: "assistant",
				content: [{ type: "output_text", text: block.text.toWellFormed(), annotations: [] }],
				status: "completed",
				...(msgId ? { id: msgId } : {}),
				...(parsedSignature?.phase ? { phase: parsedSignature.phase } : {}),
			};
			outputItems.push(messageItem as ResponseInput[number]);
			continue;
		}

		if (block.type !== "toolCall") {
			continue;
		}

		const normalized = normalizeResponsesToolCallId(block.id, block.customWireName ? "ctc" : "fc");
		let itemId: string | undefined = normalized.itemId;
		if (
			!hasReplayableReasoningItem &&
			(itemId?.startsWith("fc_") || itemId?.startsWith("fcr_") || itemId?.startsWith("ctc_"))
		) {
			itemId = undefined;
		} else if (
			isDifferentModel &&
			(itemId?.startsWith("fc_") || itemId?.startsWith("fcr_") || itemId?.startsWith("ctc_"))
		) {
			itemId = undefined;
		}
		knownCallIds.add(normalized.callId);
		if (block.customWireName && supportsCustomToolCalls) {
			const rawInput = typeof block.arguments?.input === "string" ? block.arguments.input : "";
			customCallIds?.add(normalized.callId);
			outputItems.push({
				type: "custom_tool_call",
				...(itemId ? { id: itemId } : {}),
				call_id: normalized.callId,
				name: block.customWireName,
				input: rawInput,
			} as ResponseInput[number]);
			continue;
		}
		const functionName =
			block.customWireName && !supportsCustomToolCalls
				? resolveReplayCustomToolName(block.customWireName, customToolWireNameMap)
				: block.name;
		outputItems.push({
			type: "function_call",
			...(itemId ? { id: itemId } : {}),
			call_id: normalized.callId,
			name: functionName,
			arguments: stringifyJson(block.arguments) ?? "null",
		});
	}

	return outputItems;
}

export function appendResponsesToolResultMessages<TApi extends Api>(
	messages: ResponseInput,
	toolResult: ToolResultMessage,
	model: Model<TApi>,
	strictResponsesPairing: boolean,
	supportsImageDetailOriginal: boolean,
	knownCallIds: ReadonlySet<string>,
	customCallIds?: ReadonlySet<string>,
	supportsCustomToolCalls = true,
): void {
	const supportsImages = model.input.includes("image");
	const textResult = toolResult.content
		.filter((block): block is TextContent => block.type === "text")
		.map(block => block.text)
		.join("\n");
	const hasImages = toolResult.content.some((block): block is ImageContent => block.type === "image");
	const omittedImages = hasImages && !supportsImages;
	const normalized = normalizeResponsesToolCallId(toolResult.toolCallId);
	const output = (
		omittedImages
			? joinTextWithImagePlaceholder(textResult, true)
			: textResult.length > 0
				? textResult
				: hasImages
					? "(see attached image)"
					: ""
	).toWellFormed();
	if (strictResponsesPairing && !knownCallIds.has(normalized.callId)) {
		const limit = 16_000;
		const noteText = output.length > limit ? `${output.slice(0, limit)}\n...[truncated]` : output;
		messages.push({
			type: "message",
			role: "assistant",
			content: `[Orphan ${toolResult.toolName || "tool"} result; call_id=${normalized.callId}]: ${noteText}`,
		} as ResponseInput[number]);
		return;
	}
	if (supportsCustomToolCalls && customCallIds?.has(normalized.callId)) {
		messages.push({
			type: "custom_tool_call_output",
			call_id: normalized.callId,
			output,
		} as ResponseInput[number]);
	} else {
		messages.push({
			type: "function_call_output",
			call_id: normalized.callId,
			output,
		});
	}

	if (!hasImages || !supportsImages) {
		return;
	}

	const contentParts: ResponseInputContent[] = [
		{ type: "input_text", text: "Attached image(s) from tool result:" } satisfies ResponseInputText,
	];
	for (const block of toolResult.content) {
		if (block.type === "image") {
			contentParts.push({
				type: "input_image",
				detail: clampResponsesImageDetail(block.detail, supportsImageDetailOriginal),
				image_url: `data:${block.mimeType};base64,${block.data}`,
			} satisfies ResponseInputImage);
		}
	}
	messages.push({ role: "user", content: contentParts });
}

export type ResponsesToolCallBlock = ToolCall & { [kStreamingPartialJson]: string; [kStreamingLastParseLen]?: number };

export function appendReasoningSummaryPart(
	item: ResponseReasoningItem,
	part: ResponseReasoningItem["summary"][number],
): void {
	item.summary = item.summary || [];
	item.summary.push(part);
}

export interface SequentialCutoffSummaryState {
	summary: ResponseReasoningItem["summary"];
	emitted: string;
}

export function createSequentialCutoffSummaryState(): SequentialCutoffSummaryState {
	return { summary: [], emitted: "" };
}

export function foldReasoningSummary(parts: ResponseReasoningItem["summary"] | undefined): string {
	if (!parts) return "";
	let canonical = "";
	for (const part of parts) {
		const text = part.text;
		if (!text || text === canonical) continue;
		const extendsCanonical = text.startsWith(canonical) && text[canonical.length] === "\n";
		canonical = !canonical || extendsCanonical ? text : `${canonical}\n\n${text}`;
	}
	return canonical;
}

export function finalizeReasoningThinking(
	item: ResponseReasoningItem,
	streamedThinking: string,
	cutoff?: SequentialCutoffSummaryState,
): string {
	if (cutoff) return finalizeCutoffReasoningThinking(item, streamedThinking, cutoff);
	const summaryThinking = item.summary?.map(part => part.text).join("\n\n") ?? "";
	if (summaryThinking) return summaryThinking;
	const contentThinking = item.content?.[0]?.type === "reasoning_text" ? (item.content[0].text ?? "") : "";
	return contentThinking || streamedThinking || "";
}

export function finalizeCutoffReasoningThinking(
	item: ResponseReasoningItem,
	streamedThinking: string,
	cutoff: SequentialCutoffSummaryState,
): string {
	if (streamedThinking) return streamedThinking;
	const summaryThinking = foldReasoningSummary(item.summary);
	if (summaryThinking) {
		if (cutoff.emitted.startsWith(summaryThinking)) return "";
		if (!cutoff.emitted || summaryThinking.startsWith(cutoff.emitted)) {
			const suffix = summaryThinking.slice(cutoff.emitted.length).replace(/^\n+/, "");
			cutoff.summary = item.summary?.map(part => ({ ...part })) ?? [];
			cutoff.emitted = summaryThinking;
			return suffix;
		}
		return "";
	}
	return item.content?.[0]?.type === "reasoning_text" ? (item.content[0].text ?? "") : "";
}
