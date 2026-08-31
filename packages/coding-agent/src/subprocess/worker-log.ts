// Owners, not the `@veyyon/utils` barrel: 1 module against 74.
import * as logger from "@veyyon/utils/logger";

/**
 * The CONTENT of a log line a worker sent to its supervisor: level, text, meta.
 *
 * Structural rather than tied to one worker's message union, because the two
 * supervisors that receive these (the JS eval context manager and the browser tab
 * supervisor) each define their own outbound union.
 *
 * A PAYLOAD, not a message. `WorkerLogMessage` in `worker-client.ts` is this plus
 * the `type: "log"` discriminator that makes it a member of an outbound union, and
 * that is the only difference between them. Both were called `WorkerLogMessage` in
 * sibling modules of this directory, with two byte-identical copies of
 * {@link logWorkerMessage} to go with them, so which one you got depended on which
 * file your editor imported from -- and the two shapes are not interchangeable:
 * only one of them narrows an outbound union.
 */
export interface WorkerLogPayload {
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
export function logWorkerMessage(msg: WorkerLogPayload): void {
	if (msg.level === "debug") logger.debug(msg.msg, msg.meta);
	else if (msg.level === "warn") logger.warn(msg.msg, msg.meta);
	else logger.error(msg.msg, msg.meta);
}
