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

export interface RequestDebugCapture {
	readonly capturedBytes: number;
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
	} catch {}
}

export const DEFAULT_REQUEST_DEBUG_MAX_CAPTURE_BYTES = 32 * 1024 * 1024;

let reportedInvalidCeiling = false;

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
		} catch {}
	}
	return DEFAULT_REQUEST_DEBUG_MAX_CAPTURE_BYTES;
}

function reportRequestDebugCeiling(path: string, capturedBytes: number, ceiling: number): void {
	try {
		logger.warn("Request debug capture reached its ceiling; the rest was not recorded", {
			path,
			capturedBytes,
			ceiling,
			variable: REQUEST_DEBUG_MAX_BYTES_ENV,
		});
	} catch {}
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

	#ceilingMarker(): string {
		return `\n[veyyon request debug] capture ceiling reached: recorded ${this.#written} bytes of this response; the rest was not written (${REQUEST_DEBUG_MAX_BYTES_ENV}=${this.#ceiling})\n`;
	}

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
	} catch {}
}

async function openPrivateDebugFile(filePath: string): Promise<fs.FileHandle> {
	const DEBUG_FILE_MODE = 0o600;
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
		const head = await readBoundedBody(body.stream(), ceiling);
		return snapshotBytes(head.bytes, body.type || contentType, ceiling, head.more ? body.size : undefined);
	}
	if (body instanceof ArrayBuffer) return snapshotBytes(new Uint8Array(body), contentType, ceiling);
	if (ArrayBuffer.isView(body)) {
		return snapshotBytes(new Uint8Array(body.buffer, body.byteOffset, body.byteLength), contentType, ceiling);
	}
	if (body instanceof ReadableStream) return { bodyUnavailable: "ReadableStream" };
	return snapshotText(String(body), contentType, ceiling);
}

interface BoundedBodyReader {
	read(): Promise<{ done: boolean; value?: Uint8Array }>;
	cancel(reason?: unknown): Promise<void>;
}

interface BoundedBody {
	readonly bytes: Uint8Array;
	readonly more: boolean;
}

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
	} finally {
		void reader.cancel().catch(() => {});
	}
	return { bytes: concatChunks(chunks, read), more };
}

async function snapshotRequestStream(
	request: Request,
	contentType: string | null,
	ceiling: number,
): Promise<RequestDebugBody> {
	const clone = request.clone();
	const declared = declaredContentLength(request.headers);
	const head = await readBoundedBody(clone.body, ceiling);
	return snapshotBytes(head.bytes, contentType, ceiling, head.more ? (declared ?? null) : undefined);
}

function concatChunks(chunks: readonly Uint8Array[], total: number): Uint8Array {
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
	const head = bytes.byteLength > ceiling ? bytes.subarray(0, ceiling) : bytes;
	const note = captureNote(head.byteLength, bytes.byteLength > ceiling ? bytes.byteLength : totalBytes);
	if (note === undefined) {
		try {
			return snapshotText(utf8Decoder.decode(head), contentType, ceiling);
		} catch {
			return { bodyBase64: Buffer.from(head).toString("base64") };
		}
	}
	try {
		return { bodyText: utf8Decoder.decode(head), bodyCapture: note };
	} catch {
		return { bodyBase64: Buffer.from(head).toString("base64"), bodyCapture: note };
	}
}

function snapshotText(text: string, contentType: string | null, ceiling: number): RequestDebugBody {
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
		} catch {}
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
