import { type Env, enhancedRecallEnabled } from "../config";

export type QueryCacheResult = Record<string, unknown>;
export type QueryEmbedding = readonly number[];

export interface QueryCacheOptions {
	readonly dbPath?: string | null;
	readonly db_path?: string | null;
	readonly maxSize?: number;
	readonly max_size?: number;
	readonly ttlSeconds?: number;
	readonly ttl_seconds?: number;
}

export interface QueryCacheStats {
	readonly hits: number;
	readonly misses: number;
	readonly hit_rate: number;
	readonly tier1_hits: number;
	readonly tier2_hits: number;
	readonly tier3_hits: number;
	readonly tier4_hits: number;
	readonly size: number;
	readonly max_size: number;
	readonly version: number;
}

export interface Tier23Entry {
	readonly embedding: QueryEmbedding;
	readonly results: readonly QueryCacheResult[];
}

export interface CacheRow {
	readonly normalized: string;
	readonly embedding_json: string | null;
	readonly results_json: string;
	readonly created_at_epoch: number | null;
}

export function isEnhancedRecallEnabled(env: Env = process.env): boolean {
	return enhancedRecallEnabled(env);
}

export function isQueryCacheEnabled(useCache = true, env: Env = process.env): boolean {
	return useCache && isEnhancedRecallEnabled(env);
}
