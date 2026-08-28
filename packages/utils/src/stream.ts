const trailingEvents = new WeakSet<ServerSentEvent>();

import { abortableSource } from "./abortable";
import { parseStreamingJson } from "./json-parse";
import type { JsonlSkip } from "./jsonl-incremental";
import { DEFAULT_MAX_STREAM_FRAME_BYTES, type StreamFrameKind, StreamFrameLimitError } from "./stream-frame-limit";

const LF = 0x0a;

export interface StreamFrameLimits {
	maxFrameBytes?: number;
	maxEventBytes?: number;
}

export const STREAM_FRAME_MAX_BYTES_ENV = "VEYYON_STREAM_FRAME_MAX_BYTES";

function envCeiling(): number {
	const raw = process.env[STREAM_FRAME_MAX_BYTES_ENV];
	if (raw === undefined) return DEFAULT_MAX_STREAM_FRAME_BYTES;
	const parsed = Number(raw.trim());
	return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_STREAM_FRAME_BYTES;
}

export function streamFrameCeiling(limits?: StreamFrameLimits): number {
	const declared = limits?.maxFrameBytes;
	return declared !== undefined && declared > 0 ? declared : envCeiling();
}

export function streamEventCeiling(limits?: StreamFrameLimits): number {
	const declared = limits?.maxEventBytes;
	return declared !== undefined && declared > 0 ? declared : streamFrameCeiling(limits);
}

type JsonlChunkResult = {
	values: unknown[];
	error: unknown;
	read: number;
	done: boolean;
};

function parseJsonlChunkCompat(input: Uint8Array, beg?: number, end?: number): JsonlChunkResult;
function parseJsonlChunkCompat(input: string): JsonlChunkResult;
function parseJsonlChunkCompat(input: Uint8Array | string, beg?: number, end?: number): JsonlChunkResult {
	if (typeof input === "string") {
		const { values, error, read, done } = Bun.JSONL.parseChunk(input);
		return { values, error, read, done };
	}
	const start = beg ?? 0;
	const stop = end ?? input.length;
	const { values, error, read, done } = Bun.JSONL.parseChunk(input, start, stop);
	return { values, error, read, done };
}

export async function* readLines(
	stream: ReadableStream<Uint8Array>,
	signal?: AbortSignal,
	limits?: StreamFrameLimits,
): AsyncGenerator<Uint8Array> {
	const buffer = new ConcatSink(streamFrameCeiling(limits), "line");
	const source = abortableSource(stream, signal);
	try {
		for await (const chunk of source) {
			for (const line of buffer.appendAndFlushLines(chunk)) {
				yield line;
			}
		}
		if (!buffer.isEmpty) {
			const tail = buffer.flush();
			if (tail) {
				buffer.clear();
				yield tail;
			}
		}
	} catch (err) {
		if (signal?.aborted) return;
		throw err;
	}
}

export async function* readJsonl<T>(
	stream: ReadableStream<Uint8Array>,
	signal?: AbortSignal,
	limits?: StreamFrameLimits,
): AsyncGenerator<T> {
	const buffer = new ConcatSink(streamFrameCeiling(limits), "jsonl-record");
	const source = abortableSource(stream, signal);
	try {
		for await (const chunk of source) {
			yield* buffer.pullJSONL<T>(chunk, 0, chunk.length);
		}
		if (!buffer.isEmpty) {
			const tail = buffer.flush();
			if (tail) {
				buffer.clear();
				const { values, error, done } = parseJsonlChunkCompat(tail, 0, tail.length);
				if (values.length > 0) {
					yield* values as T[];
				}
				if (error) throw error;
				if (!done) {
					throw new Error("JSONL stream ended unexpectedly");
				}
			}
		}
	} catch (err) {
		if (signal?.aborted) return;
		throw err;
	}
}

class ConcatSink {
	#space?: Buffer;
	#length = 0;
	readonly #limit: number;
	readonly #frame: StreamFrameKind;

	constructor(limit: number, frame: StreamFrameKind) {
		this.#limit = limit;
		this.#frame = frame;
	}

	#guard(size: number): void {
		if (size > this.#limit) throw new StreamFrameLimitError(this.#frame, size, this.#limit);
	}

	#ensureCapacity(size: number): Buffer {
		const space = this.#space;
		if (space && space.length >= size) return space;
		const nextSize = space ? Math.max(size, space.length * 2) : size;
		const next = Buffer.allocUnsafe(nextSize);
		if (space && this.#length > 0) {
			space.copy(next, 0, 0, this.#length);
		}
		this.#space = next;
		return next;
	}

	append(chunk: Uint8Array) {
		const n = chunk.length;
		if (!n) return;
		const offset = this.#length;
		this.#guard(offset + n);
		const space = this.#ensureCapacity(offset + n);
		space.set(chunk, offset);
		this.#length += n;
	}

	reset(chunk: Uint8Array) {
		const n = chunk.length;
		if (!n) {
			this.#length = 0;
			return;
		}
		this.#guard(n);
		const space = this.#ensureCapacity(n);
		space.set(chunk, 0);
		this.#length = n;
	}

	get isEmpty(): boolean {
		return this.#length === 0;
	}

	flush(): Uint8Array | undefined {
		if (!this.#length) return undefined;
		return this.#space!.subarray(0, this.#length);
	}

	clear() {
		this.#length = 0;
	}

	*appendAndFlushLines(chunk: Uint8Array) {
		let pos = 0;
		while (pos < chunk.length) {
			const nl = chunk.indexOf(LF, pos);
			if (nl === -1) {
				this.append(chunk.subarray(pos));
				return;
			}
			const suffix = chunk.subarray(pos, nl);
			pos = nl + 1;
			if (this.isEmpty) {
				this.#guard(suffix.length);
				yield suffix;
			} else {
				this.append(suffix);
				const payload = this.flush();
				if (payload) {
					yield payload;
					this.clear();
				}
			}
		}
	}
	*pullJSONL<T>(chunk: Uint8Array, beg: number, end: number) {
		if (this.isEmpty) {
			const { values, error, read, done } = parseJsonlChunkCompat(chunk, beg, end);
			if (values.length > 0) {
				yield* values as T[];
			}
			if (error) throw error;
			if (done) return;
			this.reset(chunk.subarray(read, end));
			return;
		}

		const offset = this.#length;
		const n = end - beg;
		const total = offset + n;
		this.#guard(total);
		const space = this.#ensureCapacity(total);
		space.set(chunk.subarray(beg, end), offset);
		this.#length = total;

		const { values, error, read, done } = parseJsonlChunkCompat(space.subarray(0, total), 0, total);
		if (values.length > 0) {
			yield* values as T[];
		}
		if (error) throw error;
		if (done) {
			this.#length = 0;
			return;
		}
		const rem = total - read;
		if (rem < total) {
			space.copyWithin(0, read, total);
		}
		this.#length = rem;
	}
}

export type SseEventObserver = (event: ServerSentEvent) => void;

function notifySseEventObserver(observer: SseEventObserver | undefined, event: ServerSentEvent): void {
	if (!observer) return;
	try {
		observer(event);
	} catch {}
}

function isRecoverableTrailingJson(data: string): boolean {
	const first = data.trimStart()[0];
	if (first !== "{" && first !== "[") return false;
	const recovered = parseStreamingJson<unknown>(data);
	return typeof recovered === "object" && recovered !== null;
}

export async function* readSseJson<T>(
	stream: ReadableStream<Uint8Array>,
	signal?: AbortSignal,
	onEvent?: SseEventObserver,
	limits?: StreamFrameLimits,
): AsyncGenerator<T> {
	for await (const sse of readSseEvents(stream, signal, limits)) {
		const isTrailing = trailingEvents.has(sse);
		notifySseEventObserver(onEvent, sse);
		const data = sse.data;
		if (data === "" || data === "[DONE]") {
			if (data === "[DONE]") return;
			continue;
		}
		try {
			yield JSON.parse(data) as T;
		} catch (err) {
			if (err instanceof SyntaxError && isTrailing && isRecoverableTrailingJson(data)) {
				return;
			}
			throw err;
		}
	}
}

export interface ServerSentEvent {
	event: string | null;
	data: string;
	raw: string[];
}

interface SseEventState {
	event: string | null;
	data: string | null;
	raw: string[];
	bytes: number;
}

const SSE_LINE_DECODER = new TextDecoder("utf-8");

function decodeSseLineBytes(line: Uint8Array, end: number): string {
	return end === line.length ? SSE_LINE_DECODER.decode(line) : SSE_LINE_DECODER.decode(line.subarray(0, end));
}

function flushSseEvent(state: SseEventState): ServerSentEvent | null {
	state.bytes = 0;
	if (state.event === null && state.data === null) {
		state.raw = [];
		return null;
	}
	const event: ServerSentEvent = {
		event: state.event,
		data: state.data ?? "",
		raw: state.raw,
	};
	state.event = null;
	state.data = null;
	state.raw = [];
	return event;
}

function pushSseLine(line: Uint8Array, state: SseEventState, maxEventBytes: number): ServerSentEvent | null {
	let end = line.length;
	if (end > 0 && line[end - 1] === 0x0d /* '\r' */) end--;
	if (end === 0) return flushSseEvent(state);

	state.bytes += line.length + 1;
	if (state.bytes > maxEventBytes) throw new StreamFrameLimitError("sse-event", state.bytes, maxEventBytes);

	if (line[0] === 0x3a /* ':' */) {
		state.raw.push(decodeSseLineBytes(line, end));
		return null;
	}

	const text = decodeSseLineBytes(line, end);
	state.raw.push(text);

	const colon = text.indexOf(":");
	if (colon === -1) {
		if (text === "data") {
			if (state.data === null) state.data = "";
			else state.data += "\n";
		} else if (text === "event") {
			state.event = "";
		}
		return null;
	}

	const valueStart = text.charCodeAt(colon + 1) === 0x20 ? colon + 2 : colon + 1;
	const value = text.slice(valueStart);

	if (
		colon === 4 &&
		text.charCodeAt(0) === 0x64 /* d */ &&
		text.charCodeAt(1) === 0x61 /* a */ &&
		text.charCodeAt(2) === 0x74 /* t */ &&
		text.charCodeAt(3) === 0x61 /* a */
	) {
		if (state.data === null) {
			state.data = value;
		} else {
			state.data += "\n";
			state.data += value;
		}
	} else if (
		colon === 5 &&
		text.charCodeAt(0) === 0x65 /* e */ &&
		text.charCodeAt(1) === 0x76 /* v */ &&
		text.charCodeAt(2) === 0x65 /* e */ &&
		text.charCodeAt(3) === 0x6e /* n */ &&
		text.charCodeAt(4) === 0x74 /* t */
	) {
		state.event = value;
	}
	return null;
}

export async function* readSseEvents(
	stream: ReadableStream<Uint8Array>,
	signal?: AbortSignal,
	limits?: StreamFrameLimits,
): AsyncGenerator<ServerSentEvent> {
	const lineBuffer = new ConcatSink(streamFrameCeiling(limits), "sse-line");
	const maxEventBytes = streamEventCeiling(limits);
	const state: SseEventState = { event: null, data: null, raw: [], bytes: 0 };
	const source = abortableSource(stream, signal);
	try {
		for await (const chunk of source) {
			for (const line of lineBuffer.appendAndFlushLines(chunk)) {
				const event = pushSseLine(line, state, maxEventBytes);
				if (event) yield event;
			}
		}
		if (!lineBuffer.isEmpty) {
			const tail = lineBuffer.flush();
			if (tail) {
				lineBuffer.clear();
				const event = pushSseLine(tail, state, maxEventBytes);
				if (event) {
					trailingEvents.add(event);
					yield event;
				}
			}
		}
		const trailing = flushSseEvent(state);
		if (trailing) {
			trailingEvents.add(trailing);
			yield trailing;
		}
	} catch (err) {
		if (signal?.aborted) return;
		throw err;
	}
}

export type { JsonlSkip } from "./jsonl-incremental";
export * from "./stream-frame-limit";

export interface ParseJsonlLenientOptions {
	onSkip?: (skip: JsonlSkip) => void;
}

export function parseJsonlLenient<T>(buffer: string, options?: ParseJsonlLenientOptions): T[] {
	let entries: T[] | undefined;
	let consumed = 0;

	while (buffer.length > 0) {
		const { values, error, read, done } = parseJsonlChunkCompat(buffer);
		if (values.length > 0) {
			const ext = values as T[];
			if (!entries) {
				entries = ext;
			} else {
				for (let ei = 0; ei < ext.length; ei++) entries.push(ext[ei]!);
			}
		}
		if (error) {
			const isHeadError = read === 0;
			const nextNewline = buffer.indexOf("\n", read);
			if (nextNewline === -1) {
				if (isHeadError) options?.onSkip?.({ offset: consumed, snippet: buffer.slice(0, 200) });
				break;
			}
			if (isHeadError) {
				options?.onSkip?.({ offset: consumed, snippet: buffer.slice(0, Math.min(nextNewline, 200)) });
			}
			const step = nextNewline + 1;
			consumed += step;
			buffer = buffer.substring(step);
			continue;
		}
		if (read === 0) break;
		consumed += read;
		buffer = buffer.substring(read);
		if (done) break;
	}
	return entries ?? [];
}

export async function readPipeText(stream: ReadableStream<Uint8Array> | null): Promise<string> {
	if (!stream) return "";
	return await new Response(stream).text();
}
