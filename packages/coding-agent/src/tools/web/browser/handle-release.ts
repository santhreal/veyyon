/**
 * Releasing a browser-side handle, in one place.
 *
 * Every element or JS handle the browser tools resolve refers to a remote object living in the page, and
 * that object has to be released or the page leaks it for as long as the tab is open. The release runs in
 * a `finally`, after the action the handle was resolved for has either finished or failed.
 *
 * The release itself is allowed to fail and there is nothing to report when it does. It fails for exactly
 * one reason: the remote object is already gone, because the page navigated, the frame detached, the
 * execution context was destroyed, or the tab closed. In every one of those cases the leak the release
 * exists to prevent cannot happen, so the failure carries no information. What matters is that it must not
 * replace the outcome of the action: a `finally` that throws would report "Protocol error: Runtime
 * .releaseObject" in place of the click that actually failed.
 *
 * This lives in one function so that reason is written once rather than restated at each of the release
 * sites, and so a future change to how releases are reported has a single place to change.
 */

/** The one thing this needs from a handle. Deliberately structural, so it fits every handle type. */
export interface DisposableHandle {
	dispose(): Promise<void>;
}

/** Release a handle if there is one, swallowing the already-gone failure for the reason documented above. */
export async function releaseHandle(handle: DisposableHandle | null | undefined): Promise<void> {
	if (!handle) return;
	await handle.dispose().catch(() => undefined);
}

/** Release many handles concurrently; one that is already gone does not stop the others. */
export async function releaseHandles(handles: Iterable<DisposableHandle | null | undefined>): Promise<void> {
	await Promise.all([...handles].map(handle => releaseHandle(handle)));
}
