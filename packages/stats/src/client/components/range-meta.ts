import { DAY_MS, HOUR_MS, MINUTE_MS } from "@veyyon/utils/time";
import { format } from "date-fns";
import type { TimeRange } from "../types";

const FIVE_MIN_MS = 5 * MINUTE_MS;

export interface RangeMeta {
	windowLabel: string;
	trendLabel: string;
	bucketMs: number;
	bucketCount: number;
	tickFormat: string;
}

const RANGE_META: Record<TimeRange, RangeMeta> = {
	"1h": {
		windowLabel: "the last hour",
		trendLabel: "1h Trend",
		bucketMs: FIVE_MIN_MS,
		bucketCount: 12,
		tickFormat: "HH:mm",
	},
	"24h": {
		windowLabel: "the last 24 hours",
		trendLabel: "24h Trend",
		bucketMs: HOUR_MS,
		bucketCount: 24,
		tickFormat: "HH:mm",
	},
	"7d": {
		windowLabel: "the last 7 days",
		trendLabel: "7d Trend",
		bucketMs: DAY_MS,
		bucketCount: 7,
		tickFormat: "MMM d",
	},
	"30d": {
		windowLabel: "the last 30 days",
		trendLabel: "30d Trend",
		bucketMs: DAY_MS,
		bucketCount: 30,
		tickFormat: "MMM d",
	},
	"90d": {
		windowLabel: "the last 90 days",
		trendLabel: "90d Trend",
		bucketMs: DAY_MS,
		bucketCount: 90,
		tickFormat: "MMM d",
	},
	all: { windowLabel: "all time", trendLabel: "Trend", bucketMs: DAY_MS, bucketCount: 0, tickFormat: "MMM d" },
};

export function rangeMeta(range: TimeRange): RangeMeta {
	return RANGE_META[range];
}

export function formatRangeTick(timestamp: number, range: TimeRange): string {
	return format(new Date(timestamp), RANGE_META[range].tickFormat);
}
