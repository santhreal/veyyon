import { beforeAll, describe, expect, it } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { renderSegment } from "@veyyon/coding-agent/modes/terminal/components/status-line/segments";
import type { SegmentContext } from "@veyyon/coding-agent/modes/terminal/components/status-line/types";
import { withIcon } from "@veyyon/coding-agent/theme/icon-label";
import { initTheme } from "@veyyon/coding-agent/theme/theme";
import { theme } from "@veyyon/coding-agent/theme/theme-binding";
import { formatNumber } from "@veyyon/utils/format";
import { useFullColor } from "./helpers/theme-assertions";

beforeAll(async () => {
	await initTheme();
});

function ctxWith(usage: Partial<SegmentContext["usageStats"]>): SegmentContext {
	return {
		usageStats: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			orchestrationInput: 0,
			orchestrationOutput: 0,
			orchestrationCacheRead: 0,
			premiumRequests: 0,
			cost: 0,
			tokensPerSecond: null,
			...usage,
		},
	} as unknown as SegmentContext;
}

// ANSI is irrelevant to the rate math; strip it before asserting the number.
function plain(text: string): string {
	return stripVTControlCharacters(text);
}

describe("cache_hit status-line segment", () => {
	it("computes hit rate over the full prompt (DeepSeek miss lives in input)", () => {
		// DeepSeek: cacheRead = hit, input = miss, cacheWrite = 0.
		// 800 / (800 + 0 + 200) = 80.00%.
		const result = renderSegment("cache_hit", ctxWith({ cacheRead: 800, cacheWrite: 0, input: 200 }));
		expect(result.visible).toBe(true);
		expect(plain(result.content)).toContain("80.00%");
	});

	it("counts uncached input in the denominator alongside cacheWrite (Anthropic/OpenRouter)", () => {
		// All prompt tokens count: 600 / (600 + 300 + 100) = 60.00%.
		// (Dropping uncached input here would overstate the rate as 66.67%.)
		const result = renderSegment("cache_hit", ctxWith({ cacheRead: 600, cacheWrite: 300, input: 100 }));
		expect(result.visible).toBe(true);
		expect(plain(result.content)).toContain("60.00%");
	});

	it("is hidden until there is a cache read, even with uncached input", () => {
		const result = renderSegment("cache_hit", ctxWith({ cacheRead: 0, cacheWrite: 0, input: 5_000 }));
		expect(result.visible).toBe(false);
		expect(result.content).toBe("");
	});
});

describe("token and cache count status-line segments", () => {
	useFullColor();
	const rows = [
		["token_in", "input", () => theme.icon.input, "statusLineSpend"],
		["token_out", "output", () => theme.icon.output, "statusLineOutput"],
		["cache_read", "cacheRead", () => theme.icon.cache, "statusLineSpend"],
		["cache_write", "cacheWrite", () => theme.icon.cache, "statusLineOutput"],
	] as const;

	for (const [id, field, icon, color] of rows) {
		it(`${id} paints its own count with its icon in the ${color} color, and hides at zero`, () => {
			const others = Object.fromEntries(
				rows.filter(([otherId]) => otherId !== id).map(([, otherField]) => [otherField, 7]),
			);
			const shown = renderSegment(id, ctxWith({ ...others, [field]: 12_345 }));
			expect(shown.visible).toBe(true);
			expect(plain(shown.content)).toBe(withIcon(icon(), formatNumber(12_345)));
			expect(shown.content).toBe(theme.fg(color, withIcon(icon(), formatNumber(12_345))));
			const hidden = renderSegment(id, ctxWith({ ...others, [field]: 0 }));
			expect(hidden).toEqual({ content: "", visible: false });
		});
	}
});
