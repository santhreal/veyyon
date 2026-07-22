import { describe, expect, it } from "bun:test";
import {
	formatAge,
	formatBytes,
	formatCount,
	formatDuration,
	formatNumber,
	formatPercent,
	pluralize,
	truncate,
} from "@veyyon/utils/format";

describe("formatDuration", () => {
	// Codex's wham/usage endpoint returns the prior window's reset_at until the
	// next request opens a fresh window, so the `resetsAt - now` delta can land
	// in the recent past. The util must defend against that — older builds
	// rendered "-612090ms", which leaked straight into the /usage TUI.
	it("clamps non-positive, NaN, and Infinity inputs to 0ms", () => {
		expect(formatDuration(-612_090)).toBe("0ms");
		expect(formatDuration(-1)).toBe("0ms");
		expect(formatDuration(0)).toBe("0ms");
		expect(formatDuration(Number.NaN)).toBe("0ms");
		expect(formatDuration(Number.POSITIVE_INFINITY)).toBe("0ms");
		expect(formatDuration(Number.NEGATIVE_INFINITY)).toBe("0ms");
	});

	it("formats sub-second, sub-minute, sub-hour, sub-day, and multi-day ranges", () => {
		expect(formatDuration(500)).toBe("500ms");
		expect(formatDuration(1_500)).toBe("1.5s");
		expect(formatDuration(90_000)).toBe("1m30s");
		expect(formatDuration(3_600_000)).toBe("1h");
		expect(formatDuration(3_660_000)).toBe("1h1m");
		expect(formatDuration(2 * 86_400_000 + 3_600_000)).toBe("2d1h");
	});
});

describe("truncate", () => {
	it("returns short strings unchanged", () => {
		expect(truncate("hello", 10)).toBe("hello");
		expect(truncate("hello", 5)).toBe("hello");
		expect(truncate("", 3)).toBe("");
	});

	it("cuts to maxLen including the ellipsis", () => {
		expect(truncate("hello world", 8)).toBe("hello w\u2026");
		expect(truncate("hello world", 8).length).toBe(8);
		expect(truncate("abcdef", 4, "...")).toBe("a...");
	});

	// Cutting by UTF-16 unit used to split astral characters into a lone
	// surrogate; the cut must land on a code-point boundary.
	it("never splits an astral character", () => {
		const s = "ab\u{1F600}\u{1F601}cd"; // each emoji is 2 UTF-16 units
		const out = truncate(s, 4);
		expect(out).toBe("ab\u{1F600}\u2026");
		expect(out.includes("\uFFFD")).toBe(false);
		for (const ch of out) expect(ch.length <= 2).toBe(true);
	});

	it("counts astral-only strings by code point, not code unit", () => {
		const s = "\u{1F600}\u{1F601}\u{1F602}"; // length 6, 3 code points
		expect(truncate(s, 3)).toBe(s); // 3 code points fit a 3-char budget
		expect(truncate(s, 2)).toBe("\u{1F600}\u2026");
	});

	it("degrades to just the ellipsis when the budget is tiny", () => {
		expect(truncate("hello", 1)).toBe("\u2026");
		expect(truncate("hello", 0)).toBe("\u2026");
	});
});

describe("formatNumber", () => {
	it("keeps small numbers verbatim and adds K/M/B with one leading decimal", () => {
		expect(formatNumber(0)).toBe("0");
		expect(formatNumber(999)).toBe("999");
		expect(formatNumber(1_000)).toBe("1K");
		expect(formatNumber(1_500)).toBe("1.5K");
		expect(formatNumber(25_000)).toBe("25K");
		expect(formatNumber(999_499)).toBe("999K");
		expect(formatNumber(1_000_000)).toBe("1M");
		expect(formatNumber(1_500_000)).toBe("1.5M");
		expect(formatNumber(25_000_000)).toBe("25M");
		expect(formatNumber(1_500_000_000)).toBe("1.5B");
		expect(formatNumber(25_000_000_000)).toBe("25B");
	});

	// Regression lock: NaN/Infinity previously fell through every threshold to the
	// billions branch and rendered "NaNB"/"InfinityB". They now return "0", matching
	// formatCount/formatDuration's non-finite handling. Signed negatives keep their
	// sign (a negative delta is a valid display value), unlike duration.
	it("renders non-finite input as 0 and keeps signed negatives", () => {
		expect(formatNumber(Number.NaN)).toBe("0");
		expect(formatNumber(Number.POSITIVE_INFINITY)).toBe("0");
		expect(formatNumber(Number.NEGATIVE_INFINITY)).toBe("0");
		expect(formatNumber(-5)).toBe("-5");
	});
});

describe("formatBytes", () => {
	it("uses binary steps with product-wide unit labels", () => {
		expect(formatBytes(0)).toBe("0B");
		expect(formatBytes(512)).toBe("512B");
		expect(formatBytes(1024)).toBe("1.0KB");
		expect(formatBytes(1536)).toBe("1.5KB");
		expect(formatBytes(2.3 * 1024 * 1024)).toBe("2.3MB");
		expect(formatBytes(1.2 * 1024 * 1024 * 1024)).toBe("1.2GB");
	});

	// Regression lock: NaN/Infinity previously fell through to the GB branch and
	// rendered "NaNGB"/"InfinityGB". They now return "0B", matching the house
	// non-finite convention. Signed negatives keep their sign.
	it("renders non-finite input as 0B and keeps signed negatives", () => {
		expect(formatBytes(Number.NaN)).toBe("0B");
		expect(formatBytes(Number.POSITIVE_INFINITY)).toBe("0B");
		expect(formatBytes(Number.NEGATIVE_INFINITY)).toBe("0B");
		expect(formatBytes(-512)).toBe("-512B");
	});
});

describe("formatCount and pluralize", () => {
	it("pluralizes with s/es/ies rules and keeps singular at exactly 1", () => {
		expect(formatCount("file", 0)).toBe("0 files");
		expect(formatCount("file", 1)).toBe("1 file");
		expect(formatCount("file", 3)).toBe("3 files");
		expect(pluralize("match", 2)).toBe("matches");
		expect(pluralize("brush", 2)).toBe("brushes");
		expect(pluralize("class", 2)).toBe("classes");
		expect(pluralize("box", 2)).toBe("boxes");
		expect(pluralize("quiz", 2)).toBe("quizes");
		expect(pluralize("entry", 2)).toBe("entries");
		expect(pluralize("day", 2)).toBe("days");
	});

	it("treats a non-finite count as 0 instead of rendering NaN", () => {
		expect(formatCount("file", Number.NaN)).toBe("0 files");
		expect(formatCount("file", Number.POSITIVE_INFINITY)).toBe("0 files");
	});
});

describe("formatAge", () => {
	it("scales from just now to months and returns empty for missing input", () => {
		expect(formatAge(null)).toBe("");
		expect(formatAge(undefined)).toBe("");
		expect(formatAge(0)).toBe("");
		expect(formatAge(30)).toBe("just now");
		expect(formatAge(120)).toBe("2m ago");
		expect(formatAge(2 * 3600)).toBe("2h ago");
		expect(formatAge(3 * 86_400)).toBe("3d ago");
		expect(formatAge(14 * 86_400)).toBe("2w ago");
		expect(formatAge(90 * 86_400)).toBe("3mo ago");
	});

	// Regression lock: a negative age (a future timestamp from bad data or clock
	// skew) previously fell through every `> 0` branch and returned "just now",
	// mislabeling a future-dated item as freshly published. formatAge now treats
	// a negative age as unknown ("") like its sibling renderers. If the `< 0`
	// guard is removed, these fall back to "just now" and fail.
	it("returns empty for a negative (future) age instead of 'just now'", () => {
		expect(formatAge(-1)).toBe("");
		expect(formatAge(-30)).toBe("");
		expect(formatAge(-90 * 86_400)).toBe("");
		expect(formatAge(Number.NEGATIVE_INFINITY)).toBe("");
	});
});

describe("formatPercent", () => {
	it("renders a ratio with one decimal", () => {
		expect(formatPercent(0)).toBe("0.0%");
		expect(formatPercent(0.1234)).toBe("12.3%");
		expect(formatPercent(1)).toBe("100.0%");
	});

	// A ratio above 1 is a legitimate above-100% value and must not be clamped.
	it("renders above-100% ratios without clamping", () => {
		expect(formatPercent(1.5)).toBe("150.0%");
	});

	// Regression lock: a 0/0 ratio is NaN and previously rendered "NaN%". It now
	// returns "0.0%", matching the house non-finite convention.
	it("renders non-finite input as 0.0%", () => {
		expect(formatPercent(Number.NaN)).toBe("0.0%");
		expect(formatPercent(Number.POSITIVE_INFINITY)).toBe("0.0%");
		expect(formatPercent(0 / 0)).toBe("0.0%");
	});
});
