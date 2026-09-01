export const RECALL_TIERS = ["wm_fts", "wm_vec", "wm_fallback", "em_fts", "em_vec", "em_fallback"] as const;
export type RecallTier = (typeof RECALL_TIERS)[number];

export interface TierStatsSnapshot {
	readonly calls_with_hits: number;
	readonly total_hits: number;
}

export interface RecallDiagnosticsSnapshot {
	readonly created_at: string;
	readonly snapshot_at: string;
	readonly totals: {
		readonly calls: number;
		readonly calls_using_wm_fallback: number;
		readonly calls_using_em_fallback: number;
		readonly calls_truly_empty: number;
		readonly wm_fallback_rate: number;
		readonly em_fallback_rate: number;
	};
	readonly by_tier: Record<RecallTier, TierStatsSnapshot>;
}

export interface TierStats {
	callsWithHits: number;
	totalHits: number;
}

export function newTierStats(): Record<RecallTier, TierStats> {
	return {
		wm_fts: { callsWithHits: 0, totalHits: 0 },
		wm_vec: { callsWithHits: 0, totalHits: 0 },
		wm_fallback: { callsWithHits: 0, totalHits: 0 },
		em_fts: { callsWithHits: 0, totalHits: 0 },
		em_vec: { callsWithHits: 0, totalHits: 0 },
		em_fallback: { callsWithHits: 0, totalHits: 0 },
	};
}

export function isRecallTier(tier: string): tier is RecallTier {
	return (RECALL_TIERS as readonly string[]).includes(tier);
}
