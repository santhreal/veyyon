/** Bound the size of the `oldText` / `newText` snapshots that edit-tool results carry in `details`. These fields hold the full pre/post file content; for */

import type { EditToolDetails, EditToolPerFileResult } from "./renderer";

/** Combined `oldText` + `newText` character budget for a single edit-tool result. Applies both per-entry (one file at a time) and as an aggregate */
export const MAX_EDIT_SNAPSHOT_TEXT_CHARS = 32_768;

type WithSnapshot = { oldText?: string; newText?: string; snapshotsPruned?: boolean };

function pruneSnapshot<T extends WithSnapshot>(details: T): T {
	if ((details.oldText?.length ?? 0) + (details.newText?.length ?? 0) <= MAX_EDIT_SNAPSHOT_TEXT_CHARS) {
		return details;
	}
	const { oldText: _old, newText: _new, ...rest } = details;
	return { ...rest, snapshotsPruned: true } as T;
}

/** Walk `perFileResults` in order with a shared budget. Each per-entry payload is first capped individually by {@link pruneSnapshot}; if its kept bytes */
function capPerFileSnapshots<T extends WithSnapshot>(entries: T[]): T[] {
	let remaining = MAX_EDIT_SNAPSHOT_TEXT_CHARS;
	return entries.map(entry => {
		const perEntry = pruneSnapshot(entry);
		const kept = (perEntry.oldText?.length ?? 0) + (perEntry.newText?.length ?? 0);
		if (kept === 0) return perEntry;
		if (kept <= remaining) {
			remaining -= kept;
			return perEntry;
		}
		const { oldText: _old, newText: _new, ...rest } = perEntry;
		return { ...rest, snapshotsPruned: true } as T;
	});
}

/** Prune oversized `oldText` / `newText` from an edit-tool details payload, recursing into `perFileResults` when present. Per-file overload comes first */
export function pruneOversizedEditSnapshots(details: EditToolPerFileResult): EditToolPerFileResult;
export function pruneOversizedEditSnapshots(details: EditToolDetails): EditToolDetails;
export function pruneOversizedEditSnapshots(
	details: EditToolDetails | EditToolPerFileResult,
): EditToolDetails | EditToolPerFileResult {
	const pruned = pruneSnapshot(details);
	if ("perFileResults" in pruned && pruned.perFileResults) {
		return { ...pruned, perFileResults: capPerFileSnapshots(pruned.perFileResults) };
	}
	return pruned;
}
