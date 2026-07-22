import * as path from "node:path";
import { errorMessage, getProjectDir, logger } from "@veyyon/utils";
import type { ToolSession } from "../../tools";
import {
	attachSessionOwner,
	createCancelledKernelResult,
	executeWithKernelBase,
	getRemainingTimeoutMs,
	isCancellationError as isCancellationErrorBase,
	isTimedOutCancellation as isTimedOutCancellationBase,
} from "../executor-base";
import { ensureKernelToolBridge, type KernelToolBridgeInfo } from "../kernel-tool-bridge";
import type { EvalDisplayOutput, EvalStatusEvent } from "../types";
import {
	checkJuliaKernelAvailability,
	JuliaKernel,
	type KernelExecuteOptions,
	type KernelExecuteResult,
} from "./kernel";
import { resolveExplicitJuliaRuntime } from "./runtime";

const SHUTDOWN_GRACE_MS = 1_000;

export interface JuliaExecutorOptions {
	cwd?: string;
	sessionId?: string;
	sessionFile?: string;
	artifactsDir?: string;
	localRoots?: Record<string, string>;
	interpreter?: string;
	onChunk?: (text: string) => void | Promise<void>;
	onStatus?: (event: EvalStatusEvent) => void;
	signal?: AbortSignal;
	timeoutMs?: number;
	deadlineMs?: number;
	idleTimeoutMs?: number;
	kernelOwnerId?: string;
	reset?: boolean;
	toolSession?: ToolSession;
	bridge?: KernelToolBridgeInfo;
	bridgeSessionId?: string;
	artifactId?: string;
}

export interface JuliaKernelExecutor {
	execute: (code: string, options?: KernelExecuteOptions) => Promise<KernelExecuteResult>;
}

export interface JuliaResult {
	output: string;
	exitCode: number | undefined;
	cancelled: boolean;
	truncated: boolean;
	artifactId: string | undefined;
	totalLines: number;
	totalBytes: number;
	outputLines: number;
	outputBytes: number;
	displayOutputs: EvalDisplayOutput[];
	stdinRequested: boolean;
}

interface JuliaSessionOwners {
	ownerIds: Set<string>;
	hasFallbackOwner: boolean;
}

interface JuliaSession extends JuliaSessionOwners {
	sessionKey: string;
	sessionId: string;
	cwd: string;
	kernel: JuliaKernel;
}

interface StartingJuliaSession extends JuliaSessionOwners {
	promise: Promise<JuliaSession>;
}

class JuliaExecutionCancelledError extends Error {
	constructor(readonly timedOut: boolean) {
		super(timedOut ? "Julia execution timed out" : "Julia execution cancelled");
		this.name = "JuliaExecutionCancelledError";
	}
}

const sessions = new Map<string, JuliaSession>();
const startingSessions = new Map<string, StartingJuliaSession>();
const resettingSessions = new Map<string, Promise<void>>();

function normalizeSessionCwd(cwd: string): string {
	return path.resolve(cwd);
}

function normalizeExplicitInterpreter(cwd: string, interpreter: string | undefined): string {
	if (interpreter === undefined) return "";
	const resolved = resolveExplicitJuliaRuntime(interpreter, cwd, {}).juliaPath;
	try {
		return path.resolve(resolved);
	} catch {
		return resolved;
	}
}

function buildSessionKey(sessionId: string, cwd: string, interpreter: string | undefined): string {
	const normalizedCwd = normalizeSessionCwd(cwd);
	const normalizedInterpreter = normalizeExplicitInterpreter(normalizedCwd, interpreter);
	return `${sessionId}::${normalizedCwd}::${normalizedInterpreter}`;
}

// Cancellation classification is owned by executor-base; these bind the Julia
// cancelled-error class and delegate. The shared versions handle a DOMException
// timeout/abort reason explicitly (on both the error and `signal.reason`),
// which the previous local copies only caught because Bun happens to make
// DOMException a subclass of Error — a runtime quirk, not a guarantee.
function isCancellationError(error: unknown): boolean {
	return isCancellationErrorBase(error, JuliaExecutionCancelledError);
}

function isTimedOutCancellation(error: unknown, signal?: AbortSignal): boolean {
	return isTimedOutCancellationBase(error, JuliaExecutionCancelledError, signal);
}

// Kept local (not the shared executor-base owner) on purpose: unlike py/rb, jl
// treats `timeoutMs === 0` as "no timeout" (returns undefined) rather than an
// immediate deadline. The shared `getExecutionDeadlineMs` returns `Date.now()`
// for a zero timeout; jl's kernel path would then reject a still-valid session
// as already expired. The `> 0` guard is the intentional difference; see the
// getExecutionDeadlineMs test in julia-cancellation-helpers.test.ts.
export function getExecutionDeadlineMs(
	options?: Pick<JuliaExecutorOptions, "deadlineMs" | "timeoutMs">,
): number | undefined {
	if (options?.deadlineMs !== undefined) return options.deadlineMs;
	if (options?.timeoutMs !== undefined && options.timeoutMs > 0) return Date.now() + options.timeoutMs;
	return undefined;
}

function requireRemainingTimeoutMs(deadlineMs?: number): number | undefined {
	if (deadlineMs === undefined) return undefined;
	const remaining = getRemainingTimeoutMs(deadlineMs);
	if (remaining !== undefined && remaining <= 0) {
		throw new JuliaExecutionCancelledError(true);
	}
	return remaining;
}

async function waitForPromiseWithCancellation<T>(
	promise: Promise<T>,
	options: Pick<JuliaExecutorOptions, "signal" | "deadlineMs">,
): Promise<T> {
	if (options.signal?.aborted) {
		throw new JuliaExecutionCancelledError(isTimedOutCancellation(options.signal.reason, options.signal));
	}
	const cleanups: Array<() => void> = [];
	const { promise: cancelPromise, reject } = Promise.withResolvers<never>();

	if (options.signal) {
		const onAbort = () => {
			reject(new JuliaExecutionCancelledError(isTimedOutCancellation(options.signal?.reason, options.signal)));
		};
		options.signal.addEventListener("abort", onAbort, { once: true });
		cleanups.push(() => options.signal?.removeEventListener("abort", onAbort));
	}

	const deadlineMs = options.deadlineMs;
	if (typeof deadlineMs === "number" && deadlineMs > Date.now()) {
		const timeout = setTimeout(() => {
			reject(new JuliaExecutionCancelledError(true));
		}, deadlineMs - Date.now());
		timeout.unref?.();
		cleanups.push(() => clearTimeout(timeout));
	}

	try {
		return await Promise.race([promise, cancelPromise]);
	} finally {
		for (const cleanup of cleanups) cleanup();
	}
}

function formatTimeoutAnnotation(timeoutMs?: number): string | undefined {
	if (timeoutMs === undefined) return undefined;
	const rounded = (timeoutMs / 1000).toFixed(0);
	return `[cell timed out after ${rounded}s]`;
}

function formatKernelTimeoutAnnotation(timeoutMs: number | undefined, kernelKilled: boolean): string {
	const explanation = kernelKilled ? "; active subprocess terminated to recover" : "; kernel is still running";
	if (timeoutMs === undefined) return `[execution timed out${explanation}]`;
	const rounded = (timeoutMs / 1000).toFixed(0);
	return `[execution timed out after ${rounded}s${explanation}]`;
}

export function createCancelledJuliaResult(timedOut: boolean, timeoutMs?: number): JuliaResult {
	// Honor the `timedOut` flag so a timed-out cell is labeled as a timeout, not a
	// generic cancellation. Previously this argument was ignored and the annotation
	// keyed only on `timeoutMs`, which the outer catch never passes, so EVERY
	// cancelled Julia cell (timeout or plain abort) rendered "[execution cancelled]"
	// and the timeout signal was lost. Julia keeps its own bracketed wording (its
	// kernel-recovery model differs from the python/ruby interrupt+reset flow), but
	// now a timeout is distinguishable: "[cell timed out ...]" vs "[execution cancelled]".
	const output = timedOut ? (formatTimeoutAnnotation(timeoutMs) ?? "[cell timed out]\n") : "[execution cancelled]\n";
	return createCancelledKernelResult(output);
}

function buildKernelEnvPatch(options: {
	sessionFile?: string;
	artifactsDir?: string;
	bridge?: KernelToolBridgeInfo;
	bridgeSessionId?: string;
	localRoots?: Record<string, string>;
}): Record<string, string | undefined> {
	const patch: Record<string, string | undefined> = {};
	if (options.sessionFile) patch.VEYYON_SESSION_FILE = options.sessionFile;
	if (options.artifactsDir) patch.VEYYON_ARTIFACTS_DIR = options.artifactsDir;
	if (options.bridge) {
		patch.VEYYON_TOOL_BRIDGE_URL = options.bridge.url;
		patch.VEYYON_TOOL_BRIDGE_TOKEN = options.bridge.token;
		patch.VEYYON_TOOL_BRIDGE_SESSION = options.bridgeSessionId ?? "";
	}
	if (options.localRoots) {
		patch.VEYYON_EVAL_LOCAL_ROOTS = JSON.stringify(options.localRoots);
	}
	return patch;
}

function buildKernelEnv(options: {
	sessionFile?: string;
	artifactsDir?: string;
	bridge?: KernelToolBridgeInfo;
	bridgeSessionId?: string;
	localRoots?: Record<string, string>;
}): Record<string, string> | undefined {
	const patch = buildKernelEnvPatch(options);
	const keys = Object.keys(patch);
	if (keys.length === 0) return undefined;
	const realEnv: Record<string, string> = {};
	for (const key in patch) {
		const val = patch[key];
		if (typeof val === "string") realEnv[key] = val;
	}
	return realEnv;
}

async function startKernel(cwd: string, options: JuliaExecutorOptions): Promise<JuliaKernel> {
	requireRemainingTimeoutMs(options.deadlineMs);
	const env: Record<string, string | undefined> = {};
	const patch = buildKernelEnv(options);
	if (patch) {
		for (const key in patch) {
			const value = patch[key];
			if (typeof value === "string") env[key] = value;
		}
	}
	return await JuliaKernel.start({
		cwd,
		interpreter: options.interpreter,
		env,
		signal: options.signal,
		deadlineMs: options.deadlineMs,
	});
}

async function acquireSession(
	sessionKey: string,
	sessionId: string,
	cwd: string,
	options: JuliaExecutorOptions,
): Promise<JuliaSession> {
	const existing = sessions.get(sessionKey);
	if (existing) {
		attachSessionOwner(existing, sessionId, options.kernelOwnerId);
		return existing;
	}

	const inFlight = startingSessions.get(sessionKey);
	if (inFlight) {
		attachSessionOwner(inFlight, sessionId, options.kernelOwnerId);
		return await waitForPromiseWithCancellation(inFlight.promise, options);
	}

	let startingSession!: StartingJuliaSession;
	const startPromise = (async () => {
		const kernel = await startKernel(cwd, options);
		const session: JuliaSession = {
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
		promise: startPromise,
	};
	attachSessionOwner(startingSession, sessionId, options.kernelOwnerId);
	startingSessions.set(sessionKey, startingSession);
	try {
		return await waitForPromiseWithCancellation(startPromise, options);
	} finally {
		if (startingSessions.get(sessionKey) === startingSession) startingSessions.delete(sessionKey);
	}
}

async function replaceSessionKernel(session: JuliaSession, cwd: string, options: JuliaExecutorOptions): Promise<void> {
	logger.warn("Julia subprocess died or is unresponsive; spawning fresh process", {
		sessionKey: session.sessionKey,
	});
	const oldKernel = session.kernel;
	const remaining = getRemainingTimeoutMs(options.deadlineMs);
	await oldKernel
		.shutdown(remaining !== undefined ? { timeoutMs: Math.max(0, remaining) } : undefined)
		.catch(() => undefined);
	if (sessions.get(session.sessionKey) !== session) {
		throw new JuliaExecutionCancelledError(false);
	}
	requireRemainingTimeoutMs(options.deadlineMs);
	const nextKernel = await startKernel(cwd, options);
	if (sessions.get(session.sessionKey) !== session) {
		await nextKernel.shutdown().catch(() => undefined);
		throw new JuliaExecutionCancelledError(false);
	}
	session.kernel = nextKernel;
}

async function resetSession(sessionKey: string): Promise<void> {
	const session = sessions.get(sessionKey) ?? (await startingSessions.get(sessionKey)?.promise.catch(() => undefined));
	if (!session) return;
	sessions.delete(sessionKey);
	await session.kernel.shutdown({ timeoutMs: SHUTDOWN_GRACE_MS }).catch(() => undefined);
}

export async function disposeAllJuliaKernelSessions(): Promise<void> {
	const pending = [...startingSessions.values()].map(starting => starting.promise);
	startingSessions.clear();
	resettingSessions.clear();
	const started = await Promise.allSettled(pending);
	const all = [...sessions.entries()];
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
		logger.warn("Julia kernel shutdown not confirmed", {
			sessionId: session.sessionId,
			sessionKey: id,
			cwd: session.cwd,
			reason,
		});
		if (!sessions.has(id)) sessions.set(id, session);
	}
}

export async function disposeJuliaKernelSessionsByOwner(ownerId: string): Promise<void> {
	const toShutdown: JuliaSession[] = [];
	const startingToShutdown: StartingJuliaSession[] = [];
	for (const session of [...sessions.values()]) {
		if (!session.ownerIds.has(ownerId)) continue;
		if (session.ownerIds.size === 1) {
			toShutdown.push(session);
			continue;
		}
		session.ownerIds.delete(ownerId);
	}
	for (const [sessionKey, starting] of [...startingSessions.entries()]) {
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
		logger.warn("Julia kernel shutdown not confirmed", {
			sessionId: session.sessionId,
			sessionKey: session.sessionKey,
			cwd: session.cwd,
			reason,
		});
		if (!sessions.has(session.sessionKey)) sessions.set(session.sessionKey, session);
	}
}

async function executeWithKernel(
	kernel: JuliaKernel,
	code: string,
	options: JuliaExecutorOptions | undefined,
): Promise<JuliaResult> {
	return executeWithKernelBase<JuliaExecutorOptions, Record<string, string | undefined>>({
		kernel,
		code,
		options,
		runIdPrefix: "jl",
		errorLogLabel: "Julia",
		isJulia: true,
		cancelledErrorClass: JuliaExecutionCancelledError,
		buildKernelEnvPatch,
		formatKernelTimeoutAnnotation,
		formatTimeoutAnnotation,
		resolveDeadlineMs: opts => opts?.deadlineMs,
	});
}

async function ensureKernelAvailable(cwd: string, options: JuliaExecutorOptions): Promise<void> {
	const availability = await waitForPromiseWithCancellation(
		checkJuliaKernelAvailability(cwd, options.interpreter),
		options,
	);
	if (!availability.ok) {
		throw new Error(availability.reason ?? "Julia kernel unavailable");
	}
}

async function ensureToolBridge(options: JuliaExecutorOptions): Promise<void> {
	if (!options.toolSession || options.bridge) return;
	try {
		options.bridge = await ensureKernelToolBridge();
	} catch (err) {
		logger.warn("Failed to start Julia tool bridge", {
			error: errorMessage(err),
		});
	}
}

async function executeOnSession(code: string, cwd: string, options: JuliaExecutorOptions): Promise<JuliaResult> {
	const sessionId = options.sessionId ?? `session:${cwd}`;
	const sessionKey = buildSessionKey(sessionId, cwd, options.interpreter);
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
		throw new JuliaExecutionCancelledError(isTimedOutCancellation(options.signal.reason, options.signal));
	}
	if (sessions.get(session.sessionKey) !== session) {
		throw new JuliaExecutionCancelledError(false);
	}
	if (!session.kernel.isAlive()) {
		await replaceSessionKernel(session, cwd, options);
		if (sessions.get(session.sessionKey) !== session) {
			throw new JuliaExecutionCancelledError(false);
		}
	}
	const runOptions = { ...options, cwd };
	try {
		return await executeWithKernel(session.kernel, code, runOptions);
	} catch (err) {
		if (isCancellationError(err) || options.signal?.aborted) throw err;
		if (session.kernel.isAlive()) throw err;
		if (sessions.get(session.sessionKey) !== session) {
			throw new JuliaExecutionCancelledError(false);
		}
		await replaceSessionKernel(session, cwd, options);
		if (sessions.get(session.sessionKey) !== session) {
			throw new JuliaExecutionCancelledError(false);
		}
		return await executeWithKernel(session.kernel, code, runOptions);
	}
}

export async function executeJuliaWithKernel(
	kernel: JuliaKernel,
	code: string,
	options?: JuliaExecutorOptions,
): Promise<JuliaResult> {
	return await executeWithKernel(kernel, code, options);
}

export async function executeJulia(code: string, options?: JuliaExecutorOptions): Promise<JuliaResult> {
	const cwd = normalizeSessionCwd(options?.cwd ?? getProjectDir());
	const deadlineMs = getExecutionDeadlineMs(options);
	const executionOptions: JuliaExecutorOptions = {
		...(options ?? {}),
		cwd,
		deadlineMs,
	};

	try {
		requireRemainingTimeoutMs(deadlineMs);
		if (executionOptions.signal?.aborted) {
			throw new JuliaExecutionCancelledError(
				isTimedOutCancellation(executionOptions.signal.reason, executionOptions.signal),
			);
		}
		await ensureKernelAvailable(cwd, executionOptions);
		await ensureToolBridge(executionOptions);
		return await executeOnSession(code, cwd, executionOptions);
	} catch (err) {
		if (isCancellationError(err) || executionOptions.signal?.aborted) {
			return createCancelledJuliaResult(isTimedOutCancellation(err, executionOptions.signal));
		}
		throw err;
	}
}
