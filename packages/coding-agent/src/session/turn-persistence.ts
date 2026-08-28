/** Helpers that share one cheap, structural identity for messages — both during incremental persistence and for the mid-run-compaction ordering check. */
import type { AgentMessage } from "@veyyon/agent-core";

/** Stable identity for messages that pass through {@link AgentSession}'s incremental persistence path. */
export function sessionMessagePersistenceKey(message: AgentMessage): string | undefined {
	switch (message.role) {
		case "assistant":
			return [
				"assistant",
				message.timestamp,
				message.provider,
				message.model,
				message.responseId ?? "",
				message.stopReason,
			].join(":");
		case "toolResult":
			return `toolResult:${message.timestamp}:${message.toolCallId}:${message.toolName}`;
		case "user":
		case "developer":
			return `${message.role}:${message.timestamp}:${message.attribution ?? ""}`;
		case "fileMention":
			return `fileMention:${message.timestamp}`;
		default:
			return undefined;
	}
}

/** Slow-path content equality check used when two messages collide on {@link sessionMessagePersistenceKey}. Only the role's content fields are */
export function sameMessageContent(left: AgentMessage, right: AgentMessage): boolean {
	if (left === right) return true;
	if (left.role !== right.role) return false;
	// `JSON.stringify` is the slow-path serializer here on purpose: nothing on the hot persistence-check path reaches it (key lookup short-circuits
	const leftRaw = left.role === "fileMention" ? left.files : "content" in left ? left.content : undefined;
	const rightRaw = right.role === "fileMention" ? right.files : "content" in right ? right.content : undefined;
	if (leftRaw === undefined || rightRaw === undefined) return false;
	return (JSON.stringify(leftRaw) ?? "undefined") === (JSON.stringify(rightRaw) ?? "undefined");
}

/** Outcome of {@link planTurnPersistence}. `ok` lists the turn-message indices that still need to be appended (in */
export type TurnPersistencePlan =
	| { kind: "ok"; toPersist: readonly number[] }
	| { kind: "out-of-order"; messageIndex: number };

/** Decide what to do with a turn's messages relative to what's already on the branch, in a single pass over the pre-computed keys. */
export function planTurnPersistence(
	turnKeys: readonly (string | undefined)[],
	persistedKeys: ReadonlySet<string>,
): TurnPersistencePlan {
	const toPersist: number[] = [];
	for (let index = 0; index < turnKeys.length; index++) {
		const key = turnKeys[index];
		// Slots without a persistence key (non-persistent roles like `custom` / `hookMessage`) take other branches in `SessionManager` — they are not
		if (key === undefined) continue;
		if (persistedKeys.has(key)) continue;
		for (let later = index + 1; later < turnKeys.length; later++) {
			const laterKey = turnKeys[later];
			if (laterKey !== undefined && persistedKeys.has(laterKey)) {
				return { kind: "out-of-order", messageIndex: index };
			}
		}
		toPersist.push(index);
	}
	return { kind: "ok", toPersist };
}
