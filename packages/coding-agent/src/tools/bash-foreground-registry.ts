/** Foreground-bash wait registry — the ONE owner connecting the TUI's manual "background this now" keystroke to the bash tool's foreground wait. */

type Entry = {
	resolve: () => void;
};

const stack: Entry[] = [];
const listeners: Array<() => void> = [];

function notify(): void {
	for (const listener of listeners) listener();
}

/** Register a foreground bash wait. `resolve` is called when the operator requests a manual background. Returns the unregister function; ALWAYS call */
export function registerForegroundBashWait(resolve: () => void): () => void {
	const entry: Entry = { resolve };
	stack.push(entry);
	notify();
	return () => {
		const index = stack.indexOf(entry);
		if (index !== -1) {
			stack.splice(index, 1);
			notify();
		}
	};
}

/** Whether any foreground bash is currently waiting (the hint-line gate). */
export function hasForegroundBashWait(): boolean {
	return stack.length > 0;
}

/** Resolve the NEWEST registered wait with a manual-background request. Returns false (and does nothing) when no foreground bash is waiting, so */
export function requestManualBackground(): boolean {
	const entry = stack[stack.length - 1];
	if (!entry) return false;
	entry.resolve();
	return true;
}

/** Subscribe to registry changes (the hint line re-render hook). Returns the unsubscribe function; a listener that outlives its component keeps repainting */
export function onForegroundBashWaitChange(listener: () => void): () => void {
	listeners.push(listener);
	return () => {
		const index = listeners.indexOf(listener);
		if (index !== -1) listeners.splice(index, 1);
	};
}

/** Test hook: clear all waits and listeners. */
export function resetForegroundBashRegistryForTest(): void {
	stack.length = 0;
	listeners.length = 0;
}
