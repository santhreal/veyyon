/** Signal-safe session teardown: persists the in-progress editor draft, then disposes the session (which emits `session_shutdown`, cancels the session's */
import { logger, type postmortem } from "@veyyon/utils";
import { isSensitiveSlashCommand } from "../slash-commands/helpers/parse";

/** Dependencies the teardown captures at construction time. */
export interface SessionTeardownDeps {
	/** Snapshot the current editor text; called once, before disposal touches session state. */
	getDraftText: () => string;
	/** Synchronously mark the session as disposing before any awaited teardown work. This closes the async gap where deferred jobs could otherwise start */
	beginDispose: () => void;
	/** Persist the snapshotted draft. Called even for an empty string so a previously-persisted draft sidecar is cleared on a clean exit. */
	saveDraft: (text: string) => Promise<void>;
	/** Flush any pending debounced Settings save to disk. A `settings.set()` schedules a 100ms-debounced async write; without this flush a setting the */
	flushSettings: () => Promise<void>;
	/** Dispose the session — emits `session_shutdown`, drains async jobs, closes the manager. Receives the postmortem reason that triggered the teardown */
	disposeSession: (reason?: postmortem.Reason) => Promise<void>;
}

/** Idempotent teardown: concurrent/repeat invocations share one settled promise. The optional `reason` is the postmortem reason that triggered the */
export type SessionTeardown = (reason?: postmortem.Reason) => Promise<void>;

/** Build a promise-memoized teardown function. The first call snapshots the draft text, marks the session disposing synchronously, runs `saveDraft` */
export function createSessionTeardown(deps: SessionTeardownDeps): SessionTeardown {
	let pending: Promise<void> | undefined;
	const run = async (reason?: postmortem.Reason): Promise<void> => {
		const draftText = deps.getDraftText();
		// A command-shaped credential must never become a resume sidecar. Saving
		// the empty string is intentional: it also unlinks any older ordinary
		// draft instead of merely skipping this write and leaving stale text.
		const persistedDraft = isSensitiveSlashCommand(draftText) ? "" : draftText;
		deps.beginDispose();
		try {
			await deps.saveDraft(persistedDraft);
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
