import { beforeAll, describe, expect, it } from "bun:test";
import type { SegmentContext } from "@veyyon/coding-agent/modes/components/status-line/segments";
import { renderSegment } from "@veyyon/coding-agent/modes/components/status-line/segments";
import { initTheme, theme } from "@veyyon/coding-agent/modes/theme/theme";

beforeAll(async () => {
	await initTheme();
});

/**
 * Minimal SegmentContext for the mode segment. `bypassed` drives
 * `session.isApprovalBypassed()`; `goalMode` optionally exercises the compose
 * path where YOLO prefixes an active mode instead of replacing it.
 */
function createModeContext(opts: {
	bypassed: boolean;
	goalMode?: { enabled: boolean; paused: boolean };
}): SegmentContext {
	return {
		session: {
			isApprovalBypassed: () => opts.bypassed,
			getGoalModeState: () => (opts.goalMode ? { goal: { status: "active", tokensUsed: 0 } } : undefined),
			settings: { get: () => false },
		} as unknown as SegmentContext["session"],
		width: 120,
		compactThinkingLevel: false,
		options: {},
		planMode: null,
		loopMode: null,
		prewalk: null,
		goalMode: opts.goalMode ?? null,
		vibeMode: null,
		collab: null,
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
		},
		contextPercent: 0,
		contextTokens: 0,
		contextWindow: 0,
		autoCompactEnabled: false,
		subagentCount: 0,
		activeMs: 0,
		activeRepo: null,
		worktree: null,
		git: { branch: null, status: null, pr: null },
		usage: null,
	};
}

describe("status line mode segment YOLO bypass marker", () => {
	it("shows a red YOLO marker when the full bypass is active", () => {
		const rendered = renderSegment("mode", createModeContext({ bypassed: true }));
		expect(rendered.visible).toBe(true);
		expect(Bun.stripANSI(rendered.content)).toBe(`${theme.symbol("status.warning")} YOLO`);
		// The marker carries the error color, so "all prompts off" reads as danger.
		expect(rendered.content).toContain(theme.fg("error", `${theme.symbol("status.warning")} YOLO`));
	});

	it("prefixes the YOLO marker onto an active mode rather than replacing it", () => {
		const rendered = renderSegment(
			"mode",
			createModeContext({ bypassed: true, goalMode: { enabled: true, paused: false } }),
		);
		const plain = Bun.stripANSI(rendered.content);
		expect(plain.startsWith(`${theme.symbol("status.warning")} YOLO`)).toBe(true);
		// The underlying Goal label is still present, not clobbered.
		expect(plain).toContain("Goal");
	});

	it("renders nothing when the bypass is off and no mode is active", () => {
		const rendered = renderSegment("mode", createModeContext({ bypassed: false }));
		expect(rendered.visible).toBe(false);
		expect(rendered.content).toBe("");
	});
});
