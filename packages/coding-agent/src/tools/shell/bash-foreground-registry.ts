/**
 * Foreground-bash wait registry — the ONE owner connecting a host's manual
 * "background this now" request to the bash tool's foreground wait.
 *
 * Why this exists: bash could only move to the background AUTOMATICALLY (the
 * wall-clock threshold or the stall watcher). When the operator could already
 * see a command would run long, there was no way to reclaim the turn — the
 * only keys were wait or interrupt. A host calls
 * {@link requestManualBackground}; each foreground wait registers a resolver
 * here for its duration, and within one session the newest wait wins (the
 * innermost command is the one being watched).
 *
 * Why the session key: waits are keyed by the session their tool call belongs
 * to, because a host draws many sessions at once. A request carries the
 * session it came from and reaches only that session's waits, so a window
 * backgrounding its own command cannot resolve the wait of a command running
 * in another window. A tool session that states no id is its own bucket,
 * reachable only by a request that states none either.
 *
 * The registry also states whether a manual background is currently possible
 * ({@link hasForegroundBashWait}), so a control appears only when it would do
 * something — a control for a dead action is chrome noise — and
 * {@link foregroundBashCommand} names the command it would move.
 */

type Entry = {
	resolve: () => void;
	command: string;
};

/** The waits of one session, newest last. A session with none holds no key. */
const waits = new Map<string | null, Entry[]>();
const listeners: Array<(session: string | null) => void> = [];

function notify(session: string | null): void {
	for (const listener of listeners) listener(session);
}

/**
 * Register a foreground bash wait for `session`. `resolve` is called when a
 * manual background is requested for that session. Returns the unregister
 * function; ALWAYS call it when the wait settles, or a control will advertise
 * a command that is no longer running.
 */
export function registerForegroundBashWait(session: string | null, command: string, resolve: () => void): () => void {
	const entry: Entry = { resolve, command };
	const open = waits.get(session);
	if (open) {
		open.push(entry);
	} else {
		waits.set(session, [entry]);
	}
	notify(session);
	return () => {
		const current = waits.get(session);
		if (!current) return;
		const index = current.indexOf(entry);
		if (index === -1) return;
		current.splice(index, 1);
		if (current.length === 0) waits.delete(session);
		notify(session);
	};
}

/** Whether `session` has a foreground bash waiting. */
export function hasForegroundBashWait(session: string | null): boolean {
	return waits.has(session);
}

/**
 * The command line a manual background would move, or `undefined` when
 * `session` has nothing waiting.
 */
export function foregroundBashCommand(session: string | null): string | undefined {
	const open = waits.get(session);
	return open?.[open.length - 1]?.command;
}

/**
 * Resolve the NEWEST wait registered for `session` with a manual-background
 * request. Returns false (and does nothing) when that session has no
 * foreground bash waiting, so a keybinding can fall through to its other
 * meaning and a host can state the condition instead.
 */
export function requestManualBackground(session: string | null): boolean {
	const open = waits.get(session);
	const entry = open?.[open.length - 1];
	if (!entry) return false;
	entry.resolve();
	return true;
}

/**
 * Subscribe to registry changes. The listener is called with the session
 * whose waits changed. Returns the unsubscribe function; a listener that
 * outlives its component keeps repainting a surface that is no longer mounted.
 */
export function onForegroundBashWaitChange(listener: (session: string | null) => void): () => void {
	listeners.push(listener);
	return () => {
		const index = listeners.indexOf(listener);
		if (index !== -1) listeners.splice(index, 1);
	};
}

/** Test hook: clear all waits and listeners. */
export function resetForegroundBashRegistryForTest(): void {
	waits.clear();
	listeners.length = 0;
}
