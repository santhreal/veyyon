import { invalidateFsScanCache } from "@veyyon/natives";

/**
 * Invalidate shared filesystem scan caches after a content write/update.
 */
export function invalidateFsScanAfterWrite(path: string): void {
	invalidateFsScanCache(path);
}

/**
 * Invalidate shared filesystem scan caches after deleting a file.
 */
export function invalidateFsScanAfterDelete(path: string): void {
	invalidateFsScanCache(path);
}

/** Invalidate shared filesystem scan caches after a rename/move. Some watchers care about the disappearance at the old path; others about the */
export function invalidateFsScanAfterRename(oldPath: string, newPath: string): void {
	invalidateFsScanCache(oldPath);
	if (newPath !== oldPath) {
		invalidateFsScanCache(newPath);
	}
}
