/**
 * `/context` in text mode: what the window holds, and how much room is left.
 *
 * Two contracts are pinned here, both from the CTX-GAUGE audit (2026-07-25):
 *
 *  1. The report states room LEFT, not only consumption. Consumption is what the
 *     old header gave, and the decision the reader is about to make ("do I have
 *     space for this file?") is about the remainder.
 *  2. When the per-category breakdown cannot be computed, the degraded report
 *     SAYS SO and carries the reason. It used to swallow the error and print
 *     three plain lines, which looked exactly like a healthy narrow report — a
 *     silent fallback on the one surface whose whole job is to explain where the
 *     context went.
 *
 * Token counts are also formatted (`272K`, not `272000`) so the header reads at
 * a glance, matching the status-line gauge's vocabulary.
 */
import { describe, expect, it } from "bun:test";
import { buildContextReportText } from "@veyyon/coding-agent/slash-commands/helpers/context-report";
import type { SlashCommandRuntime } from "@veyyon/coding-agent/slash-commands/types";

interface FakeSessionOptions {
	contextWindow?: number;
	usedTokens?: number;
	/** Throw from getContextBreakdown to exercise the degraded path. */
	breakdownError?: string;
	usage?: { tokens: number; contextWindow: number; percent: number } | null;
}

function runtime(options: FakeSessionOptions = {}): SlashCommandRuntime {
	const contextWindow = options.contextWindow ?? 200_000;
	const usedTokens = options.usedTokens ?? 50_000;
	const session = {
		model: { id: "m", contextWindow },
		getContextBreakdown: () => {
			if (options.breakdownError) throw new Error(options.breakdownError);
			return {
				messagesTokens: 30_000,
				skillsTokens: 2_000,
				systemToolsTokens: 15_000,
				systemContextTokens: 2_000,
				systemPromptTokens: 1_000,
				usedTokens,
			};
		},
		settings: {
			getGroup: () => ({ enabled: true, strategy: "off", threshold: "auto", reserveTokens: 20_000 }),
		},
		getContextUsage: () =>
			options.usage === undefined
				? { tokens: usedTokens, contextWindow, percent: (usedTokens / contextWindow) * 100 }
				: options.usage,
	};
	return { session } as unknown as SlashCommandRuntime;
}

describe("/context report", () => {
	it("names the window and reports both used and left", () => {
		const text = buildContextReportText(runtime({ contextWindow: 200_000, usedTokens: 50_000 }));
		expect(text).toContain("Context window: 200K tokens");
		expect(text).toContain("Used: 50K (25%)");
		expect(text).toContain("Left: 150K (75%)");
	});

	/** Raw digit strings (`Context window: 272000 tokens`) made the reader count
	 * zeroes to compare against a status line that says `272K`. */
	it("formats token counts instead of printing raw digits", () => {
		const text = buildContextReportText(runtime({ contextWindow: 272_000, usedTokens: 5_000 }));
		expect(text).not.toContain("272000");
		expect(text).toContain("272K");
	});

	it("lists each non-empty category with its token count", () => {
		const text = buildContextReportText(runtime());
		expect(text).toContain("Messages");
		expect(text).toContain("30K tokens");
		expect(text).toContain("System tools");
		expect(text).toContain("15K tokens");
	});

	it("says no model is selected rather than dividing by a zero window", () => {
		expect(buildContextReportText(runtime({ contextWindow: 0 }))).toBe(
			"Context usage is unavailable: no model is selected for this session.",
		);
	});

	/** The silent-fallback regression: the degraded report must be recognisable
	 * as degraded, and must carry the reason the categories are missing. */
	it("names the reason when the breakdown cannot be computed", () => {
		const text = buildContextReportText(runtime({ breakdownError: "tokenizer unavailable" }));
		expect(text).toContain("breakdown by category unavailable");
		expect(text).toContain("tokenizer unavailable");
		expect(text).toContain("Window: 200K");
		expect(text).toContain("Used: 50K");
		expect(text).toContain("Left: 150K");
		// It must not masquerade as the healthy report.
		expect(text).not.toContain("Context window: 200K tokens");
	});

	it("reports an unknown remainder rather than inventing one without a window", () => {
		const text = buildContextReportText(
			runtime({ breakdownError: "boom", usage: { tokens: 1_000, contextWindow: 0, percent: 0 } }),
		);
		expect(text).toContain("Left: unknown");
	});

	it("surfaces the reason when there is no usage to fall back on either", () => {
		expect(buildContextReportText(runtime({ breakdownError: "boom", usage: null }))).toBe(
			"Context usage is unavailable: boom",
		);
	});
});
