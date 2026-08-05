import * as AIError from "@veyyon/ai/error";
import { isAbortError, logger, readSseEvents, Snowflake } from "@veyyon/utils";
import type {
	JsonRpcError,
	JsonRpcMessage,
	JsonRpcRequest,
	JsonRpcResponse,
	MCPRequestOptions,
	MCPSseServerConfig,
	MCPTransport,
} from "../../mcp/types";
import { toJsonRpcError } from "../../mcp/types";
import { createMCPTimeout, getNeverAbortSignal, resolveMCPTimeoutMs } from "../timeout";
import { describeJsonRpcError, isUnattributableError, rejectAllPending } from "../unattributable-error";
import { rebuildMCPToolCallParamsForAttempt } from "./http";
import { mcpHttpFailureMessage } from "./http-failure";
import { reportUndeliveredServerResponse } from "./server-response-delivery";
import {
	describeMCPTarget,
	mcpEmptyResponseBodyMessage,
	mcpNotConnectedMessage,
	mcpStreamClosedMessage,
	mcpTimeoutMessage,
} from "./transport-failure";

interface MCPTimeoutOperation {
	signal?: AbortSignal;
	clear: () => void;
	isTimeoutAbort: (error: unknown) => boolean;
}

interface PendingLegacySseRequest {
	resolve: (value: unknown) => void;
	reject: (reason?: unknown) => void;
	operation: MCPTimeoutOperation;
	abortHandler?: () => void;
}

/** Legacy MCP HTTP+SSE transport from protocol revision 2024-11-05. */
export class LegacySseTransport implements MCPTransport {
	#connected = false;
	#endpointUrl: string | null = null;
	#sseConnection: AbortController | null = null;
	#pending = new Map<string | number, PendingLegacySseRequest>();
	#config: MCPSseServerConfig;

	onClose?: () => void;
	onError?: (error: Error) => void;
	onNotification?: (method: string, params: unknown) => void;
	onRequest?: (method: string, params: unknown) => Promise<unknown>;
	/** Called on 401/403 to attempt token refresh. Returns updated headers or null. */
	onAuthError?: () => Promise<Record<string, string> | null>;

	constructor(config: MCPSseServerConfig) {
		this.#config = config;
	}

	get connected(): boolean {
		return this.#connected;
	}

	get url(): string {
		return this.#config.url;
	}

	async connect(): Promise<void> {
		if (this.#connected) return;
		if (this.#sseConnection) return;

		const connection = new AbortController();
		const timeout = resolveMCPTimeoutMs(this.#config.timeout);
		const operation = createMCPTimeout(timeout, connection.signal);
		const endpointReady = Promise.withResolvers<void>();
		this.#sseConnection = connection;

		try {
			const response = await fetch(this.#config.url, {
				method: "GET",
				headers: {
					Accept: "text/event-stream",
					...this.#config.headers,
				},
				signal: operation.signal,
			});

			if (!response.ok) {
				const text = await response.text();
				throw new Error(mcpHttpFailureMessage(this.#config.url, response.status, text));
			}
			if (!response.body) {
				throw new Error(mcpEmptyResponseBodyMessage({ url: this.#config.url }));
			}

			void this.#readSSEStream(response.body, operation, endpointReady).finally(() => {
				const wasConnected = this.#connected;
				if (this.#sseConnection === connection) this.#sseConnection = null;
				if (wasConnected) this.onClose?.();
			});
			await endpointReady.promise;
		} catch (error) {
			operation.clear();
			if (this.#sseConnection === connection) this.#sseConnection = null;
			connection.abort();
			if (operation.isTimeoutAbort(error)) {
				throw new Error(
					mcpTimeoutMessage({ url: this.#config.url }, "the legacy SSE handshake (its `endpoint` event)", timeout),
				);
			}
			throw error;
		}
	}

	async #readSSEStream(
		body: ReadableStream<Uint8Array>,
		operation: MCPTimeoutOperation,
		endpointReady: PromiseWithResolvers<void>,
	): Promise<void> {
		const signal = operation.signal ?? getNeverAbortSignal();
		let endpointReceived = false;
		try {
			for await (const event of readSseEvents(body, signal)) {
				if (event.event === "endpoint") {
					if (!this.#endpointUrl) {
						const endpointUrl = new URL(event.data, this.#config.url);
						const configuredUrl = new URL(this.#config.url);
						if (endpointUrl.origin !== configuredUrl.origin) {
							// The remedy must not be "trust the new origin". This branch is
							// the defence against a server redirecting our Authorization
							// header to somewhere else, so a message that said "point the
							// url at ${endpointUrl.origin}" would talk the operator into
							// performing the attack by hand.
							throw new Error(
								`${describeMCPTarget({ url: this.#config.url })} advertised its message endpoint on a different origin: expected ${configuredUrl.origin}, received ${endpointUrl.origin}. Refusing it, because POSTing there would send this server's credentials to an origin you did not configure. Fix: do not point the config at ${endpointUrl.origin} to make this go away. Check this server's \`url\` in your MCP config, and if its operator has genuinely moved the server, verify the new origin with them before changing it.`,
							);
						}
						this.#endpointUrl = endpointUrl.href;
						this.#connected = true;
						endpointReceived = true;
						operation.clear();
						endpointReady.resolve();
					}
					continue;
				}
				if (event.data === "" || event.data === "[DONE]") continue;

				let payload: unknown;
				try {
					payload = JSON.parse(event.data) as unknown;
				} catch (error) {
					if (error instanceof SyntaxError) {
						throw new Error(
							`${describeMCPTarget({ url: this.#config.url })} sent a legacy SSE message that is not JSON: ${event.data}. Fix: this is a bug in the server; check its own logs. If the server is behind a proxy, the proxy may be rewriting the event stream.`,
						);
					}
					throw error;
				}

				const messages = Array.isArray(payload) ? payload : [payload];
				for (const message of messages) {
					if (typeof message !== "object" || message === null) continue;
					this.#dispatchMessage(message as JsonRpcMessage);
				}
			}
			if (!endpointReceived) {
				endpointReady.reject(
					new Error(
						`${describeMCPTarget({ url: this.#config.url })} opened an SSE stream but never sent the \`endpoint\` event the legacy HTTP+SSE protocol requires, so there is no address to POST requests to. Fix: this server is probably not a legacy SSE server. Change its \`type\` to \`"http"\` in your MCP config, or run \`/mcp test <name>\` to see what it does answer.`,
					),
				);
			}
		} catch (error) {
			if (!endpointReceived) {
				endpointReady.reject(error);
			} else if (error instanceof Error && !isAbortError(error)) {
				logger.debug("Legacy SSE stream error", { url: this.#config.url, error: error.message });
				this.onError?.(error);
				this.#rejectPending(error);
			}
		} finally {
			operation.clear();
			if (endpointReceived) {
				this.#rejectPending(new Error(mcpStreamClosedMessage({ url: this.#config.url }, "its SSE stream ended")));
			}
		}
	}

	#dispatchMessage(message: JsonRpcMessage): void {
		// An error the server could not attribute to a request (`"id": null`), which the spec
		// requires for a parse error. `this.#pending.get(null)` misses, so it used to fall past
		// every branch below and be dropped, and each caller waited out its timeout and reported
		// that the server had not answered. The connection cannot parse what we send, so every
		// request on it is dead.
		if (isUnattributableError(message)) {
			const error = message.error as { code: number; message: string };
			const failed = rejectAllPending(this.#pending, error, request => {
				request.operation.clear();
				if (request.abortHandler) request.operation.signal?.removeEventListener("abort", request.abortHandler);
			});
			logger.warn("MCP server reported an error it could not attribute to a request", {
				server: this.#config.url,
				code: error.code,
				message: error.message,
				failedRequests: failed,
			});
			this.onError?.(new Error(describeJsonRpcError(error)));
			return;
		}
		if ("id" in message && message.id != null && ("result" in message || "error" in message)) {
			const pending = this.#pending.get(message.id);
			if (pending) {
				this.#pending.delete(message.id);
				pending.operation.clear();
				if (pending.abortHandler) pending.operation.signal?.removeEventListener("abort", pending.abortHandler);
				const response = message as JsonRpcResponse;
				if (response.error) {
					pending.reject(new Error(`MCP error ${response.error.code}: ${response.error.message}`));
				} else {
					pending.resolve(response.result);
				}
				return;
			}
		}
		if ("method" in message && "id" in message && message.id != null) {
			void this.#handleServerRequest(message as JsonRpcRequest);
			return;
		}
		if ("method" in message && !("id" in message)) {
			this.onNotification?.(message.method, message.params);
		}
	}

	async request<T = unknown>(
		method: string,
		params?: Record<string, unknown>,
		options?: MCPRequestOptions,
	): Promise<T> {
		if (!this.#connected || !this.#endpointUrl) {
			throw new Error(mcpNotConnectedMessage({ url: this.#config.url }, `request "${method}"`));
		}

		const id = Snowflake.next();
		const body = {
			jsonrpc: "2.0" as const,
			id,
			method,
			params: params ?? {},
		};
		const timeout = resolveMCPTimeoutMs(this.#config.timeout);
		const operation = createMCPTimeout(timeout, options?.signal);
		const deferred = Promise.withResolvers<unknown>();
		// Observe the response promise synchronously so a stream-close rejection
		// from `#rejectPending` that lands while `request()` is still awaiting the
		// POST round-trip is never flagged as an unhandled rejection. The real
		// `await deferred.promise` below still receives and propagates the error.
		void deferred.promise.catch(() => undefined);
		const pending: PendingLegacySseRequest = {
			resolve: deferred.resolve,
			reject: deferred.reject,
			operation,
		};
		if (operation.signal) {
			pending.abortHandler = () => {
				this.#pending.delete(id);
				operation.clear();
				deferred.reject(
					options?.signal?.aborted && options.signal.reason instanceof Error
						? options.signal.reason
						: new Error(mcpTimeoutMessage({ url: this.#config.url }, `request "${method}"`, timeout)),
				);
			};
			operation.signal.addEventListener("abort", pending.abortHandler, { once: true });
		}
		this.#pending.set(id, pending);

		try {
			const response = await this.#postJson(body, operation.signal);
			if (!response.ok) {
				const text = await response.text();
				throw new Error(mcpHttpFailureMessage(this.#config.url, response.status, text));
			}
			await response.body?.cancel();
			return (await deferred.promise) as T;
		} catch (error) {
			this.#pending.delete(id);
			operation.clear();
			if (pending.abortHandler) operation.signal?.removeEventListener("abort", pending.abortHandler);
			if (operation.isTimeoutAbort(error)) {
				throw new Error(mcpTimeoutMessage({ url: this.#config.url }, `request "${method}"`, timeout));
			}
			throw error;
		}
	}

	async notify(method: string, params?: Record<string, unknown>): Promise<void> {
		if (!this.#connected || !this.#endpointUrl) {
			throw new Error(mcpNotConnectedMessage({ url: this.#config.url }, `notification "${method}"`));
		}

		const timeout = resolveMCPTimeoutMs(this.#config.timeout);
		const operation = createMCPTimeout(timeout);
		try {
			const response = await this.#postJson(
				{
					jsonrpc: "2.0" as const,
					method,
					params: params ?? {},
				},
				operation.signal,
			);
			operation.clear();
			if (!response.ok) {
				const text = await response.text();
				throw new Error(mcpHttpFailureMessage(this.#config.url, response.status, text));
			}
			await response.body?.cancel();
		} catch (error) {
			operation.clear();
			if (operation.isTimeoutAbort(error)) {
				throw new Error(mcpTimeoutMessage({ url: this.#config.url }, `notification "${method}"`, timeout));
			}
			throw error;
		}
	}

	async #postJson(
		body: JsonRpcRequest | JsonRpcResponse | { jsonrpc: "2.0"; method: string; params: Record<string, unknown> },
		signal?: AbortSignal,
	): Promise<Response> {
		const endpointUrl = this.#endpointUrl;
		if (!endpointUrl) throw new Error(mcpNotConnectedMessage({ url: this.#config.url }, "POST"));
		let headers: Record<string, string> = {
			"Content-Type": "application/json",
			Accept: "application/json, text/event-stream",
			...this.#config.headers,
		};
		let response = await fetch(endpointUrl, {
			method: "POST",
			headers,
			body: JSON.stringify(body),
			signal,
		});
		const status = AIError.status(response);
		if (!this.onAuthError || (status !== 401 && status !== 403)) return response;

		const refreshedHeaders = await this.onAuthError();
		if (!refreshedHeaders) return response;
		await response.body?.cancel();
		this.#config.headers = refreshedHeaders;
		headers = {
			"Content-Type": "application/json",
			Accept: "application/json, text/event-stream",
			...this.#config.headers,
		};
		let retryBody: typeof body = body;
		if ("params" in body) {
			const retryParams = await rebuildMCPToolCallParamsForAttempt(body.params);
			retryBody = { ...body, params: retryParams } as typeof body;
		}
		response = await fetch(endpointUrl, {
			method: "POST",
			headers,
			body: JSON.stringify(retryBody),
			signal,
		});
		return response;
	}

	async #handleServerRequest(request: JsonRpcRequest): Promise<void> {
		if (!this.onRequest) {
			await this.#sendServerResponse(request.id, undefined, { code: -32601, message: "Method not found" });
			return;
		}
		try {
			const result = await this.onRequest(request.method, request.params);
			await this.#sendServerResponse(request.id, result);
		} catch (error) {
			await this.#sendServerResponse(request.id, undefined, toJsonRpcError(error));
		}
	}

	/**
	 * POST a JSON-RPC response back to the server.
	 *
	 * Same contract, and same fix, as the streamable-HTTP transport: a dropped
	 * reply leaves the server waiting on an answer we computed and discarded, so
	 * the undelivered reply is reported rather than swallowed (Law 10).
	 */
	async #sendServerResponse(id: string | number, result?: unknown, error?: JsonRpcError): Promise<void> {
		if (!this.#connected) return;
		const timeout = resolveMCPTimeoutMs(this.#config.timeout);
		const operation = createMCPTimeout(timeout);
		try {
			const response = await this.#postJson(
				error ? { jsonrpc: "2.0" as const, id, error } : { jsonrpc: "2.0" as const, id, result: result ?? {} },
				operation.signal,
			);
			operation.clear();
			await response.body?.cancel();
		} catch (sendError) {
			operation.clear();
			reportUndeliveredServerResponse({
				url: this.#config.url,
				requestId: id,
				kind: error ? "error" : "result",
				cause: sendError,
			});
		}
	}

	#rejectPending(error: Error): void {
		for (const [id, pending] of this.#pending) {
			this.#pending.delete(id);
			pending.operation.clear();
			if (pending.abortHandler) pending.operation.signal?.removeEventListener("abort", pending.abortHandler);
			pending.reject(error);
		}
	}

	async close(): Promise<void> {
		if (!this.#connected && !this.#sseConnection) return;
		const wasConnected = this.#connected;
		this.#connected = false;
		this.#endpointUrl = null;
		if (this.#sseConnection) {
			this.#sseConnection.abort();
			this.#sseConnection = null;
		}
		this.#rejectPending(
			new Error(
				`${describeMCPTarget({ url: this.#config.url })} was disconnected by this client while requests were still in flight, so they failed. Fix: if you did not expect this, run \`/mcp reconnect <name>\` and retry; \`/mcp list\` gives the name.`,
			),
		);
		if (wasConnected) this.onClose?.();
		this.onClose = undefined;
	}
}

/** Create and connect a legacy HTTP+SSE transport. */
export async function createSseTransport(config: MCPSseServerConfig): Promise<LegacySseTransport> {
	const transport = new LegacySseTransport(config);
	await transport.connect();
	return transport;
}
