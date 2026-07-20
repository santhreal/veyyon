/**
 * Session-local tool-call ID canonicalization for outbound provider Context.
 *
 * Provider tool-call IDs are opaque to OpenAI-style APIs — only call↔result
 * match matters — but compound Responses IDs (`call_…|fc_…`) average ~80 chars
 * and are re-sent every turn. Mapping each distinct provider ID to a short
 * `tc_<n>` handle at the `transformProviderContext` boundary cuts that carry
 * while keeping prior-history bytes stable for prompt cache.
 *
 * Stored session history keeps the original IDs; only the outbound Context
 * snapshot is rewritten. The map is rebuilt identically on resume by walking
 * history in order (no schema change).
 */

import type { Message } from "@veyyon/ai";

export type ToolCallIdMap = Map<string, string>;

/**
 * Allocate the next session-local handle. Counter is 1-based (`tc_1`, `tc_2`, …).
 */
export function allocateCanonicalToolCallId(counter: { value: number }): string {
	counter.value += 1;
	return `tc_${counter.value}`;
}

/**
 * Resolve a provider ID to its session-local handle, assigning on first sight.
 *
 * IDs that already look like `tc_<n>` are still remapped so the session-local
 * namespace stays unambiguous (a provider-emitted `tc_1` must not collide with
 * our allocated `tc_1`).
 */
export function resolveCanonicalToolCallId(id: string, map: ToolCallIdMap, allocate: () => string): string {
	if (!id) return id;
	const existing = map.get(id);
	if (existing !== undefined) return existing;
	const canonical = allocate();
	map.set(id, canonical);
	return canonical;
}

/**
 * Rewrite `assistant.toolCall.id` and `toolResult.toolCallId` through `map`.
 *
 * Walks messages in order; first appearance of a provider ID assigns the next
 * handle. Call and result IDs that share a provider ID receive the same handle.
 * Returns the input array reference when nothing changed (cheap no-op for
 * empty/tool-less contexts).
 */
export function canonicalizeToolCallIds(messages: Message[], map: ToolCallIdMap, allocate: () => string): Message[] {
	let changed = false;
	const out = messages.map(msg => {
		if (msg.role === "assistant") {
			let contentChanged = false;
			const content = msg.content.map(block => {
				if (block.type !== "toolCall") return block;
				const canonical = resolveCanonicalToolCallId(block.id, map, allocate);
				if (canonical === block.id) return block;
				contentChanged = true;
				return { ...block, id: canonical };
			});
			if (!contentChanged) return msg;
			changed = true;
			return { ...msg, content };
		}
		if (msg.role === "toolResult") {
			const canonical = resolveCanonicalToolCallId(msg.toolCallId, map, allocate);
			if (canonical === msg.toolCallId) return msg;
			changed = true;
			return { ...msg, toolCallId: canonical };
		}
		return msg;
	});
	return changed ? out : messages;
}
