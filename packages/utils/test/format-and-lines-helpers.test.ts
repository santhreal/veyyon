import { describe, expect, it } from "bun:test";
import {
	formatAge,
	formatBytes,
	formatClock,
	formatCount,
	formatDuration,
	formatMoreLines,
	formatNumber,
	formatPercent,
	pluralize,
	truncate,
} from "../src/format";
import { splitTextLines } from "../src/lines";

describe("splitTextLines", () => {
	it("splits simple multiline text", () => {
		expect(splitTextLines("a\nb\nc")).toEqual(["a", "b", "c"]);
	});
	it("filters trailing empty line from final newline", () => {
		expect(splitTextLines("a\nb\n")).toEqual(["a", "b"]);
	});
	it("preserves internal empty lines", () => {
		expect(splitTextLines("a\n\nb")).toEqual(["a", "", "b"]);
	});
	it("handles single line", () => {
		expect(splitTextLines("hello")).toEqual(["hello"]);
	});
	it("handles empty string", () => {
		expect(splitTextLines("")).toEqual([]);
	});
	it("handles only newlines", () => {
		expect(splitTextLines("\n\n\n")).toEqual(["", "", ""]);
	});
});

describe("formatDuration", () => {
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
	it("formats milliseconds", () => {
		expect(formatDuration(500)).toBe("500ms");
	});
	it("formats seconds with one decimal", () => {
		expect(formatDuration(1500)).toBe("1.5s");
	});
	it("formats exact seconds", () => {
		expect(formatDuration(10000)).toBe("10.0s");
	});
	it("formats minutes without seconds", () => {
		expect(formatDuration(120000)).toBe("2m");
	});
	it("formats minutes with seconds", () => {
		expect(formatDuration(150000)).toBe("2m30s");
	});
	it("formats hours without minutes", () => {
		expect(formatDuration(7200000)).toBe("2h");
	});
	it("formats hours with minutes", () => {
		expect(formatDuration(7800000)).toBe("2h10m");
	});
	it("formats days without hours", () => {
		expect(formatDuration(86400000)).toBe("1d");
	});
	it("formats days with hours", () => {
		expect(formatDuration(90000000)).toBe("1d1h");
	});
});

describe("formatClock", () => {
	it("formats seconds only", () => {
		expect(formatClock(30000)).toBe("0:30");
	});
	it("formats minutes and seconds", () => {
		expect(formatClock(90000)).toBe("1:30");
	});
	it("formats hours minutes seconds", () => {
		expect(formatClock(3723000)).toBe("1:02:03");
	});
	it("formats zero", () => {
		expect(formatClock(0)).toBe("0:00");
	});
	it("handles NaN", () => {
		expect(formatClock(Number.NaN)).toBe("0:00");
	});
	it("handles negative", () => {
		expect(formatClock(-1000)).toBe("0:00");
	});
	it("pads single digit seconds", () => {
		expect(formatClock(5000)).toBe("0:05");
	});
	it("pads single digit minutes", () => {
		expect(formatClock(3600000)).toBe("1:00:00");
	});
});

describe("formatNumber", () => {
	it("returns 0 for NaN", () => {
		expect(formatNumber(Number.NaN)).toBe("0");
	});
	it("returns 0 for Infinity", () => {
		expect(formatNumber(Number.POSITIVE_INFINITY)).toBe("0");
	});
	it("returns number as-is below 1000", () => {
		expect(formatNumber(999)).toBe("999");
	});
	it("formats thousands with K suffix", () => {
		expect(formatNumber(1500)).toBe("1.5K");
	});
	it("formats 10000 as 10K", () => {
		expect(formatNumber(10000)).toBe("10K");
	});
	it("formats millions with M suffix", () => {
		expect(formatNumber(1500000)).toBe("1.5M");
	});
	it("formats billions with B suffix", () => {
		expect(formatNumber(1500000000)).toBe("1.5B");
	});
	it("formats exact 1000 as 1K", () => {
		expect(formatNumber(1000)).toBe("1K");
	});
	it("formats 999000 as 999K", () => {
		expect(formatNumber(999000)).toBe("999K");
	});
	it("formats 1000000 as 1M", () => {
		expect(formatNumber(1000000)).toBe("1M");
	});
});

describe("formatBytes", () => {
	it("returns 0B for NaN", () => {
		expect(formatBytes(Number.NaN)).toBe("0B");
	});
	it("returns negative bytes for negative input", () => {
		expect(formatBytes(-1)).toBe("-1B");
	});
	it("formats bytes below 1024", () => {
		expect(formatBytes(512)).toBe("512B");
	});
	it("formats kilobytes", () => {
		expect(formatBytes(1536)).toBe("1.5KB");
	});
	it("formats megabytes", () => {
		expect(formatBytes(1048576)).toBe("1.0MB");
	});
	it("formats gigabytes", () => {
		expect(formatBytes(1073741824)).toBe("1.0GB");
	});
	it("formats 0 bytes", () => {
		expect(formatBytes(0)).toBe("0B");
	});
	it("formats 1023 bytes as B", () => {
		expect(formatBytes(1023)).toBe("1023B");
	});
});

describe("truncate", () => {
	it("returns string as-is when within maxLen", () => {
		expect(truncate("hello", 10)).toBe("hello");
	});
	it("truncates string exceeding maxLen", () => {
		expect(truncate("hello world", 8)).toBe("hello w…");
	});
	it("uses custom ellipsis", () => {
		expect(truncate("hello world", 8, "...")).toBe("hello...");
	});
	it("handles maxLen of 0", () => {
		expect(truncate("hello", 0)).toBe("…");
	});
	it("handles string exactly at maxLen", () => {
		expect(truncate("hello", 5)).toBe("hello");
	});
	it("handles empty string", () => {
		expect(truncate("", 5)).toBe("");
	});
	it("handles unicode characters", () => {
		expect(truncate("你好世界你好世界", 5)).toBe("你好世界…");
	});
});

describe("formatCount", () => {
	it("formats singular label", () => {
		expect(formatCount("file", 1)).toBe("1 file");
	});
	it("formats plural label", () => {
		expect(formatCount("file", 5)).toBe("5 files");
	});
	it("handles zero count", () => {
		expect(formatCount("file", 0)).toBe("0 files");
	});
	it("handles NaN count", () => {
		expect(formatCount("file", Number.NaN)).toBe("0 files");
	});
});

describe("formatAge", () => {
	it("returns empty string for null", () => {
		expect(formatAge(null)).toBe("");
	});
	it("returns empty string for undefined", () => {
		expect(formatAge(undefined)).toBe("");
	});
	it("returns empty string for zero", () => {
		expect(formatAge(0)).toBe("");
	});
	it("returns empty string for negative", () => {
		expect(formatAge(-1)).toBe("");
	});
	it("returns 'just now' for less than a minute", () => {
		expect(formatAge(30)).toBe("just now");
	});
	it("returns minutes ago", () => {
		expect(formatAge(120)).toBe("2m ago");
	});
	it("returns hours ago", () => {
		expect(formatAge(7200)).toBe("2h ago");
	});
	it("returns days ago", () => {
		expect(formatAge(172800)).toBe("2d ago");
	});
	it("returns weeks ago", () => {
		expect(formatAge(604800 * 2)).toBe("2w ago");
	});
	it("returns months ago", () => {
		expect(formatAge(2592000 * 2)).toBe("2mo ago");
	});
});

describe("pluralize", () => {
	it("returns singular for count 1", () => {
		expect(pluralize("file", 1)).toBe("file");
	});
	it("adds s for regular plural", () => {
		expect(pluralize("file", 5)).toBe("files");
	});
	it("adds es for words ending in ch", () => {
		expect(pluralize("match", 2)).toBe("matches");
	});
	it("adds es for words ending in sh", () => {
		expect(pluralize("brush", 2)).toBe("brushes");
	});
	it("adds es for words ending in s", () => {
		expect(pluralize("bus", 2)).toBe("buses");
	});
	it("adds es for words ending in x", () => {
		expect(pluralize("box", 2)).toBe("boxes");
	});
	it("adds es for words ending in z", () => {
		expect(pluralize("buzz", 2)).toBe("buzzes");
	});
	it("changes y to ies for consonant+y", () => {
		expect(pluralize("city", 2)).toBe("cities");
	});
	it("adds s for vowel+y", () => {
		expect(pluralize("day", 2)).toBe("days");
	});
	it("handles zero count", () => {
		expect(pluralize("file", 0)).toBe("files");
	});
});

describe("formatMoreLines", () => {
	it("formats singular line", () => {
		expect(formatMoreLines(1)).toBe("1 more line");
	});
	it("formats plural lines", () => {
		expect(formatMoreLines(5)).toBe("5 more lines");
	});
});

describe("formatPercent", () => {
	it("formats ratio as percent", () => {
		expect(formatPercent(0.5)).toBe("50.0%");
	});
	it("formats 1 as 100%", () => {
		expect(formatPercent(1)).toBe("100.0%");
	});
	it("formats 0 as 0%", () => {
		expect(formatPercent(0)).toBe("0.0%");
	});
	it("handles NaN", () => {
		expect(formatPercent(Number.NaN)).toBe("0.0%");
	});
	it("handles Infinity", () => {
		expect(formatPercent(Number.POSITIVE_INFINITY)).toBe("0.0%");
	});
	it("formats decimal percent", () => {
		expect(formatPercent(0.123)).toBe("12.3%");
	});
});
