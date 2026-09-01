import { DAY_MS } from "@veyyon/utils/time";

export type SettingsRow = {
	key: string;
	value: string;
};

export type ModelUsageRow = {
	model_key: string;
	last_used_at: number;
};

export type ModelPerfRow = {
	model_key: string;
	samples: number;
	output_tokens: number;
	gen_ms: number;
	ttft_samples: number;
	ttft_ms: number;
};

export type StatsMessageRow = {
	rowid: number;
	timestamp: number;
	provider: string;
	model: string;
	output_tokens: number;
	duration: number;
	ttft: number | null;
};

export type PerfAccum = {
	samples: number;
	outputTokens: number;
	genMs: number;
	ttftSamples: number;
	ttftMs: number;
};

export interface ModelPerfSample {
	outputTokens: number;
	durationMs: number;
	ttftMs?: number;
}

export type ModelPerfInsert = {
	modelKey: string;
	outputTokens: number;
	durationMs: number;
	ttftSamples: 0 | 1;
	ttftMs: number;
};

export interface ModelPerfStats {
	samples: number;
	tps: number;
	ttftMs: number | null;
}

export const MODEL_PERF_DECAY_AT = 256;
export const MODEL_PERF_BACKFILL_KEY = "model_perf_backfill";
export const MODEL_PERF_FLUSH_DELAY_MS = 100;
export const MODEL_PERF_BACKFILL_MAX_AGE_MS = 90 * DAY_MS;
export const MODEL_PERF_BACKFILL_CHUNK = 2048;
export const MODEL_PERF_BACKFILL_MAX_ROWS = 250_000;

export function normalizeModelPerfSample(modelKey: string, sample: ModelPerfSample): ModelPerfInsert | null {
	const { outputTokens, durationMs } = sample;
	if (!Number.isFinite(outputTokens) || outputTokens <= 0) return null;
	if (!Number.isFinite(durationMs) || durationMs <= 0) return null;
	const ttftMs =
		sample.ttftMs !== undefined && Number.isFinite(sample.ttftMs) && sample.ttftMs > 0 && sample.ttftMs < durationMs
			? sample.ttftMs
			: undefined;
	return { modelKey, outputTokens, durationMs, ttftSamples: ttftMs !== undefined ? 1 : 0, ttftMs: ttftMs ?? 0 };
}

export const SCHEMA_VERSION = 6;
