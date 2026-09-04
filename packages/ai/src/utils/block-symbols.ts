export * from "@veyyon/model/stream-block";

/** Stores a provider-local stream block index without exposing a string-keyed property. */
export const kStreamingBlockIndex = Symbol("provider.block.index");

/** Stores the last parsed argument prefix length for throttled streaming JSON parsing. */
export const kStreamingLastParseLen = Symbol("provider.block.lastParseLen");

/** Marks streamed tool-call arguments that already received an authoritative done payload. */
export const kStreamingArgumentsDone = Symbol("provider.block.argumentsDone");

/** Classifies Cursor's in-flight tool-call kind without leaking provider-private state. */
export const kStreamingBlockKind = Symbol("provider.block.kind");

/**
 * Marks a `toolCall` content block that Cursor's exec channel already
 * executed server-side (via the coding-agent bridge) and whose result is
 * buffered separately for emission via the assistant-loop stream.
 *
 * `agent-loop.ts` MUST skip execution of blocks carrying this marker —
 * treating them as a fresh runnable tool call would run the same
 * side-effecting tool (bash, write, delete, …) a second time. Symbol-keyed
 * so it never persists across the JSONL round-trip, where rebuild instead
 * pairs the block with its already-persisted `toolResult` message by id.
 */
export const kCursorExecResolved = Symbol("provider.block.cursorExecResolved");

/** Carries the resolved marker without exposing a string-keyed property. */
export type CursorExecResolvedCarrier = object & { [kCursorExecResolved]?: true };

/**
 * Marks a text block synthesized by cross-model thinking demotion in
 * `transformMessages`. Converters that flatten adjacent text blocks into one
 * string (openai-completions) insert a paragraph separator after marked
 * blocks; unmarked adjacent blocks keep their original byte sequence.
 * Symbol-keyed so the marker never persists across the JSONL round-trip and
 * never reaches the wire.
 */
export const kDemotedThinking = Symbol("provider.block.demotedThinking");

/** Carries the demoted-thinking marker without exposing a string-keyed property. */
export type DemotedThinkingCarrier = object & { [kDemotedThinking]?: boolean };

/** True for text blocks synthesized by cross-model thinking demotion. */
export function isDemotedThinking(block: DemotedThinkingCarrier | null | undefined): boolean {
	return block?.[kDemotedThinking] === true;
}
