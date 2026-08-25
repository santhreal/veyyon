/**
 * Shared Content-Length message framing for the JSON byte streams spoken by the
 * LSP and DAP stdio clients. Both protocols use the same base-protocol framing:
 * each message is a `Content-Length: <n>\r\n\r\n` header block followed by `<n>`
 * bytes of UTF-8 JSON. This module owns the incremental decode so the two
 * clients don't each reimplement chunk accumulation, header scanning, and the
 * mid-message remainder handoff.
 */

// Reused for all full (non-streaming) decodes; each decode() resets state, so a
// single instance is safe and avoids per-message TextDecoder allocation.
const MESSAGE_DECODER = new TextDecoder("utf-8");

/** Where a header block ends: the index of the terminator's first byte, and its length. */
interface HeaderEnd {
	index: number;
	sepLen: number;
}

/**
 * Locate the header terminator across the pending chunk list.
 *
 * The base protocol writes `\r\n\r\n`, and a CR-less `\n\n` is what a hand-rolled adapter and
 * every Unix tool that prints a header block emit. Accepting only the four-byte form meant an
 * LF-only header never framed at all: `drain` yielded nothing, the bytes stayed in the remainder,
 * and the reader waited out the adapter timeout and reported a hung initialize rather than a
 * framing error. The two forms cannot collide, because `\r\n\r\n` holds no two adjacent LFs.
 */
function findHeaderEndInChunks(chunks: Buffer[]): HeaderEnd | undefined {
	let global = 0;
	let b0 = -1;
	let b1 = -1;
	let b2 = -1;
	for (const chunk of chunks) {
		for (let i = 0; i < chunk.length; i++) {
			const b3 = chunk[i];
			if (b2 === 10 && b3 === 10) {
				return { index: global - 1, sepLen: 2 };
			}
			if (b0 === 13 && b1 === 10 && b2 === 13 && b3 === 10) {
				return { index: global - 3, sepLen: 4 };
			}
			b0 = b1;
			b1 = b2;
			b2 = b3;
			global++;
		}
	}
	return undefined;
}

/** Every `Content-Length` header in a decoded header block, in the order the sender wrote them. */
const CONTENT_LENGTH_HEADER = /content-length:[ \t]*([^\r\n]*)/gi;

/** Copy the byte range [from, to) out of the pending chunk list into one Buffer. */
function copyChunkRange(chunks: Buffer[], from: number, to: number): Buffer {
	const out = Buffer.allocUnsafe(to - from);
	let global = 0;
	let written = 0;
	for (const chunk of chunks) {
		const chunkEnd = global + chunk.length;
		if (chunkEnd > from && global < to) {
			const start = Math.max(from, global) - global;
			const end = Math.min(to, chunkEnd) - global;
			chunk.copy(out, written, start, end);
			written += end - start;
		}
		global = chunkEnd;
		if (global >= to) break;
	}
	return out;
}

/** Drop the first `count` bytes from the pending chunk list in place. */
function dropChunkFront(chunks: Buffer[], count: number): void {
	let removed = 0;
	while (chunks.length > 0) {
		const head = chunks[0];
		if (removed + head.length <= count) {
			removed += head.length;
			chunks.shift();
		} else {
			chunks[0] = head.subarray(count - removed);
			break;
		}
	}
}

/**
 * Incremental Content-Length frame decoder for a JSON message byte stream.
 *
 * Incoming bytes are buffered as a list of chunks and only joined when a full
 * message is framed — concatenating the accumulator on every read is O(n^2) for
 * messages that span many reads (e.g. a large initial diagnostics burst). Feed
 * raw chunks with {@link push}, pull every complete message with {@link drain},
 * and persist {@link remainder} when the reader stops so a restarted reader
 * resumes mid-message.
 */
export class MessageFramer {
	readonly #pendingChunks: Buffer[] = [];
	#pendingLen = 0;

	/** Seed the buffer with any unparsed remainder left by a previous reader. */
	constructor(seed: Buffer) {
		if (seed.length > 0) {
			this.#pendingChunks.push(seed);
			this.#pendingLen = seed.length;
		}
	}

	/** Append a freshly read chunk to the pending buffer. */
	push(chunk: Buffer): void {
		this.#pendingChunks.push(chunk);
		this.#pendingLen += chunk.length;
	}

	/**
	 * Yield the JSON text of every complete message currently buffered. A header
	 * block without a `Content-Length` is non-protocol noise (e.g. a server
	 * printing to stdout); `onResync` is invoked with the offending header text
	 * and the framer drops past the bogus terminator to recover instead of
	 * stalling on the same junk header forever.
	 */
	*drain(onResync: (headerText: string) => void): Generator<string> {
		while (true) {
			const header = findHeaderEndInChunks(this.#pendingChunks);
			if (!header) break;

			const headerText = MESSAGE_DECODER.decode(copyChunkRange(this.#pendingChunks, 0, header.index));
			const bodyStart = header.index + header.sepLen;
			// Last write wins. A proxy that prepends its own `Content-Length: 0` used to frame a
			// zero-length body and hand the real payload to the next scan as junk.
			CONTENT_LENGTH_HEADER.lastIndex = 0;
			let rawLength: string | undefined;
			for (const match of headerText.matchAll(CONTENT_LENGTH_HEADER)) rawLength = match[1].trim();

			if (rawLength === undefined) {
				onResync(headerText);
				dropChunkFront(this.#pendingChunks, bodyStart);
				this.#pendingLen -= bodyStart;
				continue;
			}

			if (!/^\d+$/.test(rawLength)) {
				// `-1` and `0x5` are not lengths. The old matcher captured the digits inside them,
				// so `0x5` framed an empty body and `-1` read as a header with no length at all;
				// either way the bytes that followed were re-scanned as a header and a real frame
				// behind them was consumed as junk. There is no body length to trust here, so this
				// block is not a frame: resynchronize on the next `Content-Length` in the buffer,
				// and if there is none, keep the bytes and wait for more rather than guess.
				const next = this.#findNextHeaderName(bodyStart);
				if (next === -1) break;
				dropChunkFront(this.#pendingChunks, next);
				this.#pendingLen -= next;
				continue;
			}

			const contentLength = Number.parseInt(rawLength, 10);
			const messageEnd = bodyStart + contentLength;
			if (this.#pendingLen < messageEnd) break;

			const messageText = MESSAGE_DECODER.decode(copyChunkRange(this.#pendingChunks, bodyStart, messageEnd));
			dropChunkFront(this.#pendingChunks, messageEnd);
			this.#pendingLen -= messageEnd;
			yield messageText;
		}
	}

	/**
	 * Absolute index of the next `Content-Length:` header name at or after `from`, or -1.
	 *
	 * Copies the tail once. This runs only after a malformed length, which a conforming sender
	 * never produces, so the common path allocates nothing.
	 */
	#findNextHeaderName(from: number): number {
		if (from >= this.#pendingLen) return -1;
		const tail = copyChunkRange(this.#pendingChunks, from, this.#pendingLen);
		// Header names are ASCII, so a latin1 decode is a byte view and never reinterprets a
		// multi-byte body sequence as a match.
		const at = tail.toString("latin1").toLowerCase().indexOf("content-length:");
		return at === -1 ? -1 : from + at;
	}

	/** The unparsed remainder, to persist when the reader stops. */
	remainder(): Buffer {
		return this.#pendingChunks.length === 0
			? Buffer.alloc(0)
			: this.#pendingChunks.length === 1
				? this.#pendingChunks[0]
				: Buffer.concat(this.#pendingChunks, this.#pendingLen);
	}
}
