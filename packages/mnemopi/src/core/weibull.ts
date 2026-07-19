import { HOUR_MS } from "@veyyon/utils";
import { parseTsFast } from "../util/datetime";

export type MemoryType = keyof typeof WEIBULL_PARAMS;

export interface WeibullParams {
	readonly k: number;
	readonly eta: number;
}

// Per-memory-type Weibull parameters (k=shape, eta=scale in hours).
// Higher eta = slower decay, lower k = more long-term retention.
export const WEIBULL_PARAMS = {
	profile: { k: 0.3, eta: 8760.0 },
	preference: { k: 0.4, eta: 4380.0 },
	relationship: { k: 0.35, eta: 8760.0 },
	learning: { k: 0.7, eta: 1440.0 },

	fact: { k: 0.8, eta: 720.0 },
	entity: { k: 0.5, eta: 4380.0 },
	setup: { k: 0.6, eta: 2160.0 },
	pattern: { k: 0.6, eta: 1680.0 },
	context: { k: 0.85, eta: 360.0 },
	observation: { k: 0.9, eta: 480.0 },
	artifact: { k: 0.75, eta: 2160.0 },

	project: { k: 0.85, eta: 1080.0 },
	goal: { k: 0.9, eta: 720.0 },
	decision: { k: 1.0, eta: 336.0 },
	commitment: { k: 1.0, eta: 240.0 },

	event: { k: 1.2, eta: 168.0 },
	instruction: { k: 0.9, eta: 480.0 },
	error: { k: 1.1, eta: 336.0 },
	issue: { k: 1.1, eta: 336.0 },
	request: { k: 1.5, eta: 72.0 },

	general: { k: 1.0, eta: 168.0 },
} as const satisfies Record<string, WeibullParams>;

export const DEFAULT_HALFLIFE_HOURS = 168.0;

type TimestampInput = string | Date | null | undefined;

// Route every string timestamp through the package's one canonical parser, which
// treats a naive (no-timezone) or date-only stamp as UTC. The previous hand-rolled
// ladder here reused `new Date(...)` with a local-time `new Date(year, month-1, day)`
// fallback, so the same stored stamp decayed differently depending on the host's
// timezone. `parseTsFast` already accepts the ISO, naive, SQLite-space, and
// date-only forms these rows carry.
function parseTimestamp(timestamp: TimestampInput): Date | null {
	if (timestamp == null) return null;
	if (timestamp instanceof Date) {
		return Number.isFinite(timestamp.getTime()) ? timestamp : null;
	}
	if (typeof timestamp !== "string") return null;
	return parseTsFast(timestamp) ?? null;
}

function paramsFor(memoryType: string): WeibullParams | undefined {
	return WEIBULL_PARAMS[memoryType as MemoryType];
}

export function weibullBoost(
	timestamp: TimestampInput,
	queryTime: Date | null = new Date(),
	memoryType = "general",
	halflifeHours?: number | null,
): number {
	const memoryTime = parseTimestamp(timestamp);
	const resolvedQueryTime = queryTime ?? new Date();
	if (memoryTime === null || !Number.isFinite(resolvedQueryTime.getTime())) return 0.0;

	const ageHours = (resolvedQueryTime.getTime() - memoryTime.getTime()) / HOUR_MS;
	if (ageHours < 0) return 1.0;

	if (halflifeHours != null) {
		if (halflifeHours <= 0) return 0.0;
		return Math.exp(-ageHours / halflifeHours);
	}

	const params = paramsFor(memoryType);
	if (params === undefined) {
		return Math.exp(-ageHours / DEFAULT_HALFLIFE_HOURS);
	}

	if (params.eta <= 0) return 0.0;
	return Math.exp(-((ageHours / params.eta) ** params.k));
}

export function weibullDecayFactor(ageHours: number, memoryType = "general"): number {
	if (ageHours <= 0) return 1.0;

	const params = paramsFor(memoryType);
	if (params === undefined) {
		return Math.exp(-ageHours / DEFAULT_HALFLIFE_HOURS);
	}

	if (params.eta <= 0) return 0.0;
	return Math.exp(-((ageHours / params.eta) ** params.k));
}
