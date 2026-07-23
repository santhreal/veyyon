import { beforeAll, describe, expect, it } from "bun:test";
import type { SegmentContext } from "@veyyon/coding-agent/modes/components/status-line/segments";
import { renderSegment } from "@veyyon/coding-agent/modes/components/status-line/segments";
import { initTheme, theme } from "@veyyon/coding-agent/modes/theme/theme";

beforeAll(async () => {
	await initTheme();
});

/**
 * GMI-1/GMI-4: the goal status-line segment must always surface token progress
 * when goal state exists (repurposing `goal.statusInFooter` to control verbosity,
 * not existence), animate its icon while the agent streams under a running goal,
 * stay steady when paused, and switch to a warning treatment near the budget.
 *
 * Every assertion pins the exact rendered string (icon + label + token readout),
 * computed from the forced theme — never `!is_empty`.
 */

interface GoalState {
	status?: "active" | "paused" | "complete" | "budget-limited" | "dropped";
	tokensUsed: number;
	tokenBudget?: number;
}

function createGoalContext(opts: {
	goal?: GoalState;
	streaming?: boolean;
	verbose?: boolean;
	activeMs?: number;
	paused?: boolean;
}): SegmentContext {
	const goal = opts.goal;
	return {
		session: {
			isApprovalBypassed: () => false,
			isStreaming: opts.streaming ?? false,
			getGoalModeState: () => (goal ? { goal } : undefined),
			settings: { get: (key: string) => (key === "goal.statusInFooter" ? (opts.verbose ?? false) : false) },
		} as unknown as SegmentContext["session"],
		width: 120,
		compactThinkingLevel: false,
		options: {},
		planMode: null,
		loopMode: null,
		prewalk: null,
		goalMode: { enabled: true, paused: opts.paused ?? false },
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
		activeMs: opts.activeMs ?? 0,
		activeRepo: null,
		worktree: null,
		git: { branch: null, status: null, pr: null },
		usage: null,
	};
}

function plain(ctx: SegmentContext): string {
	return Bun.stripANSI(renderSegment("mode", ctx).content);
}

/** Mirror `withIcon`: an empty icon (some themes) drops the leading space. */
function goalLabel(icon: string, readout: string): string {
	const base = icon ? `${icon} Goal` : "Goal";
	return readout ? `${base} ${readout}` : base;
}

/** The spinner frame the segment must show for a given active-ms (period 120ms). */
function expectedSpinnerFrame(activeMs: number): string {
	const frames = theme.spinnerFrames;
	return frames[Math.floor(activeMs / 120) % frames.length] ?? theme.icon.goal;
}

describe("goal status-line segment (GMI-1)", () => {
	it("shows tokensUsed with no budget regardless of statusInFooter", () => {
		const ctx = createGoalContext({ goal: { tokensUsed: 12_345 }, verbose: false });
		// formatNumber(12_345) === "12K"; static goal icon when idle.
		expect(plain(ctx)).toBe(goalLabel(theme.icon.goal, "12K"));
	});

	it("shows used/budget + percent when a budget is set (non-verbose omits the bar)", () => {
		const ctx = createGoalContext({ goal: { tokensUsed: 20_000, tokenBudget: 50_000 }, verbose: false });
		// 20K/50K, 20000/50000 = 40%.
		expect(plain(ctx)).toBe(goalLabel(theme.icon.goal, "20K/50K 40%"));
	});

	it("appends a compact progress bar only in verbose mode", () => {
		const ctx = createGoalContext({ goal: { tokensUsed: 20_000, tokenBudget: 50_000 }, verbose: true });
		// fraction 0.4 -> round(0.4*8)=3 filled cells.
		expect(plain(ctx)).toBe(goalLabel(theme.icon.goal, "20K/50K 40% ▰▰▰▱▱▱▱▱"));
	});

	it("animates the icon while streaming under a running goal", () => {
		const activeMs = 240; // frame index floor(240/120)=2
		const ctx = createGoalContext({
			goal: { tokensUsed: 1_000, tokenBudget: 50_000 },
			streaming: true,
			activeMs,
		});
		expect(plain(ctx)).toBe(goalLabel(expectedSpinnerFrame(activeMs), "1K/50K 2%"));
	});

	it("advances the spinner frame with active-ms (steady frame is a function of active-ms only)", () => {
		const a = createGoalContext({ goal: { tokensUsed: 0, tokenBudget: 1000 }, streaming: true, activeMs: 0 });
		const b = createGoalContext({ goal: { tokensUsed: 0, tokenBudget: 1000 }, streaming: true, activeMs: 360 });
		// floor(0/120)=0 vs floor(360/120)=3 — distinct frames when the theme has >1 frame.
		if (theme.spinnerFrames.length > 1) {
			expect(plain(a)).not.toBe(plain(b));
		}
		expect(plain(a).startsWith(expectedSpinnerFrame(0))).toBe(true);
		expect(plain(b).startsWith(expectedSpinnerFrame(360))).toBe(true);
	});

	it("does NOT animate when not streaming (steady goal icon even with active-ms)", () => {
		const ctx = createGoalContext({ goal: { tokensUsed: 0, tokenBudget: 1000 }, streaming: false, activeMs: 240 });
		// 0/1000 = 0%; static goal icon despite active-ms, because not streaming.
		expect(plain(ctx)).toBe(goalLabel(theme.icon.goal, "0/1K 0%"));
	});

	it("uses a warning treatment (color + steady pause icon) when paused, even while streaming", () => {
		const ctx = createGoalContext({
			goal: { status: "paused", tokensUsed: 30_000, tokenBudget: 50_000 },
			streaming: true,
			activeMs: 240,
		});
		const icon = theme.icon.pause || theme.symbol("status.pending");
		// Paused is not "running" -> no spinner, and it keeps the token readout.
		expect(plain(ctx)).toBe(goalLabel(icon, "30K/50K 60%"));
		expect(renderSegment("mode", ctx).content).toContain(theme.fg("warning", goalLabel(icon, "30K/50K 60%")));
	});

	it("recolors to warning at ≥90% of budget while still running", () => {
		const ctx = createGoalContext({ goal: { tokensUsed: 45_000, tokenBudget: 50_000 }, streaming: false });
		// 45000/50000 = 90% -> near-budget warning, static icon (not streaming).
		expect(plain(ctx)).toBe(goalLabel(theme.icon.goal, "45K/50K 90%"));
		expect(renderSegment("mode", ctx).content).toContain(
			theme.fg("warning", goalLabel(theme.icon.goal, "45K/50K 90%")),
		);
	});

	it("stays accent-colored below the near-budget threshold", () => {
		const ctx = createGoalContext({ goal: { tokensUsed: 40_000, tokenBudget: 50_000 }, streaming: false });
		// 80% < 90% -> accent, not warning.
		expect(renderSegment("mode", ctx).content).toContain(
			theme.fg("accent", goalLabel(theme.icon.goal, "40K/50K 80%")),
		);
	});
});

describe("goal status-line segment — terminal statuses (GMI-4)", () => {
	/** A finished goal must read as DONE at a glance: success glyph + success
	 * color, never the mode accent — and it keeps the final token readout so
	 * the operator sees what the goal cost. */
	it("renders complete with the success glyph and color", () => {
		const ctx = createGoalContext({ goal: { status: "complete", tokensUsed: 48_000, tokenBudget: 50_000 } });
		const icon = theme.symbol("status.success");
		expect(plain(ctx)).toBe(goalLabel(icon, "48K/50K 96%"));
		expect(renderSegment("mode", ctx).content).toBe(theme.fg("success", goalLabel(icon, "48K/50K 96%")));
	});

	/** budget-limited is the HARD budget stop (distinct from the ≥90% soft
	 * recolor): warning glyph + warning color, so the operator knows the goal
	 * ended because the ceiling tripped, not because it finished. */
	it("renders budget-limited with the warning glyph and color", () => {
		const ctx = createGoalContext({ goal: { status: "budget-limited", tokensUsed: 50_000, tokenBudget: 50_000 } });
		const icon = theme.symbol("status.warning");
		expect(plain(ctx)).toBe(goalLabel(icon, "50K/50K 100%"));
		expect(renderSegment("mode", ctx).content).toBe(theme.fg("warning", goalLabel(icon, "50K/50K 100%")));
	});

	/** A dropped goal dims out (aborted glyph, dim color): it is history, and
	 * must not keep shouting in the accent hue. */
	it("renders dropped with the aborted glyph, dimmed", () => {
		const ctx = createGoalContext({ goal: { status: "dropped", tokensUsed: 5_000 } });
		const icon = theme.symbol("status.aborted");
		expect(plain(ctx)).toBe(goalLabel(icon, "5K"));
		expect(renderSegment("mode", ctx).content).toBe(theme.fg("dim", goalLabel(icon, "5K")));
	});

	/** Terminal statuses are not "running": the spinner must never replace
	 * their semantic glyph, even while the session streams (e.g. a follow-up
	 * turn running after the goal completed). */
	it("never animates a terminal status while streaming", () => {
		for (const status of ["complete", "budget-limited", "dropped"] as const) {
			const ctx = createGoalContext({
				goal: { status, tokensUsed: 1_000, tokenBudget: 2_000 },
				streaming: true,
				activeMs: 240,
			});
			const icon =
				status === "complete"
					? theme.symbol("status.success")
					: status === "budget-limited"
						? theme.symbol("status.warning")
						: theme.symbol("status.aborted");
			expect(plain(ctx).startsWith(icon)).toBe(true);
		}
	});

	/** The near-budget soft warning applies to a RUNNING goal only; complete at
	 * 96% must keep the success treatment, not flip back to warning. */
	it("does not apply the near-budget recolor to a non-running status", () => {
		const ctx = createGoalContext({ goal: { status: "complete", tokensUsed: 48_000, tokenBudget: 50_000 } });
		expect(renderSegment("mode", ctx).content).toBe(
			theme.fg("success", goalLabel(theme.symbol("status.success"), "48K/50K 96%")),
		);
	});
});

describe("goal progress readout — boundary geometry (GMI-4)", () => {
	/** An over-budget goal still running (grace before the hard stop) must not
	 * render a five-digit percent that blows up the status line: the percent
	 * clamps at 999% and the bar clamps full. */
	it("caps the percent readout at 999% and the bar at full", () => {
		const ctx = createGoalContext({ goal: { tokensUsed: 1_000_000, tokenBudget: 50 }, verbose: true });
		// 1e6/50 = 2,000,000% -> capped 999%; fraction >1 clamps to 8/8 cells.
		// (20000x the budget also trips the ≥90% warning recolor - asserted via
		// the plain string here; color is covered by the near-budget tests.)
		expect(plain(ctx)).toBe(goalLabel(theme.icon.goal, "1M/50 999% ▰▰▰▰▰▰▰▰"));
	});

	/** A zero or negative budget is "no budget", never a division by zero:
	 * the readout falls back to the plain tokensUsed form. */
	it("treats a non-positive budget as no budget", () => {
		for (const tokenBudget of [0, -100]) {
			const ctx = createGoalContext({ goal: { tokensUsed: 7_000, tokenBudget }, verbose: true });
			expect(plain(ctx)).toBe(goalLabel(theme.icon.goal, "7K"));
		}
	});

	/** The bar rounds to the nearest cell; a hair over a cell boundary must
	 * not render a full extra cell early (0.06 of 8 cells rounds to 0). */
	it("rounds the bar to the nearest of 8 cells", () => {
		const ctx = createGoalContext({ goal: { tokensUsed: 3, tokenBudget: 50 }, verbose: true });
		// 3/50 = 6% -> round(0.06*8) = 0 filled cells.
		expect(plain(ctx)).toBe(goalLabel(theme.icon.goal, "3/50 6% ▱▱▱▱▱▱▱▱"));
	});
});
