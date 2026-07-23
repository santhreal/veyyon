/**
 * Foreground-bash wait registry — the ONE owner connecting the TUI's manual
 * "background this now" keystroke to the bash tool's foreground wait.
 *
 * Why this exists: bash could only move to the background AUTOMATICALLY (the
 * wall-clock threshold or the stall watcher). When the operator could already
 * see a command would run long, there was no way to reclaim the turn — the
 * only keys were wait or interrupt. The TUI keybinding (`app.bash.background`)
 * calls {@link requestManualBackground}; each foreground wait registers a
 * resolver here for its duration, and the newest wait wins (the innermost
 * command is the one the operator is watching).
 *
 * The registry also tells the composer's hint line whether a manual
 * background is currently possible ({@link hasForegroundBashWait}), so the
 * hint only appears when the key would actually do something — a hint for a
 * dead key is chrome noise.
 */

type Entry = {
	resolve: () => void;
};

const stack: Entry[] = [];
const listeners: Array<() => void> = [];

function notify(): void {
	for (const listener of listeners) listener();
}

/**
 * Register a foreground bash wait. `resolve` is called when the operator
 * requests a manual background. Returns the unregister function; ALWAYS call
 * it when the wait settles, or the hint line will advertise a dead key.
 */
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

/**
 * Resolve the NEWEST registered wait with a manual-background request.
 * Returns false (and does nothing) when no foreground bash is waiting, so
 * the keybinding can fall through to its other meaning.
 */
export function requestManualBackground(): boolean {
	const entry = stack[stack.length - 1];
	if (!entry) return false;
	entry.resolve();
	return true;
}

/** Subscribe to registry changes (the hint line re-render hook). */
export function onForegroundBashWaitChange(listener: () => void): void {
	listeners.push(listener);
}

/** Test hook: clear all waits and listeners. */
export function resetForegroundBashRegistryForTest(): void {
	stack.length = 0;
	listeners.length = 0;
}
