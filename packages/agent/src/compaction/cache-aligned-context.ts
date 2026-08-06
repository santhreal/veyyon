/**
 * The cache-aligned compaction request.
 *
 * WHY THIS EXISTS. `buildCompactionProviderContext` in `compaction.ts` builds the
 * summarization request from scratch: a different system prompt
 * (`SUMMARIZATION_SYSTEM_PROMPT`), one synthesized user message holding the whole
 * conversation re-serialized as text, and no `tools` at all. Anthropic caches a
 * prefix in canonical order tools -> system -> messages, so that request shares
 * ZERO cached prefix with the session it is compacting, and it fires exactly when
 * that session is largest (the auto threshold is `contextWindow - reserve`). It is
 * affordable today only because it is lossy: `TOOL_RESULT_MAX_CHARS` truncates every
 * tool result, keeping roughly a third of the tool-result bytes.
 *
 * Replaying the session's own prefix instead turns those fresh input tokens into
 * cache reads (an order of magnitude cheaper on Anthropic) AND removes the
 * truncation, because the model reads the real tool results rather than a serialized
 * digest of them. Cheaper and higher fidelity at once.
 *
 * WHY THE WHOLE MESSAGE ARRAY, NOT THE CUT PREFIX. Our message-side cache
 * breakpoints are placed at the last one-to-two messages (`applyPromptCaching` in
 * `packages/ai/src/providers/anthropic.ts`). A cache hit needs a breakpoint at or
 * before the point where the new request diverges from the cached one. Summarizing
 * `messages[0..cut]`, the cut point `findCutPoint` chooses, would therefore MISS:
 * no breakpoint sits at `cut`. Replaying the ENTIRE live array hits exactly, because
 * the breakpoint on the last message is at or after the shared prefix. Summarizing a
 * superset of what will be discarded is harmless: the summary simply also covers the
 * recent tail that is being kept.
 *
 * THE INVARIANT, AND IT IS THE WHOLE FEATURE. **The replayed prefix is byte-exact or
 * the feature is pointless.** Any mutation of a replayed message (re-serializing it,
 * running the obfuscation seam over it, reordering, normalizing, "just" restamping a
 * timestamp) moves the divergence point ahead of the breakpoint and the request
 * misses. A missed cache-aligned request is roughly three times WORSE than today's
 * truncated one (the whole live window billed as fresh input instead of a serialized
 * digest of part of it), which is why the eligibility predicate below is
 * conservative and the truncated path stays the default whenever anything is
 * uncertain.
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
 * Whether this model's host serves prompt-prefix cache hits for a replayed
 * conversation prefix.
 *
 * Support is DATA on the model row, the same shape
 * `resolveServerCompactionTransport` uses for `compat.supportsServerCompaction`: an
 * api gate, then one resolved compat flag. The flag read here is
 * `supportsLongCacheRetention`, which `buildAnthropicCompat` resolves to the official
 * `api.anthropic.com` host and which a compatible gateway flips on per row through a
 * `compat` override or discovery. It is the anthropic-messages datum that already
 * means "this host honors Anthropic's prompt-cache directives", and its
 * official-only default is exactly the conservative default this feature needs: an
 * unknown proxy that silently ignores `cache_control` must fall back, because a
 * cache-aligned request that misses costs more than the truncated one it replaced.
 *
 * A dedicated sibling flag (`compat.supportsCacheAlignedCompaction`) would be the
 * cleaner long-term home. It cannot land in this change: `ResolvedAnthropicCompat`
 * is `Required<AnthropicCompat>`, so declaring the key forces a matching assignment
 * in `buildAnthropicCompat`, and `packages/catalog/src/types.ts` currently carries
 * another lane's uncommitted work.
 */
export function modelServesPrefixCacheHits(model: Model<Api>): boolean {
	if (!PREFIX_CACHE_WIRE_APIS[model.api]) return false;
	// Narrowed by the api gate above: every anthropic-messages model carries the
	// resolved anthropic compat record.
	const compat = model.compat as ResolvedAnthropicCompat;
	return compat.supportsLongCacheRetention === true;
}

/**
 * Whether the message array ends with a tool call that has not been answered.
 *
 * This is the sharp edge of appending anything to a live conversation. An assistant
 * turn carrying a `toolCall` must be followed by the matching `toolResult`;
 * Anthropic rejects a request where a `tool_use` block is followed by a user text
 * turn instead. Compaction can fire on exactly that state: the auto threshold is
 * evaluated between the assistant turn and the tool execution that answers it, so
 * this is a live shape, not a theoretical one.
 *
 * The scan resolves ids rather than only inspecting the last message, so a partially
 * answered parallel tool-call batch (two calls, one result, array ends) is caught
 * too. Ids answered anywhere later in the array are matched, because the provider
 * pairs by id and not by adjacency.
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
 *
 * False is the safe answer and the default: the caller keeps today's truncated
 * serialization, which costs the same as it always did. True is only worth taking
 * when the replayed prefix will actually hit, so every condition below is a
 * necessary one.
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
	 * The live final-seam transform for provider-bound compaction text
	 * (`SummaryOptions.obfuscateProviderText`, resolved inside the auth attempt).
	 * Applied to the appended instruction ONLY. It must never touch the replayed
	 * messages: those already crossed the seam when they were sent on the live turn,
	 * and running a transform over them now would change bytes the provider has
	 * cached and cost the hit this whole module exists to get.
	 */
	sanitize?: (text: string) => string;
	/** Timestamp for the appended turn. Defaults to now. */
	timestamp?: number;
}

/**
 * Build the cache-aligned summarization request: the live session's tools and system
 * prompt, its full message array replayed byte-for-byte, and exactly one appended
 * user turn carrying the summarization instruction.
 *
 * Pure and side-effect free. The returned `messages` array is new; its first
 * `sessionMessages.length` entries are the caller's own objects, unmodified and
 * uncopied, which is what makes the replay byte-exact by construction rather than by
 * convention.
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
 * Token cost of a cache-aligned summarization request.
 *
 * Compaction admission (`estimateCompactionRequestTokens`) has to know what it is
 * about to send: a cache-aligned request is far LARGER in tokens than the truncated
 * one, because it carries the whole live window rather than a truncated digest of
 * part of it. Cheap is not the same as small: those tokens are billed at the cache
 * -read rate, but they still occupy the context window, so an estimate that reported
 * the truncated size would admit a request that cannot fit.
 *
 * Uses the same tokenizer the live context meter uses, so the number is comparable
 * to `tokensBefore` rather than a second, disagreeing estimate.
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
