import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { $env, isBunTestRuntime, isCompiledBinary } from "@veyyon/utils/env";
import * as logger from "@veyyon/utils/logger";
import { stripWindowsExtendedLengthPathPrefix } from "@veyyon/utils/path";
import { errorMessage } from "@veyyon/utils/type-guards";
import { workerHostEntry } from "@veyyon/utils/worker-host";
import type { Subprocess } from "bun";
import { primarySessionCpuLimit } from "../session/cpu-limit";
import { safeSend } from "../utils/ipc";
import { logWorkerMessage, type WorkerLogPayload } from "./worker-log";

/** Shared lifecycle scaffolding for the ONNX inference subprocess clients (mnemopi embeddings, speech-to-text, tiny-model titles/completions, TTS). */

/** Minimal inbound contract shared by every worker: a correlated `ping`. */
export type WorkerInboundBase = { type: "ping"; id: string };

/** Structured log line forwarded from a worker to the parent logger. The `type: "log"` discriminator is the whole of what this adds to */
export type WorkerLogMessage = { type: "log" } & WorkerLogPayload;

/** Minimal outbound contract shared by every worker: `pong`, `error`, `log`. */
export type WorkerOutboundBase =
	| { type: "pong"; id: string }
	| { type: "error"; id: string; error: string }
	| WorkerLogMessage;

/** Parent-side view of a worker subprocess: send typed inbound messages, subscribe to outbound messages and worker errors, and hard-terminate. */
export interface WorkerHandle<Inbound, Outbound> {
	send(message: Inbound): void;
	onMessage(handler: (message: Outbound) => void): () => void;
	onError(handler: (error: Error) => void): () => void;
	terminate(): Promise<void>;
}

/** A {@link WorkerHandle} that can also be (un)referenced so a pending request keeps the parent event loop alive while an idle worker never blocks exit. */
export interface RefCountedWorkerHandle<Inbound, Outbound> extends WorkerHandle<Inbound, Outbound> {
	/** Re-reference the subprocess so a pending request keeps the parent event loop alive. */
	ref(): void;
	/** Drop the reference once the worker is idle so it never blocks process exit. */
	unref(): void;
}

/** The raw spawned subprocess plus the parent-side fan-out sets. */
export interface SpawnedSubprocess<Outbound> {
	proc: Subprocess<"ignore", "ignore", number | "ignore">;
	inbound: Set<(message: Outbound) => void>;
	errors: Set<(error: Error) => void>;
	/** Flipped to `true` right before the deliberate SIGKILL so `onExit` can distinguish the expected hard-kill from a crash (SIGSEGV from a native */
	intentionalExit: { value: boolean };
	/** Resolves when the file-backed stderr capture has drained after worker exit. `onExit` waits on this before surfacing the crash so the exit-error */
	stderrDrained: Promise<void>;
}

/** Bound on the tail of worker stderr surfaced with a crash. Sized to comfortably hold a full ONNX Runtime/glibc traceback (a few KiB) without letting a chatty */
const STDERR_TAIL_LIMIT_BYTES = 16 * 1024;

export interface WorkerSpawnCommand {
	cmd: string[];
	cwd?: string;
}

/** Cold-starting a worker from a compiled binary (decompress + module graph load) is slow on contended CI runners; the probe only proves the worker */
export const SMOKE_TEST_TIMEOUT_MS = 30_000;

/** Resolve the command used to relaunch the agent CLI into worker mode. In a compiled binary the entry point is the binary itself; otherwise re-enter the */
export function resolveWorkerSpawnCmd(workerArg: string): WorkerSpawnCommand {
	const executable = stripWindowsExtendedLengthPathPrefix(process.execPath);
	if (isCompiledBinary()) return { cmd: [executable, workerArg] };
	const hostEntry = workerHostEntry();
	if (hostEntry) {
		return { cmd: [executable, path.basename(hostEntry), workerArg], cwd: path.dirname(hostEntry) };
	}
	const packageRoot = path.resolve(import.meta.dir, "..", "..");
	return { cmd: [executable, "src/cli.ts", workerArg], cwd: packageRoot };
}

/** Snapshot the parent environment for the child. `process.env` carries `undefined` slots that `Bun.spawn` rejects, so filter them out; an optional */
export function workerEnvFromParent(overlay?: Record<string, string>): Record<string, string> {
	const base = $env as Record<string, string | undefined>;
	const merged: Record<string, string> = {};
	for (const key in base) {
		const value = base[key];
		if (typeof value === "string") merged[key] = value;
	}
	if (overlay) {
		for (const key in overlay) merged[key] = overlay[key];
	}
	return merged;
}

/** Spawn an inference worker subprocess and wire its IPC fan-out. Stdio is captured (stderr redirected to a temp file, stdout ignored) so native */
export function createWorkerSubprocess<Outbound>(options: {
	spawnCommand: WorkerSpawnCommand;
	env: Record<string, string>;
	exitLabel: string;
	/** Start the child as a new process-group/session leader where Bun supports it. */
	detached?: boolean;
	/** Treat exit code 0 as unexpected; eval cells can call process.exit(0). */
	reportCleanExit?: boolean;
	/** Whether an idle worker should stop keeping the parent event loop alive. */
	unref?: boolean;
}): SpawnedSubprocess<Outbound> {
	const inbound = new Set<(message: Outbound) => void>();
	const errors = new Set<(error: Error) => void>();
	const intentionalExit = { value: false };
	const stderrTail = new StderrTail(STDERR_TAIL_LIMIT_BYTES);
	const stderrDrained = Promise.withResolvers<void>();
	const stderrCapture = createStderrCapture(options.exitLabel);
	let stderrDrainStarted = false;
	const startStderrDrain = (): void => {
		if (stderrDrainStarted) return;
		stderrDrainStarted = true;
		void drainStderrCapture(stderrCapture, options.exitLabel, stderrTail).finally(() => stderrDrained.resolve());
	};
	const proc = Bun.spawn({
		cmd: options.spawnCommand.cmd,
		cwd: options.spawnCommand.cwd,
		detached: options.detached,
		env: options.env,
		stdin: "ignore",
		stdout: "ignore",
		stderr: stderrCapture.target,
		serialization: "advanced",
		windowsHide: true,
		ipc(message) {
			for (const handler of inbound) handler(message as Outbound);
		},
		onExit(_proc, exitCode, signalCode) {
			startStderrDrain();
			if (exitCode === 0 && !options.reportCleanExit) return;
			// Swallow only the expected SIGKILL from `terminate()`; every other signal exit (SIGSEGV from a native fault, OOM SIGKILL, operator
			if (exitCode === null && intentionalExit.value) return;
			const reason = exitCode !== null ? `code ${exitCode}` : `signal ${signalCode ?? "unknown"}`;
			// The stderr target is drained only after exit so idle unref'd
			// workers do not keep the parent alive; wait for that drain before
			// surfacing the error so the tail is complete.
			void stderrDrained.promise.finally(() => {
				const suffix = stderrTail.suffix();
				const err = new Error(`${options.exitLabel} exited with ${reason}${suffix}`);
				for (const handler of errors) handler(err);
			});
		},
	});
	// Shared service workers (tiny title model, embeddings, speech, JS eval) belong to no single session, so they join the root session's CPU budget
	const cpuLimit = primarySessionCpuLimit();
	if (cpuLimit) {
		void cpuLimit
			.adoptPid(proc.pid)
			.catch(error => logger.debug("CPU limit: worker adoption failed", { error: errorMessage(error) }));
	}
	// Don't keep the parent event loop alive on an idle worker; the dispose
	// path calls `terminate()` explicitly. Bun's test runner starves IPC for
	// unref'd subprocesses, so keep it referenced only under tests.
	if (!isBunTestRuntime() && options.unref !== false) proc.unref();
	return { proc, inbound, errors, intentionalExit, stderrDrained: stderrDrained.promise };
}

/** Bounded buffer of the *tail* of a stderr stream. Appended chunks are concatenated and truncated from the front once they exceed `limit`, so the */
class StderrTail {
	#chunks: Uint8Array[] = [];
	#bytes = 0;
	constructor(readonly limit: number) {}

	append(chunk: Uint8Array): void {
		if (chunk.length === 0) return;
		this.#chunks.push(chunk);
		this.#bytes += chunk.length;
		while (this.#bytes > this.limit && this.#chunks.length > 1) {
			const head = this.#chunks.shift();
			if (head) this.#bytes -= head.length;
		}
		if (this.#bytes > this.limit && this.#chunks.length === 1) {
			const only = this.#chunks[0];
			const start = only.length - this.limit;
			this.#chunks[0] = only.subarray(start);
			this.#bytes = this.limit;
		}
	}

	/** Human-readable trailer for an exit error, or `""` when nothing was captured. */
	suffix(): string {
		if (this.#bytes === 0) return "";
		const merged = new Uint8Array(this.#bytes);
		let offset = 0;
		for (const chunk of this.#chunks) {
			merged.set(chunk, offset);
			offset += chunk.length;
		}
		const text = new TextDecoder().decode(merged).replace(/\s+$/u, "");
		if (text.length === 0) return "";
		return `: ${text}`;
	}
}

interface StderrCapture {
	target: number | "ignore";
	fd: number | null;
	dir: string | null;
	cleanupOnExit: (() => void) | null;
}

/** Create a file-backed stderr target that does not pin Bun's event loop. */
function createStderrCapture(exitLabel: string): StderrCapture {
	try {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "veyyon-worker-stderr-"));
		const fd = fs.openSync(path.join(dir, "stderr.log"), "w+");
		const cleanupOnExit = (): void => cleanupStderrCapture({ target: fd, fd, dir, cleanupOnExit: null });
		process.once("exit", cleanupOnExit);
		return { target: fd, fd, dir, cleanupOnExit };
	} catch (error) {
		logger.debug(`${exitLabel} stderr capture unavailable`, {
			error: errorMessage(error),
		});
		return { target: "ignore", fd: null, dir: null, cleanupOnExit: null };
	}
}

function cleanupStderrCapture(capture: StderrCapture): void {
	if (capture.cleanupOnExit) process.off("exit", capture.cleanupOnExit);
	if (capture.fd !== null) {
		try {
			fs.closeSync(capture.fd);
		} catch {
			// Already closed.
		}
		capture.fd = null;
	}
	if (capture.dir) {
		try {
			fs.rmSync(capture.dir, { recursive: true, force: true });
		} catch {
			// Best-effort temp cleanup.
		}
		capture.dir = null;
	}
}

/** Drain a worker's file-backed stderr target after it exits: forward each decoded tail line to `logger.debug`, and record the bytes in `tail` so the */
async function drainStderrCapture(capture: StderrCapture, exitLabel: string, tail: StderrTail): Promise<void> {
	try {
		if (capture.fd === null) return;
		const size = fs.fstatSync(capture.fd).size;
		if (size <= 0) return;
		const length = Math.min(size, tail.limit);
		const buffer = new Uint8Array(length);
		fs.readSync(capture.fd, buffer, 0, length, size - length);
		tail.append(buffer);
		for (const rawLine of new TextDecoder().decode(buffer).split("\n")) {
			const line = rawLine.replace(/\r$/u, "");
			if (line.length > 0) logger.debug(`${exitLabel} stderr`, { line });
		}
	} catch {
		// The worker may have exited while the parent is already tearing down,
		// or the temp file may have been removed by process-exit cleanup.
	} finally {
		cleanupStderrCapture(capture);
	}
}

/** Wrap a {@link SpawnedSubprocess} as a {@link WorkerHandle}. The `send` strategy is injected so each client keeps its exact IPC-send behaviour (e.g. */
export function createWorkerHandle<Inbound, Outbound>(
	spawned: SpawnedSubprocess<Outbound>,
	send: (message: Inbound) => void,
): WorkerHandle<Inbound, Outbound> {
	const { proc, inbound, errors, intentionalExit } = spawned;
	return {
		send,
		onMessage(handler) {
			inbound.add(handler);
			return () => inbound.delete(handler);
		},
		onError(handler) {
			errors.add(handler);
			return () => errors.delete(handler);
		},
		async terminate() {
			intentionalExit.value = true;
			try {
				proc.kill("SIGKILL");
			} catch {
				// Already gone.
			}
		},
	};
}

/** Wrap a spawned subprocess as a {@link RefCountedWorkerHandle}: the shared {@link createWorkerHandle} plus `proc.ref()`/`unref()` (each swallowing the */
export function wrapRefCountedSubprocess<Inbound, Outbound>(
	spawned: SpawnedSubprocess<Outbound>,
	sendLabel: string,
): RefCountedWorkerHandle<Inbound, Outbound> {
	const { proc } = spawned;
	return {
		...createWorkerHandle<Inbound, Outbound>(spawned, message => safeSend(proc, message, sendLabel)),
		ref() {
			try {
				proc.ref();
			} catch {
				// Already gone.
			}
		},
		unref() {
			try {
				proc.unref();
			} catch {
				// Already gone.
			}
		},
	};
}

/** A stand-in handle used when the worker subprocess cannot be spawned. It ponges `ping` (so the smoke probe and readiness checks still resolve) and */
export function createUnavailableWorker<
	Inbound extends { type: string; id: string },
	Outbound extends { type: string },
>(error: unknown): WorkerHandle<Inbound, Outbound> {
	const listeners = new Set<(message: Outbound) => void>();
	const errorText = errorMessage(error);
	const emit = (message: WorkerOutboundBase): void => {
		// The stub only ever emits pong/error — members of every concrete worker
		// Outbound union — but the generic cannot prove it, hence the assertion.
		for (const listener of listeners) listener(message as unknown as Outbound);
	};
	return {
		send(message) {
			queueMicrotask(() => {
				if (message.type === "ping") {
					emit({ type: "pong", id: message.id });
					return;
				}
				emit({ type: "error", id: message.id, error: errorText });
			});
		},
		onMessage(handler) {
			listeners.add(handler);
			return () => listeners.delete(handler);
		},
		onError() {
			return () => {};
		},
		async terminate() {
			listeners.clear();
		},
	};
}

/** The {@link RefCountedWorkerHandle} form of {@link createUnavailableWorker}: the unavailable stub plus no-op `ref()`/`unref()` (an absent worker has no */
export function refCountedUnavailableWorker<
	Inbound extends { type: string; id: string },
	Outbound extends { type: string },
>(error: unknown): RefCountedWorkerHandle<Inbound, Outbound> {
	return {
		...createUnavailableWorker<Inbound, Outbound>(error),
		ref() {},
		unref() {},
	};
}

/** Spawn a worker handle, falling back to {@link createUnavailableWorker} (after a warning) when the subprocess cannot be created so the feature degrades */
export function spawnWorkerOrUnavailable<Handle>(
	spawn: () => Handle,
	unavailable: (error: unknown) => Handle,
	warnMessage: string,
): Handle {
	try {
		return spawn();
	} catch (error) {
		logger.warn(warnMessage, { error: errorMessage(error) });
		return unavailable(error);
	}
}

/** Forward a worker's structured `log` message to the matching logger level. Re-exported, not reimplemented. This file carried a byte-identical second copy of */
export { logWorkerMessage };

/** Drive the ping/pong readiness probe wired into `veyyon --smoke-test`: send one `ping`, resolve on the first `pong` (ignoring `log` chatter), and reject on */
export async function smokeTestWorker<Inbound extends { type: string; id: string }, Outbound extends { type: string }>(
	handle: WorkerHandle<Inbound, Outbound>,
	label: string,
	timeoutMs: number,
): Promise<void> {
	const { promise, resolve, reject } = Promise.withResolvers<void>();
	const timer = setTimeout(() => reject(new Error(`${label} did not pong within ${timeoutMs}ms`)), timeoutMs);
	const unsubscribeMessage = handle.onMessage(message => {
		if (message.type === "pong") {
			resolve();
			return;
		}
		if (message.type === "log") return;
		reject(new Error(`${label}: expected pong, got ${JSON.stringify(message)}`));
	});
	const unsubscribeError = handle.onError(reject);
	try {
		handle.send({ type: "ping", id: "smoke" } as Inbound);
		await promise;
	} finally {
		clearTimeout(timer);
		unsubscribeMessage();
		unsubscribeError();
		await handle.terminate();
	}
}
