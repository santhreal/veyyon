import { beforeAll, describe, expect, it } from "bun:test";
import type { SegmentContext } from "@veyyon/coding-agent/modes/terminal/components/status-line/segments";
import { renderSegment } from "@veyyon/coding-agent/modes/terminal/components/status-line/segments";
import { initTheme, theme } from "@veyyon/coding-agent/theme/theme";
import { normalizeApprovalMode } from "@veyyon/coding-agent/tools/core/approval";
import { AUTONOMY_LABEL, DEFAULT_APPROVAL_MODE } from "@veyyon/coding-agent/tools/core/approval-modes";
import { NO_SESSION_FACTS } from "../src/modes/terminal/components/status-line/session-facts";

beforeAll(async () => {
	await initTheme();
});

/**
 * Minimal SegmentContext for the mode segment. `bypassed` drives the `/yolo`
 * fact; `goalMode` optionally exercises the compose path where YOLO prefixes an
 * active mode instead of replacing it.
 */
function createModeContext(opts: {
	bypassed: boolean;
	goalMode?: { enabled: boolean; paused: boolean };
}): SegmentContext {
	return {
		facts: {
			...NO_SESSION_FACTS,
			approvalBypassed: opts.bypassed,
			goal: opts.goalMode
				? {
						id: "g",
						objective: "o",
						status: "active",
						tokensUsed: 0,
						timeUsedSeconds: 0,
						turnsCompleted: 0,
						createdAt: 0,
						updatedAt: 0,
					}
				: null,
		},
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
		contextWindow: 0,
		contextLimit: 0,
		contextLimitKind: "window" as const,
		autoCompactEnabled: false,
		subagentCount: 0,
		backgroundSessionCount: 0,
		activeMs: 0,
		activeRepo: null,
		worktree: null,
		git: { branch: null, status: null, pr: null },
		account: null,
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

	/**
	 * The segment used to render NOTHING here, and that absence is the bug this
	 * case now locks out. With no mode active, the approval rung is the only
	 * thing the mode segment has to say, and it is the one piece of session state
	 * whose absence is dangerous rather than merely unknown: an operator who
	 * cannot see it has to guess whether the next command will ask.
	 *
	 * The expected label is DERIVED from the shipped default rather than typed
	 * out, so moving `DEFAULT_APPROVAL_MODE` moves this assertion with it instead
	 * of turning a deliberate product decision into a failing status-line test.
	 */
	it("names the approval rung when the bypass is off and no mode is active", () => {
		const rendered = renderSegment("mode", createModeContext({ bypassed: false }));
		expect(rendered.visible).toBe(true);
		expect(Bun.stripANSI(rendered.content)).toBe(AUTONOMY_LABEL[normalizeApprovalMode(DEFAULT_APPROVAL_MODE)]);
	});

	/**
	 * The bypass REPLACES the rung rather than sitting beside it. Naming both
	 * would name a rung that is not being enforced, which is worse than naming
	 * none: the bypass outranks the configured rung entirely.
	 */
	it("does not name the rung alongside the bypass marker", () => {
		const rendered = renderSegment("mode", createModeContext({ bypassed: true }));
		expect(Bun.stripANSI(rendered.content)).not.toContain(
			AUTONOMY_LABEL[normalizeApprovalMode(DEFAULT_APPROVAL_MODE)],
		);
	});
});
