/**
 * Lazily format a stream of UTF-8 bytes into hashline-numbered lines, yielded
 * as bounded text chunks. Used to send `read`-style file content to consumers
 * without materializing the full file at once.
 *
 * Each yielded chunk is at most {@link StreamOptions.maxChunkLines} lines and
 * at most {@link StreamOptions.maxChunkBytes} UTF-8 bytes (whichever fires
 * first).
 */
import { formatNumberedLine } from "./format";
import type { StreamOptions } from "./types";

interface ResolvedStreamOptions {
	startLine: number;
	maxChunkLines: number;
	maxChunkBytes: number;
}

function resolveStreamOptions(options: StreamOptions): ResolvedStreamOptions {
	return {
		startLine: options.startLine ?? 1,
		maxChunkLines: options.maxChunkLines ?? 200,
		maxChunkBytes: options.maxChunkBytes ?? 64 * 1024,
	};
}

/** Returned by {@link ChunkEmitter.pushLine} when a line completes no chunk, so the common case allocates nothing. */
const NO_CHUNKS: readonly string[] = [];

/** Buffers numbered lines into chunks bounded by a line count and a UTF-8 byte count. */
class ChunkEmitter {
	#lineNumber: number;
	readonly #lines: string[] = [];
	#bytes = 0;
	readonly #maxLines: number;
	readonly #maxBytes: number;

	constructor(options: ResolvedStreamOptions) {
		this.#lineNumber = options.startLine;
		this.#maxLines = options.maxChunkLines;
		this.#maxBytes = options.maxChunkBytes;
	}

	/** The buffered chunk, emptying the buffer, or `undefined` when nothing is buffered. */
	flush(): string | undefined {
		if (this.#lines.length === 0) return undefined;
		const chunk = this.#lines.join("\n");
		this.#lines.length = 0;
		this.#bytes = 0;
		return chunk;
	}

	/**
	 * Number and buffer `text[start, end)` with one trailing `\r` dropped, and
	 * return the chunks it completed in order: the buffer it would overflow,
	 * then the buffer it fills to a bound.
	 */
	pushLine(text: string, start: number, end: number): readonly string[] {
		const lineEnd = end > start && text.charCodeAt(end - 1) === 0x0d ? end - 1 : end;
		const formatted = formatNumberedLine(this.#lineNumber++, text.slice(start, lineEnd));
		const lineBytes = Buffer.byteLength(formatted, "utf-8");
		const overflowed =
			this.#lines.length >= this.#maxLines || this.#bytes + 1 + lineBytes > this.#maxBytes
				? this.flush()
				: undefined;
		this.#bytes += (this.#lines.length === 0 ? 0 : 1) + lineBytes;
		this.#lines.push(formatted);
		const filled = this.#lines.length >= this.#maxLines || this.#bytes >= this.#maxBytes ? this.flush() : undefined;
		if (overflowed === undefined) return filled === undefined ? NO_CHUNKS : [filled];
		return filled === undefined ? [overflowed] : [overflowed, filled];
	}
}

function isReadableStream(value: unknown): value is ReadableStream<Uint8Array> {
	return (
		typeof value === "object" &&
		value !== null &&
		"getReader" in value &&
		typeof (value as { getReader?: unknown }).getReader === "function"
	);
}

async function* bytesFromReadableStream(stream: ReadableStream<Uint8Array>): AsyncGenerator<Uint8Array> {
	const reader = stream.getReader();
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) return;
			if (value) yield value;
		}
	} finally {
		reader.releaseLock();
	}
}

export async function* streamHashLines(
	source: ReadableStream<Uint8Array> | AsyncIterable<Uint8Array>,
	options: StreamOptions = {},
): AsyncGenerator<string> {
	const resolved = resolveStreamOptions(options);
	const decoder = new TextDecoder("utf-8");
	const chunks = isReadableStream(source) ? bytesFromReadableStream(source) : source;
	const emitter = new ChunkEmitter(resolved);

	let pending = "";
	let sawAnyLine = false;

	for await (const chunk of chunks) {
		pending += decoder.decode(chunk, { stream: true });
		let start = 0;
		for (let nl = pending.indexOf("\n"); nl !== -1; nl = pending.indexOf("\n", start)) {
			sawAnyLine = true;
			for (const out of emitter.pushLine(pending, start, nl)) yield out;
			start = nl + 1;
		}
		pending = pending.slice(start);
	}

	pending += decoder.decode();
	// The unterminated last line, or the one empty line of an empty source.
	if (pending.length > 0 || !sawAnyLine) {
		for (const out of emitter.pushLine(pending, 0, pending.length)) yield out;
	}

	const last = emitter.flush();
	if (last) yield last;
}
