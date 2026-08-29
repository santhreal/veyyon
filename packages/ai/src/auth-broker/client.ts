import { scopedTimeoutSignal } from "@veyyon/utils/scoped-timeout";
import { readSseEvents } from "@veyyon/utils/stream";
import { trimTrailingSlashes } from "@veyyon/utils/url";
import { type } from "arktype";
import type { AuthCredential } from "../auth-storage";
import { AuthBrokerError, AuthBrokerStreamUnsupportedError } from "../error/classes";
import type { AuthBrokerClientOptions, FetchSnapshotOptions, FetchSnapshotResult } from "./client-helpers";

export * from "./client-helpers";

import { DEFAULT_MAX_RETRIES, DEFAULT_TIMEOUT_MS } from "./client-helpers";
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
		return this.#fetchSnapshotResult(opts);
	}
	async #fetchSnapshotResult(opts: FetchSnapshotOptions): Promise<FetchSnapshotResult> {
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
		const raw = this.#parseJson(response.text, response.status);
		const validated = wireSchemas().snapshotResponseSchema(raw);
		if (validated instanceof type.errors) {
			throw new AuthBrokerError("Auth broker response failed schema validation", {
				status: response.status,
				body: validated.summary,
			});
		}
		const snapshot = validated as SnapshotResponse;
		return { status: 200, snapshot, generation: etagGeneration ?? snapshot.generation };
	}

	async *openSnapshotStream(opts: { signal?: AbortSignal } = {}): AsyncGenerator<SnapshotStreamEvent> {
		const url = `${this.#baseUrl}/v1/snapshot/stream`;
		const headers: Record<string, string> = {
			Accept: "text/event-stream",
			Authorization: `Bearer ${this.#token}`,
		};
		if (opts.signal?.aborted) {
			throw new AuthBrokerError("Auth broker request aborted", { cause: opts.signal.reason });
		}
		const response = await this.#fetch(url, { method: "GET", headers, signal: opts.signal });
		if (response.status === 404) {
			await response.text().catch(() => {});
			throw new AuthBrokerStreamUnsupportedError();
		}
		if (!response.ok) {
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
			await response.body.cancel().catch(() => {});
			throw new AuthBrokerError("Auth broker stream returned non-SSE response", {
				status: response.status,
				body: contentType ?? "",
			});
		}

		let sawFirstEvent = false;
		for await (const sse of readSseEvents(response.body, opts.signal)) {
			if (sse.event === null && sse.data === "") continue; // keepalive comment frames
			let parsed: unknown;
			try {
				parsed = JSON.parse(sse.data);
			} catch (err) {
				throw new AuthBrokerError("Auth broker stream returned malformed JSON", {
					body: sse.data,
					cause: err,
				});
			}
			const validated = wireSchemas().snapshotStreamEventSchema(parsed);
			if (validated instanceof type.errors) {
				throw new AuthBrokerError("Auth broker stream event failed schema validation", {
					body: validated.summary,
				});
			}
			const event = validated as SnapshotStreamEvent;
			if (!sawFirstEvent) {
				sawFirstEvent = true;
				if (event.kind !== "snapshot") {
					throw new AuthBrokerError("Auth broker stream did not start with snapshot", { body: sse.data });
				}
			}
			yield event;
		}
		if (!opts.signal?.aborted) {
			throw new AuthBrokerError(
				sawFirstEvent
					? "Auth broker stream ended unexpectedly"
					: "Auth broker stream ended before initial snapshot",
				{ status: response.status },
			);
		}
	}

	fetchUsage(signal?: AbortSignal): Promise<UsageResponse> {
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
		const raw = this.#parseJson(response.text, response.status);
		const validated = opts.schema(raw);
		if (validated instanceof type.errors) {
			throw new AuthBrokerError("Auth broker response failed schema validation", {
				status: response.status,
				body: validated.summary,
			});
		}
		return validated as t;
	}

	#parseJson(text: string, status: number): unknown {
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
	): Promise<{ status: number; headers: Headers; text: string }> {
		const auth = opts.auth ?? true;
		const url = `${this.#baseUrl}${path}`;
		const headers: Record<string, string> = { Accept: "application/json", ...(opts.headers ?? {}) };
		if (auth) headers.Authorization = `Bearer ${this.#token}`;
		let payload: string | undefined;
		if (opts.body !== undefined) {
			payload = JSON.stringify(opts.body);
			headers["Content-Type"] = "application/json";
		}

		if (opts.signal?.aborted) {
			throw new AuthBrokerError("Auth broker request aborted", { cause: opts.signal.reason });
		}

		let lastError: unknown;
		for (let attempt = 0; attempt <= this.#maxRetries; attempt += 1) {
			const requestTimeout = scopedTimeoutSignal(opts.timeoutMs ?? this.#timeoutMs, opts.signal);
			try {
				const response = await this.#fetch(url, {
					method,
					headers,
					body: payload,
					signal: requestTimeout.signal,
				});
				if (!response.ok && response.status !== 304) {
					const text = await response.text();
					throw new AuthBrokerError(`Auth broker request failed: ${response.status} ${response.statusText}`, {
						status: response.status,
						body: text,
					});
				}
				const text = await response.text();
				return { status: response.status, headers: response.headers, text };
			} catch (error) {
				lastError = error;
				if (opts.signal?.aborted) {
					throw new AuthBrokerError("Auth broker request aborted", { cause: opts.signal.reason });
				}
				if (error instanceof AuthBrokerError && error.status !== undefined) {
					throw error;
				}
				if (attempt >= this.#maxRetries) break;
			} finally {
				requestTimeout.cancel();
			}
		}
		throw new AuthBrokerError(`Auth broker request failed after ${this.#maxRetries + 1} attempt(s)`, {
			cause: lastError,
		});
	}
}
