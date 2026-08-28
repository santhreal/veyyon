import type { Api, Context, Message, Model, Tool } from "@veyyon/ai";
import type { ResolvedAnthropicCompat } from "@veyyon/catalog/types";
import { countTokens } from "../tokenizer";
import { estimateTokens } from "./token-estimate";

const PREFIX_CACHE_WIRE_APIS: Record<string, true> = {
	"anthropic-messages": true,
};

export function modelServesPrefixCacheHits(model: Model<Api>): boolean {
	if (!PREFIX_CACHE_WIRE_APIS[model.api]) return false;
	const compat = model.compat as ResolvedAnthropicCompat;
	return compat.supportsLongCacheRetention === true;
}

export function hasUnansweredToolCall(messages: readonly Message[]): boolean {
	const pending = new Set<string>();
	for (const message of messages) {
		if (message.role === "assistant") {
			for (const block of message.content) {
				if (block.type === "toolCall") pending.add(block.id);
			}
			continue;
		}
		if (message.role === "toolResult") pending.delete(message.toolCallId);
	}
	return pending.size > 0;
}

export interface CacheAlignedEligibility {
	model: Model<Api>;
	sessionSystemPrompt: string[] | undefined;
	sessionMessages: readonly Message[] | undefined;
}

export function canUseCacheAlignedCompaction(input: CacheAlignedEligibility): boolean {
	const { model, sessionSystemPrompt, sessionMessages } = input;
	if (!modelServesPrefixCacheHits(model)) return false;
	if (!sessionSystemPrompt || sessionSystemPrompt.length === 0) return false;
	if (sessionSystemPrompt.every(block => block.length === 0)) return false;
	if (!sessionMessages || sessionMessages.length === 0) return false;
	if (hasUnansweredToolCall(sessionMessages)) return false;
	return true;
}

export interface CacheAlignedContextInput {
	sessionSystemPrompt: string[];
	sessionMessages: readonly Message[];
	tools?: Tool[];
	instruction: string;
	sanitize?: (text: string) => string;
	timestamp?: number;
}

export function buildCacheAlignedCompactionContext(input: CacheAlignedContextInput): Context {
	const { sessionSystemPrompt, sessionMessages, tools, instruction, sanitize, timestamp } = input;
	const text = sanitize ? sanitize(instruction) : instruction;
	return {
		systemPrompt: sessionSystemPrompt,
		tools,
		messages: [
			...sessionMessages,
			{
				role: "user",
				content: [{ type: "text", text }],
				timestamp: timestamp ?? Date.now(),
			},
		],
	};
}

export function estimateCacheAlignedRequestTokens(input: {
	sessionSystemPrompt: readonly string[];
	sessionMessages: readonly Message[];
	instruction: string;
}): number {
	let total = countTokens(input.sessionSystemPrompt.concat([input.instruction]));
	for (const message of input.sessionMessages) total += estimateTokens(message);
	return total;
}
