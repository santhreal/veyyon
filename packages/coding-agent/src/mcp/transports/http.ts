import * as AIError from "@veyyon/ai/error";
import { isAbortError, logger, readSseJson, Snowflake } from "@veyyon/utils";
import { isRecord } from "@veyyon/utils/type-guards";
import type {
	JsonRpcError,
	JsonRpcMessage,
	JsonRpcRequest,
	JsonRpcResponse,
	MCPHttpServerConfig,
	MCPRequestOptions,
	MCPSseServerConfig,
	MCPTransport,
} from "../../mcp/types";
import { toJsonRpcError } from "../../mcp/types";
import { createMCPTimeout, getNeverAbortSignal, isMCPTimeoutEnabled, resolveMCPTimeoutMs } from "../timeout";
import { mcpHttpFailureMessage } from "./http-failure";
import { reportUndeliveredServerResponse } from "./server-response-delivery";
import {
	mcpEmptyResponseBodyMessage,
	mcpNoResponseForRequestMessage,
	mcpNotConnectedMessage,
	mcpTimeoutMessage,
} from "./transport-failure";

const HTTP_SSE_CONNECT_TIMEOUT_MS = 1_000;

const mcpToolArgsAttemptFactory = Symbol("mcpToolArgsAttemptFactory");

type MCPToolArgsAttemptFactory = () => Promise<Record<string, unknown>>;

type MCPToolArgsWithAttemptFactory = Record<string, unknown> & {
	[mcpToolArgsAttemptFactory]?: MCPToolArgsAttemptFactory;
};

export function retainMCPToolArgsAttemptFactory(
	args: Record<string, unknown>,
	attemptFactory: MCPToolArgsAttemptFactory,
): Record<string, unknown> {
	Object.defineProperty(args, mcpToolArgsAttemptFactory, {
		value: attemptFactory,
		configurable: false,
		enumerable: false,
		writable: false,
	});
	return args;
}

export async function rebuildMCPToolCallParamsForAttempt(
	params: Record<string, unknown> | undefined,
): Promise<Record<string, unknown> | undefined> {
	const args = params?.arguments;
	if (!isRecord(args)) return params;
	const attemptFactory = (args as MCPToolArgsWithAttemptFactory)[mcpToolArgsAttemptFactory];
	if (!attemptFactory) return params;
	return { ...params, arguments: await attemptFactory() };
}
export function resolveSSEConnectTimeoutMs(configTimeout?: number): number {
	const requestTimeout = resolveMCPTimeoutMs(configTimeout);
	if (!isMCPTimeoutEnabled(requestTimeout)) return 0;
	const boundedTimeout = Math.min(HTTP_SSE_CONNECT_TIMEOUT_MS, Math.floor(requestTimeout / 4));
	return Math.max(1, boundedTimeout);
}
export class HttpTransport implements MCPTransport {
	#connected = false;
	#sessionId: string | null = null;
	#sseConnection: AbortController | null = null;

	onClose?: () => void;
	onError?: (error: Error) => void;
	onNotification?: (method: string, params: unknown) => void;
	onRequest?: (method: string, params: unknown) => Promise<unknown>;
	onAuthError?: () => Promise<Record<string, string> | null>;

	constructor(private config: MCPHttpServerConfig | MCPSseServerConfig) {}

	get connected(): boolean {
		return this.#connected;
	}

	get url(): string {
		return this.config.url;
	}

	async connect(): Promise<void> {
		if (this.#connected) return;
		this.#connected = true;
	}

	async startSSEListener(): Promise<void> {
		if (!this.#connected) return;
		if (this.#sseConnection) return;

		this.#sseConnection = new AbortController();
		const headers: Record<string, string> = {
			Accept: "text/event-stream",
			...this.config.headers,
		};

		if (this.#sessionId) {
			headers["Mcp-Session-Id"] = this.#sessionId;
		}

		let response: Response | null;
		let timedOut = false;
		let startupFinished = false;
		const connection = this.#sseConnection;
		const startupTimeoutMs = resolveSSEConnectTimeoutMs(this.config.timeout);
		const fetchPromise = fetch(this.config.url, {
			method: "GET",
			headers,
			signal: connection.signal,
		});
		const timeoutPromise =
			startupTimeoutMs > 0
				? new Promise<null>(resolve => {
						setTimeout(() => {
							if (!startupFinished) {
								timedOut = true;
								connection.abort();
							}
							resolve(null);
						}, startupTimeoutMs);
					})
				: null;
		try {
			response = timeoutPromise === null ? await fetchPromise : await Promise.race([fetchPromise, timeoutPromise]);
		} catch (error) {
			if (this.#sseConnection === connection) this.#sseConnection = null;
			if (error instanceof Error && !isAbortError(error) && !timedOut) {
				this.onError?.(error);
			}
			return;
		} finally {
			startupFinished = true;
		}
		if (response === null) {
			if (this.#sseConnection === connection) this.#sseConnection = null;
			void fetchPromise.then(lateResponse => lateResponse.body?.cancel()).catch(() => {});
			return;
		}

		if (this.#sseConnection !== connection) {
			await response.body?.cancel();
			return;
		}
		if (response.status === 405 || !response.ok || !response.body) {
			await response.body?.cancel();
			if (this.#sseConnection === connection) this.#sseConnection = null;
			return;
		}

		const signal = connection.signal;
		void this.#readSSEStream(response.body!, signal).finally(() => {
			const wasConnected = this.#connected;
			if (this.#sseConnection === connection) this.#sseConnection = null;
			if (wasConnected) this.onClose?.();
		});
	}
	async #readSSEStream(body: ReadableStream<Uint8Array>, signal: AbortSignal): Promise<void> {
		try {
			for await (const message of readSseJson<JsonRpcMessage>(body, signal)) {
				if (!this.#connected) break;
				this.#dispatchSSEMessage(message);
			}
		} catch (error) {
			if (error instanceof Error && !isAbortError(error)) {
				logger.debug("HTTP SSE stream error", { url: this.config.url, error: error.message });
				this.onError?.(error);
			}
		}
	}

	#dispatchSSEMessage(message: JsonRpcMessage | JsonRpcMessage[]): void {
		if (Array.isArray(message)) {
			for (const m of message) this.#dispatchSSEMessage(m);
			return;
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
		try {
			return await this.#executeRequest<T>(method, params, options);
		} catch (error) {
			const status = error instanceof Error ? AIError.status(error) : undefined;
			if (this.onAuthError && (status === 401 || status === 403)) {
				const newHeaders = await this.onAuthError();
				if (newHeaders) {
					this.config = { ...this.config, headers: newHeaders };
					const retryParams = await rebuildMCPToolCallParamsForAttempt(params);
					return this.#executeRequest<T>(method, retryParams, options);
				}
			}
			throw error;
		}
	}

	async #executeRequest<T>(
		method: string,
		params: Record<string, unknown> | undefined,
		options: MCPRequestOptions | undefined,
	): Promise<T> {
		if (!this.#connected) {
			throw new Error(mcpNotConnectedMessage({ url: this.config.url }, `request "${method}"`));
		}

		const id = Snowflake.next();
		const body = {
			jsonrpc: "2.0" as const,
			id,
			method,
			params: params ?? {},
		};

		const headers: Record<string, string> = {
			"Content-Type": "application/json",
			Accept: "application/json, text/event-stream",
			...this.config.headers,
		};

		if (this.#sessionId) {
			headers["Mcp-Session-Id"] = this.#sessionId;
		}

		const timeout = resolveMCPTimeoutMs(this.config.timeout);
		const operation = createMCPTimeout(timeout, options?.signal);

		try {
			const response = await fetch(this.config.url, {
				method: "POST",
				headers,
				body: JSON.stringify(body),
				signal: operation.signal,
			});

			const newSessionId = response.headers.get("Mcp-Session-Id");
			if (newSessionId) {
				this.#sessionId = newSessionId;
			}

			if (!response.ok) {
				const text = await response.text();
				const wwwAuthenticate = response.headers.get("WWW-Authenticate");
				const mcpAuthServer = response.headers.get("Mcp-Auth-Server");
				const authHints = [
					wwwAuthenticate ? `WWW-Authenticate: ${wwwAuthenticate}` : null,
					mcpAuthServer ? `Mcp-Auth-Server: ${mcpAuthServer}` : null,
				]
					.filter(Boolean)
					.join("; ");
				throw new Error(mcpHttpFailureMessage(this.config.url, response.status, text, authHints || undefined));
			}

			const contentType = response.headers.get("Content-Type") ?? "";

			if (contentType.includes("text/event-stream")) {
				return this.#parseSSEResponse<T>(response, id, options);
			}

			const result = (await response.json()) as JsonRpcResponse;

			if (result.error) {
				throw new Error(`MCP error ${result.error.code}: ${result.error.message}`);
			}

			return result.result as T;
		} catch (error) {
			if (operation.isTimeoutAbort(error)) {
				throw new Error(mcpTimeoutMessage({ url: this.config.url }, `request "${method}"`, timeout));
			}
			throw error;
		} finally {
			operation.clear();
		}
	}

	#parseSSEResponse<T>(response: Response, expectedId: string | number, options?: MCPRequestOptions): Promise<T> {
		if (!response.body) {
			throw new Error(mcpEmptyResponseBodyMessage({ url: this.config.url }));
		}

		const timeout = resolveMCPTimeoutMs(this.config.timeout);
		const operation = createMCPTimeout(timeout, options?.signal);
		const signal = operation.signal ?? getNeverAbortSignal();

		const { promise, resolve, reject } = Promise.withResolvers<T>();
		let captured = false;

		const drain = async (): Promise<void> => {
			try {
				for await (const raw of readSseJson<JsonRpcMessage | JsonRpcMessage[]>(response.body!, signal)) {
					const messages = Array.isArray(raw) ? raw : [raw];
					for (const message of messages) {
						if (
							!captured &&
							"id" in message &&
							message.id === expectedId &&
							("result" in message || "error" in message)
						) {
							captured = true;
							operation.clear();
							if (message.error) {
								reject(new Error(`MCP error ${message.error.code}: ${message.error.message}`));
							} else {
								resolve(message.result as T);
							}
							continue;
						}
						if (!this.#connected) continue;
						this.#dispatchSSEMessage(message);
					}
				}
				if (!captured) {
					reject(new Error(mcpNoResponseForRequestMessage({ url: this.config.url }, expectedId)));
				}
			} catch (error) {
				if (captured) return;
				if (operation.isTimeoutAbort(error)) {
					reject(
						new Error(
							mcpTimeoutMessage({ url: this.config.url }, "its streamed response to this request", timeout),
						),
					);
				} else {
					reject(error as Error);
				}
			} finally {
				operation.clear();
			}
		};

		void drain();
		return promise;
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

	async #sendServerResponse(id: string | number, result?: unknown, error?: JsonRpcError): Promise<void> {
		if (!this.#connected) return;
		const body = error
			? { jsonrpc: "2.0" as const, id, error }
			: { jsonrpc: "2.0" as const, id, result: result ?? {} };
		const headers: Record<string, string> = {
			"Content-Type": "application/json",
			Accept: "application/json, text/event-stream",
			...this.config.headers,
		};
		if (this.#sessionId) {
			headers["Mcp-Session-Id"] = this.#sessionId;
		}
		const timeout = resolveMCPTimeoutMs(this.config.timeout);
		const operation = createMCPTimeout(timeout);
		try {
			const resp = await fetch(this.config.url, {
				method: "POST",
				headers,
				body: JSON.stringify(body),
				signal: operation.signal,
			});
			if (this.onAuthError && (resp.status === 401 || resp.status === 403)) {
				await resp.body?.cancel();
				const newHeaders = await this.onAuthError();
				if (newHeaders) {
					this.config.headers ??= {};
					Object.assign(this.config.headers, newHeaders);
					Object.assign(headers, newHeaders);
					operation.clear();
					const retryOperation = createMCPTimeout(timeout);
					try {
						const retry = await fetch(this.config.url, {
							method: "POST",
							headers,
							body: JSON.stringify(body),
							signal: retryOperation.signal,
						});
						await retry.body?.cancel();
					} finally {
						retryOperation.clear();
					}
					return;
				}
			}
			await resp.body?.cancel();
		} catch (sendError) {
			reportUndeliveredServerResponse({
				url: this.config.url,
				requestId: id,
				kind: error ? "error" : "result",
				cause: sendError,
			});
		} finally {
			operation.clear();
		}
	}

	async notify(method: string, params?: Record<string, unknown>): Promise<void> {
		if (!this.#connected) {
			throw new Error(mcpNotConnectedMessage({ url: this.config.url }, `notification "${method}"`));
		}

		const body = {
			jsonrpc: "2.0" as const,
			method,
			params: params ?? {},
		};

		const headers: Record<string, string> = {
			"Content-Type": "application/json",
			Accept: "application/json, text/event-stream",
			...this.config.headers,
		};

		if (this.#sessionId) {
			headers["Mcp-Session-Id"] = this.#sessionId;
		}

		const timeout = resolveMCPTimeoutMs(this.config.timeout);
		const operation = createMCPTimeout(timeout);

		try {
			const response = await fetch(this.config.url, {
				method: "POST",
				headers,
				body: JSON.stringify(body),
				signal: operation.signal,
			});

			if (!response.ok && response.status !== 202) {
				const text = await response.text();
				throw new Error(mcpHttpFailureMessage(this.config.url, response.status, text));
			}

			const contentType = response.headers.get("Content-Type") ?? "";
			if (contentType.includes("text/event-stream") && response.body) {
				if (this.#sseConnection) {
					void this.#readSSEStream(response.body, this.#sseConnection.signal);
				} else {
					const readOperation = createMCPTimeout(timeout);
					const signal = readOperation.signal ?? getNeverAbortSignal();
					void this.#readSSEStream(response.body, signal).finally(() => readOperation.clear());
				}
			} else {
				await response.body?.cancel();
			}
		} catch (error) {
			if (operation.isTimeoutAbort(error)) {
				throw new Error(mcpTimeoutMessage({ url: this.config.url }, `notification "${method}"`, timeout));
			}
			throw error;
		} finally {
			operation.clear();
		}
	}

	async close(): Promise<void> {
		if (!this.#connected) return;
		this.#connected = false;

		if (this.#sseConnection) {
			this.#sseConnection.abort();
			this.#sseConnection = null;
		}

		if (this.#sessionId) {
			const timeout = resolveMCPTimeoutMs(this.config.timeout);
			const operation = createMCPTimeout(timeout);
			try {
				const headers: Record<string, string> = {
					...this.config.headers,
					"Mcp-Session-Id": this.#sessionId,
				};

				await fetch(this.config.url, {
					method: "DELETE",
					headers,
					signal: operation.signal,
				});
				operation.clear();
			} catch {
				operation.clear();
			}
			this.#sessionId = null;
		}

		this.onClose?.();
		this.onClose = undefined;
	}
}

export async function createHttpTransport(config: MCPHttpServerConfig | MCPSseServerConfig): Promise<HttpTransport> {
	const transport = new HttpTransport(config);
	await transport.connect();
	return transport;
}
