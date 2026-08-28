const trailingEvents = new WeakSet<ServerSentEvent>();

import { abortableSource } from "./abortable";
import { parseStreamingJson } from "./json-parse";
import type { JsonlSkip } from "./jsonl-incremental";
import { DEFAULT_MAX_STREAM_FRAME_BYTES, type StreamFrameKind, StreamFrameLimitError } from "./stream-frame-limit";

const LF = 0x0a;

/**
 * How many bytes one frame may occupy before the reader stops trusting the peer.
 *
 * A reader with no bound is a reader that hands a hostile peer the heap: an SSE event
 * with no blank line, a JSON-RPC message with no newline, and a `data:` field repeated
 * forever all grow one buffer until the process dies, while the connection looks alive.
 * Every reader here bounds the frame it is assembling and stops reading the source the
 * moment the bound is crossed.
 */
export interface StreamFrameLimits {
	/** Bytes allowed in one line or record before its delimiter. Defaults to 64 MiB. */
	maxFrameBytes?: number;
	/** Bytes allowed in one SSE event before its blank-line dispatch. Defaults to `maxFrameBytes`. */
	maxEventBytes?: number;
}

/** Environment override for the default frame bound, in bytes. */
export const STREAM_FRAME_MAX_BYTES_ENV = "VEYYON_STREAM_FRAME_MAX_BYTES";

/**
 * The default bound, after the environment has had its say.
 *
 * A caller that knows its protocol passes a limit; everything else — a provider stream, an
 * MCP server's stdout, a session file — takes this one, and 64 MiB is the only number
 * anyone would want to change from outside. A value that is not a positive integer falls
 * back to the compiled default rather than to no bound, so a typo in the knob cannot undo
 * the protection the knob exists to tune.
 */
function envCeiling(): number {
	const raw = process.env[STREAM_FRAME_MAX_BYTES_ENV];
	if (raw === undefined) return DEFAULT_MAX_STREAM_FRAME_BYTES;
	const parsed = Number(raw.trim());
	return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_STREAM_FRAME_BYTES;
}

/**
 * The frame bound a reader would use for these limits: the caller's number when it declared
 * a usable one, otherwise the environment's, otherwise the compiled default. Exported so
 * the policy can be asserted for what it is, rather than inferred from how much a reader
 * happened to swallow.
 */
export function streamFrameCeiling(limits?: StreamFrameLimits): number {
	const declared = limits?.maxFrameBytes;
	return declared !== undefined && declared > 0 ? declared : envCeiling();
}

/** The bound on one SSE event: its own declared number, else whatever bounds a frame. */
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
		// Abort errors are expected — just stop the generator.
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
		// Abort errors are expected — just stop the generator.
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

	/**
	 * Refuse a frame the peer never delimited.
	 *
	 * Called before the allocation, so the buffer never reaches the size being refused:
	 * bounding the yielded frame alone would still let `#ensureCapacity` double its way
	 * to the heap ceiling first.
	 */
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
				// A complete line inside one chunk skips the buffer, so it skips `append`'s
				// guard with it. Bound it here too: one delivered chunk is as large as the
				// transport chose to make it, and a peer that sends its whole hostile frame
				// in a single chunk is the same attack arriving faster.
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
		// What we are about to own, not what the transport handed us: the empty-buffer
		// branch above parses a delivered chunk in place and only the undelimited
		// remainder reaches `reset`, which guards it. This branch copies, so the copy is
		// what has to be bounded, and it is bounded before it is allocated.
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

/**
 * Stream parsed JSON objects from SSE `data:` lines.
 *
 * Thin wrapper over {@link readSseEvents}: yields one parsed JSON value per
 * dispatched SSE event, skipping events with empty `data` and stopping at the
 * OpenAI-style `[DONE]` sentinel. If your consumer doesn't care about `event:`
 * names or doesn't need a custom parse step, use this; otherwise call
 * `readSseEvents` directly.
 *
 * @example
 * ```ts
 * for await (const obj of readSseJson(response.body!)) {
 *   console.log(obj);
 * }
 * ```
 */
export type SseEventObserver = (event: ServerSentEvent) => void;

function notifySseEventObserver(observer: SseEventObserver | undefined, event: ServerSentEvent): void {
	if (!observer) return;
	try {
		observer(event);
	} catch {
		// Diagnostic observers must never perturb provider stream consumption.
	}
}

function isRecoverableTrailingJson(data: string): boolean {
	const first = data.trimStart()[0];
	if (first !== "{" && first !== "[") return false;
	// Best-effort relaxed recovery via the shared streaming JSON parser: a
	// container-shaped final event that fails strict `JSON.parse` is treated as a
	// cut-off (or lightly malformed) stream tail and ends iteration cleanly instead
	// of throwing. Non-container final events (plain-text errors, bare scalars) are
	// not recoverable and still surface as a SyntaxError.
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

/**
 * A single Server-Sent Event dispatched on a blank-line boundary.
 *
 * - `event` is the value of the most recent `event:` field, or `null` if none.
 * - `data` is the concatenation (joined by `\n`) of every `data:` field in the
 *   event, exactly as required by the SSE spec.
 * - `raw` is the list of decoded non-empty lines that made up the event,
 *   preserved for diagnostic context (error reporting, debugging). The
 *   dispatching blank line is not included.
 */
export interface ServerSentEvent {
	event: string | null;
	data: string;
	raw: string[];
}

interface SseEventState {
	event: string | null;
	// `data` accumulates across multiple `data:` lines per the SSE spec, joined
	// by `\n`. We keep the running string here and append as lines arrive instead
	// of buffering an array and joining at flush. `null` means "no data: field
	// seen yet" (distinct from a `data:` field with an empty value).
	data: string | null;
	raw: string[];
	// Bytes this event has taken off the wire since the last dispatch, counting
	// every line including comments. Each individual line can be well inside the
	// line bound while the event they build is not: `data: x` repeated forever, or
	// a `: keepalive` comment per millisecond, grows `data` and `raw` with no
	// blank line ever arriving to release them.
	bytes: number;
}

// Single decoder reused for all line decodes. Safe because lines are split on
// LF (0x0a) which is always a single-byte ASCII char in UTF-8 and never appears
// inside a multi-byte sequence — so each line is itself a complete UTF-8 run.
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
	// `appendAndFlushLines` splits on LF only; strip a trailing CR so CRLF sources
	// don't leak `\r` into field values.
	let end = line.length;
	if (end > 0 && line[end - 1] === 0x0d /* '\r' */) end--;
	if (end === 0) return flushSseEvent(state);

	// The line's own bytes plus the LF that delimited it: what the peer spent on this
	// event so far. Checked before the line is retained, so the refusal happens instead
	// of the growth rather than after it.
	state.bytes += line.length + 1;
	if (state.bytes > maxEventBytes) throw new StreamFrameLimitError("sse-event", state.bytes, maxEventBytes);

	// Comment line: keep in `raw` for diagnostic context, skip parsing.
	if (line[0] === 0x3a /* ':' */) {
		state.raw.push(decodeSseLineBytes(line, end));
		return null;
	}

	const text = decodeSseLineBytes(line, end);
	state.raw.push(text);

	const colon = text.indexOf(":");
	if (colon === -1) {
		// No colon: the whole line is the field name with an empty value.
		if (text === "data") {
			if (state.data === null) state.data = "";
			else state.data += "\n";
		} else if (text === "event") {
			state.event = "";
		}
		return null;
	}

	// Strip a single optional leading space after the colon (SSE spec: at most one).
	const valueStart = text.charCodeAt(colon + 1) === 0x20 ? colon + 2 : colon + 1;
	const value = text.slice(valueStart);

	// Compare the field-name prefix by char code to avoid allocating a substring.
	// Only "data" (4 bytes) and "event" (5 bytes) are processed; "id" and "retry"
	// are intentionally ignored.
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
	// `id` and `retry` are intentionally ignored — the providers we consume
	// don't use them, and the underlying transport handles reconnects itself.
	return null;
}

/**
 * Stream raw Server-Sent Events from an HTTP response body.
 *
 * Yields one `ServerSentEvent` per blank-line dispatch. The consumer is
 * responsible for parsing `data` (e.g. JSON, plain text, error envelope).
 * Use `readSseJson` instead when every event is a single `data:` JSON object
 * and you don't need access to the `event:` field.
 *
 * Internally backed by a Buffer-based line reader (`ConcatSink`) so chunk
 * concatenation is O(n) and never triggers per-line string slicing of the
 * accumulated buffer.
 *
 * @example
 * ```ts
 * for await (const sse of readSseEvents(response.body!)) {
 *   if (sse.event === "ping") continue;
 *   const obj = JSON.parse(sse.data);
 * }
 * ```
 */
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
		// Treat any trailing partial line (no terminating LF) as a complete line.
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
		// Real services don't always close on a blank line — flush any pending event.
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

// `JsonlSkip` is owned by ./jsonl-incremental.ts, the dependency-free module the
// incremental (carry-forward) reader lives in, and re-exported here so the
// long-standing `@veyyon/utils/stream` import path keeps working. One shape for
// "a record was dropped", whichever reader dropped it.
export type { JsonlSkip } from "./jsonl-incremental";
// The bound and its error live in a zero-import leaf so the retry classifier can key off
// the class without pulling the reader stack in; `@veyyon/utils/stream` stays the one
// import path a consumer of these readers needs.
export * from "./stream-frame-limit";

export interface ParseJsonlLenientOptions {
	/**
	 * Called once per malformed record that is skipped. Supply this to surface
	 * dropped data loudly (never a silent skip): a session loader logs the offset
	 * and counts skips so lost entries are visible rather than invisibly gone.
	 */
	onSkip?: (skip: JsonlSkip) => void;
}

/**
 * Parse a complete JSONL string, skipping malformed lines instead of throwing.
 *
 * Uses `Bun.JSONL.parseChunk` internally. On parse errors, the malformed
 * region is skipped up to the next newline and parsing continues. Pass
 * `onSkip` to be told about every dropped record — a silent skip loses data
 * invisibly, so callers that care about recall (session load/study) should log it.
 *
 * @example
 * ```ts
 * const entries = parseJsonlLenient<MyType>(fileContents);
 * ```
 */
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
			// `read > 0` means parseChunk consumed good record(s) (already collected
			// above) and the error belongs to the NEXT record — `read` points at the
			// delimiter just before it. Advance past the good records WITHOUT counting a
			// skip; the malformed record resurfaces at the head (`read === 0`) on the
			// next iteration, where it is skipped and reported through onSkip exactly
			// once. Counting here as well is what double-reported every malformed line.
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

/**
 * Drain a spawned process's pipe to a string, treating an absent pipe as empty output.
 *
 * `Bun.spawn` gives `null` for a stream that was not piped, and the two runtime installers
 * that read a failing install's output each wrapped this in a private `readPipe` for exactly
 * that reason: a missing pipe is not an error, it means the process was configured not to
 * capture that stream, and the diagnostic that follows should say "no output" rather than
 * throw while reporting a failure.
 */
export async function readPipeText(stream: ReadableStream<Uint8Array> | null): Promise<string> {
	if (!stream) return "";
	return await new Response(stream).text();
}
