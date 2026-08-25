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
	const cached = toolCallsByIdCache.get(entries);
	if (cached !== undefined && cached.length === entries.length) {
		return cached.map;
	}
	if (cached !== undefined && cached.length < entries.length) {
		// Incremental update: only process new entries appended since the
		// last build. The branch array is extended in-place on append, so
		// earlier entries are unchanged (toolCall blocks are never mutated
		// by pruning, which only touches toolResult messages).
		for (let i = cached.length; i < entries.length; i++) {
			const entry = entries[i];
			if (entry === undefined || entry.type !== "message") continue;
			const message = entry.message;
			if (message.role !== "assistant") continue;
			for (const block of message.content) {
				if (block.type === "toolCall") cached.map.set(block.id, block);
			}
		}
		cached.length = entries.length;
		return cached.map;
	}
	const toolCalls = new Map<string, AgentToolCall>();
	for (const entry of entries) {
		if (entry.type !== "message") continue;
		const message = entry.message;
		if (message.role !== "assistant") continue;
		for (const block of message.content) {
			if (block.type === "toolCall") toolCalls.set(block.id, block);
		}
	}
	toolCallsByIdCache.set(entries, { length: entries.length, map: toolCalls });
	return toolCalls;
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
