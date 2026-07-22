import * as os from "node:os";
import * as path from "node:path";
import { ThinkingLevel } from "@veyyon/agent-core";
import { normalizePremiumRequests } from "@veyyon/stats/format";
import { TERMINAL } from "@veyyon/tui";
import {
	clamp01,
	DEFAULT_PROFILE_DIR_NAME,
	formatDuration,
	formatNumber,
	getActiveProfileOrDefault,
	getProjectDir,
	pathIsWithin,
	relativePathWithinRoot,
} from "@veyyon/utils";
import { type ThemeColor, theme } from "../../../modes/theme/theme";
import { shortenPath, TRUNCATE_LENGTHS, truncateToWidth } from "../../../tools/render-utils";
import { getSessionAccentAnsi, getSessionAccentHex } from "../../../utils/session-color";
import { sanitizeStatusText } from "../../shared";
import { emberBandEscape } from "../sun";
import {
	type ContextUsageLevel,
	formatContextUsage,
	getContextUsageLevel,
	getContextUsageThemeColor,
} from "./context-thresholds";
import type { RenderedSegment, SegmentContext, StatusLineSegment, StatusLineSegmentId } from "./types";

export type { SegmentContext } from "./types";

// ═══════════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════════

function withIcon(icon: string, text: string): string {
	return icon ? `${icon} ${text}` : text;
}

/** Left-truncate a path/label to `maxLen`, prefixing an ellipsis when clipped. */
function clampPathLength(pwd: string, maxLen: number): string {
	if (pwd.length <= maxLen) return pwd;
	const ellipsis = "…";
	return `${ellipsis}${pwd.slice(-Math.max(0, maxLen - ellipsis.length))}`;
}

/**
 * Leading glyph of a thinking-level display string (e.g. "◉ xhigh" → "◉").
 * Compact mode promotes this glyph to the model-segment icon so the level
 * stays visible without the verbose " · <level>" tail.
 */
function thinkingGlyph(display: string): string {
	const space = display.indexOf(" ");
	return space === -1 ? display : display.slice(0, space);
}

function stripDisplayRoot(pwd: string): string {
	for (const root of [path.join(os.homedir(), "Projects"), "/work"]) {
		const relative = relativePathWithinRoot(root, pwd);
		if (relative) return relative;
	}
	return pwd;
}

const SCRATCH_ROOTS: readonly string[] = (() => {
	const roots = new Set<string>([os.tmpdir(), path.join(os.homedir(), "tmp")]);
	if (process.platform === "win32") {
		const { TEMP, TMP, SystemRoot } = process.env;
		if (TEMP) roots.add(TEMP);
		if (TMP) roots.add(TMP);
		if (SystemRoot) roots.add(path.join(SystemRoot, "Temp"));
	} else {
		roots.add("/tmp");
		roots.add("/var/tmp");
		if (process.platform === "darwin") {
			roots.add("/private/tmp");
			roots.add("/private/var/tmp");
		}
	}
	return [...roots];
})();

function classifyProjectDir(pwd: string): { scratch: boolean; relative: string | null } {
	for (const root of SCRATCH_ROOTS) {
		if (pathIsWithin(root, pwd)) {
			return { scratch: true, relative: relativePathWithinRoot(root, pwd) };
		}
	}
	return { scratch: false, relative: null };
}

// ═══════════════════════════════════════════════════════════════════════════
// Segment Implementations
// ═══════════════════════════════════════════════════════════════════════════

const piSegment: StatusLineSegment = {
	id: "pi",
	render(ctx) {
		if (ctx.focusedAgentId) {
			const icon = theme.icon.ghost ? `${theme.icon.ghost} ` : "";
			return { content: theme.fg("warning", `${icon}${ctx.focusedAgentId} `), visible: true };
		}
		const content = theme.icon.pi ? `${theme.icon.pi} ` : "";
		return { content: theme.fg("accent", content), visible: true };
	},
};

const modelSegment: StatusLineSegment = {
	id: "model",
	render(ctx) {
		const state = ctx.session.state;
		const opts = ctx.options.model ?? {};

		let modelName = state.model?.name || state.model?.id || "no-model";
		if (modelName.startsWith("Claude ")) {
			modelName = modelName.slice(7);
		}

		// Resolve the current thinking-level display ("◉ xhigh", "⟳ auto", …)
		// when the model supports thinking and the segment isn't hiding it.
		let thinkingDisplay = "";
		if (opts.showThinkingLevel !== false && state.model?.thinking) {
			if (ctx.session.isAutoThinking) {
				// Pending (no turn classified yet / classifying) shows a symbol-theme
				// question-box marker; once resolved it shows `<level>`.
				const resolved = ctx.session.autoResolvedThinkingLevel();
				thinkingDisplay = resolved
					? (theme.thinking[resolved as keyof typeof theme.thinking] ?? resolved)
					: `${theme.thinking.autoPending} auto`;
			} else {
				const level = state.thinkingLevel ?? ThinkingLevel.Off;
				if (level !== ThinkingLevel.Off) {
					thinkingDisplay = theme.thinking[level as keyof typeof theme.thinking] ?? "";
				}
			}
		}

		// Compact mode swaps the model icon for the thinking-level glyph and drops
		// the " · <level>" tail, keeping the level visible as a single icon.
		const compact = ctx.compactThinkingLevel && thinkingDisplay !== "";
		const modelIcon = compact ? thinkingGlyph(thinkingDisplay) : theme.icon.model;

		// Fast-mode icon and thinking-level suffix trail the model name and are
		// colored together with it as `statusLineModel`. The advisor "++" badge
		// sits between the name and that tail in `accent`, so it reads as a
		// distinct marker. theme.fg resets only the fg, so the spans are
		// concatenated (not nested) to keep each color intact.
		let tail = "";
		if (ctx.session.isFastModeActive() && theme.icon.fast) {
			tail += ` ${theme.icon.fast}`;
		}
		if (!compact && thinkingDisplay) {
			tail += opts.roomy ? `  ·  ${thinkingDisplay}` : `${theme.sep.dot}${thinkingDisplay}`;
		}

		// `statusLineModel` is aliased to `accent` in many themes, so the badge
		// uses `success` to stay visibly distinct from the model name color.
		let content = theme.fg("statusLineModel", withIcon(modelIcon, modelName));
		if (ctx.session.isAdvisorActive()) {
			content += theme.fg("success", "++");
		}
		if (tail) {
			content += theme.fg("statusLineModel", tail);
		}

		return { content, visible: true };
	},
};

/** Cells in the compact goal progress bar (verbose mode only). */
const GOAL_BAR_WIDTH = 8;
/** Spinner advances one frame per this many active-ms (steady when idle/paused). */
const GOAL_SPINNER_PERIOD_MS = 120;
/** Recolor to warning once the goal has burned this fraction of its token budget. */
const GOAL_NEAR_BUDGET_FRACTION = 0.9;

/** Compact filled/empty unicode bar for a 0..1 fraction (clamped). */
export function goalProgressBar(fraction: number): string {
	const clamped = clamp01(fraction);
	const filled = Math.round(clamped * GOAL_BAR_WIDTH);
	return `${"▰".repeat(filled)}${"▱".repeat(GOAL_BAR_WIDTH - filled)}`;
}

/**
 * Token readout for the goal segment. Always shows `tokensUsed`; when a budget
 * is set it adds `used/budget` and a percent, and in verbose mode a compact
 * progress bar. This is surfaced regardless of `goal.statusInFooter` — that flag
 * now controls verbosity (the bar), not whether the readout exists at all.
 */
function formatGoalProgress(tokensUsed: number, tokenBudget: number | undefined, verbose: boolean): string {
	const used = formatNumber(tokensUsed);
	if (typeof tokenBudget !== "number" || tokenBudget <= 0) return used;
	const fraction = tokensUsed / tokenBudget;
	const percent = `${Math.min(999, Math.round(fraction * 100))}%`;
	const base = `${used}/${formatNumber(tokenBudget)} ${percent}`;
	return verbose ? `${base} ${goalProgressBar(fraction)}` : base;
}

/**
 * Deterministic spinner frame for a still-running goal. `activeMs` advances only
 * while the agent is streaming, so the frame is steady the instant the turn ends
 * and needs no wall-clock read (making the rendered string exact for tests).
 * Returns the static goal icon when the theme declares no spinner frames.
 */
function goalSpinnerIcon(activeMs: number): string {
	const frames = theme.spinnerFrames;
	if (frames.length === 0) return theme.icon.goal;
	const idx = Math.floor(Math.max(0, activeMs) / GOAL_SPINNER_PERIOD_MS) % frames.length;
	return frames[idx] ?? theme.icon.goal;
}

function renderGoalMode(ctx: SegmentContext, mode: { enabled: boolean; paused: boolean }): RenderedSegment {
	const goal = ctx.session.getGoalModeState()?.goal;
	const status = goal?.status ?? (mode.paused ? "paused" : "active");

	let icon: string = theme.icon.goal;
	// Modes carry the cool arc's mode hue (violet on titanium); semantic
	// warning/success/dim states below still override it.
	let color: ThemeColor = "modeAccent";
	switch (status) {
		case "paused":
			icon = theme.icon.pause || theme.symbol("status.pending");
			color = "warning";
			break;
		case "complete":
			icon = theme.symbol("status.success");
			color = "success";
			break;
		case "budget-limited":
			icon = theme.symbol("status.warning");
			color = "warning";
			break;
		case "dropped":
			icon = theme.symbol("status.aborted");
			color = "dim";
			break;
		default:
			break;
	}

	const tokensUsed = goal?.tokensUsed ?? 0;
	const tokenBudget = goal?.tokenBudget;
	const running = status === "active";

	// Near-budget soft warning: before the hard `budget-limited` status trips, a
	// goal that has burned ≥90% of its budget recolors to warning so the operator
	// sees the ceiling approaching while it is still running.
	const nearBudget =
		typeof tokenBudget === "number" && tokenBudget > 0 && tokensUsed >= tokenBudget * GOAL_NEAR_BUDGET_FRACTION;
	if (running && nearBudget) color = "warning";

	// Live motion while the agent streams under a running goal; steady otherwise.
	if (running && ctx.session.isStreaming) icon = goalSpinnerIcon(ctx.activeMs);

	const verbose = ctx.session.settings.get("goal.statusInFooter") === true;
	const parts: string[] = [withIcon(icon, "Goal")];
	if (goal) parts.push(formatGoalProgress(tokensUsed, tokenBudget, verbose));
	return { content: theme.fg(color, parts.join(" ")), visible: true };
}

/** The active mode label (plan/prewalk/goal/vibe/loop), independent of the bypass marker. */
function renderBaseMode(ctx: SegmentContext): RenderedSegment {
	const pauseSuffix = theme.icon.pause ? ` ${theme.icon.pause}` : " (paused)";

	// Every mode label reads in the cool arc's mode hue (`modeAccent`, violet
	// on titanium) so "what mode am I in" is one color everywhere; paused keeps
	// the semantic warning override.
	const plan = ctx.planMode;
	if (plan && (plan.enabled || plan.paused)) {
		const label = plan.paused ? `Plan${pauseSuffix}` : "Plan";
		const content = withIcon(theme.icon.plan, label);
		const color = plan.paused ? "warning" : "modeAccent";
		return { content: theme.fg(color, content), visible: true };
	}

	const prewalk = ctx.prewalk;
	if (prewalk?.enabled) {
		const content = withIcon(theme.icon.prewalk, "Prewalk");
		return { content: theme.fg("modeAccent", content), visible: true };
	}

	const goal = ctx.goalMode;
	if (goal && (goal.enabled || goal.paused)) {
		return renderGoalMode(ctx, goal);
	}

	const vibe = ctx.vibeMode;
	if (vibe?.enabled) {
		const content = withIcon(theme.icon.agents, "Vibe");
		return { content: theme.fg("modeAccent", content), visible: true };
	}

	const loop = ctx.loopMode;
	if (loop?.enabled) {
		const content = withIcon(theme.icon.loop, "Loop");
		return { content: theme.fg("modeAccent", content), visible: true };
	}

	return { content: "", visible: false };
}

const modeSegment: StatusLineSegment = {
	id: "mode",
	render(ctx) {
		const base = renderBaseMode(ctx);
		// The `/yolo` full-bypass ("all prompts off") is the single most important
		// state to surface, so it prefixes whatever mode is active rather than
		// replacing it. The red editor border is the always-on guarantee; this text
		// is the label. Errs loud (Law 10 — a silent bypass would be a safety bug).
		if (ctx.session.isApprovalBypassed()) {
			const marker = theme.fg("error", `${theme.symbol("status.warning")} YOLO`);
			const content = base.visible && base.content ? `${marker} ${base.content}` : marker;
			return { content, visible: true };
		}
		return base;
	},
};

const pathSegment: StatusLineSegment = {
	id: "path",
	render(ctx) {
		const opts = ctx.options.path ?? {};
		const stripPrefix = opts.stripWorkPrefix !== false;

		// Linked git worktree: the on-disk path nests the worktree base, the
		// project, and a worktree dir that usually duplicates the branch (already
		// shown by the git segment). Collapse to the project name, appending the
		// worktree dir only when it diverges from the branch.
		if (stripPrefix && ctx.worktree) {
			const { projectName, worktreeName } = ctx.worktree;
			const label = ctx.git.branch === worktreeName ? projectName : `${projectName}/${worktreeName}`;
			const content = withIcon(theme.icon.worktree, clampPathLength(label, opts.maxLength ?? 40));
			return { content: theme.fg("statusLinePath", content), visible: true };
		}

		const projectDir = ctx.session.sessionManager?.getCwd?.() ?? ctx.activeRepo?.cwd ?? getProjectDir();
		const { scratch, relative } = classifyProjectDir(projectDir);
		let pwd = projectDir;

		if (stripPrefix) {
			if (scratch) {
				if (relative) pwd = relative;
			} else {
				pwd = stripDisplayRoot(pwd);
			}
		}
		const repoSuffix = ctx.activeRepo ? ` ↳ ${ctx.activeRepo.relativeRepoRoot}` : "";
		if (opts.abbreviate !== false) {
			pwd = shortenPath(pwd);
		}

		pwd = clampPathLength(pwd, opts.maxLength ?? 40);
		if (repoSuffix) {
			pwd = `${pwd}${repoSuffix}`;
		}

		const showScratchIcon = scratch && stripPrefix;
		const icon = showScratchIcon ? theme.icon.scratchFolder : theme.icon.folder;
		const content = withIcon(icon, pwd);
		return { content: theme.fg("statusLinePath", content), visible: true };
	},
};

const gitSegment: StatusLineSegment = {
	id: "git",
	render(ctx) {
		const { branch, status } = ctx.git;
		if (!branch && !status) return { content: "", visible: false };

		const opts = ctx.options.git ?? {};
		const gitStatus = status;
		const isDirty = gitStatus && (gitStatus.staged > 0 || gitStatus.unstaged > 0 || gitStatus.untracked > 0);

		const showBranch = opts.showBranch !== false;
		let content = "";
		if (showBranch && branch) {
			content = withIcon(theme.icon.branch, branch);
		}

		// Compact: branch plus one bare dirty marker — the counts belong on the
		// full status line, not the quiet composer zone.
		if (opts.compact) {
			if (isDirty) content = `${content} ${theme.fg("statusLineDirty", "*")}`;
			if (!content) return { content: "", visible: false };
			const colorName = isDirty ? "statusLineGitDirty" : "statusLineGitClean";
			return { content: theme.fg(colorName, content), visible: true };
		}

		// Add status indicators
		if (gitStatus) {
			const indicators: string[] = [];
			if (opts.showUnstaged !== false && gitStatus.unstaged > 0) {
				indicators.push(theme.fg("statusLineDirty", `*${gitStatus.unstaged}`));
			}
			if (opts.showStaged !== false && gitStatus.staged > 0) {
				indicators.push(theme.fg("statusLineStaged", `+${gitStatus.staged}`));
			}
			if (opts.showUntracked !== false && gitStatus.untracked > 0) {
				indicators.push(theme.fg("statusLineUntracked", `?${gitStatus.untracked}`));
			}
			if (indicators.length > 0) {
				const indicatorText = indicators.join(" ");
				if (!content && showBranch === false) {
					content = withIcon(theme.icon.git, indicatorText);
				} else {
					content += content ? ` ${indicatorText}` : indicatorText;
				}
			}
		}

		if (!content) return { content: "", visible: false };

		const colorName = isDirty ? "statusLineGitDirty" : "statusLineGitClean";
		return { content: theme.fg(colorName, content), visible: true };
	},
};

const prSegment: StatusLineSegment = {
	id: "pr",
	render(ctx) {
		const { pr } = ctx.git;
		if (!pr) return { content: "", visible: false };

		const label = withIcon(theme.icon.pr, `#${pr.number}`);
		const content = TERMINAL.hyperlinks ? `\x1b]8;;${pr.url}\x07${label}\x1b]8;;\x07` : label;
		return { content: theme.fg("accent", content), visible: true };
	},
};

const subagentsSegment: StatusLineSegment = {
	id: "subagents",
	render(ctx) {
		if (ctx.subagentCount === 0) {
			return { content: "", visible: false };
		}
		const content = withIcon(theme.icon.agents, `${ctx.subagentCount}`);
		return { content: theme.fg("statusLineSubagents", content), visible: true };
	},
};

const tokenInSegment: StatusLineSegment = {
	id: "token_in",
	render(ctx) {
		const { input } = ctx.usageStats;
		if (!input) return { content: "", visible: false };

		const content = withIcon(theme.icon.input, formatNumber(input));
		return { content: theme.fg("statusLineSpend", content), visible: true };
	},
};

const tokenOutSegment: StatusLineSegment = {
	id: "token_out",
	render(ctx) {
		const { output } = ctx.usageStats;
		if (!output) return { content: "", visible: false };

		const content = withIcon(theme.icon.output, formatNumber(output));
		return { content: theme.fg("statusLineOutput", content), visible: true };
	},
};

const tokenTotalSegment: StatusLineSegment = {
	id: "token_total",
	render(ctx) {
		// Excludes cacheRead: that field re-reads the full cached context every
		// turn, making the cumulative sum N×context_size. Orchestration cache read
		// follows the same rule; orchestration input/output remain in the total so
		// provider-side service work is preserved without labeling it prompt input.
		const { input, output, cacheWrite, orchestrationInput, orchestrationOutput } = ctx.usageStats;
		const total = input + output + cacheWrite + orchestrationInput + orchestrationOutput;
		if (!total) return { content: "", visible: false };

		const content = withIcon(theme.icon.tokens, formatNumber(total));
		return { content: theme.fg("statusLineSpend", content), visible: true };
	},
};

const tokenRateSegment: StatusLineSegment = {
	id: "token_rate",
	render(ctx) {
		const { tokensPerSecond } = ctx.usageStats;
		if (!tokensPerSecond) return { content: "", visible: false };

		const content = withIcon(theme.icon.throughput, `${tokensPerSecond.toFixed(1)} tok/s`);
		return { content: theme.fg("statusLineOutput", content), visible: true };
	},
};

const costSegment: StatusLineSegment = {
	id: "cost",
	render(ctx) {
		const { cost, premiumRequests } = ctx.usageStats;
		const normalizedPremiumRequests = normalizePremiumRequests(premiumRequests);
		const state = ctx.session.state;
		const usingSubscription = state.model ? ctx.session.modelRegistry.isUsingOAuth(state.model) : false;

		if (!cost && !usingSubscription && !normalizedPremiumRequests) {
			return { content: "", visible: false };
		}

		const billingParts: string[] = [];
		if (cost) billingParts.push(`$${cost.toFixed(2)}`);
		if (normalizedPremiumRequests) billingParts.push(`* ${formatNumber(normalizedPremiumRequests)}`);
		if (usingSubscription) billingParts.push("(sub)");

		return { content: theme.fg("statusLineCost", billingParts.join(" ")), visible: true };
	},
};

/** The context bar's fixed cell count — small enough to whisper, wide enough
 *  that one cell is a meaningful 12.5% step. */
const CONTEXT_BAR_CELLS = 8;
/** Brand breathing frames for the bar's tip — the same pixel-inhale cycle the
 *  working spinner uses, so the two live elements share one vocabulary. */
const CONTEXT_BAR_TIP_FRAMES = ["░", "▒", "▓", "█", "▓", "▒"] as const;
/** Cells whose right edge is a major fill (25%, 50%, 75%, ~90%): once
 *  reached they lock in gold, giving the eye fixed anchors on the ramp. */
const CONTEXT_BAR_MAJOR_CELLS = new Set([1, 3, 5, 6]);
/** Tip breath cadence; past the error threshold the breath doubles — the bar
 *  visibly quickens as compaction nears. */
const CONTEXT_BAR_TIP_STEP_MS = 1000;
const CONTEXT_BAR_TIP_STEP_URGENT_MS = 500;

/** Static frontier glyphs for the RESTING bar: the tip encodes the next
 *  cell's fractional fill as data (quarter steps), no motion. */
const CONTEXT_BAR_FRACTION_GLYPHS = ["▱", "░", "▒", "▓"] as const;

/**
 * The growing context bar (approved §04 mock): `▰▰▰▓▱▱▱▱` — filled cells in
 * the usage-level hue (silver → gold → ember → alarm via the ONE
 * getContextUsageThemeColor owner), reached major-fill cells locked gold, and
 * dim rest cells. The frontier cell is dual-natured: while the agent RUNS
 * (`live`) it breathes the brand frames — motion means "the model is working
 * right now", the same contract as the spinner; at rest it is a STATIC
 * quarter-step glyph showing the next cell's fractional fill, because motion
 * on an idle screen signals activity that does not exist. Pure in
 * (ratio, level, nowMs, live) so tests can pin exact frames.
 */
export function renderContextBar(ratio: number, level: ContextUsageLevel, nowMs: number, live: boolean): string {
	const clamped = Math.min(1, Math.max(0, Number.isFinite(ratio) ? ratio : 0));
	const filled = Math.min(CONTEXT_BAR_CELLS, Math.floor(clamped * CONTEXT_BAR_CELLS));
	const levelColor = getContextUsageThemeColor(level);
	let tipFrame: string;
	if (live) {
		const stepMs = level === "error" ? CONTEXT_BAR_TIP_STEP_URGENT_MS : CONTEXT_BAR_TIP_STEP_MS;
		tipFrame = CONTEXT_BAR_TIP_FRAMES[Math.floor(nowMs / stepMs) % CONTEXT_BAR_TIP_FRAMES.length] as string;
	} else {
		const fraction = clamped * CONTEXT_BAR_CELLS - filled;
		tipFrame = CONTEXT_BAR_FRACTION_GLYPHS[
			Math.min(CONTEXT_BAR_FRACTION_GLYPHS.length - 1, Math.floor(fraction * 4))
		] as string;
	}
	let bar = "";
	for (let cell = 0; cell < CONTEXT_BAR_CELLS; cell++) {
		if (cell < filled) {
			bar +=
				CONTEXT_BAR_MAJOR_CELLS.has(cell) && level !== "error"
					? theme.fg("matchHighlight", "▰")
					: theme.fg(levelColor, "▰");
		} else if (cell === filled && clamped < 1) {
			bar += tipFrame === "▱" ? theme.fg("dim", "▱") : theme.fg(levelColor, tipFrame);
		} else {
			bar += theme.fg("dim", "▱");
		}
	}
	return bar;
}

const contextPctSegment: StatusLineSegment = {
	id: "context_pct",
	render(ctx) {
		const pct = ctx.contextPercent;
		const window = ctx.contextWindow;
		const level = getContextUsageLevel(pct ?? 0, window);

		if (ctx.options.context_pct?.bar) {
			// Quiet zones: the bar carries the heat; the percent number stays and
			// the `/window` denominator is dropped (approved §04). Auto-compaction
			// shows as a session-accent ∞ — the endless-session mark.
			const bar = renderContextBar((pct ?? 0) / 100, level, Date.now(), ctx.session.isStreaming);
			// Whole percent: the bar already carries the fine grain, and the two
			// saved cells keep the gauge alive on 100-col footlines.
			const pctText = pct === null || pct === undefined ? "?" : `${Math.round(pct)}%`;
			const autoIcon =
				ctx.autoCompactEnabled && theme.icon.auto ? ` ${theme.fg("sessionAccent", theme.icon.auto)}` : "";
			return {
				content: `${bar} ${theme.fg(getContextUsageThemeColor(level), pctText)}${autoIcon}`,
				visible: true,
			};
		}

		const autoIcon = ctx.autoCompactEnabled && theme.icon.auto ? ` ${theme.icon.auto}` : "";
		const text = `${formatContextUsage(pct, window, ctx.contextTokens)}${autoIcon}`;

		// The quiet zone's gauge warms up the ember ramp as it fills — the sun
		// heating — while the error state keeps its unmistakable semantic red.
		const content =
			ctx.options.context_pct?.emberRamp && level !== "error"
				? withIcon(theme.icon.context, `${emberBandEscape((pct ?? 0) / 100, TERMINAL.trueColor)}${text}\x1b[39m`)
				: withIcon(theme.icon.context, theme.fg(getContextUsageThemeColor(level), text));

		return { content, visible: true };
	},
};

const contextTotalSegment: StatusLineSegment = {
	id: "context_total",
	render(ctx) {
		const window = ctx.contextWindow;
		if (!window) return { content: "", visible: false };
		return {
			content: theme.fg("statusLineContext", withIcon(theme.icon.context, formatNumber(window))),
			visible: true,
		};
	},
};

/**
 * Total time the agent was actively processing this session — the union of
 * every `agent_start`→`agent_end` window plus the currently-running window,
 * sourced from {@link SegmentContext.activeMs}. Idle wall-clock between turns
 * never accumulates, so the displayed total reflects how long the agent has
 * been working for the user, not how long the session has been open. Hidden
 * before the first second of activity to avoid flashing `0s` at session start.
 */
const timeSpentSegment: StatusLineSegment = {
	id: "time_spent",
	render(ctx) {
		if (ctx.activeMs < 1000) return { content: "", visible: false };
		return { content: withIcon(theme.icon.time, formatDuration(ctx.activeMs)), visible: true };
	},
};

const timeSegment: StatusLineSegment = {
	id: "time",
	render(ctx) {
		const opts = ctx.options.time ?? {};
		const now = new Date();

		let hours = now.getHours();
		let suffix = "";
		if (opts.format === "12h") {
			suffix = hours >= 12 ? "pm" : "am";
			hours = hours % 12 || 12;
		}

		const mins = now.getMinutes().toString().padStart(2, "0");
		let timeStr = `${hours}:${mins}`;
		if (opts.showSeconds) {
			timeStr += `:${now.getSeconds().toString().padStart(2, "0")}`;
		}
		timeStr += suffix;

		return { content: withIcon(theme.icon.time, timeStr), visible: true };
	},
};

const sessionSegment: StatusLineSegment = {
	id: "session",
	render(ctx) {
		const sessionManager = ctx.session.sessionManager;
		const sessionId = sessionManager?.getSessionId?.();
		const display = sessionId?.slice(0, 8) || "new";

		// Session identity reads in the cool arc's session hue (teal on titanium).
		return { content: theme.fg("sessionAccent", withIcon(theme.icon.session, display)), visible: true };
	},
};

const hostnameSegment: StatusLineSegment = {
	id: "hostname",
	render(_ctx) {
		const name = os.hostname().split(".")[0];
		return { content: withIcon(theme.icon.host, name), visible: true };
	},
};

// The active veyyon profile ("work", "rec", a client sandbox). Hidden when it is
// the built-in "default" profile: an unconfigured user has nothing to disambiguate
// and the decluttered default status line stays quiet. Any named profile shows,
// so you always know which sandbox's config, sessions, and keys are in play.
const profileSegment: StatusLineSegment = {
	id: "profile",
	render(_ctx) {
		const name = getActiveProfileOrDefault();
		if (name === DEFAULT_PROFILE_DIR_NAME) {
			return { content: "", visible: false };
		}
		return { content: withIcon(theme.icon.profile, name), visible: true };
	},
};

const cacheReadSegment: StatusLineSegment = {
	id: "cache_read",
	render(ctx) {
		const { cacheRead } = ctx.usageStats;
		if (!cacheRead) return { content: "", visible: false };

		const parts = [theme.icon.cache, formatNumber(cacheRead)].filter(Boolean);
		const content = parts.join(" ");
		return { content: theme.fg("statusLineSpend", content), visible: true };
	},
};

const cacheWriteSegment: StatusLineSegment = {
	id: "cache_write",
	render(ctx) {
		const { cacheWrite } = ctx.usageStats;
		if (!cacheWrite) return { content: "", visible: false };

		const parts = [theme.icon.cache, formatNumber(cacheWrite)].filter(Boolean);
		const content = parts.join(" ");
		return { content: theme.fg("statusLineOutput", content), visible: true };
	},
};

const cacheHitSegment: StatusLineSegment = {
	id: "cache_hit",
	render(ctx) {
		const { cacheRead, cacheWrite, input } = ctx.usageStats;
		if (!cacheRead) return { content: "", visible: false };

		// Hit rate = cacheRead / total prompt tokens. The prompt is the sum of
		// cacheRead (served from cache), cacheWrite (newly cached this turn) and
		// input (uncached). Including uncached input keeps the denominator honest
		// for Anthropic/OpenRouter; DeepSeek reports its miss as input with
		// cacheWrite 0, so this still yields hit/(hit+miss).
		const total = cacheRead + cacheWrite + input;

		const rate = (cacheRead / total) * 100;
		const rateStr = rate.toFixed(2);

		const parts: string[] = [theme.icon.cache];
		parts.push(theme.fg("statusLineSpend", `${rateStr}%`));
		return { content: parts.join(" "), visible: true };
	},
};

const sessionNameSegment: StatusLineSegment = {
	id: "session_name",
	render(ctx) {
		const sessionManager = ctx.session.sessionManager;
		const name = sessionManager?.getSessionName();
		if (!name) return { content: "", visible: false };

		const ansi =
			getSessionAccentAnsi(
				getSessionAccentHex(name, theme.getMajorThemeColorHexes(), theme.accentSurfaceLuminance),
			) ?? theme.getFgAnsi("accent");
		return { content: `${ansi}${sanitizeStatusText(name)}\x1b[39m`, visible: true };
	},
};

const collabSegment: StatusLineSegment = {
	id: "collab",
	render(ctx) {
		if (!ctx.collab) return { content: "", visible: false };
		const label =
			ctx.collab.role === "host"
				? `⇄ collab:${ctx.collab.participantCount}`
				: `⇄ collab guest:${ctx.collab.participantCount}`;
		// Share/collab state reads in the cool arc's share hue (indigo on titanium).
		return { content: theme.fg("shareAccent", label), visible: true };
	},
};

function pickUsageColor(percent: number): "muted" | "warning" | "error" {
	if (percent >= 80) return "error";
	if (percent >= 50) return "warning";
	return "muted";
}

function formatUsageReset(value: number, unit: "m" | "h"): string {
	if (unit === "m") {
		// total minutes (5h window: max 300)
		if (value < 60) return `${value}m`;
		const hours = Math.floor(value / 60);
		const mins = value % 60;
		return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
	}
	// total hours (7d window: max 168)
	if (value < 24) return `${value}h`;
	const days = Math.floor(value / 24);
	const hours = value % 24;
	return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
}

const usageSegment: StatusLineSegment = {
	id: "usage",
	render(ctx) {
		const u = ctx.usage;
		if (!u || (!u.fiveHour && !u.sevenDay)) {
			return { content: "", visible: false };
		}
		const parts: string[] = [];
		if (u.tier) {
			const tier = truncateToWidth(sanitizeStatusText(u.tier), TRUNCATE_LENGTHS.SHORT);
			if (tier) parts.push(theme.fg("accent", tier));
		}
		if (u.fiveHour) {
			const pct = u.fiveHour.percent;
			const pctText = theme.fg(pickUsageColor(pct), `${Math.round(pct)}%`);
			const reset =
				u.fiveHour.resetMinutes !== undefined
					? theme.fg("muted", ` (${formatUsageReset(u.fiveHour.resetMinutes, "m")})`)
					: "";
			parts.push(`5h ${pctText}${reset}`);
		}
		if (u.sevenDay) {
			const pct = u.sevenDay.percent;
			const pctText = theme.fg(pickUsageColor(pct), `${Math.round(pct)}%`);
			const reset =
				u.sevenDay.resetHours !== undefined
					? theme.fg("muted", ` (${formatUsageReset(u.sevenDay.resetHours, "h")})`)
					: "";
			parts.push(`7d ${pctText}${reset}`);
		}
		const content = withIcon(theme.icon.time, parts.join(theme.sep.dot));
		return { content, visible: true };
	},
};

// ═══════════════════════════════════════════════════════════════════════════
// Segment Registry
// ═══════════════════════════════════════════════════════════════════════════

export const SEGMENTS: Record<StatusLineSegmentId, StatusLineSegment> = {
	pi: piSegment,
	model: modelSegment,
	mode: modeSegment,
	path: pathSegment,
	git: gitSegment,
	pr: prSegment,
	subagents: subagentsSegment,
	token_in: tokenInSegment,
	token_out: tokenOutSegment,
	token_total: tokenTotalSegment,
	token_rate: tokenRateSegment,
	cost: costSegment,
	context_pct: contextPctSegment,
	context_total: contextTotalSegment,
	time_spent: timeSpentSegment,
	time: timeSegment,
	session: sessionSegment,
	hostname: hostnameSegment,
	profile: profileSegment,
	cache_read: cacheReadSegment,
	cache_write: cacheWriteSegment,
	cache_hit: cacheHitSegment,
	session_name: sessionNameSegment,
	usage: usageSegment,
	collab: collabSegment,
};

export function renderSegment(id: StatusLineSegmentId, ctx: SegmentContext): RenderedSegment {
	const segment = SEGMENTS[id];
	if (!segment) {
		return { content: "", visible: false };
	}
	return segment.render(ctx);
}

export const ALL_SEGMENT_IDS: StatusLineSegmentId[] = Object.keys(SEGMENTS) as StatusLineSegmentId[];
