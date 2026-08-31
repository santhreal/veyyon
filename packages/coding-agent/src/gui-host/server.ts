import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as path from "node:path";
import { getAgentDir, logger } from "@veyyon/utils";
import { listSessions } from "../session/session-listing";
import { SessionManager } from "../session/session-manager";
import { computeDefaultSessionDir } from "../session/session-paths";
import { FileSessionStorage } from "../session/session-storage";
import { FrameDecoder, writeFrame } from "./frames";
import {
	buildCapabilitiesSnapshot,
	mapActionToErrorScope,
	sessionEntryToTranscriptEntry,
	sessionHeaderToView,
	sessionInfoToSummary,
} from "./session-bridge";
import {
	abortTurn,
	type ClientSessionState,
	disposeTurnSession,
	executePromptTurn,
	getOrCreateAgentSession,
} from "./turns";
import {
	type AttachmentSubmission,
	type BackendError,
	getActionTag,
	type HostAction,
	PROTOCOL_VERSION,
	type TranscriptEntry,
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
		if (Number.isNaN(port) || port <= 0 || port > 65535) {
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
	#storage = new FileSessionStorage();
	#cwd: string;
	#agentDir: string;
	#isClosing = false;

	constructor(options: GuiHostServerOptions = {}) {
		this.#cwd = options.cwd ?? process.cwd();
		this.#agentDir = options.agentDir ?? getAgentDir();
		this.#parsedEndpoint = parseEndpoint(
			options.endpoint ?? `unix:${path.join(this.#agentDir, "gui-host.sock")}`,
			this.#agentDir,
		);
	}

	get endpoint(): string {
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
		} else if (this.#parsedEndpoint.type === "tcp" && this.#parsedEndpoint.port) {
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
			void disposeTurnSession(state);
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
		switch (actionTag) {
			case "ListSessions": {
				const sessionDir = computeDefaultSessionDir(
					this.#cwd,
					this.#storage,
					path.join(this.#agentDir, "sessions"),
				);
				const sessions = await listSessions(sessionDir, this.#storage);
				const summaries = sessions.map(sessionInfoToSummary);
				clientState.revision += 1;
				writeFrame(socket, {
					Snapshot: {
						Sessions: [{ revision: clientState.revision, value: summaries }, []],
					},
				});
				writeFrame(socket, { RequestSucceeded: { request: requestId } });
				break;
			}

			case "OpenSession": {
				let targetSession: string | undefined;
				if (typeof action === "object" && action !== null && "OpenSession" in action) {
					const openPayload = action.OpenSession;
					if (openPayload && typeof openPayload === "object" && "session" in openPayload) {
						targetSession = String(openPayload.session);
					}
				}

				if (!targetSession) {
					throw new Error("OpenSession missing session identifier");
				}

				// Find or open session
				let sessionPath: string = targetSession;
				let found = false;
				try {
					await fs.access(targetSession);
					found = true;
				} catch {
					found = false;
				}

				if (!found) {
					const sessionDir = computeDefaultSessionDir(
						this.#cwd,
						this.#storage,
						path.join(this.#agentDir, "sessions"),
					);
					const sessions = await listSessions(sessionDir, this.#storage);
					const matched = sessions.find(s => s.id === targetSession || s.path === targetSession);
					if (matched) {
						sessionPath = matched.path;
					}
				}

				// Dispose any existing in-memory agent session so subsequent prompts continue this session
				await disposeTurnSession(clientState);

				const sm = await SessionManager.open(sessionPath, undefined, undefined, { suppressBreadcrumb: true });
				clientState.sessionManager = sm;

				// Wire appends
				sm.onEntryAppended = entry => {
					clientState.revision += 1;
					const transcriptEntry = sessionEntryToTranscriptEntry(entry, clientState.revision);
					writeFrame(socket, {
						TranscriptAppended: {
							revision: clientState.revision,
							entries: [transcriptEntry],
						},
					});
				};

				// Send ActiveSession snapshot
				clientState.revision += 1;
				writeFrame(socket, {
					Snapshot: {
						ActiveSession: {
							revision: clientState.revision,
							value: sessionHeaderToView(sm.getHeader()),
						},
					},
				});

				// Send Transcript snapshot
				clientState.revision += 1;
				const entries: TranscriptEntry[] = sm
					.getEntries()
					.map(e => sessionEntryToTranscriptEntry(e, clientState.revision));
				writeFrame(socket, {
					Snapshot: {
						Transcript: {
							revision: clientState.revision,
							value: entries,
						},
					},
				});

				writeFrame(socket, { RequestSucceeded: { request: requestId } });
				break;
			}

			case "LoadTranscript": {
				let before: string | null = null;
				if (typeof action === "object" && action !== null && "LoadTranscript" in action) {
					const payload = action.LoadTranscript;
					if (payload && typeof payload === "object" && "before" in payload) {
						before = typeof payload.before === "string" ? payload.before : null;
					}
				}

				const sm = clientState.sessionManager ?? clientState.agentSession?.sessionManager;
				if (!sm) {
					const error: BackendError = {
						scope: "Transcript",
						code: "NO_ACTIVE_SESSION",
						message: "No session is currently open to load transcript from",
						retryable: false,
						request: requestId,
						occurred_at_ms: Date.now(),
					};
					writeFrame(socket, { RequestFailed: { request: requestId, error } });
					break;
				}

				if (before !== null && before !== undefined) {
					const error: BackendError = {
						scope: "Transcript",
						code: "PAGING_UNSUPPORTED",
						message: "Backward transcript paging with 'before' is not supported by the session store",
						retryable: false,
						request: requestId,
						occurred_at_ms: Date.now(),
					};
					writeFrame(socket, { RequestFailed: { request: requestId, error } });
					break;
				}

				clientState.revision += 1;
				const entries: TranscriptEntry[] = sm
					.getEntries()
					.map(e => sessionEntryToTranscriptEntry(e, clientState.revision));
				writeFrame(socket, {
					Snapshot: {
						Transcript: {
							revision: clientState.revision,
							value: entries,
						},
					},
				});
				writeFrame(socket, { RequestSucceeded: { request: requestId } });
				break;
			}

			case "SubmitPrompt": {
				let promptText = "";
				let attachments: AttachmentSubmission[] = [];
				if (typeof action === "object" && action !== null && "SubmitPrompt" in action) {
					const payload = action.SubmitPrompt;
					if (payload && typeof payload === "object") {
						if ("text" in payload && typeof payload.text === "string") {
							promptText = payload.text;
						}
						if ("attachments" in payload && Array.isArray(payload.attachments)) {
							attachments = payload.attachments as AttachmentSubmission[];
						}
					}
				}

				const session = await getOrCreateAgentSession(clientState, socket, {
					cwd: this.#cwd,
					agentDir: this.#agentDir,
				});

				await executePromptTurn(session, clientState, promptText, attachments);
				writeFrame(socket, { RequestSucceeded: { request: requestId } });
				break;
			}

			case "AbortTurn": {
				const session = clientState.agentSession;
				if (!session?.isStreaming) {
					const error: BackendError = {
						scope: "Session",
						code: "NOT_RUNNING",
						message: "No turn is currently in flight to abort",
						retryable: false,
						request: requestId,
						occurred_at_ms: Date.now(),
					};
					writeFrame(socket, { RequestFailed: { request: requestId, error } });
					break;
				}

				await abortTurn(session);
				writeFrame(socket, { RequestSucceeded: { request: requestId } });
				break;
			}

			case "Detach": {
				await disposeTurnSession(clientState);
				clientState.sessionManager = undefined;
				writeFrame(socket, { RequestSucceeded: { request: requestId } });
				break;
			}

			case "RetryConnection": {
				writeFrame(socket, {
					Snapshot: {
						Capabilities: buildCapabilitiesSnapshot(),
					},
				});
				writeFrame(socket, { RequestSucceeded: { request: requestId } });
				break;
			}

			case "Shutdown": {
				writeFrame(socket, { RequestSucceeded: { request: requestId } });
				void this.close();
				break;
			}

			default: {
				const error: BackendError = {
					scope: mapActionToErrorScope(actionTag),
					code: "UNIMPLEMENTED_ACTION",
					message: `Action '${actionTag}' is not implemented by this host`,
					retryable: false,
					request: requestId,
					occurred_at_ms: Date.now(),
				};
				writeFrame(socket, { RequestFailed: { request: requestId, error } });
				break;
			}
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
