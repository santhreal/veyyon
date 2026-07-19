import { HOUR_MS, isDateOnly } from "@veyyon/utils";
import { LRUCache } from "lru-cache/raw";
import { recencyHalflifeHours } from "../config";

const TZ_RE = /(?:Z|[+-]\d\d:?\d\d)$/;
const TS_CACHE = new LRUCache<string, Date>({ max: 2000 });

export type QueryTime = string | Date | null | undefined;

export function parseIsoDateTimeUtc(value: string): Date {
	let text = value.trim();
	if (!text) throw new RangeError("Invalid ISO datetime: empty string");
	if (isDateOnly(text)) text += "T00:00:00Z";
	else if (!TZ_RE.test(text)) text += "Z";
	const date = new Date(text);
	if (Number.isNaN(date.getTime())) throw new RangeError(`Invalid ISO datetime: ${value}`);
	return date;
}

export function normalizeDateTimeUtc(value: Date): Date {
	const time = value.getTime();
	if (Number.isNaN(time)) throw new RangeError("Invalid Date");
	return new Date(time);
}

export function parseQueryTime(value: QueryTime): Date {
	if (value === null || value === undefined) return new Date();
	return typeof value === "string" ? parseIsoDateTimeUtc(value) : normalizeDateTimeUtc(value);
}

export function parseTsFast(value: string): Date | undefined {
	if (!value) return undefined;
	const cached = TS_CACHE.get(value);
	if (cached !== undefined) return cached;
	try {
		const parsed = parseIsoDateTimeUtc(value);
		TS_CACHE.set(value, parsed);
		return parsed;
	} catch {
		return undefined;
	}
}

export function toUtcIso(value: Date = new Date()): string {
	return normalizeDateTimeUtc(value).toISOString();
}

/**
 * Exponential recency weight for a timestamp: 1 at zero age, halving every
 * {@link halflifeHours}. A future timestamp is clamped to age 0 (weight 1) so
 * the result stays in (0, 1]. When the timestamp is missing or unparseable the
 * caller chooses the neutral value through {@link fallback}: recall scoring
 * passes 0 (an untimestamped row earns no recency credit) while the default
 * 0.5 keeps a memory mid-ranked.
 */
export function recencyDecay(
	timestamp: string | Date | null | undefined,
	halflifeHours = recencyHalflifeHours(),
	now: Date = new Date(),
	fallback = 0.5,
): number {
	if (!timestamp) return fallback;
	try {
		const ts = typeof timestamp === "string" ? parseIsoDateTimeUtc(timestamp) : normalizeDateTimeUtc(timestamp);
		const ageHours = Math.max(0, (now.getTime() - ts.getTime()) / HOUR_MS);
		return Math.exp(-ageHours / halflifeHours);
	} catch {
		return fallback;
	}
}

export function temporalBoost(memoryTimestamp: string, queryTime: QueryTime = undefined, halflifeHours = 24): number {
	let ts = parseTsFast(memoryTimestamp);
	if (ts === undefined) return 0;
	const query = parseQueryTime(queryTime);
	if (ts.getTime() > query.getTime()) ts = query;
	return Math.exp(-((query.getTime() - ts.getTime()) / HOUR_MS) / halflifeHours);
}
