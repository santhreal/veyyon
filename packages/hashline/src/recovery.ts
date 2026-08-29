import { RECOVERY_EXTERNAL_WARNING, RECOVERY_SESSION_CHAIN_WARNING } from "./messages";
import type { RecoveryArgs, RecoveryResult } from "./recovery-helpers";
import { replayRemappedAnchorsOnCurrent } from "./recovery-helpers";
import type { SnapshotStore } from "./snapshots";

export type { RecoveryResult };

export class Recovery {
	constructor(readonly store: SnapshotStore) {}
	tryRecover(args: RecoveryArgs): RecoveryResult | null {
		const { path, currentText, fileHash, edits } = args;
		const snapshot = this.store.byHash(path, fileHash);
		if (!snapshot) return null;
		const recoveryWarning =
			this.store.head(path) === snapshot ? RECOVERY_EXTERNAL_WARNING : RECOVERY_SESSION_CHAIN_WARNING;
		return replayRemappedAnchorsOnCurrent(snapshot.text, currentText, edits, recoveryWarning);
	}
}
