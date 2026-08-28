import * as path from "node:path";
import { errorMessage, isEnoent, logger, postmortem, ptree, untilAborted } from "@veyyon/utils";
import { MessageFramer } from "../jsonrpc/message-framing";
import { primarySessionCpuAdoption } from "../session/cpu-limit";
import { ToolAbortError, throwIfAborted } from "../tools/tool-errors";
import { scopedTimeoutSignal } from "../utils/fetch-timeout";
import { applyWorkspaceEdit } from "./edits";
import { getLspmuxCommand, isLspmuxSupported } from "./lspmux";
import type {
	LspClient,
	LspJsonRpcId,
	LspJsonRpcNotification,
	LspJsonRpcRequest,
	LspJsonRpcResponse,
	PublishDiagnosticsParams,
	ServerConfig,
	WorkspaceEdit,
} from "./types";
import { detectLanguageId, fileToUri } from "./utils";

const clients = new Map<string, LspClient>();
const clientLocks = new Map<string, Promise<LspClient>>();
const fileOperationLocks = new Map<string, Promise<void>>();

const INIT_FAILURE_BACKOFF_MS = 3 * 60 * 1000;
const initFailures = new Map<string, { at: number; message: string }>();

let idleTimeoutMs: number | null = null;
let idleCheckInterval: NodeJS.Timeout | null = null;
const IDLE_CHECK_INTERVAL_MS = 60 * 1000;

export function setIdleTimeout(ms: number | null | undefined): void {
	idleTimeoutMs = ms ?? null;

	if (idleTimeoutMs && idleTimeoutMs > 0) {
		startIdleChecker();
	} else {
		stopIdleChecker();
	}
}

function startIdleChecker(): void {
	if (idleCheckInterval) return;
	idleCheckInterval = setInterval(() => {
		if (!idleTimeoutMs) return;
		const now = Date.now();
		for (const [key, client] of Array.from(clients.entries())) {
			if (now - client.lastActivity > idleTimeoutMs) {
				void shutdownClient(key);
			}
		}
	}, IDLE_CHECK_INTERVAL_MS);
}

function stopIdleChecker(): void {
	if (idleCheckInterval) {
		clearInterval(idleCheckInterval);
		idleCheckInterval = null;
	}
}

const CLIENT_CAPABILITIES = {
	textDocument: {
		synchronization: {
			didSave: true,
			dynamicRegistration: false,
			willSave: false,
			willSaveWaitUntil: false,
		},
		hover: {
			contentFormat: ["markdown", "plaintext"],
			dynamicRegistration: false,
		},
		definition: {
			dynamicRegistration: false,
			linkSupport: true,
		},
		typeDefinition: {
			dynamicRegistration: false,
			linkSupport: true,
		},
		implementation: {
			dynamicRegistration: false,
			linkSupport: true,
		},
		references: {
			dynamicRegistration: false,
		},
		documentSymbol: {
			dynamicRegistration: false,
			hierarchicalDocumentSymbolSupport: true,
			symbolKind: {
				valueSet: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26],
			},
		},
		rename: {
			dynamicRegistration: false,
			prepareSupport: true,
		},
		codeAction: {
			dynamicRegistration: false,
			codeActionLiteralSupport: {
				codeActionKind: {
					valueSet: [
						"quickfix",
						"refactor",
						"refactor.extract",
						"refactor.inline",
						"refactor.rewrite",
						"source",
						"source.organizeImports",
						"source.fixAll",
					],
				},
			},
			resolveSupport: {
				properties: ["edit"],
			},
		},
		formatting: {
			dynamicRegistration: false,
		},
		rangeFormatting: {
			dynamicRegistration: false,
		},
		publishDiagnostics: {
			relatedInformation: true,
			versionSupport: true,
			tagSupport: { valueSet: [1, 2] },
			codeDescriptionSupport: true,
			dataSupport: true,
		},
	},
	window: {
		workDoneProgress: true,
	},
	workspace: {
		applyEdit: true,
		workspaceEdit: {
			documentChanges: true,
			resourceOperations: ["create", "rename", "delete"],
			failureHandling: "textOnlyTransactional",
		},
		configuration: true,
		workspaceFolders: true,
		symbol: {
			dynamicRegistration: false,
			symbolKind: {
				valueSet: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26],
			},
		},
		fileOperations: {
			dynamicRegistration: false,
			willCreate: false,
			didCreate: false,
			willRename: true,
			didRename: true,
			willDelete: false,
			didDelete: false,
		},
	},
	experimental: {
		snippetTextEdit: true,
	},
};

export enum FileChangeType {
	Created = 1,
	Changed = 2,
	Deleted = 3,
}

export interface WatchedFileChange {
	filePath: string;
	type: FileChangeType;
}

function abortReason(signal: AbortSignal): Error {
	return signal.reason instanceof Error ? signal.reason : new ToolAbortError();
}

class LspFlushAbortError extends Error {
	constructor(readonly reason: Error) {
		super(reason.message);
		this.name = "LspFlushAbortError";
	}
}

async function writeMessage(
	sink: Bun.FileSink,
	message: LspJsonRpcRequest | LspJsonRpcNotification | LspJsonRpcResponse,
	signal?: AbortSignal,
): Promise<void> {
	if (signal?.aborted) {
		throw abortReason(signal);
	}
	const content = JSON.stringify(message);
	sink.write(`Content-Length: ${Buffer.byteLength(content, "utf-8")}\r\n\r\n${content}`);
	const flush = Promise.resolve(sink.flush());
	if (!signal) {
		await flush;
		return;
	}
	const { promise, resolve, reject } = Promise.withResolvers<void>();
	const onAbort = () => {
		signal.removeEventListener("abort", onAbort);
		flush.catch(() => {});
		reject(new LspFlushAbortError(abortReason(signal)));
	};
	signal.addEventListener("abort", onAbort, { once: true });
	flush.then(
		() => {
			signal.removeEventListener("abort", onAbort);
			resolve();
		},
		(err: unknown) => {
			signal.removeEventListener("abort", onAbort);
			reject(err);
		},
	);
	await promise;
}

function teardownWedgedClient(client: LspClient): void {
	if (clients.get(client.name) === client) clients.delete(client.name);
	try {
		client.proc.kill();
	} catch {}
}

function queueWriteMessage(
	client: LspClient,
	message: LspJsonRpcRequest | LspJsonRpcNotification | LspJsonRpcResponse,
	signal?: AbortSignal,
): Promise<void> {
	const write = client.writeQueue.catch(() => {}).then(() => writeMessage(client.proc.stdin, message, signal));
	const result = write.catch((err: unknown) => {
		if (err instanceof LspFlushAbortError) {
			teardownWedgedClient(client);
			throw err.reason;
		}
		throw err;
	});
	client.writeQueue = result.catch(() => {});
	return result;
}

async function startMessageReader(client: LspClient): Promise<void> {
	if (client.isReading) return;
	client.isReading = true;

	const reader = (client.proc.stdout as ReadableStream<Uint8Array>).getReader();

	const framer = new MessageFramer(Buffer.from(client.messageBuffer));

	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;

			framer.push(Buffer.from(value));

			for (const messageText of framer.drain(headerText => {
				logger.warn("LSP framing resync: header block without Content-Length", {
					server: client.name,
					header: headerText.slice(0, 200),
				});
			})) {
				try {
					const message: LspJsonRpcResponse | LspJsonRpcNotification = JSON.parse(messageText);

					if ("method" in message) {
						if ("id" in message && message.id !== undefined) {
							await handleServerRequest(client, message as LspJsonRpcRequest);
						} else {
							if (message.method === "textDocument/publishDiagnostics" && message.params) {
								const params = message.params as PublishDiagnosticsParams;
								client.diagnostics.set(params.uri, {
									diagnostics: params.diagnostics,
									version: params.version ?? null,
								});
								client.diagnosticsVersion += 1;
							} else if (message.method === "$/progress" && message.params) {
								const params = message.params as { token: string | number; value?: { kind?: string } };
								if (params.value?.kind === "begin") {
									client.activeProgressTokens.add(params.token);
								} else if (params.value?.kind === "end") {
									client.activeProgressTokens.delete(params.token);
									if (client.activeProgressTokens.size === 0) {
										client.resolveProjectLoaded();
									}
								}
							}
						}
					} else if ("id" in message && message.id !== undefined) {
						const pending = client.pendingRequests.get(message.id);
						if (pending) {
							client.pendingRequests.delete(message.id);
							if ("error" in message && message.error) {
								pending.reject(new Error(`LSP error: ${message.error.message}`));
							} else {
								pending.resolve(message.result);
							}
						}
					}
				} catch (err) {
					logger.warn("LSP message handling failed", {
						server: client.name,
						error: errorMessage(err),
					});
				}
			}
		}
	} catch (err) {
		for (const pending of Array.from(client.pendingRequests.values())) {
			pending.reject(new Error(`LSP connection closed: ${err}`));
		}
		client.pendingRequests.clear();
	} finally {
		client.messageBuffer = framer.remainder();
		reader.releaseLock();
		client.isReading = false;
		if (client.proc.exitCode === null) {
			client.status = "error";
			if (clients.get(client.name) === client) {
				clients.delete(client.name);
			}
			const teardownErr = new Error("LSP reader stopped; client torn down");
			for (const pending of client.pendingRequests.values()) {
				pending.reject(teardownErr);
			}
			client.pendingRequests.clear();
			client.resolveProjectLoaded();
			client.proc.kill();
		}
	}
}

function currentWorkspaceFolders(client: LspClient): Array<{ uri: string; name: string }> {
	return [{ uri: fileToUri(client.cwd), name: path.basename(client.cwd) || "workspace" }];
}

async function handleWorkspaceFoldersRequest(client: LspClient, message: LspJsonRpcRequest): Promise<void> {
	await sendResponse(client, message.id, currentWorkspaceFolders(client), "workspace/workspaceFolders");
}

async function handleConfigurationRequest(client: LspClient, message: LspJsonRpcRequest): Promise<void> {
	const params = message.params as { items?: Array<{ section?: string }> };
	const items = params?.items ?? [];
	const result = items.map(item => {
		const section = item.section ?? "";
		return client.config.settings?.[section] ?? {};
	});
	await sendResponse(client, message.id, result, "workspace/configuration");
}

async function handleApplyEditRequest(client: LspClient, message: LspJsonRpcRequest): Promise<void> {
	const params = message.params as { edit?: WorkspaceEdit };
	if (!params?.edit) {
		await sendResponse(
			client,
			message.id,
			{ applied: false, failureReason: "No edit provided" },
			"workspace/applyEdit",
		);
		return;
	}

	try {
		await applyWorkspaceEdit(params.edit, client.cwd);
		await sendResponse(client, message.id, { applied: true }, "workspace/applyEdit");
	} catch (err) {
		await sendResponse(
			client,
			message.id,
			{ applied: false, failureReason: errorMessage(err) },
			"workspace/applyEdit",
		);
	}
}

async function handleServerRequest(client: LspClient, message: LspJsonRpcRequest): Promise<void> {
	if (message.method === "workspace/configuration") {
		await handleConfigurationRequest(client, message);
		return;
	}
	if (message.method === "workspace/workspaceFolders") {
		await handleWorkspaceFoldersRequest(client, message);
		return;
	}
	if (message.method === "workspace/applyEdit") {
		await handleApplyEditRequest(client, message);
		return;
	}
	if (message.method === "window/workDoneProgress/create") {
		await sendResponse(client, message.id, null, message.method);
		return;
	}
	if (message.method === "client/registerCapability" || message.method === "client/unregisterCapability") {
		await sendResponse(client, message.id, null, message.method);
		return;
	}
	if (message.method === "window/showMessageRequest") {
		await sendResponse(client, message.id, null, message.method);
		return;
	}
	if (message.method === "window/showDocument") {
		await sendResponse(client, message.id, { success: false }, message.method);
		return;
	}
	if (
		message.method === "workspace/semanticTokens/refresh" ||
		message.method === "workspace/inlayHint/refresh" ||
		message.method === "workspace/codeLens/refresh" ||
		message.method === "workspace/codeAction/refresh" ||
		message.method === "workspace/inlineValue/refresh" ||
		message.method === "workspace/foldingRange/refresh" ||
		message.method === "workspace/diagnostic/refresh"
	) {
		await sendResponse(client, message.id, null, message.method);
		return;
	}
	await sendResponse(client, message.id, null, message.method, {
		code: -32601,
		message: `Method not found: ${message.method}`,
	});
}

async function sendResponse(
	client: LspClient,
	id: LspJsonRpcId,
	result: unknown,
	method: string,
	error?: { code: number; message: string; data?: unknown },
): Promise<void> {
	const response: LspJsonRpcResponse = {
		jsonrpc: "2.0",
		id,
		...(error ? { error } : { result }),
	};

	try {
		await queueWriteMessage(client, response);
	} catch (err) {
		logger.error("LSP failed to respond.", { method, error: errorMessage(err) });
	}
}

export const WARMUP_TIMEOUT_MS = 5000;

const RUST_ANALYZER_WORKSPACE_READY_TIMEOUT_MS = 5_000;
const RUST_ANALYZER_WORKSPACE_READY_POLL_MS = 100;
const RUST_ANALYZER_WORKSPACE_READY_SETTLE_MS = 2_000;
const RUST_ANALYZER_STATUS_REQUEST_TIMEOUT_MS = 1_000;
const rustAnalyzerReadyClients = new WeakSet<LspClient>();

function commandBasename(command: string): string {
	const slash = command.lastIndexOf("/");
	const backslash = command.lastIndexOf("\\");
	const separator = Math.max(slash, backslash);
	return separator === -1 ? command : command.slice(separator + 1);
}

function isRustAnalyzerClient(client: LspClient): boolean {
	return (
		commandBasename(client.config.command) === "rust-analyzer" ||
		(client.config.resolvedCommand ? commandBasename(client.config.resolvedCommand) === "rust-analyzer" : false)
	);
}

function isRustAnalyzerStatusTimeout(err: unknown): boolean {
	return err instanceof Error && err.message.startsWith("LSP request rust-analyzer/analyzerStatus timed out after ");
}

async function waitForRustAnalyzerWorkspace(client: LspClient, signal?: AbortSignal): Promise<void> {
	if (rustAnalyzerReadyClients.has(client)) {
		return;
	}
	const timings = client.config.workspaceReadyTimings;
	const timeoutMs = timings?.timeoutMs ?? RUST_ANALYZER_WORKSPACE_READY_TIMEOUT_MS;
	const pollMs = timings?.pollMs ?? RUST_ANALYZER_WORKSPACE_READY_POLL_MS;
	const settleMs = timings?.settleMs ?? RUST_ANALYZER_WORKSPACE_READY_SETTLE_MS;
	const statusRequestTimeoutMs = timings?.statusRequestTimeoutMs ?? RUST_ANALYZER_STATUS_REQUEST_TIMEOUT_MS;
	const started = Date.now();
	const deadline = started + timeoutMs;
	while (true) {
		throwIfAborted(signal);
		let status: unknown;
		try {
			status = await sendRequest(client, "rust-analyzer/analyzerStatus", {}, signal, statusRequestTimeoutMs);
		} catch (err) {
			if (!isRustAnalyzerStatusTimeout(err) || Date.now() >= deadline) {
				return;
			}
			await Bun.sleep(pollMs);
			continue;
		}
		const ready = typeof status === "string" && !status.startsWith("No workspaces");
		if (ready && Date.now() - started >= settleMs) {
			rustAnalyzerReadyClients.add(client);
			return;
		}
		if (Date.now() >= deadline) {
			return;
		}
		await Bun.sleep(pollMs);
	}
}

const PROJECT_LOAD_TIMEOUT_MS = 15_000;

const SHUTDOWN_TIMEOUT_MS = 5_000;
const EXIT_TIMEOUT_MS = 1_000;

export async function getOrCreateClient(
	config: ServerConfig,
	cwd: string,
	initTimeoutMs?: number,
	signal?: AbortSignal,
): Promise<LspClient> {
	const key = `${config.command}:${cwd}`;

	const existingClient = clients.get(key);
	if (existingClient) {
		existingClient.lastActivity = Date.now();
		return existingClient;
	}

	const existingLock = clientLocks.get(key);
	if (existingLock) {
		return existingLock;
	}

	const recentFailure = initFailures.get(key);
	if (recentFailure) {
		if (Date.now() - recentFailure.at < INIT_FAILURE_BACKOFF_MS) {
			throw new Error(`LSP server ${config.command} failed to initialize recently: ${recentFailure.message}`);
		}
		initFailures.delete(key);
	}

	const clientPromise = (async () => {
		const baseCommand = config.resolvedCommand ?? config.command;
		const baseArgs = config.args ?? [];

		const { command, args, env } = isLspmuxSupported(baseCommand)
			? await getLspmuxCommand(baseCommand, baseArgs)
			: { command: baseCommand, args: baseArgs };

		const proc = ptree.spawn([command, ...args], {
			cwd,
			stdin: "pipe",
			env: env ? { ...Bun.env, ...env } : undefined,
			onSpawnPid: primarySessionCpuAdoption(),
		});

		let resolveProjectLoaded!: () => void;
		const projectLoaded = new Promise<void>(resolve => {
			resolveProjectLoaded = resolve;
		});
		const projectLoadTimeout = setTimeout(resolveProjectLoaded, PROJECT_LOAD_TIMEOUT_MS);
		const originalResolve = resolveProjectLoaded;
		resolveProjectLoaded = () => {
			clearTimeout(projectLoadTimeout);
			originalResolve();
		};

		const client: LspClient = {
			name: key,
			cwd,
			proc,
			config,
			requestId: 0,
			diagnostics: new Map(),
			diagnosticsVersion: 0,
			openFiles: new Map(),
			pendingRequests: new Map(),
			messageBuffer: new Uint8Array(0),
			isReading: false,
			status: "connecting",
			lastActivity: Date.now(),
			writeQueue: Promise.resolve(),
			activeProgressTokens: new Set(),
			projectLoaded,
			resolveProjectLoaded,
		};

		proc.exited.then(() => {
			if (clients.get(key) === client) clients.delete(key);
			if (clientLocks.get(key) === clientPromise) clientLocks.delete(key);
			client.resolveProjectLoaded();

			if (client.pendingRequests.size > 0) {
				const rawStderr = proc.peekStderr().trim();
				const stderr = rawStderr
					.split("\n")
					.filter(line => !/^\[\d{2}:\d{2}:\d{2} (?:INF|DBG|VRB)\]/.test(line))
					.join("\n")
					.trim();
				const code = proc.exitCode;
				const err = new Error(
					stderr ? `LSP server exited (code ${code}): ${stderr}` : `LSP server exited unexpectedly (code ${code})`,
				);
				for (const pending of client.pendingRequests.values()) {
					pending.reject(err);
				}
				client.pendingRequests.clear();
			}
		});

		startMessageReader(client);

		try {
			const initResult = (await sendRequest(
				client,
				"initialize",
				{
					processId: process.pid,
					rootUri: fileToUri(cwd),
					rootPath: cwd,
					capabilities: CLIENT_CAPABILITIES,
					initializationOptions: config.initOptions ?? {},
					workspaceFolders: currentWorkspaceFolders(client),
				},
				signal,
				initTimeoutMs,
			)) as { capabilities?: unknown };

			if (!initResult) {
				throw new Error("Failed to initialize LSP: no response");
			}

			client.serverCapabilities = initResult.capabilities as LspClient["serverCapabilities"];

			await sendNotification(client, "initialized", {}, signal);
			await sendNotification(
				client,
				"workspace/didChangeConfiguration",
				{ settings: config.settings ?? {} },
				signal,
			);

			client.status = "ready";
			clients.set(key, client);
			initFailures.delete(key);
			return client;
		} catch (err) {
			client.status = "error";
			if (clients.get(key) === client) clients.delete(key);
			proc.kill();
			const message = errorMessage(err);
			if (!signal?.aborted && !(initTimeoutMs !== undefined && message.includes("timed out"))) {
				initFailures.set(key, { at: Date.now(), message });
			}
			throw err;
		} finally {
			clientLocks.delete(key);
		}
	})();

	clientLocks.set(key, clientPromise);
	return clientPromise;
}

export async function ensureFileOpen(client: LspClient, filePath: string, signal?: AbortSignal): Promise<void> {
	throwIfAborted(signal);
	const uri = fileToUri(filePath);
	const lockKey = `${client.name}:${uri}`;

	if (client.openFiles.has(uri)) {
		return;
	}

	const existingLock = fileOperationLocks.get(lockKey);
	if (existingLock) {
		await untilAborted(signal, () => existingLock);
		return;
	}

	const openPromise = (async () => {
		throwIfAborted(signal);
		if (client.openFiles.has(uri)) {
			return;
		}

		let content: string;
		try {
			content = await Bun.file(filePath).text();
			throwIfAborted(signal);
		} catch (err) {
			if (isEnoent(err)) return;
			throw err;
		}
		const languageId = detectLanguageId(filePath);
		throwIfAborted(signal);

		await sendNotification(
			client,
			"textDocument/didOpen",
			{
				textDocument: {
					uri,
					languageId,
					version: 1,
					text: content,
				},
			},
			signal,
		);

		client.openFiles.set(uri, { version: 1, languageId });
		client.lastActivity = Date.now();
	})();

	fileOperationLocks.set(lockKey, openPromise);
	try {
		await openPromise;
	} finally {
		fileOperationLocks.delete(lockKey);
	}
}

export async function waitForProjectLoaded(client: LspClient, signal?: AbortSignal): Promise<void> {
	if (signal?.aborted) return;
	if (!signal) {
		await client.projectLoaded;
	} else {
		let onAbort: (() => void) | undefined;
		try {
			await Promise.race([
				client.projectLoaded,
				new Promise<void>(resolve => {
					onAbort = () => resolve();
					signal.addEventListener("abort", onAbort, { once: true });
				}),
			]);
		} finally {
			if (onAbort) signal.removeEventListener("abort", onAbort);
		}
	}
	if (signal?.aborted) return;
	if (isRustAnalyzerClient(client)) {
		await waitForRustAnalyzerWorkspace(client, signal);
	}
}

export async function syncContent(
	client: LspClient,
	filePath: string,
	content: string,
	signal?: AbortSignal,
): Promise<void> {
	const uri = fileToUri(filePath);
	const lockKey = `${client.name}:${uri}`;
	throwIfAborted(signal);

	const existingLock = fileOperationLocks.get(lockKey);
	if (existingLock) {
		await untilAborted(signal, () => existingLock);
	}

	const syncPromise = (async () => {
		client.diagnostics.delete(uri);

		const info = client.openFiles.get(uri);

		if (!info) {
			const languageId = detectLanguageId(filePath);
			throwIfAborted(signal);
			await sendNotification(
				client,
				"textDocument/didOpen",
				{
					textDocument: {
						uri,
						languageId,
						version: 1,
						text: content,
					},
				},
				signal,
			);
			client.openFiles.set(uri, { version: 1, languageId });
			client.lastActivity = Date.now();
			return;
		}

		const version = ++info.version;
		throwIfAborted(signal);
		await sendNotification(
			client,
			"textDocument/didChange",
			{
				textDocument: { uri, version },
				contentChanges: [{ text: content }],
			},
			signal,
		);
		client.lastActivity = Date.now();
	})();

	fileOperationLocks.set(lockKey, syncPromise);
	try {
		await syncPromise;
	} finally {
		fileOperationLocks.delete(lockKey);
	}
}

export async function notifySaved(client: LspClient, filePath: string, signal?: AbortSignal): Promise<void> {
	const uri = fileToUri(filePath);
	const info = client.openFiles.get(uri);
	if (!info) return; // File not open, nothing to notify

	throwIfAborted(signal);
	await sendNotification(
		client,
		"textDocument/didSave",
		{
			textDocument: { uri },
		},
		signal,
	);
	client.lastActivity = Date.now();
}

function isPathInsideWorkspace(filePath: string, workspace: string): boolean {
	const relative = path.relative(workspace, path.resolve(filePath));
	return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

const WATCHED_FILES_NOTIFY_TIMEOUT_MS = 2_000;

export async function notifyWorkspaceWatchedFiles(
	cwd: string,
	changes: readonly WatchedFileChange[],
	signal?: AbortSignal,
): Promise<void> {
	throwIfAborted(signal);
	if (changes.length === 0) return;

	const workspace = path.resolve(cwd);
	const activeClients = Array.from(clients.values()).filter(
		client => client.status === "ready" && path.resolve(client.cwd) === workspace,
	);
	if (activeClients.length === 0) return;

	const sendTimeout = scopedTimeoutSignal(WATCHED_FILES_NOTIFY_TIMEOUT_MS, signal);
	const sendSignal = sendTimeout.signal;
	const results = await Promise.allSettled(
		activeClients.map(async client => {
			const clientChanges = changes
				.filter(change => isPathInsideWorkspace(change.filePath, workspace))
				.map(change => {
					const uri = fileToUri(change.filePath);
					client.diagnostics.delete(uri);
					return { uri, type: change.type };
				});
			if (clientChanges.length === 0) return;
			await sendNotification(client, "workspace/didChangeWatchedFiles", { changes: clientChanges }, sendSignal);
		}),
	);
	sendTimeout.cancel();
	throwIfAborted(signal);
	for (const result of results) {
		if (result.status === "rejected") {
			logger.debug("LSP watched-files notification failed", { cwd, error: String(result.reason) });
		}
	}
}

export async function refreshFile(client: LspClient, filePath: string, signal?: AbortSignal): Promise<void> {
	throwIfAborted(signal);
	const uri = fileToUri(filePath);
	const lockKey = `${client.name}:${uri}`;

	const existingLock = fileOperationLocks.get(lockKey);
	if (existingLock) {
		await untilAborted(signal, () => existingLock);
	}

	const refreshPromise = (async () => {
		throwIfAborted(signal);
		client.diagnostics.delete(uri);
		const info = client.openFiles.get(uri);

		if (!info) {
			await ensureFileOpen(client, filePath, signal);
			return;
		}

		let content: string;
		try {
			content = await Bun.file(filePath).text();
			throwIfAborted(signal);
		} catch (err) {
			if (isEnoent(err)) return;
			throw err;
		}
		const version = ++info.version;
		throwIfAborted(signal);

		await sendNotification(
			client,
			"textDocument/didChange",
			{
				textDocument: { uri, version },
				contentChanges: [{ text: content }],
			},
			signal,
		);
		throwIfAborted(signal);

		await sendNotification(
			client,
			"textDocument/didSave",
			{
				textDocument: { uri },
				text: content,
			},
			signal,
		);

		client.lastActivity = Date.now();
	})();

	fileOperationLocks.set(lockKey, refreshPromise);
	try {
		await refreshPromise;
	} finally {
		fileOperationLocks.delete(lockKey);
	}
}

async function waitForExit(client: LspClient, timeoutMs: number): Promise<boolean> {
	return await Promise.race([
		client.proc.exited.then(
			() => true,
			() => true,
		),
		Bun.sleep(timeoutMs).then(() => false),
	]);
}

async function shutdownClientInstance(client: LspClient): Promise<void> {
	const err = new Error("LSP client shutdown");
	for (const pending of Array.from(client.pendingRequests.values())) {
		pending.reject(err);
	}
	client.pendingRequests.clear();

	const shutdownCompleted = await sendRequest(client, "shutdown", null, undefined, SHUTDOWN_TIMEOUT_MS).then(
		() => true,
		() => false,
	);
	if (shutdownCompleted) {
		await sendNotification(client, "exit", undefined).catch(() => {});
		if (await waitForExit(client, EXIT_TIMEOUT_MS)) return;
	}

	client.proc.kill();
	await waitForExit(client, EXIT_TIMEOUT_MS);
}

export async function shutdownClient(key: string): Promise<void> {
	const client = clients.get(key);
	if (!client) return;
	clients.delete(key);
	await shutdownClientInstance(client);
}

const DEFAULT_REQUEST_TIMEOUT_MS = 30000;

export async function sendRequest(
	client: LspClient,
	method: string,
	params: unknown,
	signal?: AbortSignal,
	timeoutMs?: number,
): Promise<unknown> {
	const id = ++client.requestId;
	if (signal?.aborted) {
		const reason = signal.reason instanceof Error ? signal.reason : new ToolAbortError();
		return Promise.reject(reason);
	}

	const request: LspJsonRpcRequest = {
		jsonrpc: "2.0",
		id,
		method,
		params,
	};

	client.lastActivity = Date.now();

	const { promise, resolve, reject } = Promise.withResolvers<unknown>();
	let timeout: NodeJS.Timeout | undefined;
	const cleanup = () => {
		if (signal) {
			signal.removeEventListener("abort", abortHandler);
		}
	};
	const abortHandler = () => {
		if (client.pendingRequests.has(id)) {
			client.pendingRequests.delete(id);
		}
		void sendNotification(client, "$/cancelRequest", { id }).catch(() => {});
		if (timeout) clearTimeout(timeout);
		cleanup();
		const reason = signal?.reason instanceof Error ? signal.reason : new ToolAbortError();
		reject(reason);
	};

	const effectiveTimeoutMs = timeoutMs ?? (signal ? undefined : DEFAULT_REQUEST_TIMEOUT_MS);
	if (effectiveTimeoutMs !== undefined) {
		timeout = setTimeout(() => {
			if (client.pendingRequests.has(id)) {
				client.pendingRequests.delete(id);
				const err = new Error(`LSP request ${method} timed out after ${effectiveTimeoutMs}ms`);
				cleanup();
				reject(err);
			}
		}, effectiveTimeoutMs);
	}
	if (signal) {
		signal.addEventListener("abort", abortHandler, { once: true });
		if (signal.aborted) {
			abortHandler();
			return promise;
		}
	}

	client.pendingRequests.set(id, {
		resolve: result => {
			if (timeout) clearTimeout(timeout);
			cleanup();
			resolve(result);
		},
		reject: err => {
			if (timeout) clearTimeout(timeout);
			cleanup();
			reject(err);
		},
		method,
	});

	queueWriteMessage(client, request, signal).catch(err => {
		if (timeout) clearTimeout(timeout);
		client.pendingRequests.delete(id);
		cleanup();
		reject(err);
	});
	return promise;
}

export async function sendNotification(
	client: LspClient,
	method: string,
	params: unknown,
	signal?: AbortSignal,
): Promise<void> {
	const notification: LspJsonRpcNotification = {
		jsonrpc: "2.0",
		method,
		params,
	};

	client.lastActivity = Date.now();
	await queueWriteMessage(client, notification, signal);
}

export async function shutdownAll(): Promise<void> {
	const clientsToShutdown = Array.from(clients.values());
	clients.clear();
	const pendingClients = Array.from(clientLocks.values());
	clientLocks.clear();
	const seen = new Set<LspClient>(clientsToShutdown);
	await Promise.allSettled([
		...clientsToShutdown.map(client => shutdownClientInstance(client)),
		...pendingClients.map(pending =>
			pending.then(client => {
				if (seen.has(client)) return;
				seen.add(client);
				return shutdownClientInstance(client);
			}),
		),
	]);
}

export interface LspServerStatus {
	name: string;
	status: "connecting" | "ready" | "error";
	fileTypes: string[];
	error?: string;
}

export function getActiveClients(): LspServerStatus[] {
	return Array.from(clients.values()).map(client => ({
		name: client.config.command,
		status: client.status,
		fileTypes: client.config.fileTypes,
	}));
}

if (typeof process !== "undefined") {
	process.on("beforeExit", () => {
		void shutdownAll();
	});
	postmortem.register("lsp-shutdown", () => shutdownAll());
}
