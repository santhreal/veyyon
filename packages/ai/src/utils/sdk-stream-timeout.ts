function resolveSdkTimeoutMs(streamFirstEventTimeoutMs: number | undefined): number | undefined {
	if (streamFirstEventTimeoutMs === undefined) return undefined;
	if (!Number.isFinite(streamFirstEventTimeoutMs)) return undefined;
	if (streamFirstEventTimeoutMs <= 0) return undefined;
	return Math.trunc(streamFirstEventTimeoutMs);
}

export function createSdkStreamRequestOptions(
	signal: AbortSignal,
	streamFirstEventTimeoutMs: number | undefined,
): { signal: AbortSignal; timeout?: number; maxRetries?: number } {
	const timeout = resolveSdkTimeoutMs(streamFirstEventTimeoutMs);
	if (timeout === undefined) return { signal };
	return { signal, timeout, maxRetries: 0 };
}
