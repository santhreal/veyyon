import { renderDemotedThinking } from "../dialect/demotion";
import type { Api, AssistantMessage, Message, Model, ToolCall, ToolResultMessage, UserMessage } from "../types";
import { isDemotedThinking, kDemotedThinking } from "../utils/block-symbols";

const enum ToolCallStatus {
	Resolved = 1,
	Aborted = 2,
}

const MAX_TOOL_CALL_ID_LENGTH = 64;

function appendDuplicateSuffix(originalId: string, suffix: string, maxLength: number): string {
	if (originalId.includes("|")) {
		return originalId
			.split("|")
			.map(segment => appendSegmentDuplicateSuffix(segment, suffix, maxLength))
			.join("|");
	}
	return appendSegmentDuplicateSuffix(originalId, suffix, maxLength);
}

function appendSegmentDuplicateSuffix(segment: string, suffix: string, maxLength: number): string {
	if (segment.length + suffix.length <= maxLength) return `${segment}${suffix}`;
	const prefixBudget = Math.max(0, maxLength - suffix.length);
	return `${segment.slice(0, prefixBudget)}${suffix}`;
}

type PendingToolResultRewrite = { replacementId: string } | undefined;

function deduplicateToolCallIds(
	messages: Message[],
	maxToolCallIdLength = MAX_TOOL_CALL_ID_LENGTH,
	duplicateSuffixPrefix = "_dup",
): Message[] {
	const seenToolCallIds = new Map<string, number>();
	const pendingToolResultRewrites = new Map<string, PendingToolResultRewrite[]>();

	return messages.map(msg => {
		if (msg.role === "toolResult") {
			const rewrites = pendingToolResultRewrites.get(msg.toolCallId);
			if (!rewrites || rewrites.length === 0) return msg;

			const rewrite = rewrites.shift();
			if (rewrites.length === 0) pendingToolResultRewrites.delete(msg.toolCallId);
			if (rewrite) return { ...msg, toolCallId: rewrite.replacementId };
			return msg;
		}

		if (msg.role !== "assistant") return msg;

		const enqueueToolResultRewrite = (id: string, rewrite: PendingToolResultRewrite): void => {
			const rewrites = pendingToolResultRewrites.get(id);
			if (rewrites) {
				rewrites.push(rewrite);
				return;
			}
			pendingToolResultRewrites.set(id, [rewrite]);
		};

		const idsTouchedInTurn = new Set<string>();
		let contentChanged = false;
		const content = msg.content.map(block => {
			if (block.type !== "toolCall") return block;

			if (!idsTouchedInTurn.has(block.id)) {
				pendingToolResultRewrites.delete(block.id);
				idsTouchedInTurn.add(block.id);
			}

			const previousCount = seenToolCallIds.get(block.id) ?? 0;
			if (previousCount === 0) {
				seenToolCallIds.set(block.id, 1);
				enqueueToolResultRewrite(block.id, undefined);
				return block;
			}

			let duplicateIndex = previousCount;
			let replacementId = appendDuplicateSuffix(
				block.id,
				`${duplicateSuffixPrefix}${duplicateIndex}`,
				maxToolCallIdLength,
			);
			while (seenToolCallIds.has(replacementId)) {
				duplicateIndex += 1;
				replacementId = appendDuplicateSuffix(
					block.id,
					`${duplicateSuffixPrefix}${duplicateIndex}`,
					maxToolCallIdLength,
				);
			}
			seenToolCallIds.set(block.id, duplicateIndex + 1);
			seenToolCallIds.set(replacementId, 1);
			enqueueToolResultRewrite(block.id, { replacementId });
			contentChanged = true;
			return { ...block, id: replacementId };
		});

		if (!contentChanged) return msg;
		return { ...msg, content };
	});
}

function isMalformedToolCallName(name: string | undefined): boolean {
	return !name || name.trim().length === 0;
}

function isMalformedToolCallId(id: string | undefined): boolean {
	return !id || id.trim().length === 0;
}

function isMalformedToolCall(block: { id: string; name: string }): boolean {
	return isMalformedToolCallId(block.id) || isMalformedToolCallName(block.name);
}

function sanitizeMalformedToolCalls(messages: Message[]): Message[] {
	let hasMalformed = false;
	outer: for (const msg of messages) {
		if (msg.role !== "assistant") continue;
		for (const block of msg.content) {
			if (block.type === "toolCall" && isMalformedToolCall(block)) {
				hasMalformed = true;
				break outer;
			}
		}
	}
	if (!hasMalformed) return messages;

	const dropQueues = new Map<string, boolean[]>();
	const result: Message[] = [];
	for (const msg of messages) {
		if (msg.role === "assistant") {
			dropQueues.clear();
			const filtered: AssistantMessage["content"] = [];
			for (const block of msg.content) {
				if (block.type === "toolCall") {
					const malformed = isMalformedToolCall(block);
					const queue = dropQueues.get(block.id);
					if (queue) queue.push(malformed);
					else dropQueues.set(block.id, [malformed]);
					if (malformed) continue;
				}
				filtered.push(block);
			}
			if (filtered.length === 0) continue;
			result.push(filtered.length === msg.content.length ? msg : { ...msg, content: filtered });
			continue;
		}
		if (msg.role === "toolResult") {
			const queue = dropQueues.get(msg.toolCallId);
			if (queue && queue.length > 0) {
				const drop = queue.shift() === true;
				if (queue.length === 0) dropQueues.delete(msg.toolCallId);
				if (drop) continue;
			}
			result.push(msg);
			continue;
		}
		dropQueues.clear();
		result.push(msg);
	}
	return result;
}

function shouldDropTruncatedThinkingOnlyAssistant(msg: AssistantMessage): boolean {
	const isTruncatedStop = msg.stopReason === "length" || msg.stopReason === "error" || msg.stopReason === "aborted";
	return isTruncatedStop && !msg.content.some(block => block.type === "toolCall" || block.type === "text");
}

function getLatestSurvivingAssistantIndex(messages: readonly Message[]): number {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const msg = messages[index]!;
		if (msg.role === "assistant" && !shouldDropTruncatedThinkingOnlyAssistant(msg)) {
			return index;
		}
	}
	return -1;
}

function isAnthropicMessagesModel(model: Model): model is Model<"anthropic-messages"> {
	return model.api === "anthropic-messages";
}

function targetReadsForeignThinking(model: Model, compat: Model["compat"]): boolean {
	if (compat === undefined) return false;
	if (model.api === "anthropic-messages") {
		return "replayUnsignedThinking" in compat && compat.replayUnsignedThinking === true;
	}
	if (model.api !== "openai-completions") return false;
	if (!("thinkingFormat" in compat)) return false;
	if (compat.requiresThinkingAsText) return false;
	return model.reasoning && compat.thinkingFormat === "zai";
}

const ANTHROPIC_TOOL_CALL_ID_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;

function isValidAnthropicToolCallId(id: string): boolean {
	return ANTHROPIC_TOOL_CALL_ID_PATTERN.test(id);
}

function fallbackAnthropicToolCallId(originalId: string): string {
	return `toolu_${Bun.hash(originalId).toString(36)}`;
}

function normalizeAnthropicTargetToolCallId<TApi extends Api>(
	id: string,
	model: Model<TApi>,
	source: AssistantMessage,
	normalizeToolCallId?: (id: string, model: Model<TApi>, source: AssistantMessage) => string,
): string {
	if (isValidAnthropicToolCallId(id)) return id;
	const normalized =
		normalizeToolCallId?.(id, model, source) ?? id.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, MAX_TOOL_CALL_ID_LENGTH);
	if (isValidAnthropicToolCallId(normalized)) return normalized;
	return fallbackAnthropicToolCallId(id);
}

export function transformMessages<TApi extends Api>(
	messages: Message[],
	model: Model<TApi>,
	normalizeToolCallId?: (id: string, model: Model<TApi>, source: AssistantMessage) => string,
	maxNormalizedToolCallIdLength = MAX_TOOL_CALL_ID_LENGTH,
	duplicateToolCallIdSuffixPrefix = "_dup",
	targetCompat: Model<TApi>["compat"] = model.compat,
): Message[] {
	messages = sanitizeMalformedToolCalls(messages);

	const toolCallIdMap = new Map<string, string>();

	const latestSurvivingAssistantIndex = getLatestSurvivingAssistantIndex(messages);
	const normalizedMessages = messages.map((msg, index) => {
		if (msg.role === "user" || msg.role === "developer") {
			return msg;
		}

		if (msg.role === "toolResult") {
			const normalizedId = toolCallIdMap.get(msg.toolCallId);
			if (normalizedId && normalizedId !== msg.toolCallId) {
				return { ...msg, toolCallId: normalizedId };
			}
			return msg;
		}

		if (msg.role === "assistant") {
			const assistantMsg = msg as AssistantMessage;
			const isSameModel =
				assistantMsg.provider === model.provider &&
				assistantMsg.api === model.api &&
				assistantMsg.model === model.id;

			const isAnthropicTarget = isAnthropicMessagesModel(model);
			const isAnthropicReplay = isAnthropicTarget && assistantMsg.api === "anthropic-messages";
			const isLatestSurvivingAssistant = index === latestSurvivingAssistantIndex;
			const isOfficialAnthropicSource = isAnthropicReplay && assistantMsg.provider === "anthropic";
			const isSigningAnthropicTarget = isAnthropicTarget && model.compat.signingEndpoint;
			const signingAnthropicInvolved = isOfficialAnthropicSource || isSigningAnthropicTarget;
			const replaysUnsignedAnthropicThinking = isAnthropicTarget && model.compat.replayUnsignedThinking;
			const invalidStopReason = assistantMsg.stopReason === "aborted" || assistantMsg.stopReason === "error";
			const abandonedToolUse =
				!invalidStopReason &&
				assistantMsg.stopReason !== "toolUse" &&
				assistantMsg.content.some(b => b.type === "toolCall");
			const lastBlockIndex = assistantMsg.content.length - 1;

			const anthropicVisibleThinkingSurvivesReplay = (
				candidate: AssistantMessage["content"][number],
				candidateIndex: number,
			): boolean => {
				if (candidate.type !== "thinking") return false;
				if (!isAnthropicReplay) return false;
				if (isLatestSurvivingAssistant && abandonedToolUse) return true;
				const candidateSignatureUntrustworthy =
					abandonedToolUse || (invalidStopReason && candidateIndex === lastBlockIndex);
				const replaySignature =
					candidateSignatureUntrustworthy && candidate.thinkingSignature ? undefined : candidate.thinkingSignature;
				if (!replaySignature && (!candidate.thinking || candidate.thinking.trim() === "")) return false;
				if (isSameModel && isSigningAnthropicTarget && (!replaySignature || replaySignature.trim() === "")) {
					return false;
				}
				return true;
			};
			const hasVisibleAnthropicThinking = assistantMsg.content.some(candidate => candidate.type === "thinking");
			const dropsAllSameModelVisibleThinking =
				isAnthropicReplay &&
				isSameModel &&
				isSigningAnthropicTarget &&
				hasVisibleAnthropicThinking &&
				!assistantMsg.content.some(anthropicVisibleThinkingSurvivesReplay);

			const transformedContent = assistantMsg.content.flatMap((block, blockIndex) => {
				if (block.type === "thinking") {
					const signatureUntrustworthy = abandonedToolUse || (invalidStopReason && blockIndex === lastBlockIndex);
					let sanitized: typeof block =
						signatureUntrustworthy && block.thinkingSignature
							? { ...block, thinkingSignature: undefined }
							: block;
					if (isAnthropicReplay) {
						if (isLatestSurvivingAssistant && abandonedToolUse) return block;
						if (
							!isLatestSurvivingAssistant &&
							!isSameModel &&
							signingAnthropicInvolved &&
							sanitized.thinkingSignature
						) {
							sanitized = { ...sanitized, thinkingSignature: undefined };
						}
						if (!sanitized.thinkingSignature && (!sanitized.thinking || sanitized.thinking.trim() === "")) {
							return [];
						}
						if (
							isSameModel &&
							isSigningAnthropicTarget &&
							(!sanitized.thinkingSignature || sanitized.thinkingSignature.trim() === "")
						) {
							return [];
						}
						return sanitized;
					}
					if (isSameModel && sanitized.thinkingSignature) return sanitized;
					if (!sanitized.thinking || sanitized.thinking.trim() === "") return [];
					if (isSameModel) return sanitized;
					if (targetReadsForeignThinking(model, targetCompat)) {
						return sanitized.thinkingSignature ? { ...sanitized, thinkingSignature: undefined } : sanitized;
					}
					return {
						type: "text" as const,
						text: renderDemotedThinking(model.id, sanitized.thinking),
						[kDemotedThinking]: true,
					};
				}

				if (block.type === "redactedThinking") {
					if (isAnthropicReplay) {
						if (dropsAllSameModelVisibleThinking) return [];
						if (isSameModel || isLatestSurvivingAssistant || replaysUnsignedAnthropicThinking) return block;
						return [];
					}
					if (isSameModel) return block;
					return [];
				}

				if (block.type === "fallback") {
					if (isAnthropicTarget && model.compat.officialEndpoint) return block;
					return [];
				}

				if (block.type === "text") {
					if (isSameModel) return block;
					return {
						type: "text" as const,
						text: block.text,
					};
				}

				if (block.type === "toolCall") {
					const toolCall = block as ToolCall;
					let normalizedToolCall: ToolCall = toolCall;

					if (!isSameModel && toolCall.thoughtSignature) {
						normalizedToolCall = { ...toolCall, thoughtSignature: undefined };
					}

					if (isAnthropicTarget) {
						const normalizedId = normalizeAnthropicTargetToolCallId(
							toolCall.id,
							model,
							assistantMsg,
							normalizeToolCallId,
						);
						if (normalizedId !== toolCall.id) {
							toolCallIdMap.set(toolCall.id, normalizedId);
							normalizedToolCall = { ...normalizedToolCall, id: normalizedId };
						}
					} else if (!isSameModel && normalizeToolCallId) {
						const normalizedId = normalizeToolCallId(toolCall.id, model, assistantMsg);
						if (normalizedId !== toolCall.id) {
							toolCallIdMap.set(toolCall.id, normalizedId);
							normalizedToolCall = { ...normalizedToolCall, id: normalizedId };
						}
					}

					return normalizedToolCall;
				}

				return block;
			});

			const finalBlock = transformedContent[transformedContent.length - 1];
			if (finalBlock?.type === "text" && isDemotedThinking(finalBlock)) {
				transformedContent[transformedContent.length - 1] = { ...finalBlock, text: finalBlock.text.trimEnd() };
			}

			return {
				...assistantMsg,
				content: transformedContent,
			};
		}
		return msg;
	});
	const transformed = deduplicateToolCallIds(
		normalizedMessages,
		maxNormalizedToolCallIdLength,
		duplicateToolCallIdSuffixPrefix,
	);
	type IndexedToolResult = { index: number; msg: ToolResultMessage; consumed: boolean };
	const realToolResultsById = new Map<string, IndexedToolResult[]>();
	for (let index = 0; index < transformed.length; index++) {
		const msg = transformed[index];
		if (msg.role === "toolResult") {
			const entry: IndexedToolResult = { index, msg, consumed: false };
			const entries = realToolResultsById.get(msg.toolCallId);
			if (entries) entries.push(entry);
			else realToolResultsById.set(msg.toolCallId, [entry]);
		}
	}
	const takeRealToolResult = (id: string, afterIndex: number): ToolResultMessage | undefined => {
		const entries = realToolResultsById.get(id);
		if (!entries) return undefined;
		for (const entry of entries) {
			if (entry.consumed || entry.index <= afterIndex) continue;
			entry.consumed = true;
			return entry.msg;
		}
		return undefined;
	};

	const validToolUseIds = new Set<string>();
	for (const msg of transformed) {
		if (msg.role !== "assistant") continue;
		for (const block of msg.content) {
			if (block.type === "toolCall") validToolUseIds.add(block.id);
		}
	}

	const result: Message[] = [];
	let pendingToolCalls: ToolCall[] = [];
	let pendingToolCallsStartIndex = -1;
	let pendingAbortedToolCalls = new Map<string, ToolCall>();
	let pendingAbortedTimestamp: number | undefined;
	let pendingAbortedStartIndex = -1;
	const toolCallStatus = new Map<string, ToolCallStatus>();

	const flushPendingToolCalls = (timestamp: number): void => {
		if (pendingToolCalls.length === 0) return;
		for (const tc of pendingToolCalls) {
			if (toolCallStatus.has(tc.id)) continue;
			const realToolResult = takeRealToolResult(tc.id, pendingToolCallsStartIndex);
			if (realToolResult) {
				result.push(realToolResult);
				toolCallStatus.set(tc.id, ToolCallStatus.Resolved);
				continue;
			}
			result.push({
				role: "toolResult",
				toolCallId: tc.id,
				toolName: tc.name,
				content: [{ type: "text", text: "No result provided" }],
				isError: true,
				timestamp,
			} as ToolResultMessage);
			toolCallStatus.set(tc.id, ToolCallStatus.Resolved);
		}
		pendingToolCalls = [];
	};

	const flushPendingAbortedToolCalls = (): void => {
		if (pendingAbortedTimestamp === undefined) return;
		for (const tc of pendingAbortedToolCalls.values()) {
			if (toolCallStatus.has(tc.id)) continue;
			const realToolResult = takeRealToolResult(tc.id, pendingAbortedStartIndex);
			if (realToolResult) {
				result.push(realToolResult);
				toolCallStatus.set(tc.id, ToolCallStatus.Resolved);
				continue;
			}
			result.push({
				role: "toolResult",
				toolCallId: tc.id,
				toolName: tc.name,
				content: [{ type: "text", text: "aborted" }],
				isError: true,
				timestamp: pendingAbortedTimestamp,
			} as ToolResultMessage);
			toolCallStatus.set(tc.id, ToolCallStatus.Aborted);
		}
		pendingAbortedToolCalls = new Map();
		pendingAbortedTimestamp = undefined;
	};

	for (let i = 0; i < transformed.length; i++) {
		const msg = transformed[i];
		const messageTimestamp = "timestamp" in msg && typeof msg.timestamp === "number" ? msg.timestamp : Date.now();

		if (msg.role === "assistant") {
			flushPendingToolCalls(messageTimestamp);
			flushPendingAbortedToolCalls();

			const assistantMsg = msg as AssistantMessage;

			const originalMsg = messages[i]!;
			if (originalMsg.role === "assistant" && shouldDropTruncatedThinkingOnlyAssistant(originalMsg)) {
				continue;
			}

			const toolCalls = assistantMsg.content.filter(b => b.type === "toolCall") as ToolCall[];

			if (assistantMsg.stopReason === "error" || assistantMsg.stopReason === "aborted") {
				result.push(msg);
				pendingAbortedToolCalls = new Map(toolCalls.map(toolCall => [toolCall.id, toolCall] as const));
				pendingAbortedTimestamp = assistantMsg.timestamp;
				pendingAbortedStartIndex = i;
				continue;
			}

			if (toolCalls.length > 0) {
				pendingToolCalls = toolCalls;
				pendingToolCallsStartIndex = i;
			}

			result.push(msg);
		} else if (msg.role === "toolResult") {
			if (toolCallStatus.has(msg.toolCallId)) continue;

			if (pendingAbortedToolCalls.has(msg.toolCallId)) {
				pendingAbortedToolCalls.delete(msg.toolCallId);
				toolCallStatus.set(msg.toolCallId, ToolCallStatus.Resolved);
				result.push(msg);
				continue;
			}

			if (pendingToolCalls.some(tc => tc.id === msg.toolCallId)) {
				toolCallStatus.set(msg.toolCallId, ToolCallStatus.Resolved);
				result.push(msg);
				continue;
			}

			if (!validToolUseIds.has(msg.toolCallId)) {
				if (pendingToolCalls.some(tc => !toolCallStatus.has(tc.id)) || pendingAbortedToolCalls.size > 0) {
					continue;
				}
				const textParts: string[] = [];
				for (const part of msg.content) {
					if (part.type === "text" && part.text.trim() !== "") textParts.push(part.text);
				}
				if (textParts.length > 0) {
					const errorAttr = msg.isError ? ' is-error="true"' : "";
					result.push({
						role: "user",
						content: `<stale-tool-result tool="${msg.toolName}" id="${msg.toolCallId}"${errorAttr}>\n${textParts.join("\n")}\n</stale-tool-result>`,
						timestamp: messageTimestamp,
					} as UserMessage);
				}
			}
		} else if (msg.role === "user" || msg.role === "developer") {
			flushPendingToolCalls(messageTimestamp);
			flushPendingAbortedToolCalls();
			result.push(msg);
		} else {
			flushPendingToolCalls(messageTimestamp);
			flushPendingAbortedToolCalls();
			result.push(msg);
		}
	}

	flushPendingToolCalls(Date.now());
	flushPendingAbortedToolCalls();

	return result;
}
