import { errorMessage, getProjectDir, isThenable, logger, readJsonl, Snowflake, truncate } from "@veyyon/utils";
import { RingBuffer } from "@veyyon/utils/ring";
import type { Subprocess } from "bun";
import { hostHasInheritableConsole } from "../../eval/py/spawn-options";
import type {
	JsonRpcError,
	JsonRpcMessage,
	JsonRpcRequest,
	JsonRpcResponse,
	MCPRequestOptions,
	MCPStdioServerConfig,
	MCPTransport,
} from "../../mcp/types";
import { toJsonRpcError } from "../../mcp/types";
import { buildMcpChildEnv } from "../child-environment";
import { isMCPTimeoutEnabled, resolveMCPTimeoutMs } from "../timeout";
import { describeJsonRpcError, isUnattributableError, rejectAllPending } from "../unattributable-error";
import { terminateMcpServerTree } from "./process-tree";
import {
	resolveStdioSpawnCommand,
	STDERR_TAIL_LINE_CHARS,
	STDERR_TAIL_LINES,
	STDIO_CLOSED_FIX,
	writeFrame,
} from "./stdio-helpers";
import { mcpNotConnectedMessage, mcpTimeoutMessage } from "./transport-failure";

export { resolveStdioSpawnCommand, writeFrame };

export class StdioTransport implements MCPTransport {
	#process: Subprocess<"pipe", "pipe", "pipe"> | null = null;
	#stderrTail = new RingBuffer<string>(STDERR_TAIL_LINES);
	#exitStatus: { code: number | null; signal: string | null } | null = null;
	#pendingRequests = new Map<
		string | number,
		{
			resolve: (value: unknown) => void;
			reject: (error: Error) => void;
		}
	>();
	#connected = false;
	#readLoop: Promise<void> | null = null;

	onClose?: () => void;
	onError?: (error: Error) => void;
	onNotification?: (method: string, params: unknown) => void;
	onRequest?: (method: string, params: unknown) => Promise<unknown>;
	onSpawnPid?: (pid: number) => void;
	beforeSpawn?: () => Promise<void>;

	constructor(private config: MCPStdioServerConfig) {}

	get connected(): boolean {
		return this.#connected;
	}

	async connect(): Promise<void> {
		if (this.#connected) return;

		const { env, withheld, inherited } = buildMcpChildEnv(this.config, Bun.env, process.platform);
		if (inherited) {
			logger.warn("MCP server spawned with the whole environment", {
				command: this.config.command,
				reason: "inheritEnv is set for this server, so every ambient credential is readable by it",
			});
		} else if (withheld.length > 0) {
			logger.debug("MCP server environment bounded", { command: this.config.command, withheld });
		}
		const cwd = this.config.cwd ?? getProjectDir();
		const spawnCommand = await resolveStdioSpawnCommand(this.config, {
			cwd,
			env,
			platform: process.platform,
			hostHasInheritableConsole: hostHasInheritableConsole(),
		});

		await this.beforeSpawn?.();
		this.#process = Bun.spawn(spawnCommand.cmd, {
			cwd,
			env,
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
			windowsHide: spawnCommand.windowsHide,
			detached: spawnCommand.detached,
		});
		this.onSpawnPid?.(this.#process.pid);

		this.#connected = true;

		void this.#process.exited.then(
			code => {
				this.#exitStatus = { code, signal: this.#process?.signalCode ?? null };
			},
			() => {},
		);

		this.#readLoop = this.#startReadLoop();

		this.#startStderrLoop();
	}

	async #startReadLoop(): Promise<void> {
		if (!this.#process?.stdout) return;
		try {
			for await (const line of readJsonl(this.#process.stdout)) {
				if (!this.#connected) break;
				try {
					this.#handleMessage(line as JsonRpcMessage);
				} catch (error) {
					logger.warn("Ignored an unreadable message from an MCP server", {
						server: this.config.command,
						error: errorMessage(error),
						line: truncate(String(JSON.stringify(line) ?? line), 500),
						fix: "If a tool call from this server hangs, this is likely why. Check the server's own logs.",
					});
				}
			}
		} catch (error) {
			if (this.#connected) {
				this.onError?.(error instanceof Error ? error : new Error(String(error)));
			}
		} finally {
			this.#handleClose();
		}
	}

	async #startStderrLoop(): Promise<void> {
		if (!this.#process?.stderr) return;

		const reader = this.#process.stderr.getReader();
		const decoder = new TextDecoder();

		try {
			while (this.#connected) {
				const { done, value } = await reader.read();
				if (done) break;
				const text = decoder.decode(value, { stream: true });
				if (text.trim()) {
					logger.debug("MCP server stderr", { server: this.config.command, text: text.trimEnd() });
					for (const line of text.split("\n")) {
						const trimmed = line.trim();
						if (trimmed) this.#stderrTail.push(truncate(trimmed, STDERR_TAIL_LINE_CHARS));
					}
				}
			}
		} catch (error) {
			logger.debug("Stopped reading an MCP server's stderr", {
				server: this.config.command,
				error: errorMessage(error),
			});
		} finally {
			reader.releaseLock();
		}
	}

	#handleMessage(message: JsonRpcMessage | JsonRpcMessage[]): void {
		if (Array.isArray(message)) {
			for (const m of message) this.#handleMessage(m);
			return;
		}
		if (isUnattributableError(message)) {
			const error = message.error as { code: number; message: string };
			const failed = rejectAllPending(this.#pendingRequests, error);
			logger.warn("MCP server reported an error it could not attribute to a request", {
				server: this.config.command,
				code: error.code,
				message: error.message,
				failedRequests: failed,
			});
			this.onError?.(new Error(describeJsonRpcError(error)));
			return;
		}

		if ("method" in message && "id" in message && message.id != null) {
			void this.#handleServerRequest(message as JsonRpcRequest);
			return;
		}

		if ("id" in message && message.id != null) {
			const response = message as JsonRpcResponse;
			const responseId = response.id as string | number;
			const pending = this.#pendingRequests.get(responseId);
			if (pending) {
				this.#pendingRequests.delete(responseId);
				if (response.error) {
					pending.reject(new Error(`MCP error ${response.error.code}: ${response.error.message}`));
				} else {
					pending.resolve(response.result);
				}
			}
			return;
		}

		if ("method" in message) {
			const notification = message as { method: string; params?: unknown };
			this.onNotification?.(notification.method, notification.params);
		}
	}

	async #handleServerRequest(request: JsonRpcRequest): Promise<void> {
		try {
			if (!this.onRequest) {
				this.#sendResponse(request.id, undefined, { code: -32601, message: "Method not found" });
				return;
			}
			const result = await this.onRequest(request.method, request.params);
			this.#sendResponse(request.id, result);
		} catch (error) {
			this.#sendResponse(request.id, undefined, toJsonRpcError(error));
		}
	}

	#sendResponse(id: string | number, result?: unknown, error?: JsonRpcError): void {
		if (!this.#connected || !this.#process?.stdin) return;
		const response = error
			? { jsonrpc: "2.0" as const, id, error }
			: { jsonrpc: "2.0" as const, id, result: result ?? {} };
		writeFrame(this.#process.stdin, `${JSON.stringify(response)}\n`);
	}

	#describeClose(): string {
		const parts = [`MCP server "${this.config.command}" closed its connection`];
		const exitCode = this.#exitStatus?.code ?? this.#process?.exitCode ?? null;
		const signal = this.#exitStatus?.signal ?? this.#process?.signalCode ?? null;
		if (signal) parts.push(`(killed by ${signal})`);
		else if (exitCode !== null) parts.push(`(exit code ${exitCode})`);
		const tail = this.#stderrTail.toArray();
		if (tail.length > 0) {
			parts.push(`Last output from the server:\n${tail.join("\n")}`);
		} else {
			parts.push("The server produced no output explaining why.");
		}
		parts.push(STDIO_CLOSED_FIX);
		return parts.join(" ");
	}

	#handleClose(): void {
		if (!this.#connected) return;
		this.#connected = false;

		const reason = this.#describeClose();
		for (const [, pending] of this.#pendingRequests) {
			pending.reject(new Error(reason));
		}
		this.#pendingRequests.clear();

		this.onClose?.();
	}

	async request<T = unknown>(
		method: string,
		params?: Record<string, unknown>,
		options?: MCPRequestOptions,
	): Promise<T> {
		if (!this.#connected || !this.#process?.stdin) {
			throw new Error(
				this.#process
					? this.#describeClose()
					: mcpNotConnectedMessage({ command: this.config.command }, `request "${method}"`),
			);
		}

		const id = Snowflake.next();
		const request = {
			jsonrpc: "2.0" as const,
			id,
			method,
			params: params ?? {},
		};

		const timeout = resolveMCPTimeoutMs(this.config.timeout);
		const signal = options?.signal;

		if (signal?.aborted) {
			const reason = signal.reason instanceof Error ? signal.reason : new Error("Aborted");
			return Promise.reject(reason);
		}

		const { promise, resolve, reject } = Promise.withResolvers<T>();
		let timer: NodeJS.Timeout | undefined;
		let settled = false;

		const cleanup = () => {
			if (settled) return;
			settled = true;
			if (timer) {
				clearTimeout(timer);
				timer = undefined;
			}
			if (signal) {
				signal.removeEventListener("abort", onAbort);
			}
			this.#pendingRequests.delete(id);
		};

		const onAbort = () => {
			cleanup();
			const reason = signal?.reason instanceof Error ? signal.reason : new Error("Aborted");
			reject(reason);
		};

		if (signal) {
			signal.addEventListener("abort", onAbort, { once: true });
		}

		this.#pendingRequests.set(id, {
			resolve: (value: unknown) => {
				cleanup();
				resolve(value as T);
			},
			reject: (error: Error) => {
				cleanup();
				reject(error);
			},
		});

		if (isMCPTimeoutEnabled(timeout)) {
			timer = setTimeout(() => {
				cleanup();
				reject(new Error(mcpTimeoutMessage({ command: this.config.command }, `request "${method}"`, timeout)));
			}, timeout);
		}

		const stdin = this.#process.stdin;
		const message = `${JSON.stringify(request)}\n`;
		const failFromSend = (error: unknown) => {
			if (settled) return;
			cleanup();
			reject(error instanceof Error ? error : new Error(String(error)));
		};
		try {
			const wrote = stdin.write(message);
			if (isThenable(wrote)) wrote.then(undefined, failFromSend);
			const flushed = stdin.flush();
			if (isThenable(flushed)) flushed.then(undefined, failFromSend);
		} catch (error) {
			failFromSend(error);
		}

		return promise;
	}

	async notify(method: string, params?: Record<string, unknown>): Promise<void> {
		if (!this.#connected || !this.#process?.stdin) {
			throw new Error(mcpNotConnectedMessage({ command: this.config.command }, `notification "${method}"`));
		}

		const notification = {
			jsonrpc: "2.0" as const,
			method,
			params: params ?? {},
		};

		if (!writeFrame(this.#process.stdin, `${JSON.stringify(notification)}\n`)) {
			this.#handleClose();
			throw new Error(
				`${this.#describeClose()} The notification "${method}" was not delivered and nothing will retry it.`,
			);
		}
	}

	async close(): Promise<void> {
		if (this.#connected) {
			this.#handleClose();
		}

		if (this.#process) {
			const child = this.#process;
			this.#process = null;
			const reaped = await terminateMcpServerTree(child.pid);
			if (!reaped) {
				child.kill();
				logger.debug("MCP server tree was not confirmed gone; signalled the child directly", {
					server: this.config.command,
					pid: child.pid,
				});
			}
		}

		if (this.#readLoop) {
			this.#readLoop.catch(() => {});
			this.#readLoop = null;
		}
	}
}

export async function createStdioTransport(config: MCPStdioServerConfig): Promise<StdioTransport> {
	const transport = new StdioTransport(config);
	await transport.connect();
	return transport;
}
