import { describe, expect, it } from "bun:test";
import { isProbablyBinaryHeader } from "../src/binary";
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

describe("formatDuration", () => {
	it("returns 0ms for 0", () => {
		expect(formatDuration(0)).toBe("0ms");
	});

	it("returns 0ms for negative", () => {
		expect(formatDuration(-100)).toBe("0ms");
	});

	it("returns 0ms for NaN", () => {
		expect(formatDuration(NaN)).toBe("0ms");
	});

	it("returns 0ms for Infinity", () => {
		expect(formatDuration(Infinity)).toBe("0ms");
	});

	it("formats milliseconds", () => {
		expect(formatDuration(500)).toBe("500ms");
	});

	it("formats seconds with one decimal", () => {
		expect(formatDuration(1500)).toBe("1.5s");
	});

	it("formats exact seconds", () => {
		expect(formatDuration(1000)).toBe("1.0s");
	});

	it("formats minutes with seconds", () => {
		expect(formatDuration(90_000)).toBe("1m30s");
	});

	it("formats exact minutes", () => {
		expect(formatDuration(60_000)).toBe("1m");
	});

	it("formats hours", () => {
		expect(formatDuration(3_600_000)).toBe("1h");
	});

	it("formats days and hours", () => {
		expect(formatDuration(90_000_000)).toBe("1d1h");
	});

	it("formats days only", () => {
		expect(formatDuration(172_800_000)).toBe("2d");
	});
});

describe("formatClock", () => {
	it("formats seconds only", () => {
		expect(formatClock(30_000)).toBe("0:30");
	});

	it("formats minutes and seconds", () => {
		expect(formatClock(90_000)).toBe("1:30");
	});

	it("formats hours, minutes, seconds", () => {
		expect(formatClock(3_661_000)).toBe("1:01:01");
	});

	it("formats zero", () => {
		expect(formatClock(0)).toBe("0:00");
	});

	it("formats NaN as 0:00", () => {
		expect(formatClock(NaN)).toBe("0:00");
	});

	it("formats negative as 0:00", () => {
		expect(formatClock(-1000)).toBe("0:00");
	});

	it("pads single digit seconds", () => {
		expect(formatClock(5000)).toBe("0:05");
	});

	it("pads single digit minutes", () => {
		expect(formatClock(3_600_000)).toBe("1:00:00");
	});
});

describe("formatNumber", () => {
	it("returns small numbers as-is", () => {
		expect(formatNumber(42)).toBe("42");
	});

	it("returns 0 for NaN", () => {
		expect(formatNumber(NaN)).toBe("0");
	});

	it("returns 0 for Infinity", () => {
		expect(formatNumber(Infinity)).toBe("0");
	});

	it("formats thousands with K", () => {
		expect(formatNumber(1500)).toBe("1.5K");
	});

	it("formats 9999 as 10K (rounds up)", () => {
		expect(formatNumber(9999)).toBe("10K");
	});

	it("formats 10000 as 10K", () => {
		expect(formatNumber(10_000)).toBe("10K");
	});

	it("formats 100000 as 100K", () => {
		expect(formatNumber(100_000)).toBe("100K");
	});

	it("formats 999999 as 1M", () => {
		expect(formatNumber(999_999)).toBe("1M");
	});

	it("formats millions", () => {
		expect(formatNumber(1_500_000)).toBe("1.5M");
	});

	it("formats 10M as 10M", () => {
		expect(formatNumber(10_000_000)).toBe("10M");
	});

	it("formats 999M as 999M", () => {
		expect(formatNumber(999_000_000)).toBe("999M");
	});

	it("formats billions", () => {
		expect(formatNumber(1_500_000_000)).toBe("1.5B");
	});

	it("formats 10B as 10B", () => {
		expect(formatNumber(10_000_000_000)).toBe("10B");
	});

	it("formats 100B as 100B", () => {
		expect(formatNumber(100_000_000_000)).toBe("100B");
	});

	it("trims .0 from K", () => {
		expect(formatNumber(2000)).toBe("2K");
	});
});

describe("formatBytes", () => {
	it("formats bytes", () => {
		expect(formatBytes(500)).toBe("500B");
	});

	it("formats 0B", () => {
		expect(formatBytes(0)).toBe("0B");
	});

	it("returns 0B for NaN", () => {
		expect(formatBytes(NaN)).toBe("0B");
	});

	it("formats KB", () => {
		expect(formatBytes(2048)).toBe("2.0KB");
	});

	it("formats MB", () => {
		expect(formatBytes(1_048_576)).toBe("1.0MB");
	});

	it("formats GB", () => {
		expect(formatBytes(1_073_741_824)).toBe("1.0GB");
	});

	it("formats 1023 as B", () => {
		expect(formatBytes(1023)).toBe("1023B");
	});
});

describe("truncate", () => {
	it("returns string unchanged when under max", () => {
		expect(truncate("hello", 10)).toBe("hello");
	});

	it("returns string unchanged when equal to max", () => {
		expect(truncate("hello", 5)).toBe("hello");
	});

	it("truncates with default ellipsis", () => {
		expect(truncate("hello world", 8)).toBe("hello w…");
	});

	it("truncates with custom ellipsis", () => {
		expect(truncate("hello world", 8, "...")).toBe("hello...");
	});

	it("handles empty string", () => {
		expect(truncate("", 10)).toBe("");
	});

	it("handles maxLen of 0", () => {
		expect(truncate("hello", 0)).toBe("…");
	});

	it("handles multi-byte characters", () => {
		expect(truncate("你好世界你好世界", 5)).toBe("你好世界…");
	});
});

describe("formatCount", () => {
	it("formats count with singular label", () => {
		expect(formatCount("item", 1)).toBe("1 item");
	});

	it("formats count with plural label", () => {
		expect(formatCount("item", 5)).toBe("5 items");
	});

	it("formats NaN count as 0", () => {
		expect(formatCount("item", NaN)).toBe("0 items");
	});

	it("formats Infinity count as 0", () => {
		expect(formatCount("item", Infinity)).toBe("0 items");
	});

	it("formats zero count", () => {
		expect(formatCount("item", 0)).toBe("0 items");
	});
});

describe("formatAge", () => {
	it("returns empty for null", () => {
		expect(formatAge(null)).toBe("");
	});

	it("returns empty for undefined", () => {
		expect(formatAge(undefined)).toBe("");
	});

	it("returns empty for 0", () => {
		expect(formatAge(0)).toBe("");
	});

	it("returns empty for negative", () => {
		expect(formatAge(-10)).toBe("");
	});

	it("returns just now for less than a minute", () => {
		expect(formatAge(30)).toBe("just now");
	});

	it("formats minutes", () => {
		expect(formatAge(120)).toBe("2m ago");
	});

	it("formats hours", () => {
		expect(formatAge(7200)).toBe("2h ago");
	});

	it("formats days", () => {
		expect(formatAge(172_800)).toBe("2d ago");
	});

	it("formats weeks", () => {
		expect(formatAge(14 * 24 * 3600)).toBe("2w ago");
	});

	it("formats months", () => {
		expect(formatAge(60 * 24 * 3600)).toBe("2mo ago");
	});
});

describe("pluralize", () => {
	it("returns singular for count 1", () => {
		expect(pluralize("item", 1)).toBe("item");
	});

	it("adds s for regular plural", () => {
		expect(pluralize("item", 2)).toBe("items");
	});

	it("adds es for words ending in ch", () => {
		expect(pluralize("match", 2)).toBe("matches");
	});

	it("adds es for words ending in sh", () => {
		expect(pluralize("wish", 2)).toBe("wishes");
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
		expect(pluralize("entry", 2)).toBe("entries");
	});

	it("adds s for vowel+y", () => {
		expect(pluralize("day", 2)).toBe("days");
	});

	it("adds s for 0 count", () => {
		expect(pluralize("item", 0)).toBe("items");
	});
});

describe("formatMoreLines", () => {
	it("formats singular line", () => {
		expect(formatMoreLines(1)).toBe("1 more line");
	});

	it("formats plural lines", () => {
		expect(formatMoreLines(5)).toBe("5 more lines");
	});

	it("formats zero lines", () => {
		expect(formatMoreLines(0)).toBe("0 more lines");
	});
});

describe("formatPercent", () => {
	it("formats ratio as percent", () => {
		expect(formatPercent(0.5)).toBe("50.0%");
	});

	it("formats 0 ratio", () => {
		expect(formatPercent(0)).toBe("0.0%");
	});

	it("formats 1 ratio", () => {
		expect(formatPercent(1)).toBe("100.0%");
	});

	it("formats NaN as 0.0%", () => {
		expect(formatPercent(NaN)).toBe("0.0%");
	});

	it("formats Infinity as 0.0%", () => {
		expect(formatPercent(Infinity)).toBe("0.0%");
	});

	it("formats small ratio", () => {
		expect(formatPercent(0.123)).toBe("12.3%");
	});
});

describe("isProbablyBinaryHeader", () => {
	it("returns true for header with NUL byte", () => {
		expect(isProbablyBinaryHeader(new Uint8Array([0x68, 0x00, 0x65]))).toBe(true);
	});

	it("returns false for valid UTF-8 text", () => {
		expect(isProbablyBinaryHeader(new TextEncoder().encode("hello world"))).toBe(false);
	});

	it("returns false for empty header", () => {
		expect(isProbablyBinaryHeader(new Uint8Array([]))).toBe(false);
	});

	it("returns true for invalid UTF-8 sequence", () => {
		// 0xFF is not valid UTF-8 start byte
		expect(isProbablyBinaryHeader(new Uint8Array([0xff, 0xfe, 0xfd]))).toBe(true);
	});

	it("returns false for ASCII text", () => {
		expect(isProbablyBinaryHeader(new TextEncoder().encode("plain ASCII text"))).toBe(false);
	});

	it("returns false for valid multi-byte UTF-8", () => {
		expect(isProbablyBinaryHeader(new TextEncoder().encode("你好"))).toBe(false);
	});
});
