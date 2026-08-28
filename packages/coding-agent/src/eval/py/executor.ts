import { errorMessage, getProjectDir, logger } from "@veyyon/utils";
import { gateSessionCpuSpawn, sessionCpuAdoption } from "../../session/cpu-limit";
import { registerOwnedResourceDisposer } from "../../session/owned-resources";
import type { ToolSession } from "../../tools";
import {
	attachSessionOwner,
	buildEvalSessionKey,
	buildManagedKernelEnv,
	buildManagedKernelEnvPatch,
	createCancelledKernelResult,
	executeWithKernelBase,
	formatKernelTimeoutAnnotation,
	formatTimeoutAnnotation,
	getExecutionDeadlineMs,
	getRemainingTimeoutMs,
	isCancellationError,
	isTimedOutCancellation,
	type KernelMode,
	normalizeSessionCwd,
	waitForPromiseWithCancellation,
} from "../executor-base";
import type { JsStatusEvent } from "../js/shared/types";
import type { KernelExecutor, SessionKernel } from "../kernel-base";
import { releaseKernel } from "../kernel-base";
import { ensureKernelToolBridge } from "../kernel-tool-bridge";
import {
	checkPythonKernelAvailability,
	type KernelDisplayOutput,
	type KernelExecuteOptions,
	PythonKernel,
} from "./kernel";
import { resolveExplicitPythonRuntime } from "./runtime";

export type PythonKernelMode = KernelMode;

export interface PythonExecutorOptions {
	cwd?: string;
	timeoutMs?: number;
	deadlineMs?: number;
	idleTimeoutMs?: number;
	onChunk?: (chunk: string) => Promise<void> | void;
	signal?: AbortSignal;
	sessionId?: string;
	kernelOwnerId?: string;
	kernelMode?: PythonKernelMode;
	interpreter?: string;
	reset?: boolean;
	sessionFile?: string;
	artifactsDir?: string;
	artifactPath?: string;
	artifactId?: string;
	localRoots?: Record<string, string>;
	toolSession?: ToolSession;
	emitStatus?: (event: JsStatusEvent) => void;
	onStatus?: (event: JsStatusEvent) => void;
	bridgeSessionId?: string;
	bridge?: { url: string; token: string };
}

export interface PythonResult {
	output: string;
	exitCode: number | undefined;
	cancelled: boolean;
	truncated: boolean;
	artifactId?: string;
	totalLines: number;
	totalBytes: number;
	outputLines: number;
	outputBytes: number;
	displayOutputs: KernelDisplayOutput[];
	stdinRequested: boolean;
}

interface PythonSession {
	sessionKey: string;
	sessionId: string;
	cwd: string;
	kernel: SessionKernel<KernelExecuteOptions>;
	ownerIds: Set<string>;
	hasFallbackOwner: boolean;
}

const sessions = new Map<string, PythonSession>();
const startingSessions = new Map<string, Promise<PythonSession>>();
const resettingSessions = new Map<string, Promise<void>>();

class PythonExecutionCancelledError extends Error {
	readonly timedOut: boolean;

	constructor(timedOut: boolean) {
		super(timedOut ? "Command timed out" : "Command aborted");
		this.name = "PythonExecutionCancelledError";
		this.timedOut = timedOut;
	}
}

function requireRemainingTimeoutMs(deadlineMs?: number): number | undefined {
	const remainingMs = getRemainingTimeoutMs(deadlineMs);
	if (remainingMs === undefined) return undefined;
	if (remainingMs <= 0) {
		throw new PythonExecutionCancelledError(true);
	}
	return remainingMs;
}

function createCancelledPythonResult(timedOut: boolean, timeoutMs?: number): PythonResult {
	const output = timedOut ? formatTimeoutAnnotation(timeoutMs) : "";
	return createCancelledKernelResult(output);
}

async function startKernel(cwd: string, options: PythonExecutorOptions): Promise<PythonKernel> {
	requireRemainingTimeoutMs(options.deadlineMs);
	return await PythonKernel.start({
		cwd,
		env: buildManagedKernelEnv({ ...options, evalSessionId: options.sessionId }),
		signal: options.signal,
		deadlineMs: options.deadlineMs,
		interpreter: options.interpreter,
		adoptPid: sessionCpuAdoption(() => options.toolSession?.getSessionId?.() ?? null),
	});
}

async function acquireSession(
	sessionKey: string,
	sessionId: string,
	cwd: string,
	options: PythonExecutorOptions,
): Promise<PythonSession> {
	const existing = sessions.get(sessionKey);
	if (existing) {
		attachSessionOwner(existing, sessionId, options.kernelOwnerId);
		return existing;
	}
	const starting = startingSessions.get(sessionKey);
	if (starting) {
		const session = await starting;
		attachSessionOwner(session, sessionId, options.kernelOwnerId);
		return session;
	}
	const startup = (async () => {
		const kernel = await startKernel(cwd, options);
		const session: PythonSession = {
			sessionKey,
			sessionId,
			cwd,
			kernel,
			ownerIds: new Set(),
			hasFallbackOwner: false,
		};
		sessions.set(sessionKey, session);
		return session;
	})();
	startingSessions.set(sessionKey, startup);
	try {
		const session = await startup;
		attachSessionOwner(session, sessionId, options.kernelOwnerId);
		return session;
	} finally {
		if (startingSessions.get(sessionKey) === startup) startingSessions.delete(sessionKey);
	}
}

async function replaceSessionKernel(
	session: PythonSession,
	cwd: string,
	options: PythonExecutorOptions,
): Promise<void> {
	const old = session.kernel;
	const remaining = getRemainingTimeoutMs(options.deadlineMs);
	await releaseKernel(
		old,
		"python-session-kernel-replaced",
		remaining !== undefined ? { timeoutMs: Math.max(0, remaining) } : undefined,
	);
	if (sessions.get(session.sessionKey) !== session) {
		throw new PythonExecutionCancelledError(false);
	}
	requireRemainingTimeoutMs(options.deadlineMs);
	const next = await startKernel(cwd, options);
	if (sessions.get(session.sessionKey) !== session) {
		await releaseKernel(next, "python-session-superseded-while-starting");
		throw new PythonExecutionCancelledError(false);
	}
	session.kernel = next;
}

async function resetSession(sessionKey: string): Promise<void> {
	const existing = sessions.get(sessionKey) ?? (await startingSessions.get(sessionKey)?.catch(() => undefined));
	if (!existing) return;
	sessions.delete(sessionKey);
	await releaseKernel(existing.kernel, "python-session-reset");
}

export async function disposeAllKernelSessions(): Promise<void> {
	const pending = Array.from(startingSessions.values());
	startingSessions.clear();
	const started = await Promise.allSettled(pending);
	const all = Array.from(sessions.entries());
	for (const result of started) {
		if (result.status !== "fulfilled") continue;
		if (!all.some(([, session]) => session === result.value)) {
			all.push([result.value.sessionKey, result.value]);
		}
	}
	for (const [id, session] of all) {
		if (sessions.get(id) === session) sessions.delete(id);
	}
	const results = await Promise.allSettled(all.map(([, session]) => session.kernel.shutdown()));
	for (let i = 0; i < all.length; i += 1) {
		const [id, session] = all[i];
		const result = results[i];
		if (result.status === "fulfilled" && result.value?.confirmed !== false) continue;
		const reason = result.status === "rejected" ? result.reason : "not confirmed";
		logger.warn("Python kernel shutdown not confirmed", {
			sessionId: session.sessionId,
			sessionKey: id,
			cwd: session.cwd,
			reason,
		});
		if (!sessions.has(id)) sessions.set(id, session);
	}
}

export async function disposeKernelSessionsByOwner(ownerId: string): Promise<void> {
	const toShutdown: PythonSession[] = [];
	for (const session of Array.from(sessions.values())) {
		if (!session.ownerIds.has(ownerId)) continue;
		if (session.ownerIds.size === 1) {
			toShutdown.push(session);
			continue;
		}
		session.ownerIds.delete(ownerId);
	}
	for (const session of toShutdown) {
		if (sessions.get(session.sessionKey) === session) sessions.delete(session.sessionKey);
	}
	const results = await Promise.allSettled(toShutdown.map(session => session.kernel.shutdown()));
	for (let i = 0; i < toShutdown.length; i += 1) {
		const session = toShutdown[i];
		const result = results[i];
		if (result.status === "fulfilled" && result.value?.confirmed !== false) {
			session.ownerIds.delete(ownerId);
			continue;
		}
		const reason = result.status === "rejected" ? result.reason : "not confirmed";
		logger.warn("Python kernel shutdown not confirmed", {
			sessionId: session.sessionId,
			sessionKey: session.sessionKey,
			cwd: session.cwd,
			reason,
		});
		if (!sessions.has(session.sessionKey)) sessions.set(session.sessionKey, session);
	}
}

async function executeWithKernel(
	kernel: KernelExecutor,
	code: string,
	options: PythonExecutorOptions | undefined,
): Promise<PythonResult> {
	return executeWithKernelBase<PythonExecutorOptions>({
		kernel,
		code,
		options,
		runIdPrefix: "py",
		errorLogLabel: "Python",
		cancelledErrorClass: PythonExecutionCancelledError,
		buildKernelEnvPatch: opts => buildManagedKernelEnvPatch({ ...opts, evalSessionId: options?.sessionId }),
		formatKernelTimeoutAnnotation,
		formatTimeoutAnnotation,
	});
}

async function ensureKernelAvailable(cwd: string, options: PythonExecutorOptions): Promise<void> {
	const availability = await waitForPromiseWithCancellation(
		checkPythonKernelAvailability(cwd, options.interpreter),
		options,
		PythonExecutionCancelledError,
	);
	if (!availability.ok) {
		throw new Error(availability.reason ?? "Python kernel unavailable");
	}
}

async function ensureToolBridge(options: PythonExecutorOptions): Promise<void> {
	if (!options.toolSession || options.bridge) return;
	try {
		options.bridge = await ensureKernelToolBridge();
	} catch (err) {
		logger.warn("Failed to start kernel tool bridge", {
			error: errorMessage(err),
		});
	}
}

async function executePerCall(code: string, cwd: string, options: PythonExecutorOptions): Promise<PythonResult> {
	if (options.bridge && !options.bridgeSessionId) {
		options.bridgeSessionId = `py-bridge:${crypto.randomUUID()}`;
	}
	const kernel = await startKernel(cwd, options);
	try {
		return await executeWithKernel(kernel, code, { ...options, cwd });
	} finally {
		await releaseKernel(kernel, "python-one-shot-finished");
	}
}

async function executeOnSession(code: string, cwd: string, options: PythonExecutorOptions): Promise<PythonResult> {
	const sessionId = options.sessionId ?? `session:${cwd}`;
	const sessionKey = buildEvalSessionKey({
		sessionId,
		cwd,
		interpreter: options.interpreter,
		resolveInterpreterPath: (interpreter, resolvedCwd) =>
			resolveExplicitPythonRuntime(interpreter, resolvedCwd, {}).pythonPath,
	});
	if (options.bridge && !options.bridgeSessionId) {
		options.bridgeSessionId = sessionId;
	}
	if (options.reset) {
		const inFlight = resettingSessions.get(sessionKey);
		if (inFlight) await inFlight.catch(() => undefined);
		else {
			const resetPromise = resetSession(sessionKey);
			resettingSessions.set(
				sessionKey,
				resetPromise.then(() => undefined),
			);
			try {
				await resetPromise;
			} finally {
				resettingSessions.delete(sessionKey);
			}
		}
	} else {
		const inFlight = resettingSessions.get(sessionKey);
		if (inFlight) await inFlight.catch(() => undefined);
	}
	const session = await acquireSession(sessionKey, sessionId, cwd, options);
	if (options.signal?.aborted) {
		throw new PythonExecutionCancelledError(
			isTimedOutCancellation(options.signal.reason, PythonExecutionCancelledError, options.signal),
		);
	}
	if (sessions.get(session.sessionKey) !== session) {
		throw new PythonExecutionCancelledError(false);
	}
	if (!session.kernel.isAlive()) {
		await replaceSessionKernel(session, cwd, options);
		if (sessions.get(session.sessionKey) !== session) {
			throw new PythonExecutionCancelledError(false);
		}
	}
	const runOptions = { ...options, cwd };
	try {
		return await executeWithKernel(session.kernel, code, runOptions);
	} catch (err) {
		if (isCancellationError(err, PythonExecutionCancelledError) || options.signal?.aborted) throw err;
		if (session.kernel.isAlive()) throw err;
		if (sessions.get(session.sessionKey) !== session) {
			throw new PythonExecutionCancelledError(false);
		}
		await replaceSessionKernel(session, cwd, options);
		if (sessions.get(session.sessionKey) !== session) {
			throw new PythonExecutionCancelledError(false);
		}
		return await executeWithKernel(session.kernel, code, runOptions);
	}
}

export async function executePythonWithKernel(
	kernel: KernelExecutor,
	code: string,
	options?: PythonExecutorOptions,
): Promise<PythonResult> {
	return await executeWithKernel(kernel, code, options);
}

export async function executePython(code: string, options?: PythonExecutorOptions): Promise<PythonResult> {
	const cwd = normalizeSessionCwd(options?.cwd ?? getProjectDir());
	const deadlineMs = getExecutionDeadlineMs(options);
	const executionOptions: PythonExecutorOptions = {
		...(options ?? {}),
		cwd,
		deadlineMs,
	};

	await gateSessionCpuSpawn(options?.toolSession?.getSessionId?.() ?? null, "a Python eval cell");
	try {
		requireRemainingTimeoutMs(deadlineMs);
		if (executionOptions.signal?.aborted) {
			throw new PythonExecutionCancelledError(
				isTimedOutCancellation(
					executionOptions.signal.reason,
					PythonExecutionCancelledError,
					executionOptions.signal,
				),
			);
		}
		await ensureKernelAvailable(cwd, executionOptions);
		await ensureToolBridge(executionOptions);

		const kernelMode = executionOptions.kernelMode ?? "session";
		if (kernelMode === "per-call") {
			return await executePerCall(code, cwd, executionOptions);
		}
		return await executeOnSession(code, cwd, executionOptions);
	} catch (err) {
		if (isCancellationError(err, PythonExecutionCancelledError) || executionOptions.signal?.aborted) {
			return createCancelledPythonResult(
				isTimedOutCancellation(err, PythonExecutionCancelledError, executionOptions.signal),
			);
		}
		throw err;
	}
}

registerOwnedResourceDisposer({
	name: "python-kernels",
	scope: "eval-kernel-owner",
	dispose: disposeKernelSessionsByOwner,
});
