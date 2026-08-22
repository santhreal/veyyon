import type { AssistantMessage } from "../types";

/**
 * What a stream that ended without its dialect's terminal marker means.
 *
 * Every dialect ends a turn with a marker of its own — `finish_reason` and
 * `[DONE]`, `response.completed`, `message_stop`, `finishReason`, `done: true`,
 * `messageStop`, `turn_ended` — and reaching the end of the body without one is
 * a transport-clean EOF that carries no statement about the turn. Two mistakes
 * are available at that point, and each is worse than the other in a different
 * way. Reporting a normal stop persists whatever arrived as a finished answer,
 * so a half-written sentence becomes history the model reads back on the next
 * turn and the compaction anchor trusts its partial token counts. Rejecting
 * every such EOF fails turns that were actually complete: several compatible
 * servers (DeepSeek V4 Flash and Muse Spark among them) simply do not send the
 * marker.
 *
 * The judgement that separates them looks at what arrived, not at how it ended,
 * and it is the same judgement on every dialect — so it lives here rather than
 * in each provider, where three copies would drift and a fourth dialect would
 * get a fresh guess.
 */
export type TerminallessStopReason = "stop" | "toolUse" | "length";

/**
 * The stop reason a terminal-less EOF earns, or `undefined` when the accumulated
 * content cannot stand as a turn and the caller must fail with its own
 * dialect's `incomplete-stream` error.
 *
 * `toolBatchIsComplete` is the dialect's own answer to "is every tool call in
 * this batch usable" — an id, a name, and complete JSON-object arguments. A
 * partial call outranks any text or reasoning beside it, because promoting a
 * repaired fragment into an apparently successful tool-use turn is the one
 * outcome that cannot be recovered downstream.
 */
export function stopReasonForTerminallessEof(
	content: AssistantMessage["content"],
	toolBatchIsComplete: boolean,
): TerminallessStopReason | undefined {
	const hasToolCalls = content.some(block => block.type === "toolCall");
	if (hasToolCalls) return toolBatchIsComplete ? "toolUse" : undefined;
	if (content.some(block => block.type === "text" && block.text.trim().length > 0)) return "stop";
	// Reasoning with no answer is a turn that ran out of room rather than one
	// that finished, and `length` is the stop reason a session can recover from.
	if (content.some(block => block.type === "thinking" && block.thinking.trim().length > 0)) return "length";
	return undefined;
}
