/**
 * Prefix stability and cache invalidation analysis across turns.
 *
 * Measures whether a prefix lever keeps the prompt prefix byte-stable across turns
 * or invalidates cached tokens by rewriting historical bytes.
 */

import type { TranscriptRecord } from "./prefix-mass";

/** The 33-character sentinel Gemini accepts in place of a real thought signature. */
export const SKIP_SIGNATURE_CHARS = 33;

/**
 * How a signature lever decides, per signature, whether to send it.
 *
 * `sizeCap` keys on a signature's own immutable length (cache-stable).
 * `retainLast` keys on distance from the conversation end, moving each turn (invalidates cache).
 */
export type SignatureLever =
	| { kind: "stock" }
	| { kind: "sizeCap"; maxLength: number }
	| { kind: "retainLast"; assistantMessages: number };

/**
 * A recency window over thinking blocks rather than signatures.
 */
export type ThinkingLever = { kind: "thinkingRetainLast"; assistantMessages: number };

/** Any lever whose cache compatibility `prefixStability` can decide. */
export type PrefixLever = SignatureLever | ThinkingLever;

/** One signature or thinking item in a session, with its position for recency evaluation. */
export interface SignatureSite {
	/** Index of the assistant message carrying it, counted from the start. */
	readonly assistantIndex: number;
	readonly length: number;
	/**
	 * What goes on the wire in place of this item when a lever elides it.
	 * 33 for a signature (`skip_thought_signature_validator`), 0 for thinking.
	 */
	readonly sentinel: number;
}

/** The characters a lever sends for one item, on a turn with `total` assistant messages so far. */
export function sentLength(lever: PrefixLever, site: SignatureSite, assistantMessagesSoFar: number): number {
	if (lever.kind === "stock") return site.length;
	if (lever.kind === "sizeCap") {
		return site.length > lever.maxLength ? site.sentinel : site.length;
	}
	const retainFrom = assistantMessagesSoFar - lever.assistantMessages;
	return site.assistantIndex < retainFrom ? site.sentinel : site.length;
}

/** What a lever does to the cacheable prefix, measured across a session's turns. */
export interface PrefixStability {
	/** Turns compared, i.e. one less than the number of billed turns in the session. */
	readonly comparisons: number;
	/** Comparisons where the previous turn's rendered prefix survived intact. */
	readonly stableComparisons: number;
	/**
	 * Signature characters that a turn re-rendered differently from the turn before.
	 */
	readonly rewrittenSignatureChars: number;
	/**
	 * Characters that were cacheable and stop being so, summed over turns.
	 */
	readonly invalidatedCharTurns: number;
}

/**
 * Whether a signature or thinking lever is compatible with a prefix cache, and by how much.
 */
export function prefixStability(records: TranscriptRecord[], lever: PrefixLever): PrefixStability {
	const items: { site: SignatureSite | null; chars: number }[] = [];
	let assistantMessages = 0;
	let previous: number[] | null = null;
	let comparisons = 0;
	let stableComparisons = 0;
	let rewrittenSignatureChars = 0;
	let invalidatedCharTurns = 0;

	const render = (): number[] =>
		items.map(item => (item.site === null ? item.chars : sentLength(lever, item.site, assistantMessages)));

	for (const record of records) {
		if (record.type === "session_init") {
			const system = (record.systemPrompt ?? "").length + JSON.stringify(record.tools ?? []).length;
			if (system > 0) items.push({ site: null, chars: system });
			continue;
		}
		if (record.type !== "message" || !record.message) continue;
		const message = record.message;
		const content = message.content ?? [];
		if (message.role === "assistant") {
			if (message.usage) {
				const rendered = render();
				if (previous !== null) {
					comparisons += 1;
					let firstChange = -1;
					for (let index = 0; index < previous.length; index++) {
						if (previous[index] !== rendered[index]) {
							firstChange = index;
							break;
						}
					}
					if (firstChange === -1) {
						stableComparisons += 1;
					} else {
						for (let index = firstChange; index < previous.length; index++) {
							invalidatedCharTurns += previous[index] ?? 0;
							if (previous[index] !== rendered[index]) rewrittenSignatureChars += previous[index] ?? 0;
						}
					}
				}
				previous = rendered;
			}
			const leversThinking = lever.kind === "thinkingRetainLast";
			for (const block of content) {
				if (block.type === "toolCall") {
					const length = (block.thoughtSignature ?? "").length;
					if (length > 0) {
						items.push({
							site: leversThinking
								? null
								: { assistantIndex: assistantMessages, length, sentinel: SKIP_SIGNATURE_CHARS },
							chars: length,
						});
					}
					items.push({ site: null, chars: JSON.stringify(block.arguments ?? {}).length });
				} else if (block.type === "thinking") {
					const length = (block.thinking ?? "").length;
					items.push({
						site: leversThinking ? { assistantIndex: assistantMessages, length, sentinel: 0 } : null,
						chars: length,
					});
				} else if (block.type === "text") {
					items.push({ site: null, chars: (block.text ?? "").length });
				}
			}
			assistantMessages += 1;
			continue;
		}
		if (message.role === "toolResult") {
			items.push({ site: null, chars: content.reduce((sum, block) => sum + (block.text ?? "").length, 0) });
			continue;
		}
		if (message.role === "user") {
			items.push({
				site: null,
				chars: content.reduce((sum, block) => sum + (block.type === "text" ? (block.text ?? "").length : 0), 0),
			});
		}
	}
	return { comparisons, stableComparisons, rewrittenSignatureChars, invalidatedCharTurns };
}
