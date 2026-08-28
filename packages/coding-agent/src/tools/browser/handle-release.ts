/** Releasing a browser-side handle, in one place. Every element or JS handle the browser tools resolve refers to a remote object living in the page, and */

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
	await Promise.all(Array.from(handles).map(handle => releaseHandle(handle)));
}
