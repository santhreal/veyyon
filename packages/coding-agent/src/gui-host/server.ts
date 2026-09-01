import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as path from "node:path";
import type { AuthStorage } from "@veyyon/ai";
import { getAgentDir, logger } from "@veyyon/utils";
import { discoverAuthStorage } from "../session/auth-broker-config";
import { allActionHandlers } from "./actions";
import type { ActionContext, ReplyHelper } from "./actions/types";
import { FrameDecoder, writeFrame } from "./frames";
import { buildCapabilitiesSnapshot, mapActionToErrorScope } from "./session-bridge";
import { type ClientSessionState, disposeClientState } from "./turns";
import {
	type BackendError,
	getActionTag,
	type HostAction,
	type HostActionTag,
	PROTOCOL_VERSION,
	type SnapshotSection,
} from "./wire";

export class SocketInUseError extends Error {
	readonly code = "EADDRINUSE";
	constructor(socketPath: string) {
		super(`Unix socket ${socketPath} is already in use by another active server`);
		this.name = "SocketInUseError";
	}
}

export interface GuiHostServerOptions {
	endpoint?: string;
	cwd?: string;
	agentDir?: string;
	/**
	 * The credential store every action reads and writes. Default: the
	 * profile's store through `discoverAuthStorage`, which follows credential
	 * sharing to the machine-wide one. A test passes its own so a key it seeds
	 * never lands there.
	 */
	authStorage?: AuthStorage;
}

interface ParsedEndpoint {
	type: "unix" | "tcp";
	path?: string;
	host?: string;
	port?: number;
	formatted: string;
}

/**
 * Parse an endpoint string in `unix:<path>` or `tcp:<host>:<port>` format.
 */
export function parseEndpoint(written: string, defaultAgentDir?: string): ParsedEndpoint {
	if (written.startsWith("unix:")) {
		const socketPath = written.slice(5);
		if (socketPath.trim().length === 0) {
			throw new Error("Unix endpoint path must not be empty");
		}
		return {
			type: "unix",
			path: path.resolve(socketPath),
			formatted: `unix:${path.resolve(socketPath)}`,
		};
	}

	if (written.startsWith("tcp:")) {
		const authority = written.slice(4);
		const colonIndex = authority.lastIndexOf(":");
		if (colonIndex === -1) {
			throw new Error(`TCP endpoint must specify a port (e.g. tcp:127.0.0.1:7654): '${written}'`);
		}
		const host = authority.slice(0, colonIndex) || "127.0.0.1";
		const portStr = authority.slice(colonIndex + 1);
		const port = Number.parseInt(portStr, 10);
		if (Number.isNaN(port) || port < 0 || port > 65535) {
			throw new Error(`Invalid TCP port number: '${portStr}'`);
		}
		return {
			type: "tcp",
			host,
			port,
			formatted: `tcp:${host}:${port}`,
		};
	}

	// Default fallback to unix socket if no scheme was provided
	const resolvedAgentDir = defaultAgentDir ?? getAgentDir();
	const defaultSocketPath = path.join(resolvedAgentDir, "gui-host.sock");
	return {
		type: "unix",
		path: defaultSocketPath,
		formatted: `unix:${defaultSocketPath}`,
	};
}

/**
 * GUI host engine server speaking the desktop JSON wire protocol.
 */
export class GuiHostServer {
	#parsedEndpoint: ParsedEndpoint;
	#server: net.Server | null = null;
	#clients = new Set<net.Socket>();
	#clientStates = new Map<net.Socket, ClientSessionState>();
	#cwd: string;
	#agentDir: string;
	#authStorage: Promise<AuthStorage> | null;
	#isClosing = false;

	constructor(options: GuiHostServerOptions = {}) {
		this.#cwd = options.cwd ?? process.cwd();
		this.#agentDir = options.agentDir ?? getAgentDir();
		this.#authStorage = options.authStorage ? Promise.resolve(options.authStorage) : null;
		this.#parsedEndpoint = parseEndpoint(
			options.endpoint ?? `unix:${path.join(this.#agentDir, "gui-host.sock")}`,
			this.#agentDir,
		);
	}

	/**
	 * One store for the server's lifetime. A discovery that failed is not
	 * cached, so the next action retries it rather than inheriting the failure.
	 */
	#resolveAuthStorage(): Promise<AuthStorage> {
		if (!this.#authStorage) {
			this.#authStorage = discoverAuthStorage(this.#agentDir).catch(error => {
				this.#authStorage = null;
				throw error;
			});
		}
		return this.#authStorage;
	}

	get endpoint(): string {
		if (this.#parsedEndpoint.type === "tcp" && this.#server?.listening) {
			const addr = this.#server.address();
			if (addr && typeof addr === "object") {
				return `tcp:${this.#parsedEndpoint.host ?? "127.0.0.1"}:${addr.port}`;
			}
		}
		return this.#parsedEndpoint.formatted;
	}

	async start(): Promise<void> {
		if (this.#parsedEndpoint.type === "unix" && this.#parsedEndpoint.path) {
			await this.#prepareUnixSocket(this.#parsedEndpoint.path);
		}

		const { promise, resolve, reject } = Promise.withResolvers<void>();

		this.#server = net.createServer(socket => {
			this.#handleConnection(socket);
		});

		this.#server.on("error", error => {
			if (!this.#server?.listening) {
				reject(error);
			} else {
				logger.error("GUI host server error", { error: error.message });
			}
		});

		if (this.#parsedEndpoint.type === "unix" && this.#parsedEndpoint.path) {
			this.#server.listen(this.#parsedEndpoint.path, () => {
				resolve();
			});
		} else if (this.#parsedEndpoint.type === "tcp" && typeof this.#parsedEndpoint.port === "number") {
			this.#server.listen(this.#parsedEndpoint.port, this.#parsedEndpoint.host ?? "127.0.0.1", () => {
				resolve();
			});
		}

		await promise;
	}

	async #prepareUnixSocket(socketPath: string): Promise<void> {
		await fs.mkdir(path.dirname(socketPath), { recursive: true });

		let exists = false;
		try {
			await fs.access(socketPath);
			exists = true;
		} catch {
			exists = false;
		}

		if (!exists) {
			return;
		}

		const isLive = await new Promise<boolean>(resolve => {
			const probe = net.createConnection(socketPath);
			probe.on("connect", () => {
				probe.destroy();
				resolve(true);
			});
			probe.on("error", () => {
				probe.destroy();
				resolve(false);
			});
		});

		if (isLive) {
			throw new SocketInUseError(socketPath);
		}

		try {
			await fs.unlink(socketPath);
		} catch (error) {
			if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
				return;
			}
			throw error;
		}
	}

	#handleConnection(socket: net.Socket): void {
		this.#clients.add(socket);
		const clientState: ClientSessionState = { revision: 0 };
		this.#clientStates.set(socket, clientState);

		// 1. Write greeting frame first
		writeFrame(socket, {
			ConnectionChanged: {
				Connected: {
					endpoint: this.endpoint,
					protocol: PROTOCOL_VERSION,
				},
			},
		});

		// 2. Write capabilities snapshot
		writeFrame(socket, {
			Snapshot: {
				Capabilities: buildCapabilitiesSnapshot(),
			},
		});

		// 3. Attach frame decoder
		const decoder = new FrameDecoder(
			socket,
			frame => {
				void this.#handleFrame(socket, clientState, frame);
			},
			error => {
				logger.debug("GUI host client connection closed on error", { error: error.message });
			},
		);

		socket.on("close", () => {
			decoder.detach();
			this.#cleanupClient(socket);
		});

		socket.on("error", () => {
			decoder.detach();
			this.#cleanupClient(socket);
		});
	}

	#cleanupClient(socket: net.Socket): void {
		this.#clients.delete(socket);
		const state = this.#clientStates.get(socket);
		if (state) {
			void disposeClientState(state);
			this.#clientStates.delete(socket);
		}
	}

	async #handleFrame(socket: net.Socket, clientState: ClientSessionState, rawFrame: unknown): Promise<void> {
		if (!rawFrame || typeof rawFrame !== "object" || !("id" in rawFrame) || typeof rawFrame.id !== "number") {
			logger.warn("GUI host received invalid request frame structure", { frame: rawFrame });
			return;
		}

		const requestId = rawFrame.id;
		const action = "action" in rawFrame ? (rawFrame.action as HostAction) : "";
		const actionTag = getActionTag(action);

		try {
			await this.#dispatchAction(socket, clientState, requestId, action, actionTag);
		} catch (error) {
			logger.error("GUI host error executing action", { action: actionTag, error });
			const backendError: BackendError = {
				scope: mapActionToErrorScope(actionTag),
				code: "ACTION_FAILED",
				message: error instanceof Error ? error.message : String(error),
				retryable: false,
				request: requestId,
				occurred_at_ms: Date.now(),
			};
			writeFrame(socket, { RequestFailed: { request: requestId, error: backendError } });
		}
	}

	async #dispatchAction(
		socket: net.Socket,
		clientState: ClientSessionState,
		requestId: number,
		action: HostAction,
		actionTag: string,
	): Promise<void> {
		const reply: ReplyHelper = {
			success: () => {
				writeFrame(socket, { RequestSucceeded: { request: requestId } });
			},
			failure: err => {
				const error: BackendError = {
					scope: err.scope,
					code: err.code ?? "ACTION_FAILED",
					message: err.message,
					retryable: err.retryable ?? false,
					request: requestId,
					occurred_at_ms: err.occurred_at_ms ?? Date.now(),
				};
				writeFrame(socket, { RequestFailed: { request: requestId, error } });
			},
			snapshot: (section: SnapshotSection) => {
				writeFrame(socket, { Snapshot: section });
			},
		};

		const handler = allActionHandlers[actionTag as HostActionTag];
		if (!handler) {
			reply.failure({
				scope: mapActionToErrorScope(actionTag),
				code: "UNIMPLEMENTED_ACTION",
				message: `Action '${actionTag}' is not implemented by this host`,
				retryable: false,
			});
			return;
		}

		let payload: unknown;
		if (typeof action === "object" && action !== null && actionTag in action) {
			payload = (action as Record<string, unknown>)[actionTag];
		}

		const ctx: ActionContext = {
			socket,
			clientState,
			cwd: this.#cwd,
			agentDir: this.#agentDir,
			authStorage: () => this.#resolveAuthStorage(),
			requestId,
			actionTag: actionTag as HostActionTag,
			reply,
		};

		await handler(ctx, payload as never);

		if (actionTag === "Shutdown") {
			void this.close();
		}
	}

	async close(): Promise<void> {
		if (this.#isClosing) {
			return;
		}
		this.#isClosing = true;

		for (const client of this.#clients) {
			this.#cleanupClient(client);
			client.destroy();
		}
		this.#clients.clear();

		if (this.#server) {
			const { promise, resolve } = Promise.withResolvers<void>();
			this.#server.close(() => {
				resolve();
			});
			await promise;
			this.#server = null;
		}

		if (this.#parsedEndpoint.type === "unix" && this.#parsedEndpoint.path) {
			try {
				await fs.unlink(this.#parsedEndpoint.path);
			} catch {
				// Ignore
			}
		}
	}
}

/**
 * Start a GUI host server on the given options.
 */
export async function startGuiHostServer(options: GuiHostServerOptions = {}): Promise<GuiHostServer> {
	const server = new GuiHostServer(options);
	await server.start();
	return server;
}
