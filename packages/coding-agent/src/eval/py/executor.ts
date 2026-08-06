import { errorMessage, getProjectDir, logger } from "@veyyon/utils";
import { sessionCpuAdoption } from "../../session/cpu-limit";
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

/**
 * Kept as an alias of the shared {@link KernelMode} rather than its own union: the type is exported and
 * `python.kernelMode` reads it in `py/index.ts`, so removing the name would break callers for nothing,
 * while a second literal union would let the two drift.
 */
export type PythonKernelMode = KernelMode;

export interface PythonExecutorOptions {
	/** Working directory for command execution */
	cwd?: string;
	/** Timeout in milliseconds */
	timeoutMs?: number;
	/** Absolute wall-clock deadline in milliseconds since epoch */
	deadlineMs?: number;
	/**
	 * Runtime-work budget (ms). Used only for timeout-annotation text when the
	 * caller drives cancellation via the eval watchdog `signal` instead of a
	 * wall-clock `deadlineMs`/`timeoutMs`. Does not arm a timer.
	 */
	idleTimeoutMs?: number;
	/** Callback for streaming output chunks (already sanitized) */
	onChunk?: (chunk: string) => Promise<void> | void;
	/** AbortSignal for cancellation */
	signal?: AbortSignal;
	/** Session identifier for kernel reuse */
	sessionId?: string;
	/** Logical owner identifier for retained kernel cleanup */
	kernelOwnerId?: string;
	/** Kernel mode (session reuse vs per-call) */
	kernelMode?: PythonKernelMode;
	/**
	 * Explicit interpreter path (`python.interpreter` resolved from the
	 * session's settings). Skips automatic runtime discovery when set.
	 */
	interpreter?: string;
	/** Restart the kernel before executing */
	reset?: boolean;
	/** Session file path for accessing task outputs */
	sessionFile?: string;
	/**
	 * Effective artifacts directory for the current session. Subagents share
	 * the parent's directory, so this can differ from `sessionFile`'s sibling
	 * dir. When present, exported to the kernel as `VEYYON_ARTIFACTS_DIR` and
	 * preferred over `VEYYON_SESSION_FILE`-derived paths.
	 */
	artifactsDir?: string;
	/** Artifact path/id for full output storage */
	artifactPath?: string;
	artifactId?: string;
	/**
	 * On-disk roots the prelude helpers (`read`/`write`) substitute for
	 * internal-URL schemes (e.g. `{ local: "/…/artifacts/local" }`). Exported to
	 * the kernel as `VEYYON_EVAL_LOCAL_ROOTS` (JSON) so `write("local://x")` lands
	 * where `read local://x` resolves instead of a literal `local:/` directory.
	 */
	localRoots?: Record<string, string>;
	/**
	 * ToolSession used to resolve host-side `tool.<name>(args)` calls made from
	 * the Python prelude's bridge proxy. When omitted, the bridge env vars are
	 * not injected and any `tool.foo(...)` raises in Python.
	 */
	toolSession?: ToolSession;
	/** Callback for status events emitted by tool bridge invocations. */
	emitStatus?: (event: JsStatusEvent) => void;
	/**
	 * Live status events streamed as they are emitted (both host-side bridge
	 * helpers like `agent()` and kernel-side `display`/`log`/`phase`). Mirrors
	 * what lands in `displayOutputs` so callers can render progress before the
	 * cell finishes.
	 */
	onStatus?: (event: JsStatusEvent) => void;
	/** @internal Bridge session id, set by `executePython` before delegating. */
	bridgeSessionId?: string;
	/** @internal Bridge endpoint info, set by `executePython` before delegating. */
	bridge?: { url: string; token: string };
}

export interface PythonResult {
	/** Combined stdout + stderr output (sanitized, possibly truncated) */
	output: string;
	/** Execution exit code (0 ok, 1 error, undefined if cancelled) */
	exitCode: number | undefined;
	/** Whether the execution was cancelled via signal */
	cancelled: boolean;
	/** Whether the output was truncated */
	truncated: boolean;
	/** Artifact ID if full output was saved to artifact storage */
	artifactId?: string;
	/** Total number of lines in the output stream */
	totalLines: number;
	/** Total number of bytes in the output stream */
	totalBytes: number;
	/** Number of lines included in the output text */
	outputLines: number;
	/** Number of bytes included in the output text */
	outputBytes: number;
	/** Rich display outputs captured from display_data/execute_result */
	displayOutputs: KernelDisplayOutput[];
	/** Whether stdin was requested */
	stdinRequested: boolean;
}

// ---------------------------------------------------------------------------
// Session bookkeeping
//
// One PythonKernel subprocess per (session id, cwd, interpreter) tuple. The
// runner mutates process-global cwd/sys.path during execution, so cross-directory
// work must never share a live kernel. Multiple agent owners can still register against
// the same tuple; the kernel stays alive until the last owner detaches.
// ---------------------------------------------------------------------------

interface PythonSession {
	sessionKey: string;
	sessionId: string;
	cwd: string;
	// The CONTRACT, not the concrete class: session bookkeeping only ever executes,
	// checks liveness, and shuts down. Typing it this way is also what lets a test fake
	// stand in without an `as unknown as PythonKernel` cast that checks nothing.
	kernel: SessionKernel<KernelExecuteOptions>;
	ownerIds: Set<string>;
	hasFallbackOwner: boolean;
}

const sessions = new Map<string, PythonSession>();
const startingSessions = new Map<string, Promise<PythonSession>>();
const resettingSessions = new Map<string, Promise<void>>();

// ---------------------------------------------------------------------------
// Cancellation plumbing
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Result formatting
// ---------------------------------------------------------------------------

function createCancelledPythonResult(timedOut: boolean, timeoutMs?: number): PythonResult {
	const output = timedOut ? formatTimeoutAnnotation(timeoutMs) : "";
	return createCancelledKernelResult(output);
}

// ---------------------------------------------------------------------------
// Kernel start helpers
// ---------------------------------------------------------------------------

async function startKernel(cwd: string, options: PythonExecutorOptions): Promise<PythonKernel> {
	requireRemainingTimeoutMs(options.deadlineMs);
	return await PythonKernel.start({
		cwd,
		env: buildManagedKernelEnv(options),
		signal: options.signal,
		deadlineMs: options.deadlineMs,
		interpreter: options.interpreter,
		adoptPid: sessionCpuAdoption(() => options.sessionId ?? null),
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
	// A start that failed leaves nothing to reset, and its failure belongs to the caller awaiting the start.
	const existing = sessions.get(sessionKey) ?? (await startingSessions.get(sessionKey)?.catch(() => undefined));
	if (!existing) return;
	sessions.delete(sessionKey);
	await releaseKernel(existing.kernel, "python-session-reset");
}

// ---------------------------------------------------------------------------
// Public dispose entry points
// ---------------------------------------------------------------------------

export async function disposeAllKernelSessions(): Promise<void> {
	const pending = [...startingSessions.values()];
	startingSessions.clear();
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
	for (const session of [...sessions.values()]) {
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

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

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
		buildKernelEnvPatch: buildManagedKernelEnvPatch,
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
		// Coalesce concurrent resets: if another reset is in flight for this
		// session, await it instead of throwing — the caller's intent ("start
		// from a clean kernel") is satisfied once that reset settles.
		const inFlight = resettingSessions.get(sessionKey);
		// Another caller owns this reset and is awaiting `resetPromise` itself, so its failure is reported
		// there. Here the only thing that matters is that the reset has SETTLED before running on the
		// context: if it failed, `acquireSession` below starts a fresh one and fails with its own reason.
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
		// A reset already in progress is an internal coordination state, not a
		// user-visible failure. Wait for it to clear, then proceed with the
		// requested execution on the freshly-restarted kernel.
		const inFlight = resettingSessions.get(sessionKey);
		// Another caller owns this reset and is awaiting `resetPromise` itself, so its failure is reported
		// there. Here the only thing that matters is that the reset has SETTLED before running on the
		// context: if it failed, `acquireSession` below starts a fresh one and fails with its own reason.
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
		// Shared kernels are keyed by cwd, so a dead kernel can be recreated in place
		// without risking cross-directory state bleed.
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

/**
 * Wire this subsystem into the session's owner-scoped cleanup.
 *
 * Registered at module scope rather than called by name from `agent-session.dispose()`, which is
 * what used to happen. See `session/owned-resources.ts` for why load-time registration is safe
 * here: a kernel cannot exist unless this module was loaded to create it.
 */
registerOwnedResourceDisposer({
	name: "python-kernels",
	scope: "eval-kernel-owner",
	dispose: disposeKernelSessionsByOwner,
});
