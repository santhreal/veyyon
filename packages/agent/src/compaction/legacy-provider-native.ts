/** The two DEAD preserve-data keys, written by earlier provider-native */
export const LEGACY_REMOTE_PRESERVE_KEYS = ["openaiRemoteCompaction", "compactionV2"] as const;

/** Whether a compaction entry carries one of the two dead payloads no runtime can replay. */
export function hasLegacyProviderNativeCompaction(preserveData: Record<string, unknown> | undefined): boolean {
	return !!preserveData && LEGACY_REMOTE_PRESERVE_KEYS.some(key => key in preserveData);
}
