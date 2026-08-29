import { truncateForLog } from "../../util/log-format";
import type {
	ErrorSample,
	ExtractionStatsSnapshot,
	ExtractionTier,
	MutableTierStats,
	TierStatsSnapshot,
} from "./diagnostics-helpers";
import {
	ERROR_MESSAGE_CAP,
	EXTRACTION_TIERS,
	emptyTierStats,
	errorRepr,
	isTier,
	MAX_ERROR_SAMPLES_PER_TIER,
} from "./diagnostics-helpers";

export { safeForLog } from "./diagnostics-helpers";

export class ExtractionDiagnostics {
	#tierStats: Record<ExtractionTier, MutableTierStats> = emptyTierStats();
	#totalCalls = 0;
	#totalSuccesses = 0;
	#totalFailures = 0;
	#totalEmpty = 0;
	#createdAt = new Date().toISOString();

	#validateTier(tier: string): asserts tier is ExtractionTier {
		if (!isTier(tier)) {
			throw new Error(
				`unknown extraction tier ${JSON.stringify(tier)}; valid tiers: ${EXTRACTION_TIERS.join(", ")}`,
			);
		}
	}

	recordAttempt(tier: ExtractionTier): void {
		this.#validateTier(tier);
		this.#tierStats[tier].attempts += 1;
	}
	recordSuccess(tier: ExtractionTier, _factCount = 0): void {
		this.#validateTier(tier);
		this.#tierStats[tier].successes += 1;
	}
	recordNoOutput(tier: ExtractionTier): void {
		this.#validateTier(tier);
		this.#tierStats[tier].no_output += 1;
	}
	recordFailure(tier: ExtractionTier, exc?: unknown, reason?: string): void {
		this.#validateTier(tier);
		const stats = this.#tierStats[tier];
		stats.failures += 1;
		const sample: ErrorSample = { at: new Date().toISOString(), type: "unspecified", msg: "" };
		if (exc !== undefined && exc !== null) {
			sample.type = exc instanceof Error ? exc.name : typeof exc;
			sample.msg = truncateForLog(errorRepr(exc), ERROR_MESSAGE_CAP);
		} else if (reason !== undefined) {
			sample.type = "reason";
			sample.msg = truncateForLog(reason, ERROR_MESSAGE_CAP);
		}
		if (reason !== undefined) {
			sample.reason = reason;
		}
		stats.error_samples.push(sample);
		if (stats.error_samples.length > MAX_ERROR_SAMPLES_PER_TIER) {
			stats.error_samples.splice(0, stats.error_samples.length - MAX_ERROR_SAMPLES_PER_TIER);
		}
	}
	recordCall(opts: { succeeded: boolean; allEmpty?: boolean }): void {
		this.#totalCalls += 1;
		if (opts.succeeded) {
			this.#totalSuccesses += 1;
		} else if (opts.allEmpty === true) {
			this.#totalEmpty += 1;
		} else {
			this.#totalFailures += 1;
		}
	}
	successRate(): number {
		return this.#totalCalls === 0 ? 0 : this.#totalSuccesses / this.#totalCalls;
	}
	snapshot(): ExtractionStatsSnapshot {
		const byTier = {} as Record<ExtractionTier, TierStatsSnapshot>;
		for (const tier of EXTRACTION_TIERS) {
			const stats = this.#tierStats[tier];
			byTier[tier] = {
				attempts: stats.attempts,
				successes: stats.successes,
				no_output: stats.no_output,
				failures: stats.failures,
				error_samples: stats.error_samples.map(sample => ({ ...sample })),
			};
		}
		return {
			created_at: this.#createdAt,
			snapshot_at: new Date().toISOString(),
			totals: {
				calls: this.#totalCalls,
				successes: this.#totalSuccesses,
				failures: this.#totalFailures,
				empty: this.#totalEmpty,
				success_rate: this.successRate(),
			},
			by_tier: byTier,
		};
	}

	reset(): void {
		this.#tierStats = emptyTierStats();
		this.#totalCalls = 0;
		this.#totalSuccesses = 0;
		this.#totalFailures = 0;
		this.#totalEmpty = 0;
		this.#createdAt = new Date().toISOString();
	}
}

let singleton: ExtractionDiagnostics | null = null;

export function extractionDiagnostics(): ExtractionDiagnostics {
	if (singleton === null) {
		singleton = new ExtractionDiagnostics();
	}
	return singleton;
}

export function getExtractionStats(): ExtractionStatsSnapshot {
	return extractionDiagnostics().snapshot();
}

export function resetExtractionStats(): void {
	extractionDiagnostics().reset();
}
