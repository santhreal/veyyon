import { logger, type postmortem } from "@veyyon/utils";
import { isSensitiveSlashCommand } from "../slash-commands/helpers/parse";

export interface SessionTeardownDeps {
	getDraftText: () => string;
	beginDispose: () => void;
	saveDraft: (text: string) => Promise<void>;
	flushSettings: () => Promise<void>;
	disposeSession: (reason?: postmortem.Reason) => Promise<void>;
}

export type SessionTeardown = (reason?: postmortem.Reason) => Promise<void>;

export function createSessionTeardown(deps: SessionTeardownDeps): SessionTeardown {
	let pending: Promise<void> | undefined;
	const run = async (reason?: postmortem.Reason): Promise<void> => {
		const draftText = deps.getDraftText();
		const persistedDraft = isSensitiveSlashCommand(draftText) ? "" : draftText;
		deps.beginDispose();
		try {
			await deps.saveDraft(persistedDraft);
		} catch (err) {
			logger.warn("Failed to save session draft during teardown", { error: String(err) });
		}
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
