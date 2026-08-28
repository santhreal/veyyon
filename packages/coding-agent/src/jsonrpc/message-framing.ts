/** Shared Content-Length message framing for the JSON byte streams spoken by the LSP and DAP stdio clients. Both protocols use the same base-protocol framing: */

// Reused for all full (non-streaming) decodes; each decode() resets state, so a
// single instance is safe and avoids per-message TextDecoder allocation.
const MESSAGE_DECODER = new TextDecoder("utf-8");

/** Locate the `\r\n\r\n` header terminator across the pending chunk list. Returns the absolute byte index of the first `\r`, or -1 when not present. */
function findHeaderEndInChunks(chunks: Buffer[]): number {
	let global = 0;
	let b0 = -1;
	let b1 = -1;
	let b2 = -1;
	for (const chunk of chunks) {
		for (let i = 0; i < chunk.length; i++) {
			const b3 = chunk[i];
			if (b0 === 13 && b1 === 10 && b2 === 13 && b3 === 10) {
				return global - 3;
			}
			b0 = b1;
			b1 = b2;
			b2 = b3;
			global++;
		}
	}
	return -1;
}

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

/** The `Content-Length` of a header block, or `undefined` when the block states none, states a malformed one, or states two that disagree. */
function parseContentLength(headerText: string): number | undefined {
	let found: number | undefined;
	for (const line of headerText.split(/\r?\n/)) {
		const separator = line.indexOf(":");
		if (separator === -1) continue;
		if (line.slice(0, separator).trim().toLowerCase() !== "content-length") continue;
		const value = line.slice(separator + 1).trim();
		if (!/^\d+$/.test(value)) return undefined;
		const parsed = Number.parseInt(value, 10);
		if (!Number.isSafeInteger(parsed)) return undefined;
		// Two lengths that disagree leave the frame boundary ambiguous, and
		// picking either one mis-frames every message after it. Resync instead.
		if (found !== undefined && found !== parsed) return undefined;
		found = parsed;
	}
	return found;
}

/** Incremental Content-Length frame decoder for a JSON message byte stream. Incoming bytes are buffered as a list of chunks and only joined when a full */
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

	/** Yield the JSON text of every complete message currently buffered. A header block that states no usable `Content-Length` is non-protocol noise (e.g. a */
	*drain(onResync: (headerText: string) => void): Generator<string> {
		while (true) {
			const headerEnd = findHeaderEndInChunks(this.#pendingChunks);
			if (headerEnd === -1) break;

			const headerText = MESSAGE_DECODER.decode(copyChunkRange(this.#pendingChunks, 0, headerEnd));
			const contentLength = parseContentLength(headerText);
			if (contentLength === undefined) {
				onResync(headerText);
				dropChunkFront(this.#pendingChunks, headerEnd + 4);
				this.#pendingLen -= headerEnd + 4;
				continue;
			}

			const messageStart = headerEnd + 4; // Skip \r\n\r\n
			const messageEnd = messageStart + contentLength;
			if (this.#pendingLen < messageEnd) break;

			const messageText = MESSAGE_DECODER.decode(copyChunkRange(this.#pendingChunks, messageStart, messageEnd));
			dropChunkFront(this.#pendingChunks, messageEnd);
			this.#pendingLen -= messageEnd;
			yield messageText;
		}
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
