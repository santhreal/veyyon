/**
 * Signal-safe session teardown: persists the in-progress editor draft, then
 * disposes the session (which emits `session_shutdown`, cancels the session's
 * background async jobs, and closes the session manager). Shared by the TUI
 * Ctrl+C/Ctrl+D/`/exit` keypress path in `InteractiveMode.shutdown()` and by
 * the postmortem `SIGINT`/`SIGTERM`/`SIGHUP`/`uncaughtException` handlers so a
 * real kernel signal executes the exact same teardown as a keypress exit.
 *
 * Extracted (rather than inlined into `InteractiveMode`) so the callback body
 * is directly unit-testable without instantiating the full TUI stack.
 */
import { logger, type postmortem } from "@veyyon/utils";

/** Dependencies the teardown captures at construction time. */
export interface SessionTeardownDeps {
	/** Snapshot the current editor text; called once, before disposal touches session state. */
	getDraftText: () => string;
	/**
	 * Synchronously mark the session as disposing before any awaited teardown
	 * work. This closes the async gap where deferred jobs could otherwise start
	 * after a signal requested shutdown but before `disposeSession()` begins.
	 */
	beginDispose: () => void;
	/**
	 * Persist the snapshotted draft. Called even for an empty string so a
	 * previously-persisted draft sidecar is cleared on a clean exit.
	 */
	saveDraft: (text: string) => Promise<void>;
	/**
	 * Flush any pending debounced Settings save to disk. A `settings.set()`
	 * schedules a 100ms-debounced async write; without this flush a setting the
	 * user changed just before quitting (or whose async write has not landed) is
	 * lost on the next exit/signal. Called on EVERY teardown so the keypress
	 * `/exit`, Ctrl+C/Ctrl+D, and every catchable signal path all persist pending
	 * settings, matching the session record's exit-durability guarantee. Runs
	 * before the (potentially long) `disposeSession` so a slow dispose or a second
	 * signal cannot strand the settings write. Errors are logged, never abort the
	 * disposal chain (same contract as `saveDraft`).
	 */
	flushSettings: () => Promise<void>;
	/**
	 * Dispose the session — emits `session_shutdown`, drains async jobs, closes
	 * the manager. Receives the postmortem reason that triggered the teardown
	 * (undefined on the keypress/`/exit` path) so `AgentSession.dispose()` can
	 * persist the real exit reason instead of the generic `"dispose"`.
	 */
	disposeSession: (reason?: postmortem.Reason) => Promise<void>;
}

/**
 * Idempotent teardown: concurrent/repeat invocations share one settled
 * promise. The optional `reason` is the postmortem reason that triggered the
 * teardown (`sigterm`, `sighup`, `uncaught_exception`, …); only the FIRST
 * call's reason is used — later callers await the same settled promise.
 */
export type SessionTeardown = (reason?: postmortem.Reason) => Promise<void>;

/**
 * Build a promise-memoized teardown function. The first call snapshots the
 * draft text, marks the session disposing synchronously, runs `saveDraft`
 * (draft-loss protection for `--resume`), then `disposeSession`; subsequent
 * calls await the same settled promise, so the keypress
 * `InteractiveMode.shutdown()` path and the postmortem signal callback cannot
 * double-emit `session_shutdown`, double-dispose the session's async-job
 * manager, or race each other.
 *
 * The postmortem callback forwards its `Reason` so the persisted
 * `session_exit` diagnostic carries the real trigger (`sigterm`, `sighup`,
 * `uncaught_exception`, …) instead of the generic `"dispose"` that plain
 * programmatic disposal records. First call wins: a signal arriving after a
 * keypress-initiated teardown awaits the in-flight promise and its reason is
 * dropped — by then the exit entry is already being written as a normal exit.
 *
 * `saveDraft` and `flushSettings` failures are logged but never abort the
 * disposal chain — a draft- or settings-write error must not leak background
 * bash/task jobs or skip the extension `session_shutdown` event.
 */
export function createSessionTeardown(deps: SessionTeardownDeps): SessionTeardown {
	let pending: Promise<void> | undefined;
	const run = async (reason?: postmortem.Reason): Promise<void> => {
		const draftText = deps.getDraftText();
		deps.beginDispose();
		try {
			await deps.saveDraft(draftText);
		} catch (err) {
			logger.warn("Failed to save session draft during teardown", { error: String(err) });
		}
		// Persist pending debounced settings BEFORE the (potentially long) dispose so
		// a slow dispose or a second signal cannot strand a just-changed setting.
		try {
			await deps.flushSettings();
		} catch (err) {
			logger.warn("Failed to flush settings during teardown", { error: String(err) });
		}
		await deps.disposeSession(reason);
	};
	return (reason?: postmortem.Reason) => {
		if (!pending) pending = run(reason);
		return pending;
	};
}
