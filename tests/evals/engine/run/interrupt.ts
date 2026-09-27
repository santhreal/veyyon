/**
 * Running a plan so that SIGINT and SIGTERM stop it cleanly.
 *
 * `@veyyon/utils/postmortem` handles both signals for every process that loads it: it runs the
 * registered cleanups, then exits. A run that listened on the signals itself lost that race and
 * exited mid-trial, leaving its trials' process trees running, their scratch directories on disk,
 * and no journal row for them. Here the run is a registered cleanup: a signal aborts the run's
 * signal, and the process exits only once the run has settled, within postmortem's own deadline.
 */

import { postmortem } from "@veyyon/utils";

export interface SignalledRun<T> {
	readonly result: T;
	/** `SIGINT` or `SIGTERM` when a signal stopped the run, else null. */
	readonly interrupted: string | null;
}

/**
 * Run `run` with a signal that SIGINT and SIGTERM abort. `onInterrupted` runs after `run` settles
 * and before the process may exit, so what it writes synchronously is not lost.
 */
export async function runUnderSignals<T>(
	id: string,
	run: (signal: AbortSignal) => Promise<T>,
	onInterrupted: (signal: string, result: T | undefined) => void,
): Promise<SignalledRun<T>> {
	const controller = new AbortController();
	let interrupted: string | null = null;
	const settled = Promise.withResolvers<void>();
	const unregister = postmortem.register(id, async reason => {
		interrupted =
			reason === postmortem.Reason.SIGINT ? "SIGINT" : reason === postmortem.Reason.SIGTERM ? "SIGTERM" : reason;
		controller.abort();
		await settled.promise;
	});
	let result: T | undefined;
	try {
		result = await run(controller.signal);
		return { result, interrupted };
	} finally {
		unregister();
		if (interrupted !== null) onInterrupted(interrupted, result);
		settled.resolve();
	}
}
