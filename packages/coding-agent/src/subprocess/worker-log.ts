import { logger } from "@veyyon/utils";

/**
 * A log line a worker sent to its supervisor.
 *
 * Structural rather than tied to one worker's message union, because the two
 * supervisors that receive these (the JS eval context manager and the browser tab
 * supervisor) each define their own `WorkerOutbound`.
 */
export interface WorkerLogMessage {
	level: "debug" | "warn" | "error";
	msg: string;
	meta?: Record<string, unknown>;
}

/**
 * Log a worker's line at the level the worker asked for.
 *
 * A worker has no logger of its own: it runs in another thread or process, so it
 * ships the level with the message and the supervisor replays it. Both supervisors
 * had a byte-identical copy of that replay, and a copy that mapped a level to the
 * wrong method would move a whole class of worker diagnostics out of the log the
 * operator is reading. An unrecognised level is logged as an error rather than
 * dropped: a line worth sending is worth seeing, and losing it silently is worse
 * than logging it too loudly.
 */
export function logWorkerMessage(msg: WorkerLogMessage): void {
	if (msg.level === "debug") logger.debug(msg.msg, msg.meta);
	else if (msg.level === "warn") logger.warn(msg.msg, msg.meta);
	else logger.error(msg.msg, msg.meta);
}
