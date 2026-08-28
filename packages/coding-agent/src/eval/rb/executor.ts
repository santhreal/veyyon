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
import type { KernelExecutor } from "../kernel-base";
import { releaseKernel } from "../kernel-base";
import { ensureKernelToolBridge } from "../kernel-tool-bridge";
import { checkRubyKernelAvailability, type KernelDisplayOutput, RubyKernel } from "./kernel";
import { resolveExplicitRubyRuntime } from "./runtime";

export interface RubyExecutorOptions {
	cwd?: string;
	timeoutMs?: number;
	deadlineMs?: number;
	idleTimeoutMs?: number;
	onChunk?: (chunk: string) => Promise<void> | void;
	signal?: AbortSignal;
	sessionId?: string;
	kernelOwnerId?: string;
	interpreter?: string;
	reset?: boolean;
	kernelMode?: KernelMode;
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

export interface RubyResult {
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

interface RubySessionOwners {
	ownerIds: Set<string>;
	hasFallbackOwner: boolean;
}

interface RubySession extends RubySessionOwners {
	sessionKey: string;
	sessionId: string;
	cwd: string;
	kernel: RubyKernel;
}

interface StartingRubySession extends RubySessionOwners {
	promise: Promise<RubySession>;
}

const sessions = new Map<string, RubySession>();
const startingSessions = new Map<string, StartingRubySession>();
const resettingSessions = new Map<string, Promise<void>>();

class RubyExecutionCancelledError extends Error {
	readonly timedOut: boolean;

	constructor(timedOut: boolean) {
		super(timedOut ? "Command timed out" : "Command aborted");
		this.name = timedOut ? "TimeoutError" : "AbortError";
		this.timedOut = timedOut;
	}
}

function requireRemainingTimeoutMs(deadlineMs?: number): number | undefined {
	const remainingMs = getRemainingTimeoutMs(deadlineMs);
	if (remainingMs === undefined) return undefined;
	if (remainingMs <= 0) {
		throw new RubyExecutionCancelledError(true);
	}
	return remainingMs;
}

function createCancelledRubyResult(timedOut: boolean, timeoutMs?: number): RubyResult {
	const output = timedOut ? formatTimeoutAnnotation(timeoutMs) : "";
	return createCancelledKernelResult(output);
}

async function startKernel(cwd: string, options: RubyExecutorOptions): Promise<RubyKernel> {
	requireRemainingTimeoutMs(options.deadlineMs);
	return await RubyKernel.start({
		cwd,
		env: buildManagedKernelEnv(options),
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
	options: RubyExecutorOptions,
): Promise<RubySession> {
	const existing = sessions.get(sessionKey);
	if (existing) {
		attachSessionOwner(existing, sessionId, options.kernelOwnerId);
		return existing;
	}
	const starting = startingSessions.get(sessionKey);
	if (starting) {
		attachSessionOwner(starting, sessionId, options.kernelOwnerId);
		return await starting.promise;
	}
	let startingSession!: StartingRubySession;
	const startup = (async () => {
		const kernel = await startKernel(cwd, options);
		const session: RubySession = {
			sessionKey,
			sessionId,
			cwd,
			kernel,
			ownerIds: new Set(startingSession.ownerIds),
			hasFallbackOwner: startingSession.hasFallbackOwner,
		};
		if (startingSessions.get(sessionKey) === startingSession) {
			sessions.set(sessionKey, session);
		}
		return session;
	})();
	startingSession = {
		ownerIds: new Set(),
		hasFallbackOwner: false,
		promise: startup,
	};
	attachSessionOwner(startingSession, sessionId, options.kernelOwnerId);
	startingSessions.set(sessionKey, startingSession);
	try {
		return await startup;
	} finally {
		if (startingSessions.get(sessionKey) === startingSession) startingSessions.delete(sessionKey);
	}
}

async function replaceSessionKernel(session: RubySession, cwd: string, options: RubyExecutorOptions): Promise<void> {
	const old = session.kernel;
	const remaining = getRemainingTimeoutMs(options.deadlineMs);
	await releaseKernel(
		old,
		"ruby-session-kernel-replaced",
		remaining !== undefined ? { timeoutMs: Math.max(0, remaining) } : undefined,
	);
	if (sessions.get(session.sessionKey) !== session) {
		throw new RubyExecutionCancelledError(false);
	}
	requireRemainingTimeoutMs(options.deadlineMs);
	const next = await startKernel(cwd, options);
	if (sessions.get(session.sessionKey) !== session) {
		await releaseKernel(next, "ruby-session-superseded-while-starting");
		throw new RubyExecutionCancelledError(false);
	}
	session.kernel = next;
}

async function resetSession(sessionKey: string): Promise<void> {
	const existing =
		sessions.get(sessionKey) ?? (await startingSessions.get(sessionKey)?.promise.catch(() => undefined));
	if (!existing) return;
	sessions.delete(sessionKey);
	await releaseKernel(existing.kernel, "ruby-session-reset");
}

export async function disposeAllRubyKernelSessions(): Promise<void> {
	const pending = Array.from(startingSessions.values()).map(starting => starting.promise);
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
		logger.warn("Ruby kernel shutdown not confirmed", {
			sessionId: session.sessionId,
			sessionKey: id,
			cwd: session.cwd,
			reason,
		});
		if (!sessions.has(id)) sessions.set(id, session);
	}
}

export async function disposeRubyKernelSessionsByOwner(ownerId: string): Promise<void> {
	const toShutdown: RubySession[] = [];
	const startingToShutdown: StartingRubySession[] = [];
	for (const session of Array.from(sessions.values())) {
		if (!session.ownerIds.has(ownerId)) continue;
		if (session.ownerIds.size === 1) {
			toShutdown.push(session);
			continue;
		}
		session.ownerIds.delete(ownerId);
	}
	for (const [sessionKey, starting] of Array.from(startingSessions.entries())) {
		if (sessions.has(sessionKey) || !starting.ownerIds.has(ownerId)) continue;
		if (starting.ownerIds.size === 1) {
			startingSessions.delete(sessionKey);
			startingToShutdown.push(starting);
			continue;
		}
		starting.ownerIds.delete(ownerId);
	}
	for (const session of toShutdown) {
		if (sessions.get(session.sessionKey) === session) sessions.delete(session.sessionKey);
	}
	const started = await Promise.allSettled(startingToShutdown.map(starting => starting.promise));
	for (const result of started) {
		if (result.status !== "fulfilled") continue;
		const session = result.value;
		if (sessions.get(session.sessionKey) === session) sessions.delete(session.sessionKey);
		toShutdown.push(session);
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
		logger.warn("Ruby kernel shutdown not confirmed", {
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
	options: RubyExecutorOptions | undefined,
): Promise<RubyResult> {
	return executeWithKernelBase<RubyExecutorOptions>({
		kernel,
		code,
		options,
		runIdPrefix: "rb",
		errorLogLabel: "Ruby",
		cancelledErrorClass: RubyExecutionCancelledError,
		buildKernelEnvPatch: buildManagedKernelEnvPatch,
		formatKernelTimeoutAnnotation,
		formatTimeoutAnnotation,
	});
}

async function ensureKernelAvailable(cwd: string, options: RubyExecutorOptions): Promise<void> {
	const availability = await waitForPromiseWithCancellation(
		checkRubyKernelAvailability(cwd, options.interpreter),
		options,
		RubyExecutionCancelledError,
	);
	if (!availability.ok) {
		throw new Error(availability.reason ?? "Ruby kernel unavailable");
	}
}

async function ensureToolBridge(options: RubyExecutorOptions): Promise<void> {
	if (!options.toolSession || options.bridge) return;
	try {
		options.bridge = await ensureKernelToolBridge();
	} catch (err) {
		logger.warn("Failed to start Ruby tool bridge", {
			error: errorMessage(err),
		});
	}
}

async function executePerCall(code: string, cwd: string, options: RubyExecutorOptions): Promise<RubyResult> {
	if (options.bridge && !options.bridgeSessionId) {
		options.bridgeSessionId = `rb-bridge:${crypto.randomUUID()}`;
	}
	const kernel = await startKernel(cwd, options);
	try {
		return await executeWithKernel(kernel, code, { ...options, cwd });
	} finally {
		await releaseKernel(kernel, "ruby-one-shot-finished");
	}
}

async function executeOnSession(code: string, cwd: string, options: RubyExecutorOptions): Promise<RubyResult> {
	const sessionId = options.sessionId ?? `session:${cwd}`;
	const sessionKey = buildEvalSessionKey({
		sessionId,
		cwd,
		interpreter: options.interpreter,
		resolveInterpreterPath: (interpreter, resolvedCwd) =>
			resolveExplicitRubyRuntime(interpreter, resolvedCwd, {}).rubyPath,
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
		throw new RubyExecutionCancelledError(
			isTimedOutCancellation(options.signal.reason, RubyExecutionCancelledError, options.signal),
		);
	}
	if (sessions.get(session.sessionKey) !== session) {
		throw new RubyExecutionCancelledError(false);
	}
	if (!session.kernel.isAlive()) {
		await replaceSessionKernel(session, cwd, options);
		if (sessions.get(session.sessionKey) !== session) {
			throw new RubyExecutionCancelledError(false);
		}
	}
	const runOptions = { ...options, cwd };
	try {
		return await executeWithKernel(session.kernel, code, runOptions);
	} catch (err) {
		if (isCancellationError(err, RubyExecutionCancelledError) || options.signal?.aborted) throw err;
		if (session.kernel.isAlive()) throw err;
		if (sessions.get(session.sessionKey) !== session) {
			throw new RubyExecutionCancelledError(false);
		}
		await replaceSessionKernel(session, cwd, options);
		if (sessions.get(session.sessionKey) !== session) {
			throw new RubyExecutionCancelledError(false);
		}
		return await executeWithKernel(session.kernel, code, runOptions);
	}
}

export async function executeRubyWithKernel(
	kernel: KernelExecutor,
	code: string,
	options?: RubyExecutorOptions,
): Promise<RubyResult> {
	return await executeWithKernel(kernel, code, options);
}

export async function executeRuby(code: string, options?: RubyExecutorOptions): Promise<RubyResult> {
	const cwd = normalizeSessionCwd(options?.cwd ?? getProjectDir());
	const deadlineMs = getExecutionDeadlineMs(options);
	const executionOptions: RubyExecutorOptions = {
		...(options ?? {}),
		cwd,
		deadlineMs,
	};

	await gateSessionCpuSpawn(options?.toolSession?.getSessionId?.() ?? null, "a Ruby eval cell");
	try {
		requireRemainingTimeoutMs(deadlineMs);
		if (executionOptions.signal?.aborted) {
			throw new RubyExecutionCancelledError(
				isTimedOutCancellation(
					executionOptions.signal.reason,
					RubyExecutionCancelledError,
					executionOptions.signal,
				),
			);
		}
		await ensureKernelAvailable(cwd, executionOptions);
		await ensureToolBridge(executionOptions);
		if ((executionOptions.kernelMode ?? "session") === "per-call") {
			return await executePerCall(code, cwd, executionOptions);
		}
		return await executeOnSession(code, cwd, executionOptions);
	} catch (err) {
		if (isCancellationError(err, RubyExecutionCancelledError) || executionOptions.signal?.aborted) {
			return createCancelledRubyResult(
				isTimedOutCancellation(err, RubyExecutionCancelledError, executionOptions.signal),
			);
		}
		throw err;
	}
}

registerOwnedResourceDisposer({
	name: "ruby-kernels",
	scope: "eval-kernel-owner",
	dispose: disposeRubyKernelSessionsByOwner,
});
