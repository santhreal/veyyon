/**
 * The shapes of a failed assistant turn the retry ladder reads before it re-sends the turn, switches
 * the model, or continues from the results already in context.
 */

import { type AgentMessage, toolResultNeverRan } from "@veyyon/agent-core";
import type { AssistantMessage } from "@veyyon/ai";
import { type CursorExecResolvedCarrier, kCursorExecResolved } from "@veyyon/ai/utils/block-symbols";

/** Whether the turn ended on a content-classifier refusal or sensitivity stop. */
export function isClassifierRefusal(message: AssistantMessage): boolean {
	if (message.stopReason !== "error") return false;
	const stopType = message.stopDetails?.type;
	return stopType === "refusal" || stopType === "sensitive";
}

/**
 * Retried turns remove the failed assistant message from active context, so
 * the question here is whether replaying it can double-apply a side effect.
 *
 * A tool call in a FAILED turn is not evidence that the tool ran. The agent
 * loop has exactly one call site for `tool.execute()`, inside
 * `executeToolCalls`, and it is reached only from the runnable-stop branch;
 * an `error` stop returns before it, pairing every retained call with a
 * placeholder result that says `executed: false`. So the ordinary shape of
 * this failure (a provider that stalls, or closes without a terminal finish
 * reason, after streaming its tool calls) has applied nothing at all, and
 * refusing to retry it turned a transport fault into a dead turn: the
 * operator saw the provider's error and the model was handed a ledger telling
 * it to reissue the calls itself, on a batch where nothing had happened.
 *
 * Two shapes ARE unsafe and both are checked. A Cursor exec-channel block
 * carries {@link kCursorExecResolved} because that channel dispatches the
 * tool through the caller's handler INSIDE the provider stream, before the
 * block is synthesized, so it may have finished, may still be running, and
 * may have applied half its work. And a call answered by a result that is
 * not a never-ran placeholder ran by definition, whatever produced it.
 */
export function hasReplayUnsafeToolOutput(message: AssistantMessage, context: readonly AgentMessage[]): boolean {
	const toolCallIds = new Set<string>();
	for (const block of message.content) {
		if (block.type !== "toolCall") continue;
		if ((block as CursorExecResolvedCarrier)[kCursorExecResolved] === true) return true;
		toolCallIds.add(block.id);
	}
	if (toolCallIds.size === 0) return false;
	for (const contextMessage of context) {
		if (contextMessage.role !== "toolResult") continue;
		if (!toolCallIds.has(contextMessage.toolCallId)) continue;
		if (!toolResultNeverRan(contextMessage.details)) return true;
	}
	return false;
}

/**
 * Whether sending the turn now in context moves the work forward, asked per CALL.
 *
 * Two shapes continue. A call left with no answer at all: its never-ran
 * placeholder and the ledger tell the model to reissue it. And a batch whose
 * every call carries a real result: the batch finished and only the model's
 * next step is missing, which is exactly the request an ordinary tool turn
 * sends after its results land. Cursor's exec channel produces the second
 * shape whenever the stream dies after the last call returned.
 *
 * One shape does not: an exec-channel call whose result has not arrived yet.
 * It ran or is running out of band, and a request sent now would answer it
 * with nothing while its real result is still on its way.
 *
 * A mixed batch is normal (the reported one: 21 interrupted, 54 never ran).
 * A call that already has a real result is answered, and a placeholder sitting
 * beside that result does not make it unanswered again.
 *
 * A call whose arguments never finished streaming is outstanding by
 * construction and is counted without looking for a result. `retainCompleted-
 * ToolCalls` deletes its block, because partial arguments are unsafe to run
 * and an unpaired `tool_use` breaks replay, so nothing ever pairs against it:
 * looking it up among the results can only ever answer no. Its identity is
 * on `incompleteToolCalls` and the ledger tells the model to reconstruct the
 * arguments, which is work only a further request can do.
 */
export function toolBatchCanContinue(message: AssistantMessage, context: readonly AgentMessage[]): boolean {
	if ((message.incompleteToolCalls?.length ?? 0) > 0) return true;
	const toolCallIds = new Set<string>();
	for (const block of message.content) {
		if (block.type === "toolCall") toolCallIds.add(block.id);
	}
	if (toolCallIds.size === 0) return false;
	const answered = new Set<string>();
	const unanswered = new Set<string>();
	for (const contextMessage of context) {
		if (contextMessage.role !== "toolResult") continue;
		const id = contextMessage.toolCallId;
		if (!toolCallIds.has(id)) continue;
		if (toolResultNeverRan(contextMessage.details)) unanswered.add(id);
		else answered.add(id);
	}
	for (const id of unanswered) {
		if (!answered.has(id)) return true;
	}
	// Nothing never ran, so continue only when nothing is still in flight either.
	for (const id of toolCallIds) {
		if (!answered.has(id)) return false;
	}
	return true;
}
