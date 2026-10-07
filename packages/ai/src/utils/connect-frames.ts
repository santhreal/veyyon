/**
 * Connect streaming framing, shared by every provider that speaks it.
 *
 * A frame is one flag byte, a four-byte big-endian payload length, and the payload. Flag bit
 * {@link CONNECT_COMPRESSED_FLAG} marks a gzip payload; bit {@link CONNECT_END_STREAM_FLAG} marks the
 * end-of-stream JSON trailers rather than a message.
 */

export const CONNECT_COMPRESSED_FLAG = 0x01;
export const CONNECT_END_STREAM_FLAG = 0x02;

/**
 * Hard upper bound on a single Connect frame payload. The four-byte length prefix is otherwise
 * peer-controlled (up to `2**32 - 1`), so a corrupt or hostile prefix fails at its header instead of
 * buffering until memory runs out or an idle timeout fires.
 */
export const MAX_CONNECT_FRAME_PAYLOAD = 16 * 1024 * 1024;

const HEADER_BYTES = 5;

export function frameConnectMessage(data: Uint8Array, flags = 0): Buffer {
	const frame = Buffer.alloc(HEADER_BYTES + data.length);
	frame[0] = flags;
	frame.writeUInt32BE(data.length, 1);
	frame.set(data, HEADER_BYTES);
	return frame;
}

/** What {@link ConnectFrameReader.next} found at the head of the buffered bytes. */
export type ConnectRead =
	| { kind: "frame"; flags: number; payload: Buffer }
	/** A header whose declared length exceeds {@link MAX_CONNECT_FRAME_PAYLOAD}. Nothing is consumed. */
	| { kind: "oversized"; length: number };

/**
 * Splits Connect frames out of a byte stream that arrives in reads of any size.
 *
 * Reads are held as a list, not joined into one growing buffer: a frame inside one read is a view
 * of that read, and a frame that straddles reads is copied once, when its last byte arrives. A
 * growing buffer copies everything it holds on every read, which is quadratic in the reads one
 * large frame spans.
 */
export class ConnectFrameReader {
	#chunks: Buffer[] = [];
	/** Index of the first chunk holding an unread byte. */
	#first = 0;
	/** Offset of the first unread byte in `#chunks[#first]`. */
	#offset = 0;
	#buffered = 0;

	push(chunk: Uint8Array): void {
		if (chunk.length === 0) return;
		// Drop the chunks a frame already consumed, so a stream that always holds a partial frame
		// does not keep every earlier read alive behind it.
		if (this.#first > 0) {
			this.#chunks.splice(0, this.#first);
			this.#first = 0;
		}
		this.#chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength));
		this.#buffered += chunk.length;
	}

	/** The frame at the head of the buffered bytes, or `undefined` until all of it has arrived. */
	next(): ConnectRead | undefined {
		if (this.#buffered < HEADER_BYTES) return undefined;
		const head = this.#chunks[this.#first] as Buffer;
		const header = head.length - this.#offset >= HEADER_BYTES ? head : this.#gather(HEADER_BYTES);
		const at = header === head ? this.#offset : 0;
		const flags = header[at] as number;
		const length = header.readUInt32BE(at + 1);
		if (length > MAX_CONNECT_FRAME_PAYLOAD) return { kind: "oversized", length };
		if (this.#buffered < HEADER_BYTES + length) return undefined;
		this.#consume(HEADER_BYTES);
		return { kind: "frame", flags, payload: this.#take(length) };
	}

	/** Copies the next `count` buffered bytes without consuming them. */
	#gather(count: number): Buffer {
		const out = Buffer.allocUnsafe(count);
		let written = 0;
		let offset = this.#offset;
		for (let i = this.#first; written < count; i++) {
			const chunk = this.#chunks[i] as Buffer;
			written += chunk.copy(out, written, offset, Math.min(chunk.length, offset + count - written));
			offset = 0;
		}
		return out;
	}

	/** Consumes the next `count` bytes, copying them into `out` when one is given. */
	#consume(count: number, out?: Buffer): void {
		let done = 0;
		while (done < count) {
			const chunk = this.#chunks[this.#first] as Buffer;
			const step = Math.min(count - done, chunk.length - this.#offset);
			if (out) chunk.copy(out, done, this.#offset, this.#offset + step);
			done += step;
			this.#advance(chunk, step);
		}
	}

	/** Consumes the next `count` bytes: a view when one chunk holds them, else one copy. */
	#take(count: number): Buffer {
		const head = this.#chunks[this.#first];
		if (head === undefined) return Buffer.alloc(0);
		if (head.length - this.#offset >= count) {
			const view = head.subarray(this.#offset, this.#offset + count);
			this.#advance(head, count);
			return view;
		}
		const out = Buffer.allocUnsafe(count);
		this.#consume(count, out);
		return out;
	}

	#advance(chunk: Buffer, count: number): void {
		this.#offset += count;
		this.#buffered -= count;
		if (this.#offset < chunk.length) return;
		this.#offset = 0;
		this.#first++;
		if (this.#first === this.#chunks.length) {
			this.#chunks = [];
			this.#first = 0;
		}
	}
}
