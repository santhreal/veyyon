/**
 * HTTP client for the veyyon auth-broker server.
 *
 * Used by {@link RemoteAuthCredentialStore} (snapshot pulls) and by
 * `veyyon auth-broker status` (liveness checks). All endpoints except
 * `/v1/healthz` require a bearer token.
 */
import { scopedTimeoutSignal } from "@veyyon/utils/scoped-timeout";
import { readSseEvents } from "@veyyon/utils/stream";
import { trimTrailingSlashes } from "@veyyon/utils/url";
import type { AuthCredential } from "../auth-storage";
import { AuthBrokerError, AuthBrokerStreamUnsupportedError } from "../error/classes";
import { type } from "../utils/schema/arktype";
import { formatGenerationTag, parseGenerationTag } from "./generation-tag";
import type {
	CredentialBlockRequest,
	CredentialBlockResponse,
	CredentialBlocksDeleteResponse,
	CredentialDisableRequest,
	CredentialDisableResponse,
	CredentialRefreshResponse,
	CredentialUploadRequest,
	CredentialUploadResponse,
	HealthzResponse,
	SnapshotResponse,
	SnapshotStreamEvent,
	UsageResponse,
	UsageStaleResponse,
} from "./types";
import { wireSchemas } from "./wire-schemas";

export interface AuthBrokerClientOptions {
	/** Base URL (e.g. `https://broker.tailnet:8765`). Trailing slashes are trimmed. */
	url: string;
	/** Bearer token used for everything except `healthz`. */
	token: string;
	/** Per-request timeout in milliseconds. Default 10s. */
	timeoutMs?: number;
	/** Retry connection errors this many times. Default 1. */
	maxRetries?: number;
	/** Override fetch (used in tests). Default global `fetch`. */
	fetchImpl?: typeof fetch;
}

export interface FetchSnapshotOptions {
	ifGenerationGt?: number;
	waitMs?: number;
	signal?: AbortSignal;
}

export type FetchSnapshotResult =
	| { status: 200; snapshot: SnapshotResponse; generation: number }
	| { status: 304; generation: number };

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_RETRIES = 1;

export class AuthBrokerClient {
	readonly #baseUrl: string;
	readonly #token: string;
	readonly #timeoutMs: number;
	readonly #maxRetries: number;
	readonly #fetch: typeof fetch;

	constructor(opts: AuthBrokerClientOptions) {
		this.#baseUrl = trimTrailingSlashes(opts.url);
		this.#token = opts.token;
		this.#timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
		this.#maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES;
		this.#fetch = opts.fetchImpl ?? fetch;
	}

	healthz(signal?: AbortSignal): Promise<HealthzResponse> {
		return this.#request<HealthzResponse>("GET", "/v1/healthz", {
			schema: wireSchemas().healthzResponseSchema,
			auth: false,
			signal,
		});
	}

	async fetchSnapshot(opts: FetchSnapshotOptions = {}): Promise<FetchSnapshotResult> {
		const query = new URLSearchParams();
		if (opts.waitMs !== undefined) query.set("wait", String(opts.waitMs));
		const path = `/v1/snapshot${query.size > 0 ? `?${query.toString()}` : ""}`;
		const headers: Record<string, string> = {};
		if (opts.ifGenerationGt !== undefined) headers["If-None-Match"] = formatGenerationTag(opts.ifGenerationGt);
		const timeoutMs =
			opts.waitMs !== undefined && opts.waitMs > 0 ? Math.max(this.#timeoutMs, opts.waitMs + 1000) : undefined;
		const response = await this.#fetchRaw("GET", path, {
			auth: true,
			headers,
			signal: opts.signal,
			timeoutMs,
		});
		const etagGeneration = parseGenerationTag(response.headers.get("etag"));
		if (response.status === 304) {
			return { status: 304, generation: etagGeneration ?? opts.ifGenerationGt ?? 0 };
		}
		const snapshot = validateWire<SnapshotResponse>(
			wireSchemas().snapshotResponseSchema,
			parseJson(response.text, response.status),
			"Auth broker response failed schema validation",
			response.status,
		);
		return { status: 200, snapshot, generation: etagGeneration ?? snapshot.generation };
	}

	/**
	 * Subscribe to the broker's SSE snapshot stream. The first frame is always
	 * a full `snapshot`; subsequent frames are `entry` upserts / refreshes or
	 * `removed` deletes. Caller controls lifecycle via `opts.signal`.
	 *
	 * Throws {@link AuthBrokerStreamUnsupportedError} when the broker responds
	 * 404 — older brokers predate this endpoint and the caller should fall back
	 * to long-polling for the remainder of its lifetime.
	 */
	async *openSnapshotStream(opts: { signal?: AbortSignal } = {}): AsyncGenerator<SnapshotStreamEvent> {
		const stream = await this.#openSnapshotStreamBody(opts.signal);
		let sawFirstEvent = false;
		for await (const sse of readSseEvents(stream.body, opts.signal)) {
			if (sse.event === null && sse.data === "") continue; // keepalive comment frames
			const event = parseStreamEvent(sse.data);
			if (!sawFirstEvent && event.kind !== "snapshot") {
				throw new AuthBrokerError("Auth broker stream did not start with snapshot", { body: sse.data });
			}
			sawFirstEvent = true;
			yield event;
		}
		if (!opts.signal?.aborted) {
			throw new AuthBrokerError(
				sawFirstEvent
					? "Auth broker stream ended unexpectedly"
					: "Auth broker stream ended before initial snapshot",
				{ status: stream.status },
			);
		}
	}

	/** The body of an accepted `GET /v1/snapshot/stream`, or the error naming why the broker refused it. */
	async #openSnapshotStreamBody(
		signal: AbortSignal | undefined,
	): Promise<{ body: ReadableStream<Uint8Array>; status: number }> {
		if (signal?.aborted) {
			throw new AuthBrokerError("Auth broker request aborted", { cause: signal.reason });
		}
		// No timeout: this connection is intentionally long-lived. Caller's signal
		// is the only cancel path.
		const response = await this.#fetch(`${this.#baseUrl}/v1/snapshot/stream`, {
			method: "GET",
			headers: { Accept: "text/event-stream", Authorization: `Bearer ${this.#token}` },
			signal,
		});
		if (response.status === 404) {
			// Drain the body so the socket can be reused; tiny payload. Nobody reads it, so a drain that fails
			// costs one connection and has no bearing on the unsupported-stream error thrown next.
			await response.text().catch(() => {});
			throw new AuthBrokerStreamUnsupportedError();
		}
		if (!response.ok) {
			// The STATUS is the failure, and it is thrown below with the body attached as context. A body that
			// cannot be read must not replace a 500 with a read error, so it degrades to empty.
			const text = await response.text().catch(() => "");
			throw new AuthBrokerError(`Auth broker stream failed: ${response.status} ${response.statusText}`, {
				status: response.status,
				body: text,
			});
		}
		if (!response.body) {
			throw new AuthBrokerError("Auth broker stream response had no body", { status: response.status });
		}
		const contentType = response.headers.get("content-type")?.toLowerCase();
		if (contentType?.split(";", 1)[0].trim() !== "text/event-stream") {
			// The content type is the failure and it is thrown next. Cancelling the body we will not read is a
			// courtesy to the socket; its failure cannot change what is wrong with this response.
			await response.body.cancel().catch(() => {});
			throw new AuthBrokerError("Auth broker stream returned non-SSE response", {
				status: response.status,
				body: contentType ?? "",
			});
		}
		return { body: response.body, status: response.status };
	}

	fetchUsage(signal?: AbortSignal): Promise<UsageResponse> {
		// Validates the envelope (`generatedAt`, `reports[].provider`, `limits`,
		// `metadata`) but leaves provider-specific extension fields permissive so
		// the broker can ship new shapes ahead of the client. `raw` is accepted
		// but normally stripped by the broker before send.
		return this.#request<UsageResponse>("GET", "/v1/usage", { schema: wireSchemas().usageResponseSchema, signal });
	}

	notifyUsageStale(signal?: AbortSignal): Promise<UsageStaleResponse> {
		return this.#request<UsageStaleResponse>("POST", "/v1/usage/stale", {
			schema: wireSchemas().usageStaleResponseSchema,
			signal,
		});
	}

	async refreshCredential(id: number, signal?: AbortSignal): Promise<CredentialRefreshResponse> {
		return this.#request<CredentialRefreshResponse>("POST", `/v1/credential/${id}/refresh`, {
			schema: wireSchemas().credentialRefreshResponseSchema,
			signal,
		});
	}

	async disableCredential(id: number, cause: string, signal?: AbortSignal): Promise<CredentialDisableResponse> {
		const body: CredentialDisableRequest = { cause };
		return this.#request<CredentialDisableResponse>("POST", `/v1/credential/${id}/disable`, {
			body,
			schema: wireSchemas().credentialDisableResponseSchema,
			signal,
		});
	}

	async uploadCredential(
		provider: string,
		credential: AuthCredential,
		signal?: AbortSignal,
	): Promise<CredentialUploadResponse> {
		const body: CredentialUploadRequest = { provider, credential };
		return this.#request<CredentialUploadResponse>("POST", "/v1/credential", {
			body,
			schema: wireSchemas().credentialUploadResponseSchema,
			signal,
		});
	}

	async upsertCredentialBlock(
		id: number,
		block: CredentialBlockRequest,
		signal?: AbortSignal,
	): Promise<CredentialBlockResponse> {
		const body: CredentialBlockRequest = block;
		return this.#request<CredentialBlockResponse>("POST", `/v1/credential/${id}/block`, {
			body,
			schema: wireSchemas().credentialBlockResponseSchema,
			signal,
		});
	}

	async deleteCredentialBlocks(id: number, signal?: AbortSignal): Promise<CredentialBlocksDeleteResponse> {
		return this.#request<CredentialBlocksDeleteResponse>("DELETE", `/v1/credential/${id}/blocks`, {
			schema: wireSchemas().credentialBlocksDeleteResponseSchema,
			signal,
		});
	}

	async #request<t>(
		method: "GET" | "POST" | "DELETE",
		path: string,
		opts: { schema: (input: unknown) => unknown; auth?: boolean; body?: unknown; signal?: AbortSignal },
	): Promise<t> {
		const response = await this.#fetchRaw(method, path, opts);
		return validateWire<t>(
			opts.schema,
			parseJson(response.text, response.status),
			"Auth broker response failed schema validation",
			response.status,
		);
	}

	async #fetchRaw(
		method: "GET" | "POST" | "DELETE",
		path: string,
		opts: {
			auth?: boolean;
			body?: unknown;
			signal?: AbortSignal;
			headers?: Record<string, string>;
			timeoutMs?: number;
		},
	): Promise<BrokerResponse> {
		const headers: Record<string, string> = { Accept: "application/json", ...opts.headers };
		if (opts.auth ?? true) headers.Authorization = `Bearer ${this.#token}`;
		let body: string | undefined;
		if (opts.body !== undefined) {
			body = JSON.stringify(opts.body);
			headers["Content-Type"] = "application/json";
		}

		// Fast-fail when the caller's signal is already aborted — avoids spinning
		// up a fetch + timer that the first `await` would just abort anyway.
		if (opts.signal?.aborted) {
			throw new AuthBrokerError("Auth broker request aborted", { cause: opts.signal.reason });
		}

		const url = `${this.#baseUrl}${path}`;
		const timeoutMs = opts.timeoutMs ?? this.#timeoutMs;
		let lastError: unknown;
		for (let attempt = 0; attempt <= this.#maxRetries; attempt += 1) {
			try {
				return await this.#attempt(url, { method, headers, body }, timeoutMs, opts.signal);
			} catch (error) {
				// Caller-driven abort wins over retry — the caller said stop.
				if (opts.signal?.aborted) {
					throw new AuthBrokerError("Auth broker request aborted", { cause: opts.signal.reason });
				}
				// HTTP errors (4xx/5xx) don't retry — caller knows what to do.
				if (error instanceof AuthBrokerError && error.status !== undefined) throw error;
				lastError = error;
			}
		}
		throw new AuthBrokerError(`Auth broker request failed after ${this.#maxRetries + 1} attempt(s)`, {
			cause: lastError,
		});
	}

	/** One request under its own deadline; a status other than 2xx or 304 throws with the status and body. */
	async #attempt(
		url: string,
		init: { method: string; headers: Record<string, string>; body: string | undefined },
		timeoutMs: number,
		signal: AbortSignal | undefined,
	): Promise<BrokerResponse> {
		// The scoped handle clears its timer on settle (a bare AbortSignal.timeout
		// stays armed), and the fence spans the body read — a stalled stream is
		// only interrupted by the armed signal.
		const requestTimeout = scopedTimeoutSignal(timeoutMs, signal);
		try {
			const response = await this.#fetch(url, { ...init, signal: requestTimeout.signal });
			const text = await response.text();
			if (!response.ok && response.status !== 304) {
				throw new AuthBrokerError(`Auth broker request failed: ${response.status} ${response.statusText}`, {
					status: response.status,
					body: text,
				});
			}
			return { status: response.status, headers: response.headers, text };
		} finally {
			requestTimeout.cancel();
		}
	}
}

interface BrokerResponse {
	status: number;
	headers: Headers;
	text: string;
}

/** `raw` checked against `schema`, or an {@link AuthBrokerError} carrying the schema's summary of what failed. */
function validateWire<T>(schema: (input: unknown) => unknown, raw: unknown, message: string, status?: number): T {
	const validated = schema(raw);
	if (validated instanceof type.errors) {
		throw new AuthBrokerError(message, { status, body: validated.summary });
	}
	return validated as T;
}

/** One SSE `data` payload of the snapshot stream, parsed and validated. */
function parseStreamEvent(data: string): SnapshotStreamEvent {
	let parsed: unknown;
	try {
		parsed = JSON.parse(data);
	} catch (err) {
		throw new AuthBrokerError("Auth broker stream returned malformed JSON", { body: data, cause: err });
	}
	return validateWire<SnapshotStreamEvent>(
		wireSchemas().snapshotStreamEventSchema,
		parsed,
		"Auth broker stream event failed schema validation",
	);
}

function parseJson(text: string, status: number): unknown {
	try {
		return text.length === 0 ? null : JSON.parse(text);
	} catch (parseError) {
		throw new AuthBrokerError("Auth broker returned malformed JSON", {
			status,
			body: text,
			cause: parseError,
		});
	}
}
