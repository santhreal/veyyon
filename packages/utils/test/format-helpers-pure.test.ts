import { describe, expect, it } from "bun:test";
import {
	formatAge,
	formatBytes,
	formatClock,
	formatCostTiered,
	formatCount,
	formatDuration,
	formatMoreLines,
	formatNumber,
	formatPercent,
	normalizePremiumRequests,
	pluralize,
	truncate,
} from "../src/format";

describe("formatDuration", () => {
	it("formats milliseconds", () => {
		expect(formatDuration(123)).toBe("123ms");
	});
	it("formats sub-second with 1 decimal", () => {
		expect(formatDuration(1500)).toBe("1.5s");
	});
	it("formats minutes with seconds", () => {
		expect(formatDuration(30 * 60 * 1000 + 15 * 1000)).toBe("30m15s");
	});
	it("formats minutes without seconds", () => {
		expect(formatDuration(30 * 60 * 1000)).toBe("30m");
	});
	it("formats hours with minutes", () => {
		expect(formatDuration(2 * 60 * 60 * 1000 + 30 * 60 * 1000)).toBe("2h30m");
	});
	it("formats hours without minutes", () => {
		expect(formatDuration(2 * 60 * 60 * 1000)).toBe("2h");
	});
	it("formats days with hours", () => {
		expect(formatDuration(3 * 24 * 60 * 60 * 1000 + 2 * 60 * 60 * 1000)).toBe("3d2h");
	});
	it("formats days without hours", () => {
		expect(formatDuration(3 * 24 * 60 * 60 * 1000)).toBe("3d");
	});
	it("returns 0ms for zero", () => {
		expect(formatDuration(0)).toBe("0ms");
	});
	it("returns 0ms for negative", () => {
		expect(formatDuration(-100)).toBe("0ms");
	});
	it("returns 0ms for NaN", () => {
		expect(formatDuration(Number.NaN)).toBe("0ms");
	});
	it("returns 0ms for Infinity", () => {
		expect(formatDuration(Number.POSITIVE_INFINITY)).toBe("0ms");
	});
});

describe("formatClock", () => {
	it("formats seconds only", () => {
		expect(formatClock(30_000)).toBe("0:30");
	});
	it("formats minutes and seconds", () => {
		expect(formatClock(5 * 60 * 1000 + 30 * 1000)).toBe("5:30");
	});
	it("formats hours with padded minutes and seconds", () => {
		expect(formatClock(2 * 3600 * 1000 + 5 * 60 * 1000 + 3 * 1000)).toBe("2:05:03");
	});
	it("formats zero as 0:00", () => {
		expect(formatClock(0)).toBe("0:00");
	});
	it("handles NaN as 0:00", () => {
		expect(formatClock(Number.NaN)).toBe("0:00");
	});
	it("clamps negative to 0:00", () => {
		expect(formatClock(-1000)).toBe("0:00");
	});
});

describe("formatNumber", () => {
	it("returns small numbers as-is", () => {
		expect(formatNumber(999)).toBe("999");
	});
	it("formats thousands with 1 decimal", () => {
		expect(formatNumber(1500)).toBe("1.5K");
	});
	it("formats thousands rounded", () => {
		expect(formatNumber(25_000)).toBe("25K");
	});
	it("formats millions with 1 decimal", () => {
		expect(formatNumber(1_500_000)).toBe("1.5M");
	});
	it("formats millions rounded", () => {
		expect(formatNumber(25_000_000)).toBe("25M");
	});
	it("formats billions with 1 decimal", () => {
		expect(formatNumber(1_500_000_000)).toBe("1.5B");
	});
	it("rolls 999500 to 1M", () => {
		expect(formatNumber(999_500)).toBe("1M");
	});
	it("returns 0 for NaN", () => {
		expect(formatNumber(Number.NaN)).toBe("0");
	});
	it("returns 0 for Infinity", () => {
		expect(formatNumber(Number.POSITIVE_INFINITY)).toBe("0");
	});
	it("handles zero", () => {
		expect(formatNumber(0)).toBe("0");
	});
	it("handles negative", () => {
		expect(formatNumber(-500)).toBe("-500");
	});
});

describe("formatBytes", () => {
	it("formats bytes", () => {
		expect(formatBytes(512)).toBe("512B");
	});
	it("formats kilobytes with 1 decimal", () => {
		expect(formatBytes(1536)).toBe("1.5KB");
	});
	it("formats megabytes with 1 decimal", () => {
		expect(formatBytes(2 * 1024 * 1024 + 300 * 1024)).toBe("2.3MB");
	});
	it("formats gigabytes with 1 decimal", () => {
		expect(formatBytes(1.2 * 1024 * 1024 * 1024)).toBe("1.2GB");
	});
	it("returns 0B for NaN", () => {
		expect(formatBytes(Number.NaN)).toBe("0B");
	});
	it("returns 0B for Infinity", () => {
		expect(formatBytes(Number.POSITIVE_INFINITY)).toBe("0B");
	});
	it("handles zero", () => {
		expect(formatBytes(0)).toBe("0B");
	});
	it("promotes near-boundary to next unit", () => {
		expect(formatBytes(1_048_575)).toBe("1.0MB");
	});
});

describe("truncate", () => {
	it("returns string unchanged when within limit", () => {
		expect(truncate("hello", 10)).toBe("hello");
	});
	it("truncates with ellipsis", () => {
		expect(truncate("hello world", 8)).toBe("hello w…");
	});
	it("handles exact length", () => {
		expect(truncate("hello", 5)).toBe("hello");
	});
	it("handles custom ellipsis", () => {
		expect(truncate("hello world", 8, "...")).toBe("hello...");
	});
	it("handles empty string", () => {
		expect(truncate("", 5)).toBe("");
	});
});

describe("formatCount", () => {
	it("formats singular", () => {
		expect(formatCount("file", 1)).toBe("1 file");
	});
	it("formats plural", () => {
		expect(formatCount("file", 3)).toBe("3 files");
	});
	it("handles zero", () => {
		expect(formatCount("error", 0)).toBe("0 errors");
	});
	it("handles NaN as 0", () => {
		expect(formatCount("error", Number.NaN)).toBe("0 errors");
	});
});

describe("formatAge", () => {
	it("returns empty for null", () => {
		expect(formatAge(null)).toBe("");
	});
	it("returns empty for undefined", () => {
		expect(formatAge(undefined)).toBe("");
	});
	it("returns empty for zero", () => {
		expect(formatAge(0)).toBe("");
	});
	it("returns empty for negative", () => {
		expect(formatAge(-10)).toBe("");
	});
	it("returns 'just now' for < 1 minute", () => {
		expect(formatAge(30)).toBe("just now");
	});
	it("formats minutes", () => {
		expect(formatAge(300)).toBe("5m ago");
	});
	it("formats hours", () => {
		expect(formatAge(7200)).toBe("2h ago");
	});
	it("formats days", () => {
		expect(formatAge(3 * 24 * 3600)).toBe("3d ago");
	});
	it("formats weeks", () => {
		expect(formatAge(2 * 7 * 24 * 3600)).toBe("2w ago");
	});
	it("formats months", () => {
		expect(formatAge(60 * 24 * 3600)).toBe("2mo ago");
	});
});

describe("pluralize", () => {
	it("returns singular for count 1", () => {
		expect(pluralize("file", 1)).toBe("file");
	});
	it("adds s for regular plural", () => {
		expect(pluralize("file", 3)).toBe("files");
	});
	it("adds es for words ending in s", () => {
		expect(pluralize("bus", 2)).toBe("buses");
	});
	it("adds es for words ending in x", () => {
		expect(pluralize("box", 2)).toBe("boxes");
	});
	it("adds es for words ending in ch", () => {
		expect(pluralize("watch", 2)).toBe("watches");
	});
	it("adds es for words ending in sh", () => {
		expect(pluralize("dish", 2)).toBe("dishes");
	});
	it("adds es for words ending in z", () => {
		expect(pluralize("quiz", 2)).toBe("quizes");
	});
	it("converts y to ies", () => {
		expect(pluralize("entry", 2)).toBe("entries");
	});
	it("keeps vowel before y", () => {
		expect(pluralize("day", 2)).toBe("days");
	});
});

describe("formatMoreLines", () => {
	it("formats plural", () => {
		expect(formatMoreLines(4)).toBe("4 more lines");
	});
	it("formats singular", () => {
		expect(formatMoreLines(1)).toBe("1 more line");
	});
});

describe("formatPercent", () => {
	it("formats ratio as percent", () => {
		expect(formatPercent(0.5)).toBe("50.0%");
	});
	it("formats 1 as 100%", () => {
		expect(formatPercent(1)).toBe("100.0%");
	});
	it("formats 0 as 0.0%", () => {
		expect(formatPercent(0)).toBe("0.0%");
	});
	it("returns 0.0% for NaN", () => {
		expect(formatPercent(Number.NaN)).toBe("0.0%");
	});
	it("handles ratio above 1", () => {
		expect(formatPercent(1.5)).toBe("150.0%");
	});
});

describe("formatCostTiered", () => {
	it("formats sub-cent with 4 decimals", () => {
		expect(formatCostTiered(0.001)).toBe("$0.0010");
	});
	it("formats sub-dollar with 3 decimals", () => {
		expect(formatCostTiered(0.5)).toBe("$0.500");
	});
	it("formats dollar and above with 2 decimals", () => {
		expect(formatCostTiered(1.5)).toBe("$1.50");
	});
	it("formats exactly 0.01 with 3 decimals", () => {
		expect(formatCostTiered(0.01)).toBe("$0.010");
	});
	it("formats exactly 1 with 2 decimals", () => {
		expect(formatCostTiered(1)).toBe("$1.00");
	});
});

describe("normalizePremiumRequests", () => {
	it("rounds to 2 decimals", () => {
		expect(normalizePremiumRequests(1.005)).toBeCloseTo(1.01, 2);
	});
	it("handles integer", () => {
		expect(normalizePremiumRequests(5)).toBe(5);
	});
	it("handles zero", () => {
		expect(normalizePremiumRequests(0)).toBe(0);
	});
	it("handles fractional", () => {
		expect(normalizePremiumRequests(1.234)).toBeCloseTo(1.23, 2);
	});
});
