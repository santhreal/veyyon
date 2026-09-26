import type { ToolResultMessage } from "@veyyon/ai";
import type { AgentToolCall } from "../types";
import type { SessionEntry } from "./entries";

export interface ProtectedToolContext {
	readonly toolResult: ToolResultMessage;
	readonly toolCall: AgentToolCall | undefined;
}

export type ProtectedToolMatcher = string | ((context: ProtectedToolContext) => boolean);

const SKILL_INTERNAL_URL_PREFIX = "skill://";

/**
 * Tool calls by id, for looking up the call behind each tool result at or after
 * `from`.
 *
 * A pass that only acts on the live tail of a branch (everything from the
 * compaction boundary on) passes that boundary as `from`, and the map is built
 * from the tail instead of the whole session history. A call id that occurs
 * more than once resolves to its last occurrence on the branch, the same answer
 * a walk from index 0 gives: that occurrence is in the tail whenever any
 * occurrence is. A tail result whose call precedes `from` is resolved by walking
 * back from `from` until every such id is found, so a result answered across a
 * compaction boundary keeps its call and the protection its call confers.
 *
 * The map holds only what those lookups need. Asking it for the call behind a
 * result BEFORE `from` is outside its contract.
 */
export function collectToolCallsById(entries: readonly SessionEntry[], from = 0): Map<string, AgentToolCall> {
	const toolCalls = new Map<string, AgentToolCall>();
	let unresolved: Set<string> | undefined;
	for (let i = from; i < entries.length; i++) {
		const entry = entries[i];
		if (entry.type !== "message") continue;
		const message = entry.message;
		if (message.role === "assistant") {
			for (const block of message.content) {
				if (block.type !== "toolCall") continue;
				toolCalls.set(block.id, block);
				unresolved?.delete(block.id);
			}
		} else if (message.role === "toolResult" && !toolCalls.has(message.toolCallId)) {
			unresolved ??= new Set();
			unresolved.add(message.toolCallId);
		}
	}
	for (let i = Math.min(from, entries.length) - 1; i >= 0 && unresolved !== undefined && unresolved.size > 0; i--) {
		const entry = entries[i];
		if (entry.type !== "message") continue;
		const message = entry.message;
		if (message.role !== "assistant") continue;
		for (const block of message.content) {
			if (block.type === "toolCall" && unresolved.delete(block.id)) toolCalls.set(block.id, block);
		}
	}
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
