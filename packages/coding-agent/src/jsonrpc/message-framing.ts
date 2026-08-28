const MESSAGE_DECODER = new TextDecoder("utf-8");

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
		if (found !== undefined && found !== parsed) return undefined;
		found = parsed;
	}
	return found;
}

export class MessageFramer {
	readonly #pendingChunks: Buffer[] = [];
	#pendingLen = 0;

	constructor(seed: Buffer) {
		if (seed.length > 0) {
			this.#pendingChunks.push(seed);
			this.#pendingLen = seed.length;
		}
	}

	push(chunk: Buffer): void {
		this.#pendingChunks.push(chunk);
		this.#pendingLen += chunk.length;
	}

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

	remainder(): Buffer {
		return this.#pendingChunks.length === 0
			? Buffer.alloc(0)
			: this.#pendingChunks.length === 1
				? this.#pendingChunks[0]
				: Buffer.concat(this.#pendingChunks, this.#pendingLen);
	}
}
