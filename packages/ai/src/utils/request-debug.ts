import { Buffer } from "node:buffer";
import * as fs from "node:fs/promises";
import * as logger from "@veyyon/utils/logger";
import { errorMessage } from "@veyyon/utils/type-guards";
import type { FetchImpl } from "../types";

const REQUEST_DEBUG_ENV = "VEYYON_REQ_DEBUG";
const REQUEST_DEBUG_MAX_BYTES_ENV = "VEYYON_REQ_DEBUG_MAX_BYTES";
const DEBUG_FETCH_MARKER = Symbol("veyyon.requestDebugFetch");
const textEncoder = new TextEncoder();
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

let nextSessionId = 1;

type DebugFetch = FetchImpl & { [DEBUG_FETCH_MARKER]?: true };
type RequestBodyInit = NonNullable<RequestInit["body"]>;

/** What was recorded, when the ceiling stopped the capture short of the whole body. */
export interface RequestDebugCapture {
	/** Bytes of the body written to the dump. */
	readonly capturedBytes: number;
	/**
	 * Bytes that were not recorded, or `null` when the sender never said how many there
	 * were. A streamed request body with no `content-length` is the `null` case: counting
	 * the rest would mean reading the rest, which is the allocation being avoided.
	 */
	readonly omittedBytes: number | null;
}

type RequestDebugBodyContent =
	| { body: unknown }
	| { bodyText: string }
	| { bodyBase64: string }
	| { bodyUnavailable: string };

type RequestDebugBody = RequestDebugBodyContent & { bodyCapture?: RequestDebugCapture };

export type RequestDebugHeaders = Headers | Record<string, string | string[] | number | undefined | null> | undefined;

export interface RequestDebugPayload {
	method: string;
	url: string;
	headers?: RequestDebugHeaders;
	body?: unknown;
	bodyText?: string;
	bodyBase64?: string;
	bodyUnavailable?: string;
	bodyCapture?: RequestDebugCapture;
	protocol?: string;
}

interface ReservedRequestDebugFile {
	id: number;
	requestPath: string;
	responsePath: string;
	handle: fs.FileHandle;
}

export interface RequestDebugResponseLog {
	write(chunk: Uint8Array | string): void;
	close(): Promise<void>;
}

export interface RequestDebugSession {
	readonly id: number;
	readonly requestPath: string;
	readonly responsePath: string;
	openResponseLog(statusLine: string, headers?: RequestDebugHeaders): Promise<RequestDebugResponseLog>;
	wrapResponse(response: Response): Promise<Response>;
}

function isRequestDebugEnvEnabled(): boolean {
	return Bun.env[REQUEST_DEBUG_ENV] === "1";
}

export function isRequestDebugEnabled(): boolean {
	return isRequestDebugEnvEnabled();
}

function reportRequestDebugFailure(message: string, error: unknown, path?: string): void {
	try {
		logger.error(message, {
			...(path ? { path } : {}),
			error: errorMessage(error),
		});
	} catch {
		// Debug observability is best-effort all the way down. A logger hook must
		// not become a second route for debug failures to reach the request.
	}
}

/**
 * A ceiling on the bytes one capture may hold, because a debug flag must not be able
 * to end the session it is diagnosing.
 *
 * Two ways it could. A provider or proxy that keeps a response flowing writes every
 * byte of it to `rr-session-N.res.log` until the filesystem is full, and the failure
 * lands on the whole machine rather than on the request being debugged. A large
 * request body — an attachment, a long transcript, a `Blob` — was read into memory in
 * full by the snapshot, next to the copy the real request is already holding.
 *
 * 32 MiB is far above any provider exchange worth reading by hand and far below the
 * point where either failure is reachable. `VEYYON_REQ_DEBUG_MAX_BYTES` raises or
 * lowers it for a capture that genuinely needs more.
 */
export const DEFAULT_REQUEST_DEBUG_MAX_CAPTURE_BYTES = 32 * 1024 * 1024;

let reportedInvalidCeiling = false;

/**
 * The ceiling in force, per captured file.
 *
 * A value that is not a positive integer is a typo, not a request for no ceiling: it
 * falls back to the default and says so once. Silently treating `VEYYON_REQ_DEBUG_MAX_BYTES=0`
 * as unlimited would turn a mistake into the outage this bound exists to prevent.
 */
export function requestDebugCaptureCeiling(): number {
	const raw = Bun.env[REQUEST_DEBUG_MAX_BYTES_ENV];
	if (raw === undefined || raw.trim() === "") return DEFAULT_REQUEST_DEBUG_MAX_CAPTURE_BYTES;
	const parsed = Number(raw);
	if (Number.isSafeInteger(parsed) && parsed > 0) return parsed;
	if (!reportedInvalidCeiling) {
		reportedInvalidCeiling = true;
		try {
			logger.warn("Request debug capture ceiling is not a positive integer; using the default", {
				variable: REQUEST_DEBUG_MAX_BYTES_ENV,
				value: raw,
				ceiling: DEFAULT_REQUEST_DEBUG_MAX_CAPTURE_BYTES,
			});
		} catch {
			// Same best-effort contract as every other diagnostic on this path.
		}
	}
	return DEFAULT_REQUEST_DEBUG_MAX_CAPTURE_BYTES;
}

/**
 * A capture that stopped at the ceiling is not a failure — the request it was
 * recording is fine — but it is not something to discover later by finding a file that
 * ends mid-JSON. It names the file, so the operator knows which dump is short and why.
 */
function reportRequestDebugCeiling(path: string, capturedBytes: number, ceiling: number): void {
	try {
		logger.warn("Request debug capture reached its ceiling; the rest was not recorded", {
			path,
			capturedBytes,
			ceiling,
			variable: REQUEST_DEBUG_MAX_BYTES_ENV,
		});
	} catch {
		// Same best-effort contract as every other diagnostic on this path.
	}
}

export function wrapFetchForRequestDebug(fetchImpl: FetchImpl): FetchImpl {
	if (!isRequestDebugEnabled()) return fetchImpl;
	const maybeWrapped = fetchImpl as DebugFetch;
	if (maybeWrapped[DEBUG_FETCH_MARKER]) return fetchImpl;

	const wrapped = Object.assign(
		async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
			if (!isRequestDebugEnabled()) return fetchImpl(input, init);
			let session: RequestDebugSession;
			try {
				session = await createFetchRequestDebugSession(input, init);
			} catch (error) {
				reportRequestDebugFailure("Request debug log could not be created; this request was not recorded", error);
				return fetchImpl(input, init);
			}

			const response = await fetchImpl(input, init);
			try {
				return await session.wrapResponse(response);
			} catch (error) {
				reportRequestDebugFailure(
					"Request debug response wrapper failed; returning the original response",
					error,
					session.responsePath,
				);
				return response;
			}
		},
		fetchImpl.preconnect ? { preconnect: fetchImpl.preconnect } : {},
		{ [DEBUG_FETCH_MARKER]: true as const },
	);
	return wrapped;
}

export function withRequestDebugFetch<T extends { fetch?: FetchImpl } | undefined>(options: T): T {
	if (!isRequestDebugEnabled()) return options;
	const fetchImpl = options?.fetch ?? (globalThis.fetch as FetchImpl);
	const wrapped = wrapFetchForRequestDebug(fetchImpl);
	return { ...(options ?? {}), fetch: wrapped } as T;
}

export async function createRequestDebugSession(payload: RequestDebugPayload): Promise<RequestDebugSession> {
	const { id, requestPath, responsePath, handle } = await reserveRequestDebugFile();
	const requestDump: Record<string, unknown> = {
		id,
		protocol: payload.protocol ?? "http",
		method: payload.method,
		url: payload.url,
	};
	const headers = headersToRecord(payload.headers);
	if (headers) requestDump.headers = headers;
	if (payload.body !== undefined) requestDump.body = payload.body;
	if (payload.bodyText !== undefined) requestDump.bodyText = payload.bodyText;
	if (payload.bodyBase64 !== undefined) requestDump.bodyBase64 = payload.bodyBase64;
	if (payload.bodyUnavailable !== undefined) requestDump.bodyUnavailable = payload.bodyUnavailable;
	// Durable, in the file rather than only in the log: a dump whose body stops early
	// looks exactly like a request that really sent that much.
	if (payload.bodyCapture !== undefined) requestDump.bodyCapture = payload.bodyCapture;

	try {
		await handle.writeFile(`${JSON.stringify(requestDump, null, 2)}\n`, "utf8");
	} finally {
		await handle.close();
	}

	return new FileRequestDebugSession(id, requestPath, responsePath);
}

async function createFetchRequestDebugSession(
	input: string | URL | Request,
	init: RequestInit | undefined,
): Promise<RequestDebugSession> {
	const headers = resolveRequestHeaders(input, init);
	const body = await snapshotRequestBody(input, init, headers.get("content-type"));
	return createRequestDebugSession({
		method: resolveRequestMethod(input, init),
		url: resolveRequestUrl(input),
		headers,
		...body,
	});
}

class FileRequestDebugSession implements RequestDebugSession {
	readonly id: number;
	readonly requestPath: string;
	readonly responsePath: string;

	constructor(id: number, requestPath: string, responsePath: string) {
		this.id = id;
		this.requestPath = requestPath;
		this.responsePath = responsePath;
	}

	async openResponseLog(statusLine: string, headers?: RequestDebugHeaders): Promise<RequestDebugResponseLog> {
		const handle = await openPrivateDebugFile(this.responsePath);
		const log = new FileRequestDebugResponseLog(handle, this.responsePath, requestDebugCaptureCeiling());
		// Through the log's own write, not the raw handle: a failure here is the same
		// kind of failure as one mid-body and has to be absorbed the same way. Writes
		// are chained in order, so the header still lands ahead of the first chunk.
		log.write(formatResponseHeaderBlock(statusLine, headers));
		return log;
	}

	async wrapResponse(response: Response): Promise<Response> {
		const log = await this.#openResponseLogOrNull(response);
		if (!log) return response;
		if (!response.body) {
			await log.close();
			return response;
		}

		// INFERRED, not annotated. Two `ReadableStreamDefaultReader`s are in scope here: the DOM one
		// that `response.body.getReader()` actually returns, and Bun's, which is generic over its
		// buffer and declares an extra `readMany`. Writing either name picked the wrong one: the
		// bare form resolved to Bun's and rejected the assignment, and deriving the return type
		// selected a BYOB overload whose `read` wants an argument. Letting the initializer decide
		// keeps this correct under both lib sets, and nothing here needs the type spelled out.
		const reader = (() => {
			try {
				return response.body.getReader();
			} catch {
				return undefined;
			}
		})();
		if (!reader) {
			await log.close().catch(() => undefined);
			return response;
		}
		const teed = new ReadableStream<Uint8Array>({
			async pull(controller) {
				try {
					const { done, value } = await reader.read();
					if (done) {
						await log.close();
						controller.close();
						return;
					}
					log.write(value);
					controller.enqueue(value);
				} catch (error) {
					// Closing a DEBUG log that is written only when request debugging is switched on. A failed close cannot be
					// allowed to fail the request it was recording, which is the whole point of the debug surface being
					// passive, and the operator who enabled it sees the truncated file.
					await log.close().catch(() => undefined);
					controller.error(error);
				}
			},
			async cancel(reason) {
				try {
					await reader.cancel(reason);
				} finally {
					await log.close();
				}
			},
		});

		const wrapped = new Response(teed, {
			status: response.status,
			statusText: response.statusText,
			headers: response.headers,
		});
		copyResponseMetadata(wrapped, response);
		return wrapped;
	}

	/**
	 * Opening the log can fail on its own: a read-only directory, a name already
	 * taken, or no file descriptors left. That is a reason to stop recording, not
	 * a reason to fail the request, so the caller gets the untouched response and
	 * an error in the log saying why nothing was captured.
	 */
	async #openResponseLogOrNull(response: Response): Promise<RequestDebugResponseLog | undefined> {
		try {
			return await this.openResponseLog(`HTTP ${response.status} ${response.statusText}`.trim(), response.headers);
		} catch (error) {
			reportRequestDebugFailure(
				"Request debug log could not be opened; this response was not recorded",
				error,
				this.responsePath,
			);
			return undefined;
		}
	}
}

/**
 * Writes the response body to the debug log without ever putting that log
 * between the user and their response.
 *
 * `VEYYON_REQ_DEBUG` is an observability flag, so its failures are reported and
 * survived rather than propagated. A rejected write used to travel out through
 * `close()` into the stream `pull` that awaited it, which called
 * `controller.error(...)` and killed the real model response. Turning on
 * request logging and then running out of disk ended the session with an error
 * about a file the user was not reading, in the middle of a request that had
 * already succeeded.
 *
 * Dropping the write instead is only acceptable because it is loud: the first
 * failure logs at error level naming the file and the cause, and every
 * subsequent chunk for that log is discarded without repeating the message. The
 * log is then knowingly incomplete rather than quietly truncated.
 *
 * The same reasoning bounds the size. A provider or proxy that keeps a response
 * flowing wrote every byte of it here, so switching on a debug flag was enough to
 * fill the disk while the request it was recording stayed perfectly valid. Past the
 * ceiling the log stops growing, states in the file that it stopped and how much it
 * never wrote, and warns once naming the path. The response itself is untouched: the
 * caller keeps receiving every byte.
 */
class FileRequestDebugResponseLog implements RequestDebugResponseLog {
	#handle: fs.FileHandle | undefined;
	#pending: Promise<void> = Promise.resolve();
	#closed: Promise<void> | undefined;
	#failed = false;
	#written = 0;
	#omitted = 0;
	#stopped = false;
	readonly #path: string;
	readonly #ceiling: number;

	constructor(handle: fs.FileHandle, path: string, ceiling: number) {
		this.#handle = handle;
		this.#path = path;
		this.#ceiling = ceiling;
	}

	write(chunk: Uint8Array | string): void {
		const handle = this.#handle;
		if (!handle || this.#failed) return;
		const bytes = typeof chunk === "string" ? textEncoder.encode(chunk) : chunk.slice();
		if (this.#stopped) {
			// Counted, not written: the tally at close is what makes the omission durable.
			this.#omitted += bytes.byteLength;
			return;
		}
		const room = this.#ceiling - this.#written;
		if (bytes.byteLength > room) {
			this.#stopped = true;
			this.#omitted += bytes.byteLength - room;
			this.#written += room;
			this.#enqueue(handle, bytes.subarray(0, room));
			this.#enqueue(handle, textEncoder.encode(this.#ceilingMarker()));
			reportRequestDebugCeiling(this.#path, this.#written, this.#ceiling);
			return;
		}
		this.#written += bytes.byteLength;
		this.#enqueue(handle, bytes);
	}

	close(): Promise<void> {
		if (this.#closed) return this.#closed;
		const handle = this.#handle;
		if (!handle) return Promise.resolve();
		if (this.#stopped && !this.#failed) this.#enqueue(handle, textEncoder.encode(this.#tallyMarker()));
		this.#handle = undefined;
		this.#closed = (async () => {
			try {
				await this.#pending;
			} finally {
				try {
					await handle.close();
				} catch (error) {
					this.#reportFailure(error);
				}
			}
		})();
		return this.#closed;
	}

	#enqueue(handle: fs.FileHandle, bytes: Uint8Array): void {
		this.#pending = this.#pending.then(async () => {
			if (this.#failed) return;
			try {
				await handle.write(bytes);
			} catch (error) {
				this.#reportFailure(error);
			}
		});
	}

	/**
	 * Written the moment the ceiling is reached, so a log whose process never got to
	 * close still says why it ends where it does.
	 */
	#ceilingMarker(): string {
		return `\n[veyyon request debug] capture ceiling reached: recorded ${this.#written} bytes of this response; the rest was not written (${REQUEST_DEBUG_MAX_BYTES_ENV}=${this.#ceiling})\n`;
	}

	/** The count the ceiling marker cannot know yet: how much went unrecorded in total. */
	#tallyMarker(): string {
		return `[veyyon request debug] captured ${this.#written} bytes, omitted ${this.#omitted} bytes\n`;
	}

	#reportFailure(error: unknown): void {
		if (this.#failed) return;
		this.#failed = true;
		reportRequestDebugFailure(
			"Request debug log failed; the rest of this response was not recorded",
			error,
			this.#path,
		);
	}
}

function copyResponseMetadata(target: Response, source: Response): void {
	const sourceUrl = source.url;
	if (!sourceUrl) return;
	try {
		Object.defineProperty(target, "url", { value: sourceUrl, configurable: true });
	} catch {
		// Some runtimes may expose Response.url as non-configurable. The body
		// capture remains correct; callers that need url already tolerate the
		// platform default on other response wrappers in this package.
	}
}

/**
 * Owner-only, because the dump is the request as it went on the wire. Header values that are
 * credentials are replaced before they reach the file, but a body still can be one: an OAuth
 * token exchange posts a refresh token, and a provider error can echo the request back. The
 * default umask leaves a new file world-readable, so the mode is pinned rather than inherited.
 */
const DEBUG_FILE_MODE = 0o600;

/**
 * Both dump files are created here, so the mode cannot be dropped at one of two call sites.
 *
 * `wx` is what makes the mode effective: it creates the file and applies `DEBUG_FILE_MODE` as it
 * does. Reopening an existing file with `w` would ignore `mode` and inherit whatever permissions a
 * previous run left, so no caller may name a file it did not create. A name already taken is
 * reported by the caller and the exchange goes unrecorded, which is the safe direction for an
 * observability flag. On win32 `mode` does nothing, so the owner-only contract there is an ACL
 * question this file does not answer.
 */
async function openPrivateDebugFile(filePath: string): Promise<fs.FileHandle> {
	return fs.open(filePath, "wx", DEBUG_FILE_MODE);
}

async function reserveRequestDebugFile(): Promise<ReservedRequestDebugFile> {
	for (;;) {
		const id = nextSessionId++;
		const requestPath = `rr-session-${id}.json`;
		try {
			const handle = await openPrivateDebugFile(requestPath);
			return { id, requestPath, responsePath: `rr-session-${id}.res.log`, handle };
		} catch (error) {
			if (isFileExistsError(error)) continue;
			throw error;
		}
	}
}

function resolveRequestMethod(input: string | URL | Request, init: RequestInit | undefined): string {
	return (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
}

function resolveRequestUrl(input: string | URL | Request): string {
	return input instanceof Request ? input.url : input.toString();
}

function resolveRequestHeaders(input: string | URL | Request, init: RequestInit | undefined): Headers {
	if (init?.headers) return new Headers(init.headers);
	return input instanceof Request ? new Headers(input.headers) : new Headers();
}

async function snapshotRequestBody(
	input: string | URL | Request,
	init: RequestInit | undefined,
	contentType: string | null,
): Promise<RequestDebugBody | undefined> {
	const ceiling = requestDebugCaptureCeiling();
	if (init?.body !== undefined && init.body !== null) return snapshotBodyInit(init.body, contentType, ceiling);
	// The clone, so the request the caller is about to send keeps its own body. Read
	// through the stream rather than `arrayBuffer()`: a body larger than the ceiling is
	// never held here, which is the whole difference between a bound and a report.
	if (input instanceof Request && input.body) return snapshotRequestStream(input, contentType, ceiling);
	return undefined;
}

async function snapshotBodyInit(
	body: RequestBodyInit,
	contentType: string | null,
	ceiling: number,
): Promise<RequestDebugBody> {
	if (typeof body === "string") return snapshotText(body, contentType, ceiling);
	if (body instanceof URLSearchParams) return snapshotText(body.toString(), contentType, ceiling);
	if (body instanceof FormData) return { bodyUnavailable: "FormData" };
	if (body instanceof Blob) {
		// `size` is known without reading, and the read goes through the blob's own stream,
		// so an attachment larger than the ceiling is never held here a second time next to
		// the copy the request is already carrying.
		const head = await readBoundedBody(body.stream(), ceiling);
		return snapshotBytes(head.bytes, body.type || contentType, ceiling, head.more ? body.size : undefined);
	}
	if (body instanceof ArrayBuffer) return snapshotBytes(new Uint8Array(body), contentType, ceiling);
	if (ArrayBuffer.isView(body)) {
		return snapshotBytes(new Uint8Array(body.buffer, body.byteOffset, body.byteLength), contentType, ceiling);
	}
	// Reading it would take it from the request that is about to send it.
	if (body instanceof ReadableStream) return { bodyUnavailable: "ReadableStream" };
	return snapshotText(String(body), contentType, ceiling);
}

/**
 * Just enough of a stream reader to read a bounded prefix.
 *
 * Structural on purpose. Three `ReadableStream` declarations are in scope in this
 * package — the DOM one, Bun's, and undici's — and a body reached through `Request`,
 * `Response` or `Blob` arrives as a different one each time. Naming what is used keeps
 * one reader for all three instead of a cast per call site.
 */
interface BoundedBodyReader {
	read(): Promise<{ done: boolean; value?: Uint8Array }>;
	cancel(reason?: unknown): Promise<void>;
}

interface BoundedBody {
	readonly bytes: Uint8Array;
	/**
	 * Whether the read stopped because it hit the ceiling rather than because the body
	 * ended. A body of exactly the ceiling reports `true` as well: distinguishing the
	 * two costs one more read, and on a `Request` clone that read can block — Bun tees a
	 * request body, and the branch the real request never consumes stops the source from
	 * yielding once its queue fills. A capture is not allowed to stall the request it is
	 * recording, so a body sitting exactly on the ceiling is reported as possibly cut.
	 */
	readonly more: boolean;
}

/**
 * Read at most `ceiling` bytes, then stop and cancel the rest.
 *
 * A body that fails mid-read leaves what it already gave: the capture is a clone or a
 * blob the caller still owns, so a read error here is not the request's problem.
 */
async function readBoundedBody(
	stream: { getReader(): BoundedBodyReader } | null,
	ceiling: number,
): Promise<BoundedBody> {
	if (!stream) return { bytes: new Uint8Array(0), more: false };
	const reader = stream.getReader();
	const chunks: Uint8Array[] = [];
	let read = 0;
	let more = false;
	try {
		while (read < ceiling) {
			const chunk = await reader.read();
			if (chunk.done) break;
			const value = chunk.value;
			if (value === undefined || value.byteLength === 0) continue;
			const room = ceiling - read;
			if (value.byteLength > room) {
				chunks.push(value.subarray(0, room));
				read += room;
				more = true;
				break;
			}
			chunks.push(value);
			read += value.byteLength;
		}
		if (read >= ceiling) more = true;
	} catch {
		// Keep the prefix. The status of the capture, not of the request.
	} finally {
		// Released, not awaited. On a `Request` clone this cancel settles only once the
		// branch the real request holds is consumed, which happens after this function has
		// returned — awaiting it deadlocks the capture and with it the request.
		void reader.cancel().catch(() => {});
	}
	return { bytes: concatChunks(chunks, read), more };
}

/**
 * Read at most `ceiling` bytes off a clone of the request body, then stop.
 *
 * The total is taken from `content-length` when the caller declared one. Without it the
 * omitted count is unknown on purpose: measuring it means reading the rest, which is
 * the allocation this exists to avoid.
 */
async function snapshotRequestStream(
	request: Request,
	contentType: string | null,
	ceiling: number,
): Promise<RequestDebugBody> {
	// The clone, so the request the caller is about to send keeps its own body.
	const clone = request.clone();
	const declared = declaredContentLength(request.headers);
	const head = await readBoundedBody(clone.body, ceiling);
	return snapshotBytes(head.bytes, contentType, ceiling, head.more ? (declared ?? null) : undefined);
}

function concatChunks(chunks: readonly Uint8Array[], total: number): Uint8Array {
	// Copied rather than handed on: a single chunk is often a view into a much larger
	// buffer the runtime would then have to keep alive for the life of the dump.
	const joined = new Uint8Array(total);
	let at = 0;
	for (const chunk of chunks) {
		joined.set(chunk, at);
		at += chunk.byteLength;
	}
	return joined;
}

function declaredContentLength(headers: Headers): number | undefined {
	const header = headers.get("content-length");
	if (header === null) return undefined;
	const parsed = Number.parseInt(header, 10);
	return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

/**
 * A capture note when the body is known to be longer than what was recorded.
 *
 * `totalBytes` is `undefined` when `bytes` IS the whole body, a number when the real
 * size is known, and `null` when the body has more that nobody counted.
 */
function captureNote(capturedBytes: number, totalBytes: number | null | undefined): RequestDebugCapture | undefined {
	if (totalBytes === undefined) return undefined;
	if (totalBytes === null) return { capturedBytes, omittedBytes: null };
	if (totalBytes <= capturedBytes) return undefined;
	return { capturedBytes, omittedBytes: totalBytes - capturedBytes };
}

function snapshotBytes(
	bytes: Uint8Array,
	contentType: string | null,
	ceiling: number,
	totalBytes?: number | null,
): RequestDebugBody {
	// Two bounds guard these bytes, and that is deliberate: the prefix here keeps the
	// decode from allocating a second copy of a body that may be megabytes, and
	// `snapshotText` below bounds again for the callers that arrive with a string. Remove
	// either and the recorded output is unchanged, so a mutation gate cannot separate
	// them — the allocation is the only difference, and only removing BOTH is a defect.
	const head = bytes.byteLength > ceiling ? bytes.subarray(0, ceiling) : bytes;
	const note = captureNote(head.byteLength, bytes.byteLength > ceiling ? bytes.byteLength : totalBytes);
	if (note === undefined) {
		try {
			return snapshotText(utf8Decoder.decode(head), contentType, ceiling);
		} catch {
			return { bodyBase64: Buffer.from(head).toString("base64") };
		}
	}
	// A truncated body is no longer the JSON it was, so it is recorded as text — or as
	// base64 when the cut landed inside a character.
	try {
		return { bodyText: utf8Decoder.decode(head), bodyCapture: note };
	} catch {
		return { bodyBase64: Buffer.from(head).toString("base64"), bodyCapture: note };
	}
}

function snapshotText(text: string, contentType: string | null, ceiling: number): RequestDebugBody {
	// `byteLength` measures without encoding; `encodeInto` then fills a buffer of exactly
	// the ceiling and never splits a character across the end of it.
	const totalBytes = Buffer.byteLength(text, "utf8");
	if (totalBytes > ceiling) {
		const room = new Uint8Array(ceiling);
		const { written } = textEncoder.encodeInto(text, room);
		return {
			bodyText: utf8Decoder.decode(room.subarray(0, written)),
			bodyCapture: { capturedBytes: written, omittedBytes: totalBytes - written },
		};
	}
	if (isJsonContentType(contentType) || looksLikeJson(text)) {
		try {
			return { body: JSON.parse(text) };
		} catch {
			// Fall through to bodyText: malformed JSON is still useful as raw text.
		}
	}
	return { bodyText: text };
}

function isJsonContentType(contentType: string | null): boolean {
	if (!contentType) return false;
	const lower = contentType.toLowerCase();
	return lower.includes("application/json") || lower.includes("+json");
}

function looksLikeJson(text: string): boolean {
	const trimmed = text.trimStart();
	return trimmed.startsWith("{") || trimmed.startsWith("[");
}

function formatResponseHeaderBlock(statusLine: string, headers?: RequestDebugHeaders): string {
	const lines = [statusLine];
	const record = headersToRecord(headers);
	if (record) {
		for (const name in record) {
			const value = record[name];
			if (Array.isArray(value)) {
				for (const item of value) lines.push(`${name}: ${item}`);
			} else {
				lines.push(`${name}: ${value}`);
			}
		}
	}
	return `${lines.join("\r\n")}\r\n\r\n`;
}

/**
 * Header names whose value is a credential rather than protocol metadata.
 *
 * A `VEYYON_REQ_DEBUG` dump is a plain file on disk that the operator may attach to a bug
 * report, so the bearer value never goes in it. The name and the value's length still do,
 * which is what a debugging session actually needs: whether the header was sent at all, and
 * whether the key looks truncated.
 *
 * Matching is by exact lowercased name plus a few substrings, so a provider-specific spelling
 * (`x-goog-api-key`, `openai-api-key`, `x-veyyon-auth-token`) is covered without an entry.
 */
const REDACTED_HEADER_NAMES: Record<string, true> = {
	authorization: true,
	"proxy-authorization": true,
	cookie: true,
	"set-cookie": true,
	"www-authenticate": true,
	"proxy-authenticate": true,
};
const REDACTED_HEADER_SUBSTRINGS: readonly string[] = ["api-key", "apikey", "auth-token", "access-token", "secret"];

export function isCredentialHeaderName(name: string): boolean {
	const lower = name.toLowerCase();
	if (REDACTED_HEADER_NAMES[lower]) return true;
	return REDACTED_HEADER_SUBSTRINGS.some(fragment => lower.includes(fragment));
}

/**
 * The spellings {@link isCredentialHeaderName} recognizes, expanded for a gate that
 * has to sweep them. A substring is listed as one representative header a provider
 * really sends, because a gate asserting on the fragment alone would pass while the
 * header carrying it leaked.
 */
export const CREDENTIAL_HEADER_SPELLINGS: readonly string[] = [
	...Object.keys(REDACTED_HEADER_NAMES),
	"x-api-key",
	"anthropic-api-key",
	"x-goog-api-key",
	"openai-apikey",
	"x-veyyon-auth-token",
	"x-access-token",
	"x-client-secret",
];

/**
 * Redacts a header set on its way into a diagnostic log or dump.
 *
 * The credential half is {@link isCredentialHeaderName} and nothing else, so a
 * provider-specific spelling is covered everywhere at once rather than in whichever
 * list a caller remembered to extend. A caller with headers that are sensitive
 * without being credentials — an account id, a conversation id — passes
 * `alsoSensitive`, which receives the lowercased name.
 */
export function redactDiagnosticHeaders(
	headers: Iterable<[string, string]>,
	alsoSensitive?: (lowercasedName: string) => boolean,
): Record<string, string> {
	const redacted: Record<string, string> = {};
	for (const [key, value] of headers) {
		redacted[key] = isCredentialHeaderName(key) || alsoSensitive?.(key.toLowerCase()) === true ? "[redacted]" : value;
	}
	return redacted;
}

function redactHeaderValue(value: string): string {
	return `<redacted ${value.length} chars>`;
}

function headersToRecord(headers: RequestDebugHeaders): Record<string, string | string[]> | undefined {
	if (!headers) return undefined;
	const record: Record<string, string | string[]> = {};
	let hasHeaders = false;
	const put = (key: string, value: string | string[]): void => {
		hasHeaders = true;
		if (!isCredentialHeaderName(key)) {
			record[key] = value;
			return;
		}
		record[key] = Array.isArray(value) ? value.map(redactHeaderValue) : redactHeaderValue(value);
	};
	if (headers instanceof Headers) {
		headers.forEach((value, key) => {
			put(key, value);
		});
	} else {
		for (const key in headers) {
			const value = headers[key];
			if (value === undefined || value === null) continue;
			put(key, Array.isArray(value) ? value.map(String) : String(value));
		}
	}
	return hasHeaders ? record : undefined;
}

function isFileExistsError(error: unknown): boolean {
	return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "EEXIST";
}
