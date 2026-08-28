import * as os from "node:os";
import * as path from "node:path";
import { ThinkingLevel } from "@veyyon/agent-core";
import { normalizePremiumRequests } from "@veyyon/stats/format";
import { sliceWithWidth, TERMINAL, visibleWidth } from "@veyyon/tui";
import {
	clamp01,
	DEFAULT_PROFILE_DIR_NAME,
	formatDuration,
	formatNumber,
	getActiveProfileOrDefault,
	getProjectDir,
	logger,
	pathIsWithin,
	relativePathWithinRoot,
} from "@veyyon/utils";
import { PRIORITY_TIER_LABEL } from "../../../config/service-tier";
import { withIcon } from "../../../modes/theme/icon-label";
import { type ThemeColor, theme } from "../../../modes/theme/theme";
import { describeMsLeft } from "../../../secrets/vault";
import { normalizeApprovalMode } from "../../../tools/approval";
import { AUTONOMY_LABEL } from "../../../tools/approval-modes";
import { shortenPath, TRUNCATE_LENGTHS, truncateToWidth } from "../../../tools/render-utils";
import { getSessionAccentAnsi, getSessionAccentHex } from "../../../utils/session-color";
import { sanitizeStatusText } from "../../shared";
import {
	type ContextUsageLevel,
	formatContextRemainingPercent,
	getContextUsageLevel,
	getContextUsageThemeColor,
} from "./context-thresholds";
import { joinStates } from "./state-grammar";
import type { RenderedSegment, SegmentContext, StatusLineSegment, StatusLineSegmentId } from "./types";

export type { SegmentContext } from "./types";

const SECRET_EXPIRY_CHIP_WINDOW_MS = 60 * 60 * 1000;

const PAD2: readonly string[] = Array.from({ length: 60 }, (_, i) => String(i).padStart(2, "0"));

function clampPathLength(pwd: string, maxLen: number): string {
	const total = visibleWidth(pwd);
	if (total <= maxLen) return pwd;
	const ellipsis = "…";
	const room = Math.max(0, maxLen - visibleWidth(ellipsis));
	if (room === 0) return ellipsis;
	return `${ellipsis}${sliceWithWidth(pwd, total - room, room, true).text}`;
}

function thinkingGlyph(display: string): string {
	const space = display.indexOf(" ");
	return space === -1 ? display : display.slice(0, space);
}

export function defaultDisplayRoots(): readonly string[] {
	return [path.join(os.homedir(), "Projects"), "/work"];
}

const warnedDisplayRoots = new Set<string>();

export function resolveDisplayRoots(roots: readonly string[]): string[] {
	const resolved: string[] = [];
	for (const root of roots) {
		const trimmed = typeof root === "string" ? root.trim() : "";
		const afterTilde = trimmed.startsWith("~/") || trimmed.startsWith("~\\") ? trimmed.slice(2) : null;
		const expanded =
			trimmed === "~" ? os.homedir() : afterTilde === null ? trimmed : path.join(os.homedir(), afterTilde);
		if (expanded !== "" && path.isAbsolute(expanded)) {
			resolved.push(expanded);
			continue;
		}
		if (warnedDisplayRoots.has(trimmed)) continue;
		warnedDisplayRoots.add(trimmed);
		logger.warn("Status line path display root ignored: not an absolute path", { root });
	}
	return resolved;
}

let displayRootCache: { pwd: string; key: string; result: string } | null = null;

function stripDisplayRoot(pwd: string, roots: readonly string[] | undefined): string {
	const declared = roots ?? defaultDisplayRoots();
	const key = declared.join("\u0000");
	if (displayRootCache?.pwd === pwd && displayRootCache.key === key) return displayRootCache.result;
	let result = pwd;
	for (const root of resolveDisplayRoots(declared)) {
		const relative = relativePathWithinRoot(root, pwd);
		if (relative) {
			result = relative;
			break;
		}
	}
	displayRootCache = { pwd, key, result };
	return result;
}

function scratchRoots(): readonly string[] {
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
	return Array.from(roots);
}

function classifyProjectDir(pwd: string): { scratch: boolean; relative: string | null } {
	for (const root of scratchRoots()) {
		if (pathIsWithin(root, pwd)) {
			return { scratch: true, relative: relativePathWithinRoot(root, pwd) };
		}
	}
	return { scratch: false, relative: null };
}

export function focusExitBadge(focusedAgentId: string): string {
	const who = theme.fg("warning", withIcon(theme.icon.ghost, sanitizeStatusText(focusedAgentId)));
	const exit = `${theme.fg("accent", "esc")}${theme.fg("muted", " to go back")}`;
	return `${who}${theme.fg("muted", " · ")}${exit}${theme.fg("border", " │")}`;
}

const piSegment: StatusLineSegment = {
	id: "pi",
	render() {
		const content = withIcon(theme.icon.pi, "");
		return { content: theme.fg("accent", content), visible: true };
	},
};

const modelSegment: StatusLineSegment = {
	id: "model",
	render(ctx) {
		const state = ctx.session.state;
		const opts = ctx.options.model ?? {};

		let modelName = sanitizeStatusText(state.model?.name || state.model?.id || "") || "no-model";
		if (modelName.startsWith("Claude ")) {
			modelName = modelName.slice(7);
		}

		let thinkingDisplay = "";
		if (opts.showThinkingLevel !== false && state.model?.thinking) {
			if (ctx.session.isAutoThinking) {
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

		const compact = ctx.compactThinkingLevel && thinkingDisplay !== "";
		const modelIcon = compact ? thinkingGlyph(thinkingDisplay) : theme.icon.model;

		let tail = "";
		if (!compact && thinkingDisplay) {
			tail += opts.roomy ? ` @${thinkingDisplay}` : `${theme.sep.dot}${thinkingDisplay}`;
		}

		let content = theme.fg("statusLineModel", withIcon(modelIcon, modelName));
		if (ctx.session.isAdvisorActive()) {
			content += theme.fg("success", "++");
		}
		if (tail) {
			content += theme.fg("statusLineModel", tail);
		}
		if (ctx.session.isFastModeActive()) {
			content += theme.fg("warning", ` ${formatServiceTierChip(compact)}`);
		}

		return { content, visible: true };
	},
};

function formatServiceTierChip(compact: boolean): string {
	const icon = theme.icon.fast;
	if (!icon) return PRIORITY_TIER_LABEL;
	return compact ? icon : `${icon} ${PRIORITY_TIER_LABEL}`;
}

const GOAL_BAR_WIDTH = 8;
const GOAL_SPINNER_PERIOD_MS = 120;
const GOAL_NEAR_BUDGET_FRACTION = 0.9;

const GOAL_BAR_STRINGS: readonly string[] = Array.from(
	{ length: GOAL_BAR_WIDTH + 1 },
	(_, i) => "▰".repeat(i) + "▱".repeat(GOAL_BAR_WIDTH - i),
);

export function goalProgressBar(fraction: number): string {
	const filled = Math.round(clamp01(fraction) * GOAL_BAR_WIDTH);
	return GOAL_BAR_STRINGS[filled]!;
}

function formatGoalProgress(tokensUsed: number, tokenBudget: number | undefined, verbose: boolean): string {
	const used = formatNumber(tokensUsed);
	if (typeof tokenBudget !== "number" || tokenBudget <= 0) return used;
	const fraction = tokensUsed / tokenBudget;
	const percent = `${Math.min(999, Math.round(fraction * 100))}%`;
	const base = `${used}/${formatNumber(tokenBudget)} ${percent}`;
	return verbose ? `${base} ${goalProgressBar(fraction)}` : base;
}

function goalSpinnerIcon(activeMs: number): string {
	const frames = theme.spinnerFrames;
	if (frames.length === 0) return theme.icon.goal;
	const idx = Math.floor(Math.max(0, activeMs) / GOAL_SPINNER_PERIOD_MS) % frames.length;
	return frames[idx] ?? theme.icon.goal;
}

function renderGoalMode(ctx: SegmentContext, mode: { enabled: boolean; paused: boolean }): string {
	const goal = ctx.session.getGoalModeState()?.goal;
	const modelBudgetsEnabled = ctx.session.settings.get("goal.modelBudgetsEnabled");
	const persistedStatus = goal?.status ?? (mode.paused ? "paused" : "active");
	const status = !modelBudgetsEnabled && persistedStatus === "budget-limited" ? "active" : persistedStatus;

	let icon: string = theme.icon.goal;
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
	const tokenBudget = modelBudgetsEnabled ? goal?.tokenBudget : undefined;
	const running = status === "active";

	const nearBudget =
		typeof tokenBudget === "number" && tokenBudget > 0 && tokensUsed >= tokenBudget * GOAL_NEAR_BUDGET_FRACTION;
	if (running && nearBudget) color = "warning";

	if (running && ctx.session.isStreaming) icon = goalSpinnerIcon(ctx.activeMs);

	const verbose = ctx.session.settings.get("goal.statusInFooter") === true;
	const goalLabel = withIcon(icon, "Goal");
	if (!goal) return theme.fg(color, goalLabel);
	return theme.fg(color, `${goalLabel} ${formatGoalProgress(tokensUsed, tokenBudget, verbose)}`);
}

interface BaseModeState {
	readonly id: string;
	render(ctx: SegmentContext): string;
}

function pauseSuffix(): string {
	return theme.icon.pause ? ` ${theme.icon.pause}` : " (paused)";
}

export const BASE_MODE_STATES: readonly BaseModeState[] = [
	{
		id: "plan",
		render(ctx) {
			const plan = ctx.planMode;
			if (!plan || !(plan.enabled || plan.paused)) return "";
			const label = plan.paused ? `Plan${pauseSuffix()}` : "Plan";
			return theme.fg(plan.paused ? "warning" : "modeAccent", withIcon(theme.icon.plan, label));
		},
	},
	{
		id: "prewalk",
		render(ctx) {
			if (!ctx.prewalk?.enabled) return "";
			return theme.fg("modeAccent", withIcon(theme.icon.prewalk, "Prewalk"));
		},
	},
	{
		id: "goal",
		render(ctx) {
			const goal = ctx.goalMode;
			if (!goal || !(goal.enabled || goal.paused)) return "";
			return renderGoalMode(ctx, goal);
		},
	},
	{
		id: "vibe",
		render(ctx) {
			if (!ctx.vibeMode?.enabled) return "";
			return theme.fg("modeAccent", withIcon(theme.icon.agents, "Vibe"));
		},
	},
	{
		id: "loop",
		render(ctx) {
			if (!ctx.loopMode?.enabled) return "";
			return theme.fg("modeAccent", withIcon(theme.icon.loop, "Loop"));
		},
	},
];

function renderBaseMode(ctx: SegmentContext): string {
	for (const mode of BASE_MODE_STATES) {
		const content = mode.render(ctx);
		if (content !== "") return content;
	}
	return "";
}

function renderApprovalRung(ctx: SegmentContext): string {
	if (ctx.planMode?.enabled) return "";
	const level = normalizeApprovalMode(ctx.session.effectiveApprovalMode?.());
	const color: ThemeColor =
		level === "yolo" ? "error" : level === "auto" ? "warning" : level === "plan" ? "warning" : "modeAccent";
	return theme.fg(color, AUTONOMY_LABEL[level]);
}

function renderBypassMarker(ctx: SegmentContext): string {
	if (!ctx.session.isApprovalBypassed()) return "";
	return theme.fg("error", withIcon(theme.symbol("status.warning"), "YOLO"));
}

const modeSegment: StatusLineSegment = {
	id: "mode",
	render(ctx) {
		const bypass = renderBypassMarker(ctx);
		const content = joinStates(bypass, renderBaseMode(ctx), bypass === "" ? renderApprovalRung(ctx) : "");
		if (content === "") return { content: "", visible: false };
		return { content, visible: true };
	},
};

function iconPin(icon: string): number {
	return icon ? visibleWidth(icon) + 1 : 0;
}

const pathSegment: StatusLineSegment = {
	id: "path",
	render(ctx) {
		const opts = ctx.options.path ?? {};
		const stripPrefix = opts.stripWorkPrefix !== false;

		if (stripPrefix && ctx.worktree) {
			const { projectName, worktreeName } = ctx.worktree;
			const label = ctx.git.branch === worktreeName ? projectName : `${projectName}/${worktreeName}`;
			const content = withIcon(
				theme.icon.worktree,
				clampPathLength(sanitizeStatusText(label), opts.maxLength ?? 40),
			);
			return { content: theme.fg("statusLinePath", content), visible: true, pin: iconPin(theme.icon.worktree) };
		}

		const projectDir = ctx.session.sessionManager?.getCwd?.() ?? ctx.activeRepo?.cwd ?? getProjectDir();
		const { scratch, relative } = classifyProjectDir(projectDir);
		let pwd = projectDir;

		if (stripPrefix) {
			if (scratch) {
				if (relative) pwd = relative;
			} else {
				pwd = stripDisplayRoot(pwd, opts.displayRoots);
			}
		}
		const repoSuffix = ctx.activeRepo ? ` ↳ ${sanitizeStatusText(ctx.activeRepo.relativeRepoRoot)}` : "";
		if (opts.abbreviate !== false) {
			pwd = shortenPath(pwd);
		}

		pwd = clampPathLength(sanitizeStatusText(pwd), opts.maxLength ?? 40);
		if (repoSuffix) {
			pwd = `${pwd}${repoSuffix}`;
		}

		const showScratchIcon = scratch && stripPrefix;
		const icon = showScratchIcon ? theme.icon.scratchFolder : theme.icon.folder;
		const content = withIcon(icon, pwd);
		return { content: theme.fg("statusLinePath", content), visible: true, pin: iconPin(icon) };
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
			content = withIcon(theme.icon.branch, sanitizeStatusText(branch));
		}

		if (isDirty) content = `${content} ${theme.fg("statusLineDirty", "*")}`;
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
const backgroundSegment: StatusLineSegment = {
	id: "background",
	render(ctx) {
		if (ctx.backgroundSessionCount === 0) {
			return { content: "", visible: false };
		}
		const content = withIcon(theme.icon.agents, `${ctx.backgroundSessionCount} bg`);
		return { content: theme.fg("warning", content), visible: true };
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

		let body = "";
		if (cost) body = `$${cost.toFixed(2)}`;
		if (normalizedPremiumRequests)
			body = body
				? `${body} * ${formatNumber(normalizedPremiumRequests)}`
				: `* ${formatNumber(normalizedPremiumRequests)}`;
		if (usingSubscription) body = body ? `${body} (sub)` : "(sub)";
		return { content: theme.fg("statusLineCost", body), visible: true };
	},
};

const CONTEXT_BAR_CELLS = 8;
const CONTEXT_BAR_TIP_STEP_MS = 1000;
const CONTEXT_BAR_TIP_STEP_URGENT_MS = 500;

export function renderContextBar(ratio: number, level: ContextUsageLevel, nowMs: number, live: boolean): string {
	const clamped = Math.min(1, Math.max(0, Number.isFinite(ratio) ? ratio : 0));
	const filled = Math.min(CONTEXT_BAR_CELLS, Math.round(clamped * CONTEXT_BAR_CELLS));
	const levelColor = getContextUsageThemeColor(level);
	let bar = "";
	for (let cell = 0; cell < CONTEXT_BAR_CELLS; cell++) {
		if (live && cell === filled - 1) {
			const stepMs = level === "error" ? CONTEXT_BAR_TIP_STEP_URGENT_MS : CONTEXT_BAR_TIP_STEP_MS;
			const tipOn = Math.floor(nowMs / stepMs) % 2 === 0;
			bar += tipOn ? theme.fg(levelColor, "▰") : theme.fg("dim", "▱");
		} else if (cell < filled) {
			bar += theme.fg(levelColor, "▰");
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
		const level = getContextUsageLevel(pct);
		const remainingRatio = pct === null || pct === undefined ? 1 : Math.max(0, 100 - pct) / 100;
		const bar = renderContextBar(remainingRatio, level, Date.now(), ctx.session.isStreaming);
		const pctText = formatContextRemainingPercent(pct);
		const autoIcon =
			ctx.autoCompactEnabled && theme.icon.auto ? ` ${theme.fg("sessionAccent", theme.icon.auto)}` : "";
		return {
			content: `${bar} ${theme.fg(getContextUsageThemeColor(level), pctText)}${autoIcon}`,
			visible: true,
		};
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

		const mins = PAD2[now.getMinutes()];
		let timeStr = `${hours}:${mins}`;
		if (opts.showSeconds) {
			timeStr += `:${PAD2[now.getSeconds()]}`;
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

		return { content: theme.fg("sessionAccent", withIcon(theme.icon.session, display)), visible: true };
	},
};

const hostnameSegment: StatusLineSegment = {
	id: "hostname",
	render(_ctx) {
		const full = os.hostname();
		const dot = full.indexOf(".");
		const name = dot === -1 ? full : full.slice(0, dot);
		return { content: withIcon(theme.icon.host, name), visible: true };
	},
};

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

const accountSegment: StatusLineSegment = {
	id: "account",
	render(ctx) {
		const account = ctx.account;
		if (!account || account.storedCount < 2) return { content: "", visible: false };
		const label = truncateToWidth(sanitizeStatusText(account.label), TRUNCATE_LENGTHS.CHIP);
		if (!label) return { content: "", visible: false };
		const prefix = account.isPrediction ? "next" : "as";
		return { content: theme.fg("muted", `${prefix} ${label}`), visible: true };
	},
};

const secretsSegment: StatusLineSegment = {
	id: "secrets",
	render(ctx) {
		const live = ctx.session.obfuscator?.liveSecrets();
		if (!live || live.count === 0) return { content: "", visible: false };
		const masked = live.count - live.named;
		const namedLabel = live.named > 0 ? `${live.named} ${live.named === 1 ? "secret" : "secrets"}` : "";
		const maskedLabel = masked > 0 ? `${masked} masked` : "";
		const bodyText = namedLabel && maskedLabel ? `${namedLabel} · ${maskedLabel}` : namedLabel || maskedLabel;
		const body = theme.fg("muted", bodyText);
		const left = live.nextExpiryAt === undefined ? undefined : live.nextExpiryAt - Date.now();
		if (left === undefined || left > SECRET_EXPIRY_CHIP_WINDOW_MS) return { content: body, visible: true };
		const deadline = `${theme.fg("muted", "(")}${theme.fg("warning", describeMsLeft(left))}${theme.fg("muted", ")")}`;
		return { content: `${body} ${deadline}`, visible: true };
	},
};

const cacheReadSegment: StatusLineSegment = {
	id: "cache_read",
	render(ctx) {
		const { cacheRead } = ctx.usageStats;
		if (!cacheRead) return { content: "", visible: false };

		const icon = theme.icon.cache;
		const num = formatNumber(cacheRead);
		const content = icon ? `${icon} ${num}` : num;
		return { content: theme.fg("statusLineSpend", content), visible: true };
	},
};

const cacheWriteSegment: StatusLineSegment = {
	id: "cache_write",
	render(ctx) {
		const { cacheWrite } = ctx.usageStats;
		if (!cacheWrite) return { content: "", visible: false };
		const icon = theme.icon.cache;
		const num = formatNumber(cacheWrite);
		const content = icon ? `${icon} ${num}` : num;
		return { content: theme.fg("statusLineOutput", content), visible: true };
	},
};

const cacheHitSegment: StatusLineSegment = {
	id: "cache_hit",
	render(ctx) {
		const { cacheRead, cacheWrite, input } = ctx.usageStats;
		if (!cacheRead) return { content: "", visible: false };

		const total = cacheRead + cacheWrite + input;

		const rateStr = ((cacheRead / total) * 100).toFixed(2);
		const icon = theme.icon.cache;
		const rateColored = theme.fg("statusLineSpend", `${rateStr}%`);
		const content = icon ? `${icon} ${rateColored}` : rateColored;
		return { content, visible: true };
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
		const label = truncateToWidth(sanitizeStatusText(name), TRUNCATE_LENGTHS.CHIP);
		return { content: `${ansi}${label}\x1b[39m`, visible: true };
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
		if (value < 60) return `${value}m`;
		const hours = Math.floor(value / 60);
		const mins = value % 60;
		return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
	}
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
		const sep = theme.sep.dot;
		let body = "";
		if (u.tier) {
			const tier = truncateToWidth(sanitizeStatusText(u.tier), TRUNCATE_LENGTHS.SHORT);
			if (tier) body = theme.fg("accent", tier);
		}
		if (u.fiveHour) {
			const pct = u.fiveHour.percent;
			const pctText = theme.fg(pickUsageColor(pct), `${Math.round(pct)}%`);
			const reset =
				u.fiveHour.resetMinutes !== undefined
					? theme.fg("muted", ` (${formatUsageReset(u.fiveHour.resetMinutes, "m")})`)
					: "";
			body = body ? `${body}${sep}5h ${pctText}${reset}` : `5h ${pctText}${reset}`;
		}
		if (u.sevenDay) {
			const pct = u.sevenDay.percent;
			const pctText = theme.fg(pickUsageColor(pct), `${Math.round(pct)}%`);
			const reset =
				u.sevenDay.resetHours !== undefined
					? theme.fg("muted", ` (${formatUsageReset(u.sevenDay.resetHours, "h")})`)
					: "";
			body = body ? `${body}${sep}7d ${pctText}${reset}` : `7d ${pctText}${reset}`;
		}
		const content = withIcon(theme.icon.time, body);
		return { content, visible: true };
	},
};

export const SEGMENTS: Record<StatusLineSegmentId, StatusLineSegment> = {
	pi: piSegment,
	model: modelSegment,
	account: accountSegment,
	secrets: secretsSegment,
	mode: modeSegment,
	path: pathSegment,
	git: gitSegment,
	pr: prSegment,
	subagents: subagentsSegment,
	background: backgroundSegment,
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
