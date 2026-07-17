import { describe, expect, it } from "bun:test";
import {
	formatBytes,
	formatCost,
	formatDuration,
	formatPercent,
	kebabSlug,
	safeFilenameSegment,
	safeFilenameSegmentCollapsed,
} from "@veyyon/pi-utils/format";

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

// Product-wide display contract for costs/percents/bytes (DEDUP-FMT-CLIENT):
// the CLI stats surface and the browser dashboard both import these owners,
// so the exact output bytes are the contract.
describe("formatCost", () => {
	it("scales precision to magnitude with an exact-zero special", () => {
		expect(formatCost(0)).toBe("$0");
		expect(formatCost(0.0042)).toBe("$0.0042");
		expect(formatCost(0.123)).toBe("$0.123");
		expect(formatCost(1.25)).toBe("$1.25");
		expect(formatCost(0.01)).toBe("$0.010");
		expect(formatCost(1)).toBe("$1.00");
	});

	it("pins fraction digits when digits is passed, except exact zero", () => {
		expect(formatCost(0.5, 2)).toBe("$0.50");
		expect(formatCost(0.000123, 4)).toBe("$0.0001");
		expect(formatCost(0, 4)).toBe("$0");
	});
});

describe("formatPercent", () => {
	it("renders a ratio with 1 decimal by default and honors digits", () => {
		expect(formatPercent(0.125)).toBe("12.5%");
		expect(formatPercent(0)).toBe("0.0%");
		expect(formatPercent(1)).toBe("100.0%");
		expect(formatPercent(0.125, 0)).toBe("13%");
		expect(formatPercent(0.12345, 2)).toBe("12.35%");
	});
});

describe("formatBytes", () => {
	it("uses binary units without a space", () => {
		expect(formatBytes(512)).toBe("512B");
		expect(formatBytes(1024)).toBe("1.0KB");
		expect(formatBytes(1536)).toBe("1.5KB");
		expect(formatBytes(5 * 1024 * 1024)).toBe("5.0MB");
		expect(formatBytes(3 * 1024 * 1024 * 1024)).toBe("3.0GB");
	});
});

describe("kebabSlug", () => {
	it("lowercases, collapses non-alphanumerics to single hyphens, trims edges", () => {
		expect(kebabSlug("Fix: The (URL) Parser!")).toBe("fix-the-url-parser");
		expect(kebabSlug("  spaced  out  ")).toBe("spaced-out");
		expect(kebabSlug("Already-Kebab")).toBe("already-kebab");
		expect(kebabSlug("___")).toBe("");
		expect(kebabSlug("")).toBe("");
	});
});

describe("safeFilenameSegment", () => {
	it("replaces every non-[A-Za-z0-9._-] char with an underscore, preserving case", () => {
		expect(safeFilenameSegment("^18.2.0 <19")).toBe("_18.2.0__19");
		expect(safeFilenameSegment("Kokoro-v1.0_int8")).toBe("Kokoro-v1.0_int8");
		expect(safeFilenameSegment("a/b\\c:d")).toBe("a_b_c_d");
		expect(safeFilenameSegment("")).toBe("");
	});
});

describe("safeFilenameSegmentCollapsed", () => {
	it("collapses each run of non-[A-Za-z0-9._-] chars into one underscore", () => {
		expect(safeFilenameSegmentCollapsed("a//b")).toBe("a_b");
		expect(safeFilenameSegmentCollapsed("^18.2.0 <19")).toBe("_18.2.0_19");
		expect(safeFilenameSegmentCollapsed("packages/agent/src")).toBe("packages_agent_src");
		expect(safeFilenameSegmentCollapsed("Kokoro-v1.0_int8")).toBe("Kokoro-v1.0_int8");
		expect(safeFilenameSegmentCollapsed("")).toBe("");
	});
});
