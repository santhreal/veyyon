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
 * Per-message token estimate cache, keyed by message object identity plus a
 * shape digest of the content that identity currently holds.
 *
 * The digest is what makes the entry trustworthy, and it is not optional. The
 * compaction rewrites edit a stored message IN PLACE: `applyShakeRegion`
 * assigns a placeholder over `message.content` and stamps `prunedAt`,
 * `pruning.ts` blanks a tool result the same way, and `dropImages` splices
 * image blocks out of one. Identity survives all three, so an identity-only
 * cache answers every later caller with the size the message had BEFORE the
 * bytes were removed, permanently. The consequences are not cosmetic: the
 * compaction decision floors the provider figure with this estimate
 * (`compactionContextTokens`), so an estimate that cannot fall means a dedup or
 * prune can never bring a session back under the trigger, the post-compaction
 * headroom and retry-fit checks measure a residual that is already gone, and
 * the operator's context meter reports elided bytes as live.
 *
 * So validity is decided by what the message says now, not by whether the
 * object is the same one. Recomputing the digest walks the blocks and reads
 * string lengths, which is what the cache is here to make cheap: the expensive
 * part is `countTokens`, and that still runs only when the shape moved.
 *
 * WHAT THE DIGEST DOES NOT CATCH: an in-place edit that preserves the fragment
 * sequence and every fragment's length (swapping two same-length texts). No
 * rewrite in this directory does that, and one that did would not change the
 * estimate by more than rounding.
 *
 * The two option variants (`default` vs `excludeEncryptedReasoning`) can
 * disagree for a message with encrypted reasoning, and they also walk different
 * fragments, so each keeps its own value and its own digest rather than sharing
 * one slot.
 */
const tokenEstimateCache = new WeakMap<
	AgentMessage,
	{ default?: { value: number; shape: number }; noReasoning?: { value: number; shape: number } }
>();

/**
 * Estimate token count for a message using cl100k_base via the native
 * tokenizer. This is not Claude's first-party tokenizer (Anthropic doesn't
 * publish one) but is within ~5-10% across English/code text.
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
	// One walk answers "is the cached number still about this content?" without
	// tokenizing anything: the sink folds fragment lengths instead of keeping the
	// strings.
	let shape = 0;
	const shapeExtra = walkCountedFragments(message, options, text => {
		shape = (shape * 31 + text.length) | 0;
	});
	shape = (shape * 31 + shapeExtra) | 0;

	const cached = tokenEstimateCache.get(message);
	const hit = cached?.[slotKey];
	if (hit !== undefined && hit.shape === shape) return hit.value;
	const value = estimateTokensUncached(message, options);
	tokenEstimateCache.set(message, { ...cached, [slotKey]: { value, shape } });
	return value;
}

function estimateTokensUncached(message: AgentMessage, options?: { excludeEncryptedReasoning?: boolean }): number {
	const fragments: string[] = [];
	const extra = walkCountedFragments(message, options, text => {
		fragments.push(text);
	});
	if (fragments.length === 0) return extra;
	return extra + countTokens(fragments);
}

/**
 * Roles a host application contributes through the `CustomAgentMessages`
 * augmentation, and the string fields each one carries. This module compiles
 * without them in `AgentMessage`, so they are matched on the role string rather
 * than in the typed switch below.
 *
 * They are not exotic: the host turns each one into a user message on its way to
 * the provider, so their bytes are billed like any other. A role missing from
 * here is content the estimate believes is free, which is the same defect the
 * `developer` case and the user-image charge below each record — and it kept
 * happening on the roles that carry the MOST text. `pythonExecution` (a `$`
 * cell's code and output) counted zero from the day it was added, and
 * `fileMention` counted zero while carrying up to 50KB of file body per turn:
 * a session that mentioned two files reported a fifth of its real prompt to the
 * compaction trigger, the pruning budgets and the operator's context gauge, and
 * the first thing the operator saw was the provider refusing the request.
 *
 * Like `bashExecution` before it, `pythonExecution` is counted even when
 * `excludeFromContext` drops it from the payload: over-counting an excluded cell
 * only makes compaction keener, while under-counting one is the failure above.
 */
const HOST_ROLE_TEXT_FIELDS: Record<string, readonly string[]> = {
	bashExecution: ["command", "output"],
	pythonExecution: ["code", "output"],
};

/**
 * The one walk over everything a message's estimate counts: every counted text
 * fragment goes to `sink`, and the return value is the token charge for content
 * a tokenizer cannot measure (images, legacy frames).
 *
 * It is a sink rather than a returned array because the cache validity check in
 * {@link estimateTokens} needs the same traversal without keeping the strings.
 * Two traversals would be two places to add a new role to, and a role missing
 * from one of them is a silent wrong answer in exactly the way the cases below
 * record.
 */
function walkCountedFragments(
	message: AgentMessage,
	options: { excludeEncryptedReasoning?: boolean } | undefined,
	sink: (text: string) => void,
): number {
	let extra = 0;
	const hostRole = (message as { role?: string }).role;
	const textFields = hostRole === undefined ? undefined : HOST_ROLE_TEXT_FIELDS[hostRole];
	if (textFields) {
		const record = message as unknown as Record<string, unknown>;
		for (const field of textFields) {
			const value = record[field];
			if (typeof value === "string") sink(value);
		}
		return 0;
	}
	if (hostRole === "fileMention") {
		const files = (message as unknown as { files?: readonly unknown[] }).files;
		for (const entry of files ?? []) {
			const file = entry as { path?: unknown; content?: unknown; image?: unknown };
			if (typeof file.path === "string") sink(file.path);
			if (typeof file.content === "string") sink(file.content);
			// A mentioned image rides as an `ImageContent` beside a placeholder body,
			// and is billed like any other inline image.
			if (file.image) extra += IMAGE_TOKEN_ESTIMATE;
		}
		return extra;
	}

	switch (message.role) {
		case "user": {
			const content = (message as { content: string | Array<{ type: string; text?: string }> }).content;
			if (typeof content === "string") {
				sink(content);
			} else if (Array.isArray(content)) {
				for (const block of content) {
					if (block.type === "text" && block.text) {
						sink(block.text);
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
					sink(block.text);
				} else if (block.type === "thinking") {
					sink(block.thinking);
					// Providers charge for the opaque signature/reasoning payload that
					// rides alongside the thinking text (OpenAI Responses encrypted
					// reasoning items, Anthropic signed thinking blocks, etc.). Without
					// counting it, this estimator can read ~half of the provider-reported
					// usage on thinking-heavy turns — see #2275 for the resulting
					// compaction-trigger / post-check metric divergence. The compaction
					// floor excludes it (its local byte size diverges from provider billing).
					if (block.thinkingSignature && !options?.excludeEncryptedReasoning) {
						sink(block.thinkingSignature);
					}
				} else if (block.type === "toolCall") {
					sink(block.name);
					sink(stringifyJson(block.arguments) ?? "null");
				} else if (block.type === "redactedThinking") {
					// Encrypted reasoning blob the provider still bills for on replay;
					// excluded from the compaction floor for the same reason as above.
					if (!options?.excludeEncryptedReasoning) sink(block.data);
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
				sink(message.content);
			} else {
				for (const block of message.content) {
					if (block.type === "text" && block.text) {
						sink(block.text);
					} else if (block.type === "image") {
						extra += IMAGE_TOKEN_ESTIMATE;
					}
				}
			}
			break;
		}
		case "branchSummary":
		case "compactionSummary": {
			sink(message.summary);
			if (message.role === "compactionSummary") {
				if (message.blocks) {
					for (const block of message.blocks) {
						if (block.type === "text") sink(block.text);
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

	return extra;
}
