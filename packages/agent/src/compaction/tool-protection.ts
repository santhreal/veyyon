import type { ToolResultMessage } from "@veyyon/ai";
import type { AgentToolCall } from "../types";
import type { SessionEntry } from "./entries";

export interface ProtectedToolContext {
	readonly toolResult: ToolResultMessage;
	readonly toolCall: AgentToolCall | undefined;
}

export type ProtectedToolMatcher = string | ((context: ProtectedToolContext) => boolean);

const SKILL_INTERNAL_URL_PREFIX = "skill://";

const toolCallsByIdCache = new WeakMap<readonly SessionEntry[], { length: number; map: Map<string, AgentToolCall> }>();

export function collectToolCallsById(entries: readonly SessionEntry[]): Map<string, AgentToolCall> {
	let cached = toolCallsByIdCache.get(entries);
	if (!cached || cached.length > entries.length) {
		cached = { length: 0, map: new Map<string, AgentToolCall>() };
		toolCallsByIdCache.set(entries, cached);
	}
	for (let i = cached.length; i < entries.length; i++) {
		const entry = entries[i];
		if (entry?.type === "message" && entry.message.role === "assistant")
			for (const block of entry.message.content) if (block.type === "toolCall") cached.map.set(block.id, block);
	}
	cached.length = entries.length;
	return cached.map;
}

/**
 * Extract the `path` argument from a paired `read` tool call, when the result
 * is a `read` result carrying a string path. Returns `undefined` otherwise.
 * Shared primitive for read-targeted protection matchers (skills, plans, …).
 */
export function getReadToolPath({ toolResult, toolCall }: ProtectedToolContext): string | undefined {
	if (toolResult.toolName !== "read" || toolCall?.name !== "read") return undefined;
	const path = (toolCall.arguments as Record<string, unknown>).path;
	return typeof path === "string" ? path : undefined;
}

export function isSkillReadToolResult(context: ProtectedToolContext): boolean {
	return getReadToolPath(context)?.startsWith(SKILL_INTERNAL_URL_PREFIX) ?? false;
}

export function isProtectedToolResult(
	toolResult: ToolResultMessage,
	toolCall: AgentToolCall | undefined,
	matchers: readonly ProtectedToolMatcher[],
): boolean {
	for (const matcher of matchers) {
		if (typeof matcher === "string") {
			if (toolResult.toolName === matcher) return true;
			continue;
		}
		if (matcher({ toolResult, toolCall })) return true;
	}
	return false;
}
