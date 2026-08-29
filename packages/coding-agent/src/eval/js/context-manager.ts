import { errorMessage, isAbortError, logger, postmortem, Snowflake, workerHostEntry } from "@veyyon/utils";
import { registerOwnedResourceDisposer } from "../../session/owned-resources";
import {
	createWorkerHandle,
	createWorkerSubprocess,
	resolveWorkerSpawnCmd,
	workerEnvFromParent,
} from "../../subprocess/worker-client";
import { logWorkerMessage } from "../../subprocess/worker-log";
import type { ToolSession } from "../../tools";
import { ToolAbortError, ToolError } from "../../tools/tool-errors";
import { raceWithTimeout } from "../../utils/fetch-timeout";
import { safeSend as safeSendIpc } from "../../utils/ipc";
import { JS_EVAL_PROCESS_ARG, JS_EVAL_WORKER_ARG } from "../../worker-args";
import { attachSessionOwner } from "../executor-base";
import { shouldDetachKernel } from "../py/spawn-options";
import { callSessionTool, type JsStatusEvent } from "./tool-bridge";
import { WorkerCore } from "./worker-core";
import type {
	EvalRunErrorPayload,
	EvalWorkerInbound,
	EvalWorkerOutbound,
	EvalWorkerTransport,
	JsDisplayOutput,
	SessionSnapshot,
} from "./worker-protocol";

export { rewriteImports, wrapCode } from "./shared/rewrite-imports";
export type { JsDisplayOutput } from "./worker-protocol";

export interface VmRunState {
	signal?: AbortSignal;
	onText?: (chunk: string) => void;
	onDisplay?: (output: JsDisplayOutput) => void;
}

interface WorkerHandle {
	mode: "process" | "worker" | "inline";
	send(msg: EvalWorkerInbound): void;
	onMessage(handler: (msg: EvalWorkerOutbound) => void): () => void;
	onError(handler: (error: Error) => void): () => void;
	close(): Promise<boolean>;
	terminate(): Promise<void>;
}

interface PendingRun {
	runId: string;
	runState: VmRunState;
	toolSession: ToolSession;
	resolve(value: { value: unknown }): void;
	reject(error: Error): void;
	toolCalls: Map<string, AbortController>;
	settled: boolean;
}

interface JsSession {
	sessionKey: string;
	sessionId: string;
	cwd: string;
	worker: WorkerHandle;
	state: "alive" | "dead";
	pending: Map<string, PendingRun>;
	ownerIds: Set<string>;
	hasFallbackOwner: boolean;
}

const sessions = new Map<string, JsSession>();
const startingSessions = new Map<string, Promise<JsSession>>();
const resettingSessions = new Map<string, Promise<void>>();
const WORKER_INIT_TIMEOUT_MS = 15_000;
const WORKER_CLOSE_TIMEOUT_MS = 1_000;
let workerCloseTimeoutMs: number = WORKER_CLOSE_TIMEOUT_MS;
let useWorkerThreadForTests = false;

export function setWorkerCloseTimeoutMsForTests(ms: number): number {
	const previous = workerCloseTimeoutMs;
	workerCloseTimeoutMs = ms;
	return previous;
}

export function setJsEvalWorkerThreadForTests(enabled: boolean): boolean {
	const previous = useWorkerThreadForTests;
	useWorkerThreadForTests = enabled;
	return previous;
}

export async function executeInVmContext(options: {
	sessionKey: string;
	sessionId: string;
	cwd: string;
	session: ToolSession;
	localRoots?: Record<string, string>;
	artifactsDir?: string | null;
	reset?: boolean;
	code: string;
	filename: string;
	timeoutMs?: number;
	runState: VmRunState;
	ownerId?: string;
}): Promise<{ value: unknown }> {
	if (options.reset) {
		const inFlight = resettingSessions.get(options.sessionKey);
		if (inFlight) await inFlight.catch(() => undefined);
		else {
			const resetPromise = resetVmContext(options.sessionKey);
			resettingSessions.set(
				options.sessionKey,
				resetPromise.then(() => undefined),
			);
			try {
				await resetPromise;
			} finally {
				resettingSessions.delete(options.sessionKey);
			}
		}
	} else {
		const inFlight = resettingSessions.get(options.sessionKey);
		if (inFlight) await inFlight.catch(() => undefined);
	}
	const session = await acquireSession(
		options.sessionKey,
		{
			cwd: options.cwd,
			sessionId: options.sessionId,
			localRoots: options.localRoots,
			artifactsDir: options.artifactsDir,
		},
		options.timeoutMs,
	);
	attachSessionOwner(session, options.sessionId, options.ownerId);
	return await runOnce(session, options);
}

async function resetVmContext(sessionKey: string): Promise<void> {
	const session = sessions.get(sessionKey) ?? (await startingSessions.get(sessionKey)?.catch(() => undefined));
	if (!session) return;
	sessions.delete(sessionKey);
	await killSession(session, new ToolError("JS context reset"), { force: false });
}

export async function disposeAllVmContexts(): Promise<void> {
	const pending = Array.from(startingSessions.values());
	startingSessions.clear();
	const started = await Promise.allSettled(pending);
	const all = Array.from(sessions.values());
	for (const result of started) {
		if (result.status !== "fulfilled") continue;
		if (!all.includes(result.value)) all.push(result.value);
	}
	sessions.clear();
	await Promise.all(all.map(session => killSession(session, new ToolError("JS context disposed"), { force: false })));
}

export async function disposeVmContextsByOwner(ownerId: string): Promise<void> {
	const toKill: JsSession[] = [];
	for (const session of Array.from(sessions.values())) {
		if (!session.ownerIds.has(ownerId)) continue;
		if (session.ownerIds.size === 1) {
			toKill.push(session);
			continue;
		}
		session.ownerIds.delete(ownerId);
	}
	for (const session of toKill) {
		if (sessions.get(session.sessionKey) === session) sessions.delete(session.sessionKey);
	}
	await Promise.all(
		toKill.map(session => killSession(session, new ToolError("JS context disposed"), { force: false })),
	);
}

export async function smokeTestJsEvalWorker(): Promise<void> {
	const worker = spawnJsWorker();
	const session: JsSession = {
		sessionKey: "smoke",
		sessionId: "smoke",
		cwd: process.cwd(),
		worker,
		state: "alive",
		pending: new Map(),
		ownerIds: new Set(),
		hasFallbackOwner: false,
	};
	try {
		await initWorker(session, { cwd: process.cwd(), sessionId: "smoke" }, WORKER_INIT_TIMEOUT_MS);
		if (worker.mode !== "process") {
			throw new Error("JS eval worker smoke fell back from the isolated subprocess");
		}
	} finally {
		await terminateJsWorker(worker, "smoke-test");
	}
}

async function terminateJsWorker(worker: Pick<WorkerHandle, "terminate">, context: string): Promise<void> {
	try {
		await worker.terminate();
	} catch (error) {
		logger.warn("JS eval worker did not terminate", { context, error: errorMessage(error) });
	}
}

async function runOnce(
	session: JsSession,
	options: {
		sessionId: string;
		cwd: string;
		session: ToolSession;
		localRoots?: Record<string, string>;
		artifactsDir?: string | null;
		code: string;
		filename: string;
		runState: VmRunState;
	},
): Promise<{ value: unknown }> {
	const runId = `r-${Snowflake.next()}`;
	const { promise, resolve, reject } = Promise.withResolvers<{ value: unknown }>();
	const pending: PendingRun = {
		runId,
		runState: options.runState,
		toolSession: options.session,
		resolve,
		reject,
		toolCalls: new Map(),
		settled: false,
	};
	session.pending.set(runId, pending);

	const onAbort = (): void => {
		const reason = options.runState.signal?.reason;
		const abortError = reasonToError(reason, "Execution aborted");
		for (const ctrl of pending.toolCalls.values()) ctrl.abort(abortError);
		void killSessionFor(session, abortError, { force: true });
	};

	if (options.runState.signal?.aborted) {
		queueMicrotask(onAbort);
	} else {
		options.runState.signal?.addEventListener("abort", onAbort, { once: true });
	}

	try {
		session.worker.send({
			type: "run",
			runId,
			code: options.code,
			filename: options.filename,
			snapshot: {
				cwd: options.cwd,
				sessionId: options.sessionId,
				localRoots: options.localRoots,
				artifactsDir: options.artifactsDir,
			},
		});
		return await promise;
	} finally {
		options.runState.signal?.removeEventListener("abort", onAbort);
		session.pending.delete(runId);
	}
}

async function acquireSession(sessionKey: string, snapshot: SessionSnapshot, timeoutMs?: number): Promise<JsSession> {
	const existing = sessions.get(sessionKey);
	if (existing && existing.state === "alive") {
		existing.sessionId = snapshot.sessionId;
		existing.cwd = snapshot.cwd;
		return existing;
	}
	const starting = startingSessions.get(sessionKey);
	if (starting) return await starting;

	const startup = (async (): Promise<JsSession> => {
		const worker = spawnJsWorker();
		const session: JsSession = {
			sessionKey,
			sessionId: snapshot.sessionId,
			cwd: snapshot.cwd,
			worker,
			state: "alive",
			pending: new Map(),
			ownerIds: new Set(),
			hasFallbackOwner: false,
		};
		const readyTimeoutMs = Math.max(WORKER_INIT_TIMEOUT_MS, timeoutMs ?? 0);
		while (true) {
			try {
				await initWorker(session, snapshot, readyTimeoutMs);
				break;
			} catch (error) {
				const failed = session.worker;
				await failed.terminate().catch(() => undefined);
				if (failed.mode === "inline") throw error;
				if (failed.mode === "process") {
					logger.warn("JS eval subprocess init failed; retrying with a Bun Worker", {
						error: errorMessage(error),
					});
					session.worker = spawnBunWorker();
				} else {
					logger.warn("JS eval worker init failed; retrying with inline worker (no sync-loop guard)", {
						error: errorMessage(error),
					});
					session.worker = spawnInlineWorker();
				}
				session.state = "alive";
			}
		}
		sessions.set(sessionKey, session);
		return session;
	})();
	startingSessions.set(sessionKey, startup);
	try {
		return await startup;
	} finally {
		if (startingSessions.get(sessionKey) === startup) startingSessions.delete(sessionKey);
	}
}

async function initWorker(session: JsSession, snapshot: SessionSnapshot, timeoutMs: number): Promise<void> {
	const worker = session.worker;
	const { promise: readyPromise, resolve: resolveReady, reject: rejectReady } = Promise.withResolvers<void>();
	let resolved = false;
	const unsubscribeMessage = worker.onMessage(msg => {
		if (!resolved && msg.type === "ready") {
			resolved = true;
			resolveReady();
			return;
		}
		if (!resolved && msg.type === "init-failed") {
			resolved = true;
			rejectReady(errorFromPayload(msg.error));
			return;
		}
		handleSessionMessage(session, msg);
	});
	const unsubscribeError = worker.onError(error => {
		if (!resolved) {
			resolved = true;
			rejectReady(error);
			return;
		}
		void killSessionFor(session, error, { force: true });
	});
	try {
		worker.send({ type: "init", snapshot });
		await raceWithTimeout(readyPromise, timeoutMs, () => new ToolError("Timed out initializing JS eval worker"));
	} catch (error) {
		unsubscribeMessage();
		unsubscribeError();
		throw error;
	}
}

function handleSessionMessage(session: JsSession, msg: EvalWorkerOutbound): void {
	switch (msg.type) {
		case "text": {
			const pending = session.pending.get(msg.runId);
			pending?.runState.onText?.(msg.chunk);
			return;
		}
		case "display": {
			const pending = session.pending.get(msg.runId);
			pending?.runState.onDisplay?.(msg.output);
			return;
		}
		case "tool-call":
			void handleToolCall(session, msg);
			return;
		case "result":
			settlePending(session, msg);
			return;
		case "log":
			logWorkerMessage(msg);
			return;
		case "ready":
		case "init-failed":
		case "closed":
			return;
	}
}

async function handleToolCall(
	session: JsSession,
	msg: Extract<EvalWorkerOutbound, { type: "tool-call" }>,
): Promise<void> {
	const pending = session.pending.get(msg.runId);
	if (!pending) {
		safeSend(session, {
			type: "tool-reply",
			id: msg.id,
			reply: { ok: false, error: { message: "Run no longer active" } },
		});
		return;
	}
	const ctrl = new AbortController();
	pending.toolCalls.set(msg.id, ctrl);
	try {
		const value = await callSessionTool(msg.name, msg.args, {
			session: pending.toolSession,
			signal: ctrl.signal,
			emitStatus: (event: JsStatusEvent) => pending.runState.onDisplay?.({ type: "status", event }),
		});
		safeSend(session, { type: "tool-reply", id: msg.id, reply: { ok: true, value } });
	} catch (error) {
		safeSend(session, { type: "tool-reply", id: msg.id, reply: { ok: false, error: toErrorPayload(error) } });
	} finally {
		pending.toolCalls.delete(msg.id);
	}
}

function settlePending(session: JsSession, msg: Extract<EvalWorkerOutbound, { type: "result" }>): void {
	const pending = session.pending.get(msg.runId);
	if (!pending || pending.settled) return;
	pending.settled = true;
	if (msg.ok) {
		pending.resolve({ value: undefined });
		return;
	}
	pending.reject(errorFromPayload(msg.error));
}

async function killSessionFor(session: JsSession, error: Error, options: { force: boolean }): Promise<void> {
	if (sessions.get(session.sessionKey) === session) {
		sessions.delete(session.sessionKey);
	}
	await killSession(session, error, options);
}

async function killSession(session: JsSession, error: Error, options: { force: boolean }): Promise<void> {
	if (session.state === "dead") return;
	session.state = "dead";
	for (const pending of session.pending.values()) {
		if (pending.settled) continue;
		pending.settled = true;
		for (const ctrl of pending.toolCalls.values()) ctrl.abort(error);
		pending.reject(error);
	}
	session.pending.clear();
	if (options.force) {
		await terminateJsWorker(session.worker, "kill-forced");
		return;
	}
	const closed = await session.worker.close().catch(() => false);
	if (closed) return;
	await terminateJsWorker(session.worker, "kill-graceful-fallback");
}

function safeSend(session: JsSession, msg: EvalWorkerInbound): void {
	if (session.state !== "alive") return;
	try {
		session.worker.send(msg);
	} catch (err) {
		logger.debug("js worker send failed", { error: errorMessage(err) });
	}
}

function reasonToError(reason: unknown, fallback: string): Error {
	if (reason instanceof Error) return reason;
	if (typeof reason === "string") return new ToolAbortError(reason);
	return new ToolAbortError(fallback);
}

function errorFromPayload(payload: EvalRunErrorPayload): Error {
	if (payload.isAbort) {
		const err = new ToolAbortError(payload.message || "Execution aborted");
		if (payload.stack) err.stack = payload.stack;
		return err;
	}
	const ctor = payload.isToolError ? ToolError : Error;
	const error = new ctor(payload.message);
	if (payload.name) error.name = payload.name;
	if (payload.stack) error.stack = payload.stack;
	return error;
}

function toErrorPayload(error: unknown): EvalRunErrorPayload {
	if (error instanceof Error) {
		return {
			name: error.name,
			message: error.message,
			stack: error.stack,
			isAbort: isAbortError(error),
			isToolError: error instanceof ToolError || error.name === "ToolError",
		};
	}
	return { message: errorMessage(error) };
}

function spawnJsWorker(): WorkerHandle {
	if (!useWorkerThreadForTests) {
		try {
			return spawnJsProcess();
		} catch (err) {
			logger.warn("JS eval subprocess spawn failed; falling back to a Bun Worker", {
				error: errorMessage(err),
			});
		}
	}
	return spawnBunWorker();
}

function spawnBunWorker(): WorkerHandle {
	try {
		const hostEntry = workerHostEntry();
		const worker = hostEntry
			? new Worker(hostEntry, { type: "module", argv: [JS_EVAL_WORKER_ARG] })
			: new Worker(new URL("./worker-entry.ts", import.meta.url).href, { type: "module" });
		return wrapBunWorker(worker);
	} catch (err) {
		logger.warn("Bun Worker spawn failed; using inline JS eval worker (no sync-loop guard)", {
			error: errorMessage(err),
		});
		return spawnInlineWorker();
	}
}

function spawnJsProcess(): WorkerHandle {
	const spawned = createWorkerSubprocess<EvalWorkerOutbound>({
		spawnCommand: resolveWorkerSpawnCmd(JS_EVAL_PROCESS_ARG),
		env: workerEnvFromParent(),
		exitLabel: "JS eval worker",
		detached: shouldDetachKernel(process.platform),
		reportCleanExit: true,
		unref: false,
	});
	const base = createWorkerHandle<EvalWorkerInbound, EvalWorkerOutbound>(spawned, message =>
		safeSendIpc(spawned.proc, message, "js-eval"),
	);
	return {
		mode: "process",
		send: message => base.send(message),
		onMessage: handler => base.onMessage(handler),
		onError: handler => base.onError(handler),
		async close() {
			const { promise, resolve } = Promise.withResolvers<boolean>();
			let settled = false;
			let timeout: NodeJS.Timeout | undefined;
			let unsubscribe = (): void => {};
			const finish = (value: boolean): void => {
				if (settled) return;
				settled = true;
				if (timeout) clearTimeout(timeout);
				unsubscribe();
				resolve(value);
			};
			unsubscribe = base.onMessage(message => {
				if (message.type !== "closed") return;
				void base.terminate().finally(() => finish(true));
			});
			timeout = setTimeout(() => finish(false), workerCloseTimeoutMs);
			base.send({ type: "close" });
			return await promise;
		},
		terminate: () => base.terminate(),
	};
}

function wrapBunWorker(worker: Worker): WorkerHandle {
	return {
		mode: "worker",
		send(msg) {
			worker.postMessage(msg);
		},
		onMessage(handler) {
			const wrap = (event: MessageEvent): void => handler(event.data as EvalWorkerOutbound);
			worker.addEventListener("message", wrap);
			return () => worker.removeEventListener("message", wrap);
		},
		onError(handler) {
			const onError = (event: ErrorEvent): void => handler(errorFromWorkerEvent(event));
			const onMessageError = (event: MessageEvent): void =>
				handler(new ToolError(`JS eval worker message error: ${String(event.data)}`));
			const onClose = (): void => handler(new Error("JS eval worker exited"));
			worker.addEventListener("error", onError);
			worker.addEventListener("messageerror", onMessageError);
			worker.addEventListener("close", onClose);
			return () => {
				worker.removeEventListener("error", onError);
				worker.removeEventListener("messageerror", onMessageError);
				worker.removeEventListener("close", onClose);
			};
		},
		async close() {
			const { promise: closed, resolve } = Promise.withResolvers<boolean>();
			let settled = false;
			let sawClosedAck = false;
			let sawWorkerExit = false;
			let timeout: NodeJS.Timeout | undefined;
			let unsubscribe = (): void => {};
			const finish = (value: boolean): void => {
				if (settled) return;
				settled = true;
				if (timeout) clearTimeout(timeout);
				unsubscribe();
				worker.removeEventListener("close", onClose);
				resolve(value);
			};
			const finishIfClosed = (): void => {
				if (sawClosedAck && sawWorkerExit) finish(true);
			};
			const onClose = (): void => {
				sawWorkerExit = true;
				finishIfClosed();
			};
			unsubscribe = this.onMessage(msg => {
				if (msg.type !== "closed") return;
				sawClosedAck = true;
				finishIfClosed();
			});
			worker.addEventListener("close", onClose);
			timeout = setTimeout(() => finish(false), workerCloseTimeoutMs);
			worker.postMessage({ type: "close" } satisfies EvalWorkerInbound);
			return await closed;
		},
		async terminate() {
			worker.terminate();
		},
	};
}

function errorFromWorkerEvent(event: ErrorEvent): Error {
	if (event.error instanceof Error) return event.error;
	if (event.message) return new Error(event.message);
	return new Error("Unknown JS eval worker error");
}

function spawnInlineWorker(): WorkerHandle {
	const hostListeners = new Set<(message: EvalWorkerOutbound) => void>();
	const workerListeners = new Set<(message: EvalWorkerInbound) => void>();
	const workerTransport: EvalWorkerTransport = {
		send: msg =>
			queueMicrotask(() => {
				for (const listener of hostListeners) listener(msg);
			}),
		onMessage: handler => {
			workerListeners.add(handler);
			return () => workerListeners.delete(handler);
		},
		close: () => {},
	};
	const core = new WorkerCore(workerTransport, {
		mode: "inline",
		interceptUnhandledRejections: postmortem.interceptUnhandledRejections,
	});
	return {
		mode: "inline",
		send: msg =>
			queueMicrotask(() => {
				for (const listener of workerListeners) listener(msg);
			}),
		onMessage: handler => {
			hostListeners.add(handler);
			return () => hostListeners.delete(handler);
		},
		onError: () => () => {},
		async close() {
			const { promise: closed, resolve } = Promise.withResolvers<boolean>();
			let settled = false;
			let timeout: NodeJS.Timeout | undefined;
			let unsubscribe = (): void => {};
			const finish = (value: boolean): void => {
				if (settled) return;
				settled = true;
				if (timeout) clearTimeout(timeout);
				unsubscribe();
				hostListeners.clear();
				workerListeners.clear();
				resolve(value);
			};
			unsubscribe = this.onMessage(msg => {
				if (msg.type === "closed") finish(true);
			});
			this.send({ type: "close" });
			timeout = setTimeout(() => finish(false), workerCloseTimeoutMs);
			return await closed;
		},
		async terminate() {
			hostListeners.clear();
			workerListeners.clear();
			core.dispose();
		},
	};
}

registerOwnedResourceDisposer({
	name: "js-eval-contexts",
	scope: "eval-kernel-owner",
	dispose: disposeVmContextsByOwner,
});
