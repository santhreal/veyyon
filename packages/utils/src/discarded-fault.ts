/**
 * Explicit contracts for discarded failures: {@link bestEffort} (resolves to void for teardown steps)
 * and {@link optionalResult} (resolves to undefined for probes where absence is an expected answer).
 */

/**
 * Run `step` for its effect and discard both its value and its failure.
 *
 * For a teardown or a nudge whose failure changes nothing the caller will do: detaching a debugger
 * session that is already gone, closing a page whose browser is going away with it, telling a target
 * to stop loading when the load has already stopped. The failure is expected often enough that
 * reporting it would be noise, and the resolved type is `void` so the value cannot be read.
 *
 * `why` is documentation the compiler enforces the presence of, in the same spirit as
 * `pathExistsQuietly`. It is never rendered anywhere.
 */
export async function bestEffort(step: Promise<unknown>, why: string): Promise<void> {
	// Read once so a linter cannot suggest deleting the parameter, which would remove the point of
	// the signature.
	void why;
	try {
		await step;
	} catch {
		// The contract: this failure is the expected shape of a step nobody is waiting on.
	}
}

/**
 * Run `probe` and answer `undefined` when it fails, because absence is a result the caller handles.
 *
 * For a value that may not exist: a page that has no title yet, a field a peer did not send. The
 * caller's next line reads the `undefined`, which is what separates this from {@link bestEffort} —
 * there the failure ends the story, here it starts the caller's.
 */
export async function optionalResult<T>(probe: Promise<T>, why: string): Promise<T | undefined> {
	void why;
	try {
		return await probe;
	} catch {
		return undefined;
	}
}
