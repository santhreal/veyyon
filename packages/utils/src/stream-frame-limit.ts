/**
 * The bound on a single frame of a streamed protocol, and the error raised when a peer
 * exceeds it.
 *
 * WHY THIS IS ITS OWN MODULE. Every reader in `./stream.ts` needs the bound, and so does
 * the code that decides whether a failure is worth retrying — which lives in
 * `@veyyon/ai`'s error classifier, a module with a reach budget. This file imports
 * nothing, so classifying a framing violation costs the classifier one leaf rather than
 * the whole stream stack.
 *
 * A FRAMING VIOLATION IS NOT A TRANSIENT FAULT. The peer sent bytes that its own
 * protocol says must be delimited, and never delimited them. Sending the request again
 * reaches the same peer with the same behavior, so a retry is not a recovery, it is a
 * second helping of the attack. That is why the error is a distinct class with a stable
 * `name`: the retry classifier keys off it structurally instead of reading the prose,
 * and the prose deliberately avoids the words the transient-transport patterns look for.
 */

/** Which delimiter the peer failed to send. */
export type StreamFrameKind = "line" | "jsonl-record" | "sse-line" | "sse-event";

/**
 * The most bytes one frame may occupy before the reader gives up on it.
 *
 * 64 MiB is far above every legitimate frame this codebase produces or consumes — a
 * JSON-RPC message from an MCP server, one JSONL session record, one provider SSE event
 * carrying inline image data — and far below the point where a peer that never sends a
 * delimiter can exhaust the heap. It is a ceiling on a single frame, not on a stream:
 * a stream of any length is fine as long as its frames end.
 */
export const DEFAULT_MAX_STREAM_FRAME_BYTES = 64 * 1024 * 1024;

/** The `name` every {@link StreamFrameLimitError} carries, for structural classification. */
export const STREAM_FRAME_LIMIT_ERROR_NAME = "StreamFrameLimitError";

const WHAT_WAS_MISSING: Record<StreamFrameKind, string> = {
	line: "a line arrived with no line feed",
	"jsonl-record": "a JSONL record arrived with no line feed",
	"sse-line": "an SSE line arrived with no line feed",
	"sse-event": "an SSE event arrived with no blank-line dispatch",
};

/**
 * A peer exceeded the frame bound. Carries the protocol, what was observed, and what was
 * allowed, so the message a user reads names the fix (raise the bound, or stop trusting
 * the peer) rather than only the symptom.
 */
export class StreamFrameLimitError extends Error {
	readonly frame: StreamFrameKind;
	readonly observedBytes: number;
	readonly allowedBytes: number;

	constructor(frame: StreamFrameKind, observedBytes: number, allowedBytes: number) {
		super(`${WHAT_WAS_MISSING[frame]}: ${observedBytes} bytes exceeded the ${allowedBytes} byte frame limit`);
		this.name = STREAM_FRAME_LIMIT_ERROR_NAME;
		this.frame = frame;
		this.observedBytes = observedBytes;
		this.allowedBytes = allowedBytes;
	}
}

/**
 * Whether an error is a framing violation, following the `cause` chain so a provider that
 * wraps the failure in its own error is still classified by what actually happened.
 */
export function isStreamFrameLimitError(error: unknown): boolean {
	const seen = new Set<object>();
	let link: unknown = error;
	while (typeof link === "object" && link !== null) {
		if (seen.has(link)) return false;
		seen.add(link);
		if ((link as { name?: unknown }).name === STREAM_FRAME_LIMIT_ERROR_NAME) return true;
		link = (link as { cause?: unknown }).cause;
	}
	return false;
}
