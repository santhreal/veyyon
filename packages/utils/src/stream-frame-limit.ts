export type StreamFrameKind = "line" | "jsonl-record" | "sse-line" | "sse-event";

export const DEFAULT_MAX_STREAM_FRAME_BYTES = 64 * 1024 * 1024;

export const STREAM_FRAME_LIMIT_ERROR_NAME = "StreamFrameLimitError";

const WHAT_WAS_MISSING: Record<StreamFrameKind, string> = {
	line: "a line arrived with no line feed",
	"jsonl-record": "a JSONL record arrived with no line feed",
	"sse-line": "an SSE line arrived with no line feed",
	"sse-event": "an SSE event arrived with no blank-line dispatch",
};

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
