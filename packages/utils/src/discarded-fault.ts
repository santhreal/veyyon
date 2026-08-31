/**
 * The two contracts under which a failure is thrown away, each spelled as a call that states why.
 *
 * WHY THIS EXISTS. A discarded fault is a decision, and `.catch(() => undefined)` records none of it.
 * There were 180 of them in this workspace, in 98 files, and they cover three different decisions that
 * look identical on the line: a teardown step that must not fail the teardown, a probe whose failure
 * IS an answer the caller wants, and a fault the caller should have seen. The third is a defect and
 * `fault-sink.ts` is where it goes; the first two are correct and are what this file names.
 *
 * `fs-optional.ts` already settled the shape for the filesystem half: {@link pathExistsQuietly} takes a
 * MANDATORY `why` that is never rendered, so silence has to be spelled and every silent probe is
 * greppable at once. The same shape works for a promise, and the type does the rest of the telling:
 * {@link bestEffort} resolves to nothing, so a caller cannot read an answer out of a step whose answer
 * it has decided not to wait for; {@link optionalResult} resolves to `undefined`, which IS the answer.
 *
 * Neither of these reports. A fault an operator should know about is `reportFault`, and a fault a
 * caller should handle is a throw. If the `why` cannot be written, the site wants one of those two.
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
