export const EXTRACTION_TIERS = ["host", "remote", "local", "cloud", "wrapper"] as const;
export type ExtractionTier = (typeof EXTRACTION_TIERS)[number];

export const MAX_ERROR_SAMPLES_PER_TIER = 10;
export const ERROR_MESSAGE_CAP = 200;

export interface ErrorSample {
	at: string;
	type: string;
	msg: string;
	reason?: string;
}

export interface TierStatsSnapshot {
	attempts: number;
	successes: number;
	no_output: number;
	failures: number;
	error_samples: ErrorSample[];
}

export interface ExtractionStatsSnapshot {
	created_at: string;
	snapshot_at: string;
	totals: {
		calls: number;
		successes: number;
		failures: number;
		empty: number;
		success_rate: number;
	};
	by_tier: Record<ExtractionTier, TierStatsSnapshot>;
}

export interface MutableTierStats {
	attempts: number;
	successes: number;
	no_output: number;
	failures: number;
	error_samples: ErrorSample[];
}

export function safeForLog(value: unknown): string {
	if (value === null || value === undefined) {
		return "";
	}
	const s = value instanceof Error ? `${value.name}: ${value.message}` : String(value);
	let out = "";
	for (let i = 0; i < s.length && out.length < ERROR_MESSAGE_CAP; i += 1) {
		const code = s.charCodeAt(i);
		out += code >= 32 && code !== 127 && code !== 27 ? s.charAt(i) : " ";
	}
	return out;
}

export function emptyTierStats(): Record<ExtractionTier, MutableTierStats> {
	return {
		host: { attempts: 0, successes: 0, no_output: 0, failures: 0, error_samples: [] },
		remote: { attempts: 0, successes: 0, no_output: 0, failures: 0, error_samples: [] },
		local: { attempts: 0, successes: 0, no_output: 0, failures: 0, error_samples: [] },
		cloud: { attempts: 0, successes: 0, no_output: 0, failures: 0, error_samples: [] },
		wrapper: { attempts: 0, successes: 0, no_output: 0, failures: 0, error_samples: [] },
	};
}

export function isTier(tier: string): tier is ExtractionTier {
	return (EXTRACTION_TIERS as readonly string[]).includes(tier);
}

export function errorRepr(exc: unknown): string {
	if (exc instanceof Error) {
		return `${exc.name}: ${exc.message}`;
	}
	return String(exc);
}
