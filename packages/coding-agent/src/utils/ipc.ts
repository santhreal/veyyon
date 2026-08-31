// Owners, not the `@veyyon/utils` barrel: 2 modules against 74.
import * as logger from "@veyyon/utils/logger";
import { errorMessage, isThenable } from "@veyyon/utils/type-guards";

/**
 * Send a message to a Bun subprocess over IPC, neutralizing both the
 * synchronous throw ("cannot be used after the process has exited") and any
 * asynchronous rejection (EPIPE from a pipe that broke between exit being
 * observed and the next `send()`). The dead worker is detected separately via
 * `onExit`/`onError` and respawned or disabled by the owning client; an
 * un-awaited EPIPE rejection must not escape as a fatal unhandled rejection
 * that takes down the whole session. See issue #2997.
 *
 * `label` prefixes the debug log on synchronous failure (e.g. "tts").
 */
export function safeSend(proc: { send(message: unknown): unknown }, message: unknown, label: string): void {
	try {
		const result = proc.send(message);
		if (isThenable(result)) result.then(undefined, () => {});
	} catch (error) {
		logger.debug(`${label}: send to subprocess failed`, {
			error: errorMessage(error),
		});
	}
}
