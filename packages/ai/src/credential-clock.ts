export const CREDENTIAL_CLOCK_TOLERANCE_MS = 5_000;

export function isRecordFromFutureClock(writtenAtMs: number | undefined, nowMs: number): boolean {
	if (typeof writtenAtMs !== "number" || !Number.isFinite(writtenAtMs)) return false;
	return nowMs + CREDENTIAL_CLOCK_TOLERANCE_MS < writtenAtMs;
}

export function epochSecondsToMs(seconds: number | undefined): number | undefined {
	if (typeof seconds !== "number" || !Number.isFinite(seconds)) return undefined;
	return seconds * 1000;
}

export function msToEpochSeconds(ms: number): number {
	return Math.floor(ms / 1000);
}
