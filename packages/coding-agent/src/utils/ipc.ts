import * as logger from "@veyyon/utils/logger";
import { errorMessage, isThenable } from "@veyyon/utils/type-guards";

/** Send a message to a Bun subprocess over IPC, neutralizing both the synchronous throw ("cannot be used after the process has exited") and any */
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
