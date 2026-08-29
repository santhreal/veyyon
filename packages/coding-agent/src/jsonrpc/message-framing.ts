const MESSAGE_DECODER = new TextDecoder("utf-8");

import { copyChunkRange, dropChunkFront, findHeaderEndInChunks, parseContentLength } from "./message-framing-helpers";

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
