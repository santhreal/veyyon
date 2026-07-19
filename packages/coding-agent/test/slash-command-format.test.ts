import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as settingsModule from "@veyyon/coding-agent/config/settings";
import type { Theme } from "@veyyon/coding-agent/modes/theme/theme";
import { formatDurationCoarse, renderAsciiBar } from "@veyyon/coding-agent/slash-commands/helpers/format";

const testTheme = {
	fg(color: Parameters<Theme["fg"]>[0], text: string): string {
		const codes = {
			accent: "\x1b[36m",
			dim: "\x1b[2m",
			muted: "\x1b[90m",
		};
		return `${codes[color as "accent" | "dim" | "muted"] ?? ""}${text}\x1b[39m`;
	},
	bold(text: string): string {
		return `\x1b[1m${text}\x1b[22m`;
	},
	getFgAnsi(color: Parameters<Theme["fg"]>[0]): string {
		const codes = {
			accent: "\x1b[36m",
			dim: "\x1b[2m",
			muted: "\x1b[90m",
		};
		return codes[color as "accent" | "dim" | "muted"] ?? "";
	},
};

// 30 cells/s with classic padding 10 positions the crest on the first cell.
const CLASSIC_CREST_VISIBLE_MS = 333;

describe("renderAsciiBar", () => {
	beforeEach(() => {
		vi.spyOn(settingsModule, "isSettingsInitialized").mockReturnValue(false);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("preserves the visible progress-bar contract", () => {
		vi.spyOn(Date, "now").mockReturnValue(CLASSIC_CREST_VISIBLE_MS);

		const rendered = renderAsciiBar(0.5, 4, testTheme);

		expect(Bun.stripANSI(rendered)).toBe("[██░░] 50%");
	});

	it("colors the shimmer band with the theme accent", () => {
		vi.spyOn(Date, "now").mockReturnValue(CLASSIC_CREST_VISIBLE_MS);

		const rendered = renderAsciiBar(undefined, 4, testTheme);

		expect(rendered).toContain("\x1b[36m");
		expect(Bun.stripANSI(rendered)).toBe("[····]");
	});

	it("renders the empty and full bars at 0% and 100%", () => {
		vi.spyOn(Date, "now").mockReturnValue(CLASSIC_CREST_VISIBLE_MS);
		expect(Bun.stripANSI(renderAsciiBar(0, 4, testTheme))).toBe("[░░░░] 0%");
		expect(Bun.stripANSI(renderAsciiBar(1, 4, testTheme))).toBe("[████] 100%");
	});

	it("clamps out-of-range fractions to [0, 1] instead of overflowing the bar", () => {
		vi.spyOn(Date, "now").mockReturnValue(CLASSIC_CREST_VISIBLE_MS);
		// A negative fraction collapses to empty, and a >1 fraction saturates full;
		// the fill count never exceeds the width in either direction.
		expect(Bun.stripANSI(renderAsciiBar(-0.5, 4, testTheme))).toBe("[░░░░] 0%");
		expect(Bun.stripANSI(renderAsciiBar(1.5, 4, testTheme))).toBe("[████] 100%");
	});

	it("rounds the fill count and the percent independently", () => {
		vi.spyOn(Date, "now").mockReturnValue(CLASSIC_CREST_VISIBLE_MS);
		// 0.375 * 4 = 1.5 fill cells, rounded to 2; 37.5% rounds to 38.
		expect(Bun.stripANSI(renderAsciiBar(0.375, 4, testTheme))).toBe("[██░░] 38%");
	});

	it("defaults to a 24-cell bar when no width is given", () => {
		vi.spyOn(Date, "now").mockReturnValue(CLASSIC_CREST_VISIBLE_MS);
		expect(Bun.stripANSI(renderAsciiBar(0.5, undefined, testTheme))).toBe("[████████████░░░░░░░░░░░░] 50%");
	});
});

describe("formatDurationCoarse", () => {
	it("renders seconds below a minute, rounding milliseconds to whole seconds", () => {
		expect(formatDurationCoarse(0)).toBe("0s");
		expect(formatDurationCoarse(499)).toBe("0s");
		expect(formatDurationCoarse(500)).toBe("1s");
		expect(formatDurationCoarse(59_400)).toBe("59s");
	});

	it("clamps a negative duration to 0s rather than emitting a negative label", () => {
		expect(formatDurationCoarse(-5_000)).toBe("0s");
	});

	it("switches to the next unit when rounding pushes a field to its ceiling", () => {
		// 59.5s rounds up to 60s, which is one minute, not "60s".
		expect(formatDurationCoarse(59_500)).toBe("1m");
		expect(formatDurationCoarse(60_000)).toBe("1m");
		// 90s is 1.5 minutes, which rounds up to 2m.
		expect(formatDurationCoarse(90_000)).toBe("2m");
		expect(formatDurationCoarse(3_560_000)).toBe("59m");
	});

	it("uses hours from one hour up to but not including 48h, then switches to days", () => {
		expect(formatDurationCoarse(3_600_000)).toBe("1h");
		// A full day still reads as 24h, because the switch to days is at 48h.
		expect(formatDurationCoarse(86_400_000)).toBe("24h");
		expect(formatDurationCoarse(169_200_000)).toBe("47h");
		expect(formatDurationCoarse(172_800_000)).toBe("2d");
	});
});
