/** Session-local tool-call ID canonicalization for outbound provider Context. Provider tool-call IDs are opaque to OpenAI-style APIs — only call↔result */

import type { Message } from "@veyyon/ai";

export type ToolCallIdMap = Map<string, string>;

/**
 * Allocate the next session-local handle. Counter is 1-based (`tc_1`, `tc_2`, …).
 */
export function allocateCanonicalToolCallId(counter: { value: number }): string {
	counter.value += 1;
	return `tc_${counter.value}`;
}

/** Resolve a provider ID to its session-local handle, assigning on first sight. IDs that already look like `tc_<n>` are still remapped so the session-local */
export function resolveCanonicalToolCallId(id: string, map: ToolCallIdMap, allocate: () => string): string {
	if (!id) return id;
	const existing = map.get(id);
	if (existing !== undefined) return existing;
	const canonical = allocate();
	map.set(id, canonical);
	return canonical;
}

/** Rewrite one message through the session-local ID map. The returned reference is unchanged when the message contains no mapped ID. */
export function canonicalizeToolCallIdsInMessage(
	message: Message,
	map: ToolCallIdMap,
	allocate: () => string,
): Message {
	if (message.role === "assistant") {
		let content: typeof message.content | undefined;
		for (let i = 0; i < message.content.length; i++) {
			const block = message.content[i];
			if (block.type !== "toolCall") continue;
			const canonical = resolveCanonicalToolCallId(block.id, map, allocate);
			if (canonical === block.id) continue;
			content ??= message.content.slice();
			content[i] = { ...block, id: canonical };
		}
		return content ? { ...message, content } : message;
	}
	if (message.role === "toolResult") {
		const canonical = resolveCanonicalToolCallId(message.toolCallId, map, allocate);
		return canonical === message.toolCallId ? message : { ...message, toolCallId: canonical };
	}
	return message;
}

/** Rewrite `assistant.toolCall.id` and `toolResult.toolCallId` through `map`. Walks messages in order; first appearance of a provider ID assigns the next */
export function canonicalizeToolCallIds(messages: Message[], map: ToolCallIdMap, allocate: () => string): Message[] {
	let out: Message[] | undefined;
	for (let i = 0; i < messages.length; i++) {
		const next = canonicalizeToolCallIdsInMessage(messages[i], map, allocate);
		if (next === messages[i]) continue;
		out ??= messages.slice();
		out[i] = next;
	}
	return out ?? messages;
}
