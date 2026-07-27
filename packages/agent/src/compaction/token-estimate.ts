/**
 * How many tokens a message costs, and the cache that keeps the answer.
 *
 * WHY IT IS NOT IN `compaction.ts`. That module is the compaction ENGINE: the summarizer, the cut point and
 * the provider round trip, and it reaches 395 modules to do that job. Estimating a message costs a tokenizer
 * and nothing else. Three modules in this directory wanted only the estimate and had taken it from the
 * engine: `shake.ts` paid 312 marginal modules for it, `pruning.ts` 197, and `branch-summarization.ts` the
 * same edge again. `compaction.ts` re-exports the name it used to declare, so no caller outside changed.
 *
 * The estimate is not a display number. It decides when compaction triggers, how pruning spends its budget,
 * and what the operator's context meter reads, so an estimate that is wrong in one direction silently lets a
 * session exceed the provider window and wrong in the other compacts a session that did not need it. That is
 * why the odd-looking cases below (a `developer` message counting its images, a thinking block counting its
 * signature) are each written with the failure they fix.
 */

import type { AssistantMessage } from "@veyyon/ai";
import { stringifyJson } from "@veyyon/utils/json";
import { countTokens } from "../tokenizer";
import type { AgentMessage } from "../types";
import { LEGACY_FRAME_TOKEN_ESTIMATE } from "./legacy-snapcompact-archive";

/**
 * Image content has no tokenizer representation; charge a fixed estimate
 * matching what providers typically bill for inline images.
 */
const IMAGE_TOKEN_ESTIMATE = 1200;

/**
 * Per-message token estimate cache, keyed by message object identity. Agent
 * messages are treated as immutable once constructed — streaming replaces
 * `context.messages[i]` with a new object per delta rather than mutating one
 * in place (see `agent-loop.ts`), so caching by identity is safe: a message
 * object's estimate never needs to change after it is first computed, and a
 * superseded in-flight object is simply dropped by the `WeakMap` once nothing
 * else references it. This avoids re-walking (and re-tokenizing) the same
 * unchanged messages every time compaction/context-usage code re-estimates
 * the stored conversation (`#estimateStoredContextTokens`,
 * `getContextBreakdown`'s tail walk, etc. call `estimateTokens` per message
 * on every recompute).
 *
 * The two option variants (`default` vs `excludeEncryptedReasoning`) can
 * disagree for a message with encrypted reasoning, so they get separate slots
 * rather than sharing one cached number.
 */
const tokenEstimateCache = new WeakMap<AgentMessage, { default?: number; noReasoning?: number }>();

/**
 * Estimate token count for a message using cl100k_base via the native
 * tokenizer. This is not Claude's first-party tokenizer (Anthropic doesn't
 * publish one) but is within ~5–10% across English/code text.
 *
 * `excludeEncryptedReasoning` drops opaque provider reasoning payloads
 * (`thinkingSignature`, `redactedThinking`) from the estimate. Those are billed
 * by the provider on replay, so the default counts them — but their *local*
 * byte size can diverge wildly from what the provider charges, so the
 * compaction floor (which only needs the reliably-countable, on-wire-compressible
 * content) excludes them to avoid false triggers on thinking-heavy turns.
 */
export function estimateTokens(message: AgentMessage, options?: { excludeEncryptedReasoning?: boolean }): number {
	const slotKey = options?.excludeEncryptedReasoning ? "noReasoning" : "default";
	const cached = tokenEstimateCache.get(message);
	const hit = cached?.[slotKey];
	if (hit !== undefined) return hit;
	const value = estimateTokensUncached(message, options);
	tokenEstimateCache.set(message, { ...cached, [slotKey]: value });
	return value;
}

function estimateTokensUncached(message: AgentMessage, options?: { excludeEncryptedReasoning?: boolean }): number {
	const fragments: string[] = [];
	let extra = 0;
	if ((message as { role?: string }).role === "bashExecution") {
		const bash = message as { command?: unknown; output?: unknown };
		if (typeof bash.command === "string") fragments.push(bash.command);
		if (typeof bash.output === "string") fragments.push(bash.output);
		return fragments.length === 0 ? 0 : countTokens(fragments);
	}

	switch (message.role) {
		case "user": {
			const content = (message as { content: string | Array<{ type: string; text?: string }> }).content;
			if (typeof content === "string") {
				fragments.push(content);
			} else if (Array.isArray(content)) {
				for (const block of content) {
					if (block.type === "text" && block.text) {
						fragments.push(block.text);
					} else if (block.type === "image") {
						// A user message is the MOST common way an image enters a session
						// (paste, drag, `/image`), and its images counted as zero here while
						// every other content-bearing role counted them. A screenshot-heavy
						// session therefore under-reported its own context to the compaction
						// trigger, the pruning budgets, and the operator's context meter — the
						// same defect the `developer` case below records having been fixed,
						// left in place on the role it matters most for.
						extra += IMAGE_TOKEN_ESTIMATE;
					}
				}
			}
			break;
		}
		case "assistant": {
			const assistant = message as AssistantMessage;
			for (const block of assistant.content) {
				if (block.type === "text") {
					fragments.push(block.text);
				} else if (block.type === "thinking") {
					fragments.push(block.thinking);
					// Providers charge for the opaque signature/reasoning payload that
					// rides alongside the thinking text (OpenAI Responses encrypted
					// reasoning items, Anthropic signed thinking blocks, etc.). Without
					// counting it, this estimator can read ~half of the provider-reported
					// usage on thinking-heavy turns — see #2275 for the resulting
					// compaction-trigger / post-check metric divergence. The compaction
					// floor excludes it (its local byte size diverges from provider billing).
					if (block.thinkingSignature && !options?.excludeEncryptedReasoning) {
						fragments.push(block.thinkingSignature);
					}
				} else if (block.type === "toolCall") {
					fragments.push(block.name);
					fragments.push(stringifyJson(block.arguments) ?? "null");
				} else if (block.type === "redactedThinking") {
					// Encrypted reasoning blob the provider still bills for on replay;
					// excluded from the compaction floor for the same reason as above.
					if (!options?.excludeEncryptedReasoning) fragments.push(block.data);
				}
			}
			break;
		}
		// `developer` shares the user-message content shape (string | text/image
		// blocks) and carries real content: synthetic auto-continue prompts are
		// stored as full developer messages, some with normalized images. It was
		// missing from this switch, so every developer message hit `default: return
		// 0` and counted as ZERO tokens — silently under-reporting context usage to
		// the compaction trigger, pruning budgets, and the operator context meter,
		// which could let a session exceed the provider window unnoticed. Counted
		// here with images, exactly like the other content-bearing roles.
		case "developer":
		case "custom":
		case "hookMessage":
		case "toolResult": {
			if (typeof message.content === "string") {
				fragments.push(message.content);
			} else {
				for (const block of message.content) {
					if (block.type === "text" && block.text) {
						fragments.push(block.text);
					} else if (block.type === "image") {
						extra += IMAGE_TOKEN_ESTIMATE;
					}
				}
			}
			break;
		}
		case "branchSummary":
		case "compactionSummary": {
			fragments.push(message.summary);
			if (message.role === "compactionSummary") {
				if (message.blocks) {
					for (const block of message.blocks) {
						if (block.type === "text") fragments.push(block.text);
						else extra += LEGACY_FRAME_TOKEN_ESTIMATE;
					}
				} else if (message.images) {
					// Legacy snapcompact frames rendered at large sizes; providers bill the
					// downscaled cap. Only old persisted summaries still carry these.
					extra += message.images.length * LEGACY_FRAME_TOKEN_ESTIMATE;
				}
			}
			break;
		}
		default:
			return 0;
	}

	if (fragments.length === 0) return extra;
	return extra + countTokens(fragments);
}
