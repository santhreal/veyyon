/**
 * The cache-aligned compaction request.
 *
 * Replaying the session's byte-exact message prefix turns summarization input tokens
 * into cheap cache reads without lossy tool result truncation.
 */

import type { Api, Context, Message, Model, Tool } from "@veyyon/ai";
import type { ResolvedAnthropicCompat } from "@veyyon/catalog/types";
import { countTokens } from "../tokenizer";
import { estimateTokens } from "./token-estimate";

/**
 * Wire APIs whose request shaping places prompt-cache breakpoints on the trailing
 * messages, which is what makes a replayed conversation prefix cacheable at all.
 * Mirrors `SERVER_COMPACTION_WIRE_APIS` in `@veyyon/ai/providers/openai-compaction`:
 * an api gate, then a compat DATA read, never a provider-name check.
 */
const PREFIX_CACHE_WIRE_APIS: Record<string, true> = {
	"anthropic-messages": true,
};

/**
 * Whether this model's host serves prompt-prefix cache hits for a replayed conversation prefix.
 * Reads `supportsLongCacheRetention` on the resolved model compat.
 */
export function modelServesPrefixCacheHits(model: Model<Api>): boolean {
	if (!PREFIX_CACHE_WIRE_APIS[model.api]) return false;
	// Narrowed by the api gate above: every anthropic-messages model carries the
	// resolved anthropic compat record.
	const compat = model.compat as ResolvedAnthropicCompat;
	return compat.supportsLongCacheRetention === true;
}

/**
 * Whether the message array ends with an unanswered tool call.
 * Prevents appending user summarization turns after unfulfilled `tool_use` blocks.
 */
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

/** Everything the eligibility decision reads. */
export interface CacheAlignedEligibility {
	/** The model the summarization request will be sent to. */
	model: Model<Api>;
	/** The live session's system prompt, as the agent holds it. */
	sessionSystemPrompt: string[] | undefined;
	/** The live provider-visible message array, already converted for the wire. */
	sessionMessages: readonly Message[] | undefined;
}

/**
 * Whether a cache-aligned summarization request is safe for this compaction.
 * Falls back to truncated serialization if prompt cache hit conditions are not met.
 */
export function canUseCacheAlignedCompaction(input: CacheAlignedEligibility): boolean {
	const { model, sessionSystemPrompt, sessionMessages } = input;
	// A host that does not serve prefix cache hits bills the whole replayed window
	// as fresh input, strictly worse than the truncated request.
	if (!modelServesPrefixCacheHits(model)) return false;
	// Without the session's own system prompt the request diverges at the very first
	// cached block, so nothing after it can hit either.
	if (!sessionSystemPrompt || sessionSystemPrompt.length === 0) return false;
	if (sessionSystemPrompt.every(block => block.length === 0)) return false;
	// Nothing to replay, and no trailing breakpoint to hit.
	if (!sessionMessages || sessionMessages.length === 0) return false;
	// Appending a user turn after an unanswered tool call is an invalid request.
	if (hasUnansweredToolCall(sessionMessages)) return false;
	return true;
}

/** Everything the cache-aligned request is built from. */
export interface CacheAlignedContextInput {
	/** The live session's system prompt. Replayed verbatim: it is cached prefix. */
	sessionSystemPrompt: string[];
	/**
	 * The live provider-visible message array. Replayed verbatim, by reference: see
	 * the byte-exactness invariant in this module's header.
	 */
	sessionMessages: readonly Message[];
	/** The live session's provider-visible tools. First block of the cached prefix. */
	tools?: Tool[];
	/** The summarization instruction, appended as the one new user turn. */
	instruction: string;
	/**
	 * Final-seam transform applied ONLY to the appended instruction to preserve cached prefix bytes.
	 */
	sanitize?: (text: string) => string;
	/** Timestamp for the appended turn. Defaults to now. */
	timestamp?: number;
}

/**
 * Build the cache-aligned summarization request by reusing the live session's tools,
 * system prompt, and exact message prefix with an appended summarization instruction.
 */
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

/**
 * Estimate token cost of a cache-aligned summarization request using the live context tokenizer.
 */
export function estimateCacheAlignedRequestTokens(input: {
	sessionSystemPrompt: readonly string[];
	sessionMessages: readonly Message[];
	instruction: string;
}): number {
	let total = countTokens([...input.sessionSystemPrompt, input.instruction]);
	for (const message of input.sessionMessages) total += estimateTokens(message);
	return total;
}
