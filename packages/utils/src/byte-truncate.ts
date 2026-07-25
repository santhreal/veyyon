/**
 * Byte-accurate text truncation that never splits a UTF-8 sequence.
 *
 * These are the primitives every size cap in the codebase is built on: the
 * per-tool output caps, the streaming tail buffers, and the agent loop's
 * final-defense cap on tool results. They live here rather than next to any one
 * of those callers so there is a single definition of what "cut this text to N
 * bytes" means, and so packages that cannot depend on the coding agent can
 * still use it.
 */

const NL = "\n";

/** Result from byte-level truncation helpers. */
export interface ByteTruncationResult {
	text: string;
	bytes: number;
}

/** Zero-copy view of a Uint8Array as a Buffer (copies only if not already one). */
function asBuffer(data: Uint8Array): Buffer {
	return Buffer.isBuffer(data) ? (data as Buffer) : Buffer.from(data.buffer, data.byteOffset, data.byteLength);
}

/** Advance past UTF-8 continuation bytes (10xxxxxx) to a leading byte. */
function findUtf8BoundaryForward(buf: Buffer, pos: number): number {
	let i = Math.max(0, pos);
	while (i < buf.length && (buf[i] & 0xc0) === 0x80) i++;
	return i;
}

/** Retreat past UTF-8 continuation bytes to land on a leading byte. */
function findUtf8BoundaryBackward(buf: Buffer, cut: number): number {
	let i = Math.min(buf.length, Math.max(0, cut));
	// A cut at end-of-buffer is already a valid boundary.
	if (i >= buf.length) return buf.length;
	while (i > 0 && (buf[i] & 0xc0) === 0x80) i--;
	return i;
}

function truncateBytesWindowed(
	data: string | Uint8Array,
	maxBytes: number,
	mode: "head" | "tail",
): ByteTruncationResult {
	if (maxBytes <= 0) return { text: "", bytes: 0 };

	if (typeof data === "string") {
		// A string of N chars is at least N bytes, so this fast path is only
		// reachable when the input might actually fit.
		if (data.length <= maxBytes) {
			const len = Buffer.byteLength(data, "utf-8");
			if (len <= maxBytes) return { text: data, bytes: len };
			// Multibyte-heavy input: fall through, encoding the whole string.
		}

		// Encoding only the window that can possibly survive keeps this O(maxBytes)
		// rather than O(input) for very large inputs.
		const window =
			mode === "head"
				? data.substring(0, Math.min(data.length, maxBytes))
				: data.substring(Math.max(0, data.length - maxBytes));
		const buf = Buffer.from(window, "utf-8");

		if (mode === "head") {
			const end = findUtf8BoundaryBackward(buf, maxBytes);
			if (end <= 0) return { text: "", bytes: 0 };
			const slice = buf.subarray(0, end);
			return { text: slice.toString("utf-8"), bytes: slice.length };
		}
		const start = findUtf8BoundaryForward(buf, Math.max(0, buf.length - maxBytes));
		const slice = buf.subarray(start);
		return { text: slice.toString("utf-8"), bytes: slice.length };
	}

	const buf = asBuffer(data);
	if (buf.length <= maxBytes) return { text: buf.toString("utf-8"), bytes: buf.length };

	if (mode === "head") {
		const end = findUtf8BoundaryBackward(buf, maxBytes);
		if (end <= 0) return { text: "", bytes: 0 };
		const slice = buf.subarray(0, end);
		return { text: slice.toString("utf-8"), bytes: slice.length };
	}
	const start = findUtf8BoundaryForward(buf, buf.length - maxBytes);
	const slice = buf.subarray(start);
	return { text: slice.toString("utf-8"), bytes: slice.length };
}

/**
 * Truncate to a byte limit keeping the tail, never splitting a UTF-8 sequence.
 */
export function truncateTailBytes(data: string | Uint8Array, maxBytes: number): ByteTruncationResult {
	return truncateBytesWindowed(data, maxBytes, "tail");
}

/**
 * Truncate to a byte limit keeping the head, never splitting a UTF-8 sequence.
 */
export function truncateHeadBytes(data: string | Uint8Array, maxBytes: number): ByteTruncationResult {
	return truncateBytesWindowed(data, maxBytes, "head");
}

/** Drop the partial last line of a head window (keep it if there is no newline). */
function trimHeadToLineBoundary(text: string): string {
	const idx = text.lastIndexOf(NL);
	return idx > 0 ? text.substring(0, idx) : text;
}

/** Drop the partial first line of a tail window (keep it if there is no newline). */
function trimTailToLineBoundary(text: string): string {
	const idx = text.indexOf(NL);
	if (idx < 0 || idx === text.length - 1) return text;
	return text.substring(idx + 1);
}

/** Outcome of {@link capTextBytes}. */
export interface TextByteCapResult {
	/** The capped text. Identical to the input when nothing was elided. */
	text: string;
	/** Byte length of the input before capping. */
	originalBytes: number;
	/** Bytes removed from the middle. `0` when the input already fit. */
	elidedBytes: number;
}

/** Head share of the budget. The rest is tail plus slack for the marker. */
const HEAD_SHARE = 0.6;
/** Tail share of the budget. */
const TAIL_SHARE = 0.25;

/**
 * Cap text to a byte budget by keeping its head and tail and eliding the middle.
 *
 * The middle is where a large output is least informative: the head says what
 * the command was doing and the tail says how it ended. Both windows are cut on
 * line boundaries so the result is still readable, and the marker between them
 * states exactly how many bytes are missing so the elision is never mistaken
 * for the real output.
 *
 * The two windows together claim 85% of the budget. The remaining 15% is slack
 * for the marker and for anything a caller appends afterwards, so the result
 * stays under `maxBytes`.
 *
 * A `maxBytes` of `0` or less means unbounded and returns the input untouched;
 * that is how callers express "no cap" without a separate flag.
 */
export function capTextBytes(text: string, maxBytes: number): TextByteCapResult {
	const originalBytes = Buffer.byteLength(text, "utf-8");
	if (maxBytes <= 0 || originalBytes <= maxBytes) return { text, originalBytes, elidedBytes: 0 };

	const head = trimHeadToLineBoundary(truncateHeadBytes(text, Math.floor(maxBytes * HEAD_SHARE)).text);
	const tail = trimTailToLineBoundary(truncateTailBytes(text, Math.floor(maxBytes * TAIL_SHARE)).text);
	const elidedBytes = Math.max(0, originalBytes - Buffer.byteLength(head, "utf-8") - Buffer.byteLength(tail, "utf-8"));
	return { text: `${head}\n${elisionMarker(elidedBytes)}\n${tail}`, originalBytes, elidedBytes };
}

/**
 * The marker {@link capTextBytes} writes between the kept windows.
 *
 * Exported so callers can recognise their own elisions without pattern-matching
 * a string literal they would have to keep in sync.
 */
export function elisionMarker(elidedBytes: number): string {
	return `[…${elidedBytes}B elided…]`;
}
