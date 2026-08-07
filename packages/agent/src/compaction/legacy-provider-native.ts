/**
 * The two DEAD preserve-data keys, written by earlier provider-native
 * compaction paths that no longer exist: OpenAI `openaiRemoteCompaction` and
 * the Responses V2 `compactionV2` variant.
 *
 * These are not the live key. Server-side compaction still runs, and it writes
 * REMOTE_COMPACTION_PRESERVE_KEY ("remoteCompaction") in `remote-compaction-entry.ts`.
 * A payload under one of the keys below is unreadable by anything shipping
 * today, so it can only be looked past: compaction re-expands the original
 * messages behind such an entry, summarizes them locally, and drops the dead
 * key rather than copying it forward. Keep this list. Deleting it would strand
 * every session that still carries one on disk.
 */
export const LEGACY_REMOTE_PRESERVE_KEYS = ["openaiRemoteCompaction", "compactionV2"] as const;

/** Whether a compaction entry carries one of the two dead payloads no runtime can replay. */
export function hasLegacyProviderNativeCompaction(preserveData: Record<string, unknown> | undefined): boolean {
	return !!preserveData && LEGACY_REMOTE_PRESERVE_KEYS.some(key => key in preserveData);
}
