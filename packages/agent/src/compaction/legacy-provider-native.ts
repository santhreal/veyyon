/** Preserve-data keys written by the removed provider-native compaction paths. */
export const LEGACY_REMOTE_PRESERVE_KEYS = ["openaiRemoteCompaction", "compactionV2"] as const;

/** Whether a compaction entry carries an opaque legacy payload no runtime can replay. */
export function hasLegacyProviderNativeCompaction(preserveData: Record<string, unknown> | undefined): boolean {
	return !!preserveData && LEGACY_REMOTE_PRESERVE_KEYS.some(key => key in preserveData);
}
