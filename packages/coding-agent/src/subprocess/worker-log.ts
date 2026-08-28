import * as logger from "@veyyon/utils/logger";

/** The CONTENT of a log line a worker sent to its supervisor: level, text, meta. Structural rather than tied to one worker's message union, because the two */
export interface WorkerLogPayload {
	level: "debug" | "warn" | "error";
	msg: string;
	meta?: Record<string, unknown>;
}

/** Log a worker's line at the level the worker asked for. A worker has no logger of its own: it runs in another thread or process, so it */
export function logWorkerMessage(msg: WorkerLogPayload): void {
	if (msg.level === "debug") logger.debug(msg.msg, msg.meta);
	else if (msg.level === "warn") logger.warn(msg.msg, msg.meta);
	else logger.error(msg.msg, msg.meta);
}
