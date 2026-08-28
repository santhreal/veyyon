export interface ExponentialBackoffOptions {
	baseMs?: number;
	maxMs?: number;
	jitter?: number;
	random?: () => number;
}

export function exponentialBackoffDelay(attempt: number, options: ExponentialBackoffOptions = {}): number {
	const { baseMs = 1_000, maxMs = 30_000, jitter = 0.25, random = Math.random } = options;
	const capped = Math.min(baseMs * 2 ** attempt, maxMs);
	return capped * (1 - jitter + random() * (2 * jitter));
}
