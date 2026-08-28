/** How many tokens a message costs, and the cache that keeps the answer. */

import type { AssistantMessage } from "@veyyon/ai";
import { stringifyJson } from "@veyyon/utils/json";
import { countTokens } from "../tokenizer";
import type { AgentMessage } from "../types";
import { LEGACY_FRAME_TOKEN_ESTIMATE } from "./legacy-snapcompact-archive";

/** Image content has no tokenizer representation; charge a fixed estimate */
const IMAGE_TOKEN_ESTIMATE = 1200;

/** Per-message token estimate cache, keyed by message object identity plus a */
const tokenEstimateCache = new WeakMap<
	AgentMessage,
	{ default?: { value: number; shape: number }; noReasoning?: { value: number; shape: number } }
>();

/** Estimate token count for a message using cl100k_base via the native */
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

/** Roles a host application contributes through the `CustomAgentMessages` */
const HOST_ROLE_TEXT_FIELDS: Record<string, readonly string[]> = {
	bashExecution: ["command", "output"],
	pythonExecution: ["code", "output"],
};

/** The one walk over everything a message's estimate counts: every counted text */
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
