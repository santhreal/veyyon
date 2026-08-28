import inspector from "node:inspector";
import { isMainThread } from "node:worker_threads";
import * as logger from "./logger";
import { restoreTerminalStderr } from "./stderr-guard";

export enum Reason {
	PRE_EXIT = "pre_exit", // Pre-exit phase (not used by default)
	EXIT = "exit", // Normal process exit
	SIGINT = "sigint", // Ctrl-C or SIGINT
	SIGTERM = "sigterm", // SIGTERM
	SIGHUP = "sighup", // SIGHUP
	UNCAUGHT_EXCEPTION = "uncaught_exception", // Fatal exception
	UNHANDLED_REJECTION = "unhandled_rejection", // Unhandled promise rejection
	MANUAL = "manual", // Manual cleanup (not triggered by process)
}

const callbackList: ((reason: Reason) => Promise<void> | void)[] = [];
let cleanupStage: "idle" | "running" | "complete" = "idle";
const CLEANUP_DEADLINE_MS = 10_000;

function runCleanup(reason: Reason): Promise<void> {
	switch (cleanupStage) {
		case "idle":
			cleanupStage = "running";
			break;
		case "running":
			return Promise.resolve();
		case "complete":
			return Promise.resolve();
	}

	const promises = callbackList.toReversed().map(callback => {
		return Promise.try(() => callback(reason));
	});

	const cleanupSettled = Promise.allSettled(promises).then(results => {
		for (const result of results) {
			if (result.status === "rejected") {
				const err = result.reason instanceof Error ? result.reason : new Error(String(result.reason));
				logger.error("Cleanup callback failed", { err, stack: err.stack });
			}
		}
		cleanupStage = "complete";
	});
	const deadline = Promise.withResolvers<void>();
	const deadlineTimer = setTimeout(() => {
		logger.error("Cleanup deadline exceeded; proceeding with exit", { reason });
		cleanupStage = "complete";
		deadline.resolve();
	}, CLEANUP_DEADLINE_MS);
	deadlineTimer.unref();
	return Promise.race([cleanupSettled, deadline.promise]).finally(() => {
		clearTimeout(deadlineTimer);
	});
}

let inspectorOpened = false;

export function isIpcSendEpipe(err: Error): boolean {
	const code = (err as { code?: unknown }).code;
	const syscall = (err as { syscall?: unknown }).syscall;
	return code === "EPIPE" && syscall === "send";
}

export function isStdioWriteEpipe(err: Error): boolean {
	const code = (err as { code?: unknown }).code;
	const syscall = (err as { syscall?: unknown }).syscall;
	return code === "EPIPE" && syscall === "write";
}

const EXPECTED_CLEANUP = Symbol.for("veyyon.expectedCleanupError");

export function markExpectedCleanupError<T extends object>(reason: T): T {
	(reason as Record<PropertyKey, unknown>)[EXPECTED_CLEANUP] = true;
	return reason;
}

export function isExpectedCleanupError(reason: unknown): boolean {
	let current: unknown = reason;
	for (let depth = 0; depth < 8 && current !== null && typeof current === "object"; depth++) {
		if ((current as Record<PropertyKey, unknown>)[EXPECTED_CLEANUP] === true) return true;
		current = (current as { cause?: unknown }).cause;
	}
	return false;
}

const rejectionInterceptors = new Set<(reason: unknown) => boolean>();

export function interceptUnhandledRejections(interceptor: (reason: unknown) => boolean): () => void {
	rejectionInterceptors.add(interceptor);
	return () => rejectionInterceptors.delete(interceptor);
}

function formatFatalError(label: string, err: Error): string {
	const name = err.name || "Error";
	const message = err.message || "(no message)";
	const stack = err.stack || "";
	const stackLines = stack.split("\n").slice(1);
	const formattedStack = stackLines.length > 0 ? `\n${stackLines.join("\n")}` : "";
	return `\n[${label}] ${name}: ${message}${formattedStack}\n`;
}

if (isMainThread) {
	process
		.on("SIGINT", async () => {
			await runCleanup(Reason.SIGINT);
			process.exit(130); // 128 + SIGINT (2)
		})
		.on("SIGUSR1", () => {
			if (inspectorOpened) return;
			inspectorOpened = true;
			inspector.open(undefined, undefined, false);
			const url = inspector.url();
			process.stderr.write(`Inspector opened: ${url}\n`);
		})
		.on("uncaughtException", async err => {
			if (isExpectedCleanupError(err)) {
				logger.warn("Ignoring expected cleanup exception", { err });
				return;
			}
			if (isStdioWriteEpipe(err)) {
				logger.info("stdout/stderr pipe closed by consumer; exiting quietly", { err });
				await runCleanup(Reason.EXIT);
				process.exit(0);
			}
			restoreTerminalStderr();
			process.stderr.write(formatFatalError("Uncaught Exception", err));
			logger.error("Uncaught exception", { err });
			await runCleanup(Reason.UNCAUGHT_EXCEPTION);
			process.exit(1);
		})
		.on("unhandledRejection", async reason => {
			const err = reason instanceof Error ? reason : new Error(String(reason));
			if (isIpcSendEpipe(err)) {
				logger.warn("Ignoring EPIPE from worker IPC send; optional subsystem will self-recover", { err });
				return;
			}
			if (isExpectedCleanupError(reason)) {
				logger.warn("Ignoring expected cleanup rejection", { err });
				return;
			}
			if (isStdioWriteEpipe(err)) {
				logger.info("stdout/stderr pipe closed by consumer; exiting quietly", { err });
				await runCleanup(Reason.EXIT);
				process.exit(0);
			}
			for (const interceptor of rejectionInterceptors) {
				try {
					if (interceptor(reason)) return;
				} catch (interceptorErr) {
					logger.warn("Unhandled-rejection interceptor threw; continuing with fatal path", {
						err: interceptorErr,
					});
				}
			}
			restoreTerminalStderr();
			process.stderr.write(formatFatalError("Unhandled Rejection", err));
			logger.error("Unhandled rejection", { err });
			await runCleanup(Reason.UNHANDLED_REJECTION);
			process.exit(1);
		})
		.on("exit", async () => {
			void runCleanup(Reason.EXIT); // fire and forget (exit imminent)
		})
		.on("SIGTERM", async () => {
			await runCleanup(Reason.SIGTERM);
			process.exit(143); // 128 + SIGTERM (15)
		})
		.on("SIGHUP", async () => {
			await runCleanup(Reason.SIGHUP);
			process.exit(129); // 128 + SIGHUP (1)
		});
} else {
	process.on("exit", () => {
		void runCleanup(Reason.EXIT);
	});
}

export function register(id: string, callback: (reason: Reason) => void | Promise<void>): () => void {
	let done = false;
	const exec = (reason: Reason) => {
		if (done) return;
		done = true;
		try {
			return callback(reason);
		} catch (e) {
			const err = e instanceof Error ? e : new Error(String(e));
			logger.error("Cleanup callback failed", { err, id, stack: err.stack });
		}
	};

	const cancel = () => {
		const index = callbackList.indexOf(exec);
		if (index >= 0) {
			callbackList.splice(index, 1);
		}
		done = true;
	};

	if (cleanupStage !== "idle") {
		logger.debug("Cleanup already started; running late callback once", { id });
		try {
			callback(Reason.MANUAL);
		} catch (e) {
			const err = e instanceof Error ? e : new Error(String(e));
			logger.error("Cleanup callback failed", { err, id, stack: err.stack });
		}
		return () => {};
	}

	callbackList.push(exec);
	return cancel;
}

export function cleanup(): Promise<void> {
	return runCleanup(Reason.MANUAL);
}

export async function quit(code: number = 0): Promise<void> {
	await runCleanup(Reason.MANUAL);

	if (!isMainThread) {
		return; // Workers: cleanup done, let worker exit naturally
	}

	if (process.stdout.writableLength > 0) {
		const { promise, resolve } = Promise.withResolvers<void>();
		process.stdout.once("drain", resolve);
		await Promise.race([promise, Bun.sleep(5000)]);
	}
	process.exit(code);
}
