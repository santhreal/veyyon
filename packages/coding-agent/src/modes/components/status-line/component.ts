import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentMessage } from "@veyyon/agent-core";
import type { UsageLimit, UsageReport } from "@veyyon/ai";
import {
	type Component,
	MOTION,
	type MotionClock,
	padding,
	SettleValue,
	truncateToWidth,
	visibleWidth,
} from "@veyyon/tui";
import { formatClock, getProjectDir, scopedTimeoutSignal, withScopedTimeoutSignal } from "@veyyon/utils";
import { resolveContextLimit } from "../../../config/compaction-strategy";
import { settings } from "../../../config/settings-instance";
import { accountDisplayLabel, accountsForProvider, buildAccountInventory } from "../../../session/account-inventory";
import type { AgentSession } from "../../../session/agent-session";
import type { OAuthAccountIdentity } from "../../../session/auth-storage";
import type { UsageStatistics } from "../../../session/session-entries";
import { limitMatchesActiveAccount } from "../../../slash-commands/helpers/active-oauth-account";
import { type ActiveRepoContext, resolveActiveRepoContextSync } from "../../../utils/active-repo-context";
import * as git from "../../../utils/git";
import { sanitizeStatusText } from "../../shared";
import { withIcon } from "../../theme/icon-label";
import { transitionsEnabled } from "../../theme/shimmer";
import { theme } from "../../theme/theme";
import { type ContextUsageMemo, messageFingerprint } from "./context-usage";
import { canReuseCachedPr, createPrCacheContext, isSamePrCacheContext, type PrCacheContext } from "./git-utils";
import {
	fitLocation,
	MIN_LOCATION_PART,
	MIN_READABLE_PART,
	type QuietPart,
	type QuietSegmentBounds,
} from "./location-fit";
import { getPreset } from "./presets";
import { focusExitBadge, renderSegment, type SegmentContext } from "./segments";
import { segmentSeparator, stateSeparator } from "./state-grammar";
import { getLastRateableAssistantMessage, tokensPerSecondForMessage } from "./token-rate";
import type {
	CollabStatus,
	EffectiveStatusLineSettings,
	StatusLineSegmentId,
	StatusLineSegmentOptions,
	StatusLineSettings,
} from "./types";

/**
 * Gap between the location group and the total-elapsed clock. Deliberately
 * wider than the standard `  ·  ` separator and dot-free, so the clock reads
 * as its own quiet zone at the end of the line rather than one more segment.
 */
const SESSION_CLOCK_GAP = "      ";
const EMPTY_USAGE_STATS: UsageStatistics = {
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
};
const EMPTY_USAGE_STATS_WITH_RATE: SegmentContext["usageStats"] = {
	...EMPTY_USAGE_STATS,
	tokensPerSecond: null,
};
const EMPTY_SEGMENT_OPTIONS: StatusLineSegmentOptions = {};

export type { ContextUsageMemo } from "./context-usage";
export { messageFingerprint } from "./context-usage";
export type { QuietPart, QuietSegmentBounds } from "./location-fit";
export { CLIP_BOUNDARIES, fitLocation, MIN_LOCATION_PART } from "./location-fit";

/** Join the `content` fields of quiet-line parts with `sep`, without allocating an intermediate array. */
function joinContents(parts: readonly QuietPart[], sep: string): string {
	if (parts.length === 0) return "";
	let result = parts[0]!.content;
	for (let i = 1; i < parts.length; i++) {
		result += sep + parts[i]!.content;
	}
	return result;
}

/** Render a segment and push it into the output array if visible. Module-level to avoid
 *  allocating a closure per frame in #gatherQuietSegments. */
function pushQuietPart(id: StatusLineSegmentId, ctx: SegmentContext, out: QuietPart[]): void {
	if (id === "subagents") return;
	const rendered = renderSegment(id, ctx);
	if (!rendered.visible || !rendered.content) return;
	out.push({ id, content: rendered.content, pin: rendered.pin });
}

/**
 * Shed order for the right group, as a rank rather than a boolean. Higher survives longer;
 * everything unlisted ranks 0 and sheds first, right to left, which is the ordinary case.
 *
 * A rank rather than a flag because "protected" cannot be absolute. When every remaining part
 * was protected the shed had nothing legal to drop, fell through to truncating the joined
 * group, and a one-cell budget rendered a bare `…` — destroying all four at once, including
 * the one the oldest contract here says must be the last thing standing. The ranking makes the
 * degradation ordered instead: the weakest ranked part goes, then the next, and the persistent
 * count is alone on the line before anything clips it.
 * Why each of the six outranks a badge:
 *
 * `background` (6) counts the conversations this process is running that NO screen is showing.
 * It outranks even the persistent subagent count, which is the only thing here it could be
 * accused of crowding out: a running subagent is spending in a transcript the operator is
 * looking at, and a handed-off conversation is spending somewhere they cannot look at all. It
 * renders nothing at zero, so on the overwhelmingly common single-conversation line it costs
 * the width it is worth, and the older contract below never observes it because that fixture
 * has no background conversation.
 *
 * `subagents` (5) is the persistent running count. It is the last thing standing by an older
 * contract than any of the rest: `status-line-running-subagents.test.ts` narrows the footline
 * to exactly the chip's width and requires the number to be what survives.
 *
 * `location_right` (4) is the owner-supplied zone holding the composer's draft token readout.
 * It is pushed LAST and the shed walks from the end, so without a rank it is always the FIRST
 * casualty however important it is. That is how the always-visible approval rung silently
 * evicted the draft counter at 100 columns: nothing removed the counter, the rung widened the
 * right group by one label and the counter fell off the end. Losing the count while the
 * operator is actively typing is a worse trade than dropping a badge they can re-read.
 *
 * `mode` (3) carries the approval rung — the one place that says whether the next command will
 * ask before it runs ("safety state outranks identity").
 *
 * `model` (2) is the active session model identity. Ranking it ensures the model name is preserved
 * against wide location strings (long working directories and git branches) by shortening the location
 * before shedding the model name.
 *
 * `context_pct` (1) is how much room is left before compaction fires — the footline's one live
 * value. `#gatherQuietSegments` appends it AFTER the right group on purpose, so it reads as the
 * line's last word, and the shed walks from the end: the deliberate placement made it the first
 * thing dropped at every width that did not fit, while `session_name`, a fixed string, was kept
 * ahead of it. On the DEFAULT preset at 80 columns that meant no gauge at all, and on `full` at
 * 160 it meant a cache-hit percentage on screen while the number that says when the session
 * ends was gone. It ranks lowest of the five because it is the only one that still reads as a
 * whole thought after the others are gone.
 */
const RIGHT_PART_SHED_RANK: Record<string, number> = {
	context_pct: 1,
	model: 2,
	mode: 3,
	location_right: 4,
	subagents: 5,
	background: 6,
};

/**
 * The part the row gives up next: the lowest-ranked one, taken from the END so that equally
 * ranked parts still go right to left. Index -1 for an empty group.
 */
function weakestRightPart(parts: readonly QuietPart[]): { index: number; rank: number } {
	let index = -1;
	let rank = Number.POSITIVE_INFINITY;
	for (let i = parts.length - 1; i >= 0; i--) {
		const partRank = RIGHT_PART_SHED_RANK[parts[i]?.id ?? ""] ?? 0;
		if (partRank < rank) {
			rank = partRank;
			index = i;
		}
	}
	return { index, rank };
}

/**
 * What the location's FLOOR may be paid with, when the zone has been cut under the width at
 * which a directory or a branch still reads as itself.
 *
 * This is a different question from the shed order above, which asks what the ROW gives up to
 * fit at all, and it wants a different answer. These three are re-readable or recoverable: a
 * percentage is back on the next frame, a draft token estimate is re-derived on the next
 * keystroke, and owner-pinned right content restates itself. The model chip and the mode rungs
 * are not on that list: the chip is what this row exists to retain, and a rung says what the
 * next keystroke will DO, which is not something to spend on a wider directory.
 *
 * Neither is the persistent running-subagent count, which the row sheds LAST of all (see
 * RIGHT_PART_SHED_RANK). Paying the floor with it inverted that order twice over: a row whose
 * only remaining part was the count spent it and rendered nothing at all, and a row narrowing
 * under pressure lost the count while a mode rung it outranks stayed. A count is a small chip
 * and buys the zone almost nothing; the order it sits in is worth more than its three cells.
 * The animated badge slot is off the list for a duller reason: it is unranked, so the shed loop
 * above has already dropped it before this ladder can run.
 *
 * Without this the ladder stopped at the model chip and left the zone under its floor with
 * three spendable parts still on the row -- `…izer  ·  …g-path` beside a token estimate, two
 * fragments that each read as a name in their own right, which is the exact failure
 * MIN_LOCATION_PART exists to prevent.
 */
export const FLOOR_SPENDABLE: Record<string, true> = {
	context_pct: true,
	context_total: true,
	location_right: true,
};
const LOCATION_SEGMENT_IDS: Record<string, true> = { path: true, git: true, pr: true };
const CONTEXT_SEGMENT_IDS: Record<string, true> = { context_pct: true, context_total: true };
const USAGE_SEGMENT_IDS: Record<string, true> = {
	token_in: true,
	token_out: true,
	token_total: true,
	token_rate: true,
	cost: true,
	cache_read: true,
	cache_write: true,
	cache_hit: true,
};

/**
 * The spendable part the location's floor takes next: lowest-ranked first, from the END, so
 * the order among them matches the row's own. -1 when the row holds nothing it may spend.
 */
function weakestSpendablePart(parts: readonly QuietPart[]): number {
	let index = -1;
	let rank = Number.POSITIVE_INFINITY;
	for (let i = parts.length - 1; i >= 0; i--) {
		const id = parts[i]?.id ?? "";
		if (!FLOOR_SPENDABLE[id]) continue;
		const partRank = RIGHT_PART_SHED_RANK[id] ?? 0;
		if (partRank < rank) {
			rank = partRank;
			index = i;
		}
	}
	return index;
}

interface ActiveRepoCache {
	projectDir: string;
	activeRepo: ActiveRepoContext | null;
	effectiveGitCwd: string;
	/** Project + worktree dir name when `projectDir` is a linked worktree, else null. */
	worktree: WorktreeContext | null;
}

interface WorktreeContext {
	/** Primary-checkout (project) name shown by the path segment. */
	projectName: string;
	/** Worktree directory name — suppressed from the path when it equals the branch. */
	worktreeName: string;
}

/**
 * Project + worktree-dir names when `cwd` is a linked git worktree, else null.
 * The project name comes from the shared primary checkout; bare-repo worktrees
 * resolve to the shared `foo.git` dir, so a trailing `.git` is stripped.
 */
function resolveWorktreeContext(cwd: string): WorktreeContext | null {
	const worktree = git.repo.linkedWorktreeSync(cwd);
	if (!worktree) return null;
	const base = path.basename(worktree.primaryRoot);
	const projectName = base.endsWith(".git") ? base.slice(0, -4) : base;
	if (!projectName) return null;
	return { projectName, worktreeName: path.basename(worktree.root) };
}

/**
 * Per-{@link AgentSession} active-processing meter for the `time_spent`
 * segment. `activeMs` is the union of every completed `agent_start`→
 * `agent_end` window; `activeStartedAt` is the start timestamp of the
 * currently-running window, or `null` when idle.
 *
 * `sessionFile` snapshots the loaded session-file path at meter-creation
 * time. `AgentSession.switchSession` (/resume, /move, ACP fork, RPC
 * `switch_session`, extension `switchSession`) mutates the loaded file
 * under the same {@link AgentSession} ref, so the WeakMap key alone
 * cannot tell two conversations apart. `#meter()` compares this snapshot
 * against the live `session.sessionFile`, and a real-to-real change
 * starts the meter fresh instead of crediting the new conversation with
 * the previous one's accumulated active time. The undefined → real
 * first-save transition does not reset, since the session identity has
 * not changed.
 */
interface ActiveMeter {
	activeMs: number;
	activeStartedAt: number | null;
	/** Duration of the most recently COMPLETED run window — what the location
	 * line's stopped clock (`✓ 0:21`) shows once the agent yields. */
	lastRunMs: number;
	sessionFile: string | undefined;
}

const EMPTY_MESSAGES: readonly AgentMessage[] = [];
const STATUS_USAGE_START_DELAY_MS = 0;
const STATUS_USAGE_REFRESH_TIMEOUT_MS = 2_000;
const PREWALK_ENABLED = { enabled: true } as const;

function hasContextSegment(segments: readonly StatusLineSegmentId[]): boolean {
	return segments.includes("context_pct") || segments.includes("context_total");
}
function hasGitSegment(segments: readonly StatusLineSegmentId[]): boolean {
	return segments.includes("git");
}

function hasPrSegment(segments: readonly StatusLineSegmentId[]): boolean {
	return segments.includes("pr");
}
function hasPathSegment(segments: readonly StatusLineSegmentId[]): boolean {
	return segments.includes("path");
}
function hasUsageSegment(segments: readonly StatusLineSegmentId[]): boolean {
	for (const id of segments) {
		if (USAGE_SEGMENT_IDS[id]) return true;
	}
	return false;
}

function hasGitBackedSegment(segments: readonly StatusLineSegmentId[]): boolean {
	return hasGitSegment(segments) || hasPrSegment(segments);
}

/** How the host paints the footline's motion. */
export interface StatusLineMotionOptions {
	/**
	 * Repaint hook for the frames between a click and the row it lands on. Without one the
	 * expansion is a hard cut, which is what every non-interactive caller wants.
	 */
	requestRender?: () => void;
	/** The clock the travel runs on. Tests pass a hand-ticked one. */
	clock?: MotionClock;
}

/** Stable empty array for the no-hooks render path, so the TUI engine's
 * stableRows reference-equality check sees the same identity every frame. */
const EMPTY_HOOK_ROWS: readonly string[] = [];
const EMPTY_BOUNDS: readonly QuietSegmentBounds[] = [];

export class StatusLineComponent implements Component {
	#settings: StatusLineSettings = {};
	#effectiveSettings: EffectiveStatusLineSettings | undefined;
	#cachedBranch: string | null | undefined = undefined;
	/**
	 * The plain branch name for lookups, kept apart from the displayed label.
	 * `#cachedBranch` may carry an operation suffix (`topic|REBASE`), which is
	 * for reading, not for querying a forge by.
	 */
	#cachedPrBranch: string | null = null;
	#cachedBranchRepoId: string | null | undefined = undefined;
	#cachedBranchCwd: string | undefined = undefined;
	#gitWatcher: fs.FSWatcher | null = null;
	#onBranchChange: (() => void) | null = null;
	#disposed = false;
	#autoCompactEnabled: boolean = true;
	#hookStatuses: Map<string, string> = new Map();
	#cachedHookRows: readonly string[] = EMPTY_HOOK_ROWS;
	#cachedHookSig = "";
	#subagentCount: number = 0;
	#backgroundSessionCount: number = 0;
	/**
	 * Active-processing accounting for the `time_spent` segment, keyed per
	 * {@link AgentSession} so the focus-controller mid-turn attach path
	 * cannot leak an unmatched synthesized `agent_start` from a subagent
	 * into the main session's meter.
	 *
	 * Each meter is `{ activeMs, activeStartedAt }`: `activeMs` is the union
	 * of every completed `agent_start`→`agent_end` window since
	 * {@link resetActiveTime} last reset it; `activeStartedAt` is the start
	 * timestamp of the currently-running window (or `null` when idle).
	 * `getActiveMs()` returns `activeMs + (now - activeStartedAt)` for the
	 * currently-attached session, so the counter ticks live during a turn
	 * and freezes the instant the agent yields.
	 *
	 * WeakMap so meters die with their session (e.g. a parked subagent
	 * dropped from the registry); the main session's meter survives focus
	 * round-trips because the same {@link AgentSession} ref is reused.
	 */
	#activeMeters: WeakMap<AgentSession, ActiveMeter> = new WeakMap();
	#planModeStatus: { enabled: boolean; paused: boolean } | null = null;
	#loopModeStatus: { enabled: boolean } | null = null;
	#goalModeStatus: { enabled: boolean; paused: boolean } | null = null;
	#vibeModeStatus: { enabled: boolean } | null = null;
	#collabStatus: CollabStatus | null = null;
	#focusedAgentId: string | undefined;
	#activeRepoCache: ActiveRepoCache | undefined;

	// Git status caching (1s TTL)
	#cachedGitStatus: git.GitStatusSummary | null = null;
	#cachedGitStatusCwd: string | undefined = undefined;
	#gitStatusLastFetch = 0;
	#gitStatusInFlightCwd: string | undefined = undefined;

	// PR lookup caching (invalidated on branch/repo context changes)
	#cachedPr: { number: number; url: string } | null | undefined = undefined;
	#cachedPrContext: PrCacheContext | undefined = undefined;
	#prLookupInFlight = false;
	#defaultBranch?: string;
	#defaultBranchCwd: string | undefined = undefined;
	#lastTokensPerSecond: number | null = null;
	#lastTokensPerSecondMsg: { timestamp: number } | null = null;

	// Provider usage caching (5-min TTL, OAuth/sub only)
	#cachedUsage: {
		tier?: string;
		fiveHour?: { percent: number; resetMinutes?: number };
		sevenDay?: { percent: number; resetHours?: number };
	} | null = null;
	#cachedUsageContextKey: string | null = null;
	#usageFetchedAt = 0;
	#usageInFlight = false;
	#usageStartTimer: Timer | null = null;
	/**
	 * Serving-account memo. The label ladder has ONE owner ({@link accountDisplayLabel} over the
	 * account inventory), and reaching it means reading every stored credential plus the
	 * failed-refresh list, which is far too much work for a line that redraws on every spinner
	 * tick. The key holds the cheap facts that can change the answer — the provider, how many
	 * credentials it stores, which one routing says is serving, and that account's stored name — so
	 * the rebuild happens when one of them moves and not otherwise. The name is in the key because
	 * renaming an account from the card must change this line, not the line after next.
	 */
	#cachedServingAccount: {
		key: string;
		value: { label: string; storedCount: number; isPrediction: boolean } | null;
	} | null = null;
	// Context-usage memo. The status line redraws on every agent event, so the
	// hot path must not recompute context tokens unless an input changed.
	// `getContextUsage()` anchors on the last assistant's real prompt-token
	// count (matching the provider and the `/context` panel), so a stable
	// message list + model window yields a stable result we can return verbatim.
	#contextUsageCache: ContextUsageMemo | undefined;
	// Reusable SegmentContext: #buildSegmentContext updates this in-place every
	// frame instead of allocating a new ~25-field object. Safe because ctx is
	// consumed synchronously by renderSegment and never stored.
	#ctx: SegmentContext | undefined;
	// Pre-allocated arrays for #gatherQuietSegments: cleared and refilled every
	// frame instead of allocating new arrays. Safe because both callers
	// (renderQuietLine, renderQuietLines) consume them synchronously.
	#quietLocation: QuietPart[] = [];
	#quietCapLeft: QuietPart[] = [];
	#quietCapRight: QuietPart[] = [];
	#quietContextFromLeft: QuietPart[] = [];
	#quietGatherResult: { location: QuietPart[]; capLeft: QuietPart[]; capRight: QuietPart[] } = {
		location: this.#quietLocation,
		capLeft: this.#quietCapLeft,
		capRight: this.#quietCapRight,
	};
	#quietLocationContents: string[] = [];
	#quietBadgeParts: string[] = [];
	#quietRightParts: QuietPart[] = [];
	#quietBounds: QuietSegmentBounds[] = [];
	#quietShiftedBounds: QuietSegmentBounds[] = [];

	/**
	 * The path expansion, as a value between the collapsed row and the expanded one, or
	 * undefined when the host gave no repaint hook: a widening row nobody paints is a timer
	 * with no picture, and every caller that only renders (tests, the two-line selector) gets
	 * the hard cut it always got.
	 */
	readonly #expansion: SettleValue | undefined;

	constructor(
		private session: AgentSession,
		motion: StatusLineMotionOptions = {},
	) {
		if (motion.requestRender) {
			this.#expansion = new SettleValue({
				requestRender: motion.requestRender,
				clock: motion.clock,
				curve: MOTION.reflow,
			});
			// Seed the resting state so the FIRST click travels. SettleValue lands its first
			// value without motion -- a gauge that sweeps up from zero on its first paint is
			// animating the session starting -- and here that first value is the collapsed row,
			// which is where the row already is.
			this.#expansion.set(0);
		}
		this.#settings = {
			preset: settings.get("statusLine.preset"),
			leftSegments: settings.get("statusLine.leftSegments"),
			rightSegments: settings.get("statusLine.rightSegments"),
			separator: settings.get("statusLine.separator"),
			showHookStatus: settings.get("statusLine.showHookStatus"),
			segmentOptions: settings.getGroup("statusLine").segmentOptions,
			sessionAccent: settings.get("statusLine.sessionAccent"),
			transparent: settings.get("statusLine.transparent"),
			compactThinkingLevel: settings.get("statusLine.compactThinkingLevel"),
		};
	}
	#gitEnabled(): boolean {
		return settings.get("git.enabled");
	}
	#hasGitBackedSegment(): boolean {
		const effectiveSettings = this.#resolveSettings();
		return (
			hasGitBackedSegment(effectiveSettings.leftSegments) || hasGitBackedSegment(effectiveSettings.rightSegments)
		);
	}

	#resolveActiveRepoCache(): ActiveRepoCache {
		const projectDir = this.session.sessionManager?.getCwd?.() ?? getProjectDir();
		if (this.#activeRepoCache?.projectDir === projectDir) {
			return this.#activeRepoCache;
		}

		const activeRepo = resolveActiveRepoContextSync(projectDir);
		const effectiveGitCwd = activeRepo?.repoRoot ?? projectDir;
		// Only collapse the bare-cwd case: a single-direct-child-repo context
		// (activeRepo set) renders `<parent> ↳ <child>`, which we leave intact.
		const worktree = activeRepo ? null : resolveWorktreeContext(effectiveGitCwd);
		this.#activeRepoCache = { projectDir, activeRepo, effectiveGitCwd, worktree };
		return this.#activeRepoCache;
	}

	/**
	 * Re-point the status line at another session (focus proxy). Invalidate: model/context/usage all derive
	 * from it. `focusedAgentId` is the focused subagent id while the view is proxied, undefined for main.
	 */
	setSession(session: AgentSession, focusedAgentId?: string): void {
		const sessionChanged = this.session !== session;
		if (!sessionChanged && this.#focusedAgentId === focusedAgentId) return;
		this.session = session;
		this.#focusedAgentId = focusedAgentId;
		if (sessionChanged) {
			this.#invalidateSessionCaches();
			this.#closeStaleActiveWindow();
		}
		this.invalidate();
	}

	/**
	 * Drop a meter's in-flight window when the newly-attached session is no
	 * longer streaming. Handles the case where the focus controller
	 * synthesized an `agent_start` on a mid-turn attach but the matching
	 * real `agent_end` never reached us — the user detached before it
	 * fired, and re-focusing later (after the agent finished) would
	 * otherwise tick over the entire detached gap. Crediting that gap to
	 * `activeMs` would be wrong (the agent finished at some point we never
	 * observed), so the window is dropped rather than folded in.
	 */
	#closeStaleActiveWindow(): void {
		const meter = this.#meter();
		if (meter.activeStartedAt === null) return;
		if (this.session.isStreaming) return;
		meter.activeStartedAt = null;
	}

	updateSettings(settings: StatusLineSettings): void {
		this.#settings = settings;
		this.#effectiveSettings = undefined;
		this.#cachedQuietOptsBaseRef = undefined;
		if (this.#onBranchChange) this.#setupGitWatcher();
	}

	getEffectiveSettingsForTest(): EffectiveStatusLineSettings {
		return this.#resolveSettings();
	}

	setAutoCompactEnabled(enabled: boolean): void {
		this.#autoCompactEnabled = enabled;
	}

	setSubagentCount(count: number): void {
		this.#subagentCount = Number.isFinite(count) ? Math.max(0, Math.trunc(count)) : 0;
	}

	/** Currently executing subagents shown on every interactive status surface. */
	get subagentCount(): number {
		return this.#subagentCount;
	}

	setBackgroundSessionCount(count: number): void {
		const next = Number.isFinite(count) ? Math.max(0, Math.trunc(count)) : 0;
		if (next === this.#backgroundSessionCount) return;
		this.#backgroundSessionCount = next;
		this.invalidate();
	}

	/** Conversations still running that no screen is showing. */
	get backgroundSessionCount(): number {
		return this.#backgroundSessionCount;
	}

	/**
	 * Reset the currently-attached session's active-time accumulators so
	 * the `time_spent` segment starts from zero. Called from `/clear`,
	 * fresh-session, and joined-collab paths; both the completed
	 * accumulator and any in-flight window are dropped, so a reset
	 * mid-turn ignores the running window (the matching `markActivityEnd`
	 * will see an idle meter and no-op).
	 */
	resetActiveTime(): void {
		const meter = this.#meter();
		meter.activeMs = 0;
		meter.activeStartedAt = null;
		meter.lastRunMs = 0;
	}

	/**
	 * Mark the currently-attached session as having started a unit of
	 * active processing. Idempotent: a second start while a window is
	 * already open is a no-op, so reentrant `agent_start` events (e.g.
	 * nested auto-compaction loops, focus-controller mid-turn attach onto
	 * an already-running window) do not double-count.
	 */
	markActivityStart(): void {
		const meter = this.#meter();
		if (meter.activeStartedAt !== null) return;
		meter.activeStartedAt = Date.now();
	}

	/**
	 * Close the currently-attached session's open active-processing
	 * window, folding its elapsed time into the accumulator. Idempotent
	 * when the meter is already idle so callers can fire it on every
	 * `agent_end` without guarding.
	 */
	markActivityEnd(): void {
		const meter = this.#meter();
		if (meter.activeStartedAt === null) return;
		const windowMs = Math.max(0, Date.now() - meter.activeStartedAt);
		meter.activeMs += windowMs;
		meter.lastRunMs = windowMs;
		meter.activeStartedAt = null;
	}

	/**
	 * Run-clock snapshot for the location line: `runningMs` is the current
	 * run's live elapsed (null when the agent is idle), `lastRunMs` the
	 * duration of the most recently completed run (0 before the first run).
	 */
	getRunClock(): { runningMs: number | null; lastRunMs: number } {
		const meter = this.#meter();
		return {
			runningMs: meter.activeStartedAt === null ? null : Math.max(0, Date.now() - meter.activeStartedAt),
			lastRunMs: meter.lastRunMs,
		};
	}

	/**
	 * Snapshot of total active-processing time for the currently-attached
	 * session, including any in-flight window. Exposed for the segment
	 * context builder; tests assert against this too.
	 */
	getActiveMs(): number {
		const meter = this.#meter();
		if (meter.activeStartedAt === null) return meter.activeMs;
		return meter.activeMs + Math.max(0, Date.now() - meter.activeStartedAt);
	}

	/**
	 * Return (lazily creating) the meter for the currently-attached
	 * session. Detects an in-place session-file swap under the same
	 * {@link AgentSession} ref (`switchSession` paths: `/resume`, `/move`,
	 * ACP fork/load, RPC `switch_session`, extension `switchSession`):
	 * a real-to-real change starts the meter fresh so the new
	 * conversation does not inherit the previous one's accumulated active
	 * time. The undefined → real first-save transition only refreshes the
	 * snapshot — the conversation identity has not changed.
	 */
	#meter(): ActiveMeter {
		const currentFile = this.session.sessionFile;
		let meter = this.#activeMeters.get(this.session);
		if (meter) {
			const switched =
				currentFile !== undefined && meter.sessionFile !== undefined && meter.sessionFile !== currentFile;
			if (switched) {
				meter = undefined;
			} else {
				meter.sessionFile = currentFile;
			}
		}
		if (!meter) {
			meter = { activeMs: 0, activeStartedAt: null, lastRunMs: 0, sessionFile: currentFile };
			this.#activeMeters.set(this.session, meter);
		}
		return meter;
	}

	setPlanModeStatus(status: { enabled: boolean; paused: boolean } | undefined): void {
		this.#planModeStatus = status ?? null;
	}

	setLoopModeStatus(status: { enabled: boolean } | undefined): void {
		this.#loopModeStatus = status ?? null;
	}

	setGoalModeStatus(status: { enabled: boolean; paused: boolean } | undefined): void {
		this.#goalModeStatus = status ?? null;
	}

	setVibeModeStatus(status: { enabled: boolean } | undefined): void {
		this.#vibeModeStatus = status ?? null;
	}

	setCollabStatus(status: CollabStatus | null): void {
		this.#collabStatus = status;
	}

	setHookStatus(key: string, text: string | undefined): void {
		if (text === undefined) {
			this.#hookStatuses.delete(key);
		} else {
			this.#hookStatuses.set(key, text);
		}
	}

	watchBranch(onBranchChange: () => void): void {
		this.#onBranchChange = onBranchChange;
		this.#setupGitWatcher();
	}

	#setupGitWatcher(): void {
		if (this.#gitWatcher) {
			this.#gitWatcher.close();
			this.#gitWatcher = null;
		}

		if (!this.#gitEnabled() || !this.#hasGitBackedSegment()) {
			this.#invalidateGitCaches();
			return;
		}

		const { effectiveGitCwd } = this.#resolveActiveRepoCache();
		const repository = git.repo.resolveSync(effectiveGitCwd);
		if (!repository) return;

		const watchPath = git.repo.isReftableSync(repository)
			? path.join(repository.gitDir, "reftable")
			: repository.headPath;

		try {
			this.#gitWatcher = fs.watch(watchPath, () => {
				if (this.#disposed) return;
				this.#invalidateGitCaches();
				if (this.#onBranchChange) {
					this.#onBranchChange();
				}
			});
		} catch {
			this.#invalidateGitCaches();
		}
	}

	dispose(): void {
		this.#disposed = true;
		this.#onBranchChange = null;
		this.#clearUsageStartTimer();
		// A travel with no row left to paint is a repaint loop for a component that is gone.
		this.#expansion?.dispose();
		if (this.#gitWatcher) {
			this.#gitWatcher.close();
			this.#gitWatcher = null;
		}
	}

	#clearUsageStartTimer(): void {
		if (!this.#usageStartTimer) return;
		clearTimeout(this.#usageStartTimer);
		this.#usageStartTimer = null;
	}

	invalidate(): void {
		this.#invalidateGitCaches();
		this.#cachedHookSig = "";
		this.#cachedHookRows = EMPTY_HOOK_ROWS;
		this.#cachedSubagentBadgeCount = -1;
	}
	#invalidateSessionCaches(): void {
		this.#clearUsageStartTimer();
		this.#cachedUsage = null;
		this.#usageFetchedAt = 0;
		this.#usageInFlight = false;
		this.#contextUsageCache = undefined;
		this.#lastTokensPerSecond = null;
		this.#lastTokensPerSecondMsg = null;
	}

	#invalidateGitCaches(): void {
		this.#cachedBranch = undefined;
		this.#cachedBranchRepoId = undefined;
		this.#cachedBranchCwd = undefined;
		this.#cachedPrContext = undefined;
		this.#cachedGitCtx = undefined;
		this.#cachedGitCtxBranch = undefined;
		this.#cachedGitCtxStatus = undefined;
		this.#cachedGitCtxPr = undefined;
	}
	#getCurrentBranch(effectiveGitCwd?: string): string | null {
		if (!this.#gitEnabled()) return null;

		const gitCwd = effectiveGitCwd ?? this.#resolveActiveRepoCache().effectiveGitCwd;
		if (this.#cachedBranch !== undefined && this.#cachedBranchCwd === gitCwd) {
			return this.#cachedBranch;
		}

		const head = git.head.resolveSync(gitCwd);
		const gitHeadPath = head?.headPath ?? null;
		this.#cachedBranchCwd = gitCwd;
		this.#cachedBranchRepoId = gitHeadPath;
		if (!head) {
			this.#cachedBranch = null;
			this.#cachedPrBranch = null;
			return null;
		}

		const operation = git.head.operation(head);
		this.#cachedBranch = git.head.label(head, operation);
		this.#cachedPrBranch = git.head.branchForLookup(head, operation);

		return this.#cachedBranch ?? null;
	}

	#isDefaultBranch(branch: string, effectiveGitCwd: string): boolean {
		if (this.#defaultBranchCwd !== effectiveGitCwd) {
			this.#defaultBranch = undefined;
			this.#defaultBranchCwd = effectiveGitCwd;
		}

		if (this.#defaultBranch === undefined) {
			this.#defaultBranch = "main";
			const lookupCwd = effectiveGitCwd;
			// Wrapped like the status and PR lookups beside it: `git()` REJECTS when the
			// binary is missing rather than returning a non-zero result, and this is the
			// one unawaited lookup here that used to let that escape. A directory holding
			// a `.git` on a host with no git on PATH -- a copied tree, a slim container --
			// then raised an unhandled rejection out of a render. The `"main"` fallback
			// assigned above is what a failed lookup is supposed to leave behind.
			(async () => {
				try {
					const resolved = await git.branch.default(lookupCwd);
					if (this.#disposed || this.#defaultBranchCwd !== lookupCwd) return;
					if (resolved) {
						this.#defaultBranch = resolved;
						if (this.#onBranchChange) {
							this.#onBranchChange();
						}
					}
				} catch {
					// Keep the `"main"` fallback; a decoration cannot fail a render.
				}
			})();
		}
		return branch === this.#defaultBranch;
	}

	#getGitStatus(effectiveGitCwd?: string): git.GitStatusSummary | null {
		if (!this.#gitEnabled()) return null;

		const gitCwd = effectiveGitCwd ?? this.#resolveActiveRepoCache().effectiveGitCwd;
		if (this.#gitStatusInFlightCwd !== undefined) {
			return this.#cachedGitStatusCwd === gitCwd ? this.#cachedGitStatus : null;
		}
		if (this.#cachedGitStatusCwd === gitCwd && Date.now() - this.#gitStatusLastFetch < 1000) {
			return this.#cachedGitStatus;
		}

		this.#gitStatusInFlightCwd = gitCwd;

		(async () => {
			let nextStatus: git.GitStatusSummary | null = null;
			try {
				nextStatus = await git.status.summary(gitCwd);
			} catch {
				nextStatus = null;
			} finally {
				if (this.#gitStatusInFlightCwd === gitCwd) {
					this.#cachedGitStatus = nextStatus;
					this.#cachedGitStatusCwd = gitCwd;
					this.#gitStatusLastFetch = Date.now();
					this.#gitStatusInFlightCwd = undefined;
				}
			}
		})();

		return this.#cachedGitStatusCwd === gitCwd ? this.#cachedGitStatus : null;
	}

	#lookupPr(effectiveGitCwd?: string): { number: number; url: string } | null {
		if (!this.#gitEnabled()) return null;

		const gitCwd = effectiveGitCwd ?? this.#resolveActiveRepoCache().effectiveGitCwd;
		const branch = this.#getCurrentBranch(gitCwd);
		const currentContext = branch ? createPrCacheContext(branch, this.#cachedBranchRepoId ?? null) : null;

		if (canReuseCachedPr(this.#cachedPr, this.#cachedPrContext, currentContext)) {
			return this.#cachedPr ?? null;
		}

		const stalePr = this.#cachedPr;

		if (!branch) {
			this.#cachedPr = null;
			this.#cachedPrContext = undefined;
			return null;
		}

		// Don't look up without a plain branch to look up BY (detached, or an
		// operation in progress), on the default branch, or with one in flight.
		const lookupBranch = this.#cachedPrBranch;
		if (!lookupBranch || this.#isDefaultBranch(lookupBranch, gitCwd) || this.#prLookupInFlight) {
			return stalePr ?? null;
		}

		this.#prLookupInFlight = true;
		const lookupContext = currentContext;
		const lookupCwd = gitCwd;

		// Fire async lookup, keep stale value visible until resolved
		(async () => {
			// Helper: only write cache if branch/repo context hasn't changed since launch
			const setCachedPr = (value: { number: number; url: string } | null) => {
				const latestBranch = this.#getCurrentBranch(lookupCwd);
				const latestContext = latestBranch
					? createPrCacheContext(latestBranch, this.#cachedBranchRepoId ?? null)
					: undefined;
				if (lookupContext && isSamePrCacheContext(latestContext, lookupContext)) {
					this.#cachedPr = value;
					this.#cachedPrContext = lookupContext;
				}
			};
			try {
				// Route through the shared `gh` helper so the child inherits
				// `GH_NON_INTERACTIVE_ENV` (disables terminal/keychain prompts) and
				// hard-terminates on the git command deadline instead of stalling
				// the status-line indefinitely (#4234). Requires `gh repo set-default`;
				// non-zero exit still falls through to the null cache below.
				const result = await withScopedTimeoutSignal(git.GIT_COMMAND_TIMEOUT_MS, signal =>
					git.github.run(lookupCwd, ["pr", "view", "--json", "number,url"], signal),
				);
				if (this.#disposed) return;
				if (result.exitCode !== 0) {
					setCachedPr(null);
					return;
				}
				const pr = JSON.parse(result.stdout) as { number: number; url: string };
				if (typeof pr.number === "number") {
					setCachedPr({ number: pr.number, url: pr.url });
				} else {
					setCachedPr(null);
				}
			} catch {
				if (this.#disposed) return;
				setCachedPr(null);
			} finally {
				this.#prLookupInFlight = false;
				if (!this.#disposed && this.#onBranchChange) {
					this.#onBranchChange();
				}
			}
		})();

		return stalePr ?? null;
	}

	#getTokensPerSecond(): number | null {
		const last = getLastRateableAssistantMessage(this.session.state.messages);
		if (!last) {
			this.#lastTokensPerSecond = null;
			this.#lastTokensPerSecondMsg = null;
			return null;
		}
		const rate = tokensPerSecondForMessage(last, this.session.isStreaming);
		if (rate !== null) {
			this.#lastTokensPerSecond = rate;
			this.#lastTokensPerSecondMsg = last;
			return rate;
		}
		if (this.#lastTokensPerSecondMsg === last) return this.#lastTokensPerSecond;
		return null;
	}

	#getUsageContextKey(session: AgentSession): string {
		const activeProvider = session.state.model?.provider ?? session.model?.provider ?? "";
		if (!activeProvider) return "";
		const identity = session.modelRegistry?.authStorage?.getOAuthAccountIdentity(activeProvider, session.sessionId);
		// orgId is part of the key: rotating between two same-email Anthropic
		// subscriptions must invalidate the cached usage immediately instead of
		// showing the previous org's quota for the rest of the cache TTL.
		return `${activeProvider}\0${identity?.accountId ?? ""}\0${identity?.email ?? ""}\0${identity?.projectId ?? ""}\0${identity?.orgId ?? ""}`;
	}

	/**
	 * Which stored credential is serving the active provider, and how many it stores.
	 *
	 * Reports the fact only; whether one account is worth naming on the line is the segment's
	 * decision. Prefers what routing says is ACTIVE over what the user selected, because those
	 * differ exactly when the interesting thing happened — a chosen account was rate-limit blocked
	 * or revoked and traffic moved — and the line has to name what is being spent, not what was
	 * picked. Falls back to the first stored credential, which is what an unselected provider uses.
	 *
	 * Carries whether the answer is a PREDICTION. Routing answers with the account the next request
	 * would use even before one has gone out, so this resolver has a label to report from the first
	 * frame; the flag is what stops the line from wording that as an account already being spent.
	 * It joins the memo key, because the flip from predicted to observed happens on the first
	 * request with everything else about the account unchanged, and a key that could not see it
	 * would pin the opening wording for the rest of the cache's life.
	 */
	#servingAccount(session: AgentSession): { label: string; storedCount: number; isPrediction: boolean } | null {
		// Read here rather than in the segment, so the whole inventory walk below is skipped as well as
		// the chip: an operator who has not asked for this pays neither the width nor the work.
		if (!settings.get("statusLine.showAccount")) return null;
		const activeProvider = session.state.model?.provider ?? session.model?.provider;
		const authStorage = session.modelRegistry?.authStorage;
		if (!activeProvider || !authStorage) return null;
		const stored = authStorage.listStoredCredentials(activeProvider);
		if (stored.length === 0) return null;
		const routing = authStorage.sessionCredentialRouting(activeProvider, session.sessionId);
		const servingId = routing?.activeCredentialId ?? routing?.selectedCredentialId ?? stored[0]?.id;
		if (servingId === undefined) return null;
		const key = `${activeProvider}\0${servingId}\0${stored.length}\0${authStorage.getAccountName(activeProvider, servingId) ?? ""}\0${routing?.activeIsPrediction === true ? "next" : "serving"}`;
		const cached = this.#cachedServingAccount;
		if (cached?.key === key) return cached.value;
		const rows = accountsForProvider(
			buildAccountInventory(authStorage, { sessionId: session.sessionId }),
			activeProvider,
		);
		const serving = rows.find(row => row.credentialId === servingId) ?? rows[0];
		const value = serving
			? {
					label: accountDisplayLabel(serving),
					storedCount: rows.length,
					isPrediction: serving.activeForSession && serving.activeIsPrediction,
				}
			: null;
		this.#cachedServingAccount = { key, value };
		return value;
	}

	/**
	 * Startup redraws only arm a short-delayed task; timeout releases the render
	 * cadence while a late successful fetch can still refresh the cached segment.
	 */
	refreshUsageInBackground(): void {
		const now = Date.now();
		const session = this.session;
		const usageContextKey = this.#getUsageContextKey(session);
		if (this.#cachedUsageContextKey !== usageContextKey) {
			this.#cachedUsage = null;
			this.#usageFetchedAt = 0;
			this.#cachedUsageContextKey = usageContextKey;
		}
		if (this.#usageInFlight || this.#usageStartTimer) return;
		if (this.#usageFetchedAt > 0 && now - this.#usageFetchedAt < 5 * 60_000) return;
		const fetcher = (session as { fetchUsageReports?: (signal?: AbortSignal) => Promise<unknown> }).fetchUsageReports;
		if (typeof fetcher !== "function") return;
		this.#usageInFlight = true;
		this.#usageStartTimer = setTimeout(() => {
			this.#usageStartTimer = null;
			void this.#runUsageRefresh(session, fetcher);
		}, STATUS_USAGE_START_DELAY_MS);
	}

	async #runUsageRefresh(session: AgentSession, fetcher: (signal?: AbortSignal) => Promise<unknown>): Promise<void> {
		if (this.#disposed || this.session !== session) {
			this.#usageInFlight = false;
			return;
		}
		const { signal, cancel } = scopedTimeoutSignal(STATUS_USAGE_REFRESH_TIMEOUT_MS);
		let reportsPromise: Promise<unknown> | undefined;
		try {
			reportsPromise = fetcher.call(session, signal);
			this.#applyUsageRefreshReports(session, await this.#raceUsageRefreshWithSignal(reportsPromise, signal));
		} catch {
			if (this.session !== session) return;
			this.#usageFetchedAt = Date.now();
			if (signal.aborted && reportsPromise) {
				this.#observeLateUsageRefresh(session, reportsPromise);
			}
		} finally {
			cancel();
			if (this.session === session) this.#usageInFlight = false;
		}
	}

	#applyUsageRefreshReports(session: AgentSession, reports: unknown): void {
		if (this.#disposed || this.session !== session) return;
		const activeProvider = session.state.model?.provider ?? session.model?.provider;
		const activeIdentity =
			activeProvider && session.modelRegistry?.authStorage
				? session.modelRegistry.authStorage.getOAuthAccountIdentity(activeProvider, session.sessionId)
				: undefined;
		this.#cachedUsage = this.#normalizeUsageReports(reports, activeProvider, activeIdentity);
		this.#usageFetchedAt = Date.now();
	}

	#observeLateUsageRefresh(session: AgentSession, reportsPromise: Promise<unknown>): void {
		void reportsPromise
			.then(reports => {
				this.#applyUsageRefreshReports(session, reports);
			})
			.catch(() => {
				if (this.#disposed || this.session !== session) return;
				this.#usageFetchedAt = Date.now();
			});
	}

	async #raceUsageRefreshWithSignal(promise: Promise<unknown>, signal: AbortSignal): Promise<unknown> {
		if (signal.aborted) throw signal.reason;
		const aborted = Promise.withResolvers<never>();
		const onAbort = () => aborted.reject(signal.reason);
		signal.addEventListener("abort", onAbort, { once: true });
		try {
			return await Promise.race([promise, aborted.promise]);
		} finally {
			signal.removeEventListener("abort", onAbort);
		}
	}

	#normalizeUsageReports(
		reports: unknown,
		activeProvider?: string,
		activeIdentity?: OAuthAccountIdentity,
	): {
		tier?: string;
		fiveHour?: { percent: number; resetMinutes?: number };
		sevenDay?: { percent: number; resetHours?: number };
	} | null {
		if (!Array.isArray(reports)) return null;
		let fiveHour: { percent: number; resetMinutes?: number } | undefined;
		let sevenDay: { percent: number; resetHours?: number } | undefined;
		let fiveHourTier: string | undefined;
		let sevenDayTier: string | undefined;
		const now = Date.now();
		for (const report of reports) {
			if (!report || typeof report !== "object") continue;
			const provider = (report as { provider?: unknown }).provider;
			if (activeProvider && provider !== activeProvider) continue;
			const limits = (report as { limits?: unknown }).limits;
			if (!Array.isArray(limits)) continue;
			for (const limit of limits) {
				if (!limit || typeof limit !== "object") continue;
				if (
					activeIdentity &&
					!limitMatchesActiveAccount(report as UsageReport, limit as UsageLimit, activeIdentity)
				) {
					continue;
				}
				const l = limit as {
					scope?: { windowId?: string; tier?: string };
					window?: { resetsAt?: number };
					amount?: { usedFraction?: number };
				};
				const fraction = l.amount?.usedFraction;
				if (typeof fraction !== "number") continue;
				const windowId = l.scope?.windowId;
				const tier = l.scope?.tier;
				const resetsAt = l.window?.resetsAt;
				// Accept tiered limits, but prefer untiered (backward compat with Anthropic).
				// An untiered limit always replaces a tiered one; among same-tieredness, first wins.
				if (windowId === "5h" && (!fiveHour || (fiveHourTier !== undefined && !tier))) {
					fiveHour = {
						percent: fraction * 100,
						resetMinutes:
							typeof resetsAt === "number" ? Math.max(0, Math.round((resetsAt - now) / 60_000)) : undefined,
					};
					fiveHourTier = tier || undefined;
				}
				if (windowId === "7d" && (!sevenDay || (sevenDayTier !== undefined && !tier))) {
					sevenDay = {
						percent: fraction * 100,
						resetHours:
							typeof resetsAt === "number" ? Math.max(0, Math.round((resetsAt - now) / 3_600_000)) : undefined,
					};
					sevenDayTier = tier || undefined;
				}
			}
		}
		if (!fiveHour && !sevenDay) return null;
		// Single compact label; prefer the five-hour tier if displayed windows ever disagree.
		const effectiveTier = fiveHourTier ?? sevenDayTier;
		return { tier: effectiveTier, fiveHour, sevenDay };
	}

	/**
	 * Used-tokens / context-window totals for the status-line context% segment,
	 * memoized so the per-event redraw stays O(1) when nothing changed.
	 *
	 * The numerator comes from `session.getContextUsage()`, which anchors on the
	 * last assistant's real prompt-token count — so the bar matches the provider
	 * and the `/context` panel — and reports `null` while that count is unknown
	 * (right after compaction, before the next response). Exposed (non-private)
	 * for unit tests and the collab host's state broadcast.
	 */
	getCachedContextBreakdown(): { usedTokens: number | null; contextWindow: number } {
		const messages = this.session.messages ?? EMPTY_MESSAGES;
		const modelContextWindow = this.session.model?.contextWindow ?? 0;
		const length = messages.length;
		const lastFingerprint = length > 0 ? messageFingerprint(messages[length - 1]!) : undefined;
		// Bumps when the in-flight pending snapshot is set/cleared. Without it a
		// value computed mid-turn (estimate of the active tail) would survive after
		// the turn ends/aborts, since clearing the snapshot touches no message.
		const contextUsageRevision = this.session.contextUsageRevision ?? 0;

		const systemPrompt = this.session.systemPrompt;
		const tools = this.session.agent?.state?.tools;
		const skills = this.session.skills;

		const cache = this.#contextUsageCache;
		if (
			cache &&
			cache.messagesRef === messages &&
			cache.length === length &&
			cache.lastFingerprint === lastFingerprint &&
			cache.modelContextWindow === modelContextWindow &&
			cache.contextUsageRevision === contextUsageRevision &&
			cache.systemPromptRef === systemPrompt &&
			cache.toolsRef === tools &&
			cache.skillsRef === skills
		) {
			return { usedTokens: cache.usedTokens, contextWindow: cache.contextWindow };
		}

		const usage = this.session.getContextUsage();
		// `undefined` from the session means "no anchor yet", which is a different fact
		// from zero tokens and is carried as `null` rather than flattened into a number.
		const usedTokens = usage?.tokens ?? null;
		const contextWindow = usage?.contextWindow ?? modelContextWindow;
		this.#contextUsageCache = {
			messagesRef: messages,
			length,
			lastFingerprint,
			modelContextWindow,
			contextUsageRevision,
			usedTokens,
			contextWindow,
			systemPromptRef: systemPrompt,
			toolsRef: tools,
			skillsRef: skills,
		};
		return { usedTokens, contextWindow };
	}

	#buildSegmentContext(
		width: number,
		segmentOptions: StatusLineSettings["segmentOptions"],
		includePath: boolean,
		includeContext: boolean,
		includeGit: boolean,
		includePr: boolean,
		includeUsage: boolean,
	): SegmentContext {
		const state = this.session.state;

		// Trigger background fetch (5-min TTL); render uses cached value
		this.refreshUsageInBackground();

		// Usage stats (token counts, tokensPerSecond) are only needed when a
		// segment that reads them is configured. The default preset has none,
		// so this skips getUsageStatistics() (object spread per frame) and
		// #getTokensPerSecond() (O(N) message scan per frame) on every frame
		// for the common case.
		const usageStats = includeUsage
			? {
					...(this.session.sessionManager?.getUsageStatistics() ?? EMPTY_USAGE_STATS),
					tokensPerSecond: this.#getTokensPerSecond(),
				}
			: EMPTY_USAGE_STATS_WITH_RATE;

		let contextWindow = state.model?.contextWindow ?? this.session.model?.contextWindow ?? 0;
		let contextLimit = contextWindow;
		let contextLimitKind: "window" | "compaction" = "window";
		let contextPercent: number | null = 0;
		if (includeContext) {
			const breakdown = this.getCachedContextBreakdown();
			contextWindow = breakdown.contextWindow || contextWindow;
			contextLimit = contextWindow;
			// Measure against the auto-compact fire point, not the raw model
			// window: the question the gauge answers is "when does the context
			// run out", and with auto-compaction on it runs out at the trigger.
			// The window itself stays intact in `contextWindow` — overwriting it
			// here is what made `context_total` print the trigger.
			//
			// `resolveContextLimit` owns that question for every surface, so the
			// gauge and the `/context` panel cannot disagree about whether a fire
			// point exists. `#autoCompactEnabled` is the same predicate mirrored
			// from the session for the `∞` icon, not a second axis on the limit.
			if (this.#autoCompactEnabled) {
				const limit = resolveContextLimit(contextWindow, this.session.settings.getGroup("compaction"));
				contextLimit = limit.tokens;
				contextLimitKind = limit.kind;
			}
			// A used-token count of `null` is the session saying it does not know yet --
			// the anchor is the last assistant's real prompt-token count, and right after
			// a compaction there is no last assistant to anchor on. Substituting 0 here
			// is what made the gauge answer `100% left` in the one moment it knew least,
			// while `/context` said usage was unavailable: two surfaces, one fact, two
			// answers. `null` reaches the segment as the `? left` the grammar already
			// spells, and the next response replaces it with a real number.
			contextPercent =
				breakdown.usedTokens === null
					? null
					: contextLimit > 0
						? (breakdown.usedTokens / contextLimit) * 100
						: null;
		}

		// Collab guest: context comes from the host's state frames — the local
		// replica does no accounting of its own.
		const collabState = this.#collabStatus?.stateOverride;
		if (collabState?.contextUsage) {
			contextWindow = collabState.contextUsage.contextWindow || contextWindow;
			// The host's frame is authoritative, null included: a guest that fell back to
			// its own number here would paint a percentage the host never sent, and the
			// local replica does no accounting to base one on.
			contextPercent = collabState.contextUsage.percent;
			// The host frame carries a window and a percent, not the host's
			// compaction trigger, so the guest's limit is the window it was told
			// about — never a trigger resolved from the guest's own settings.
			contextLimit = contextWindow;
			contextLimitKind = "window";
		}

		const shouldResolveActiveRepo = this.#gitEnabled() && (includePath || includeGit || includePr);
		const projectDir = this.session.sessionManager?.getCwd?.() ?? getProjectDir();
		const activeRepoCache = shouldResolveActiveRepo
			? this.#resolveActiveRepoCache()
			: { projectDir, activeRepo: null, effectiveGitCwd: projectDir, worktree: null };
		const gitBranch = includeGit || includePr ? this.#getCurrentBranch(activeRepoCache.effectiveGitCwd) : null;
		const gitStatus = includeGit ? this.#getGitStatus(activeRepoCache.effectiveGitCwd) : null;
		const gitPr = includePr ? this.#lookupPr(activeRepoCache.effectiveGitCwd) : null;
		const prewalk =
			typeof this.session.getPrewalkState === "function" && this.session.getPrewalkState() ? PREWALK_ENABLED : null;
		const compactThinkingLevel = this.#resolveSettings().compactThinkingLevel ?? false;
		const activeMs = this.getActiveMs();
		const gitCtx = this.#gitContext(gitBranch, gitStatus, gitPr);
		const account = this.#servingAccount(this.session);
		const options = segmentOptions ?? EMPTY_SEGMENT_OPTIONS;
		const ctx = this.#ctx;
		if (ctx === undefined) {
			this.#ctx = {
				session: this.session,
				focusedAgentId: this.#focusedAgentId,
				activeRepo: activeRepoCache.activeRepo,
				width,
				options,
				compactThinkingLevel,
				planMode: this.#planModeStatus,
				loopMode: this.#loopModeStatus,
				prewalk,
				goalMode: this.#goalModeStatus,
				vibeMode: this.#vibeModeStatus,
				collab: this.#collabStatus,
				usageStats,
				contextPercent,
				contextWindow,
				contextLimit,
				contextLimitKind,
				autoCompactEnabled: this.#autoCompactEnabled,
				subagentCount: this.#subagentCount,
				backgroundSessionCount: this.#backgroundSessionCount,
				activeMs,
				git: gitCtx,
				worktree: activeRepoCache.worktree,
				account,
				usage: this.#cachedUsage,
			};
			return this.#ctx;
		}
		ctx.session = this.session;
		ctx.focusedAgentId = this.#focusedAgentId;
		ctx.activeRepo = activeRepoCache.activeRepo;
		ctx.width = width;
		ctx.options = options;
		ctx.compactThinkingLevel = compactThinkingLevel;
		ctx.planMode = this.#planModeStatus;
		ctx.loopMode = this.#loopModeStatus;
		ctx.prewalk = prewalk;
		ctx.goalMode = this.#goalModeStatus;
		ctx.vibeMode = this.#vibeModeStatus;
		ctx.collab = this.#collabStatus;
		ctx.usageStats = usageStats;
		ctx.contextPercent = contextPercent;
		ctx.contextWindow = contextWindow;
		ctx.contextLimit = contextLimit;
		ctx.contextLimitKind = contextLimitKind;
		ctx.autoCompactEnabled = this.#autoCompactEnabled;
		ctx.subagentCount = this.#subagentCount;
		ctx.backgroundSessionCount = this.#backgroundSessionCount;
		ctx.activeMs = activeMs;
		ctx.git = gitCtx;
		ctx.worktree = activeRepoCache.worktree;
		ctx.account = account;
		ctx.usage = this.#cachedUsage;
		return ctx;
	}

	// Git context sub-object cache: { branch, status, pr } are all individually cached, but
	// the wrapper object was allocated every frame. Cache by reference identity of the three
	// values so the same object is reused when nothing changed.
	#cachedGitCtx:
		| { branch: string | null; status: git.GitStatusSummary | null; pr: { number: number; url: string } | null }
		| undefined;
	#cachedGitCtxBranch: string | null | undefined = undefined;
	#cachedGitCtxStatus: git.GitStatusSummary | null | undefined = undefined;
	#cachedGitCtxPr: { number: number; url: string } | null | undefined = undefined;

	#gitContext(
		branch: string | null,
		status: git.GitStatusSummary | null,
		pr: { number: number; url: string } | null,
	): { branch: string | null; status: git.GitStatusSummary | null; pr: { number: number; url: string } | null } {
		if (
			branch === this.#cachedGitCtxBranch &&
			status === this.#cachedGitCtxStatus &&
			pr === this.#cachedGitCtxPr &&
			this.#cachedGitCtx !== undefined
		) {
			return this.#cachedGitCtx;
		}
		this.#cachedGitCtxBranch = branch;
		this.#cachedGitCtxStatus = status;
		this.#cachedGitCtxPr = pr;
		this.#cachedGitCtx = { branch, status, pr };
		return this.#cachedGitCtx;
	}

	#resolveSettings(): EffectiveStatusLineSettings {
		if (this.#effectiveSettings === undefined) {
			this.#effectiveSettings = this.#computeEffectiveSettings();
		}
		return this.#effectiveSettings;
	}

	#computeEffectiveSettings(): EffectiveStatusLineSettings {
		const preset = this.#settings.preset ?? "default";
		const presetDef = getPreset(preset);
		const useCustomSegments = preset === "custom";
		const mergedSegmentOptions: StatusLineSettings["segmentOptions"] = {};

		for (const [segment, options] of Object.entries(presetDef.segmentOptions ?? {})) {
			mergedSegmentOptions[segment as keyof StatusLineSegmentOptions] = { ...(options as Record<string, unknown>) };
		}

		for (const [segment, options] of Object.entries(this.#settings.segmentOptions ?? {})) {
			const current = mergedSegmentOptions[segment as keyof StatusLineSegmentOptions] ?? {};
			mergedSegmentOptions[segment as keyof StatusLineSegmentOptions] = {
				...(current as Record<string, unknown>),
				...(options as Record<string, unknown>),
			};
		}

		const leftSegments = useCustomSegments
			? (this.#settings.leftSegments ?? presetDef.leftSegments)
			: presetDef.leftSegments;
		const rightSegments = useCustomSegments
			? (this.#settings.rightSegments ?? presetDef.rightSegments)
			: presetDef.rightSegments;

		return {
			...this.#settings,
			leftSegments,
			rightSegments,
			segmentOptions: mergedSegmentOptions,
		};
	}

	#cachedSubagentBadgeCount = -1;
	#cachedSubagentBadge = "";

	#subagentBadgeText(): string {
		if (this.#subagentCount === this.#cachedSubagentBadgeCount) return this.#cachedSubagentBadge;
		this.#cachedSubagentBadgeCount = this.#subagentCount;
		this.#cachedSubagentBadge = theme.fg(
			"statusLineSubagents",
			withIcon(theme.icon.agents, `${this.#subagentCount}`),
		);
		return this.#cachedSubagentBadge;
	}

	/**
	 * Running background jobs the SUBAGENT badge does not already stand for.
	 *
	 * A `task` spawn registers an async job (`type: "task"`, see `task/index.ts`) AND counts as a
	 * running subagent, so counting every job here printed the same three agents twice: the bar
	 * read `3 · 3`, two badges whose numbers moved together and neither of which said what it
	 * was counting. Async bash, debug and launch jobs are real background work with no subagent
	 * behind them, and those are what this badge is for.
	 */
	#backgroundJobBadgeCount(): number {
		return this.session.getRunningNonTaskJobCount();
	}

	/**
	 * Quiet composer chrome: the segment set split across two whisper lines with
	 * free space between them, instead of one crammed bar. Location (path · git)
	 * lives above the composer's hairline; capability (model · mode) and budget
	 * (context, session) sit below it, split left/right. Honors the configured
	 * segments — a segment renders in its zone iff it appears in the preset.
	 * `extras.locationRight` pins owner-supplied content (MCP health, the ghost
	 * sun) at the location line's right edge.
	 */
	/**
	 * Gather the quiet-zone segments into their three groups: location (path ·
	 * git · pr), capability-left (model · mode …), and capability-right
	 * (context, badges, background jobs). ONE owner for the grouping logic —
	 * both the two-line selector layout ({@link renderQuietLines}) and the
	 * composer's single footline ({@link renderQuietLine}) read from here.
	 */
	#gatherQuietSegments(width: number): { location: QuietPart[]; capLeft: QuietPart[]; capRight: QuietPart[] } {
		const effectiveSettings = this.#resolveSettings();
		const gitEnabled = this.#gitEnabled();
		const leftCfg = effectiveSettings.leftSegments;
		const rightCfg = effectiveSettings.rightSegments;
		const includePath = hasPathSegment(leftCfg) || hasPathSegment(rightCfg);
		const includeContext = hasContextSegment(leftCfg) || hasContextSegment(rightCfg);
		const includeGit = gitEnabled && (hasGitSegment(leftCfg) || hasGitSegment(rightCfg));
		const includePr = gitEnabled && (hasPrSegment(leftCfg) || hasPrSegment(rightCfg));
		const includeUsage = hasUsageSegment(leftCfg) || hasUsageSegment(rightCfg);
		// The footline reads at a glance, so the model-effort gap is roomy. The
		// per-kind git counts and the token-text context gauge that the other
		// options here used to switch between are gone: nothing could reach
		// them, because this is the only place a segment is ever rendered.
		//
		// `path.maxLength` was pinned to 30 here, which quietly overrode every
		// preset's own budget (40 on `default`, 60 on `nerd`) AND any
		// `statusLine.segmentOptions.path.maxLength` the operator set — picking
		// `nerd` for its long paths changed nothing on screen. The preset wins
		// now; 30 is only the fallback for a preset that names no budget.
		//
		// EXPANDED PATH. A click on the path toggles `#pathExpanded`: the location zone
		// gives up its clamp and takes the room the model chip vacates, so a path too long
		// for the footline can be read without resizing the terminal. The shed loop below
		// still clips the location to the row, so this widens the budget rather than
		// promising the whole path.
		//
		// The clamp travels between the two budgets rather than switching between them, so
		// the path grows a cell at a time out of the room the chip is giving back. Both ends
		// of the trade are driven by ONE progress value, so the row can never be mid-way
		// through widening while the chip is already gone.
		const expansion = this.#expansionProgress();
		const collapsedPathBudget = effectiveSettings.segmentOptions?.path?.maxLength ?? 30;
		// A row narrower than the clamp has nothing to widen INTO, and interpolating toward it
		// would make the click cut the path shorter than the clamp already had it.
		const expandedPathBudget = Math.max(collapsedPathBudget, width);
		const pathBudget = Math.round(collapsedPathBudget + (expandedPathBudget - collapsedPathBudget) * expansion);
		const quietOptions = this.#quietOptions(effectiveSettings.segmentOptions, pathBudget);
		const ctx = this.#buildSegmentContext(
			width,
			quietOptions,
			includePath,
			includeContext,
			includeGit,
			includePr,
			includeUsage,
		);
		const subagentBadge = this.#subagentBadgeText();
		const location = this.#quietLocation;
		location.length = 0;
		const capLeft = this.#quietCapLeft;
		capLeft.length = 0;
		const capRight = this.#quietCapRight;
		capRight.length = 0;
		// The context gauge is the footline's one LIVE value; everything else on the
		// right is standing state. A gauge configured on the left still belongs in the
		// right group (it is a capability reading, not a location), but pushing it there
		// during this first loop put it AHEAD of every right-configured segment, so the
		// default preset read `model · gauge · session-name`: the number that changes
		// every turn sandwiched between two that do not. Nobody chose that order; it
		// fell out of which loop ran first. Held aside and appended after the right
		// group instead, so the live value is the line's last word. A gauge the user
		// configured on the RIGHT keeps the position they gave it.
		const contextFromLeft = this.#quietContextFromLeft;
		contextFromLeft.length = 0;
		for (const id of leftCfg) {
			if (LOCATION_SEGMENT_IDS[id]) pushQuietPart(id, ctx, location);
			else if (CONTEXT_SEGMENT_IDS[id]) pushQuietPart(id, ctx, contextFromLeft);
			else pushQuietPart(id, ctx, capLeft);
		}
		for (const id of rightCfg) {
			if (LOCATION_SEGMENT_IDS[id]) pushQuietPart(id, ctx, location);
			else pushQuietPart(id, ctx, capRight);
		}
		capRight.push(...contextFromLeft);
		const runningBackgroundJobs = this.#backgroundJobBadgeCount();
		const badgeParts = this.#quietBadgeParts;
		badgeParts.length = 0;
		if (runningBackgroundJobs > 0) {
			badgeParts.push(theme.fg("statusLineSubagents", withIcon(theme.icon.job, `${runningBackgroundJobs}`)));
		}
		const badgeSlot = this.#animatedBadgeSlot(badgeParts);
		if (badgeSlot !== null) capRight.unshift({ id: "badges", content: badgeSlot });
		capRight.unshift({ id: "subagents", content: subagentBadge });
		return this.#quietGatherResult;
	}

	// Cached quiet options: the base spread (segmentOptions + model.roomy) is constant
	// between settings changes; only path.maxLength varies (with the expansion animation).
	// Caching by (segmentOptions ref, pathBudget) avoids 3 nested object allocations per frame.
	#cachedQuietOptsBaseRef: object | undefined;
	#cachedQuietOptsBudget = -1;
	#cachedQuietOpts: StatusLineSegmentOptions | undefined;

	#quietOptions(base: StatusLineSegmentOptions | undefined, pathBudget: number): StatusLineSegmentOptions {
		if (base === this.#cachedQuietOptsBaseRef && pathBudget === this.#cachedQuietOptsBudget) {
			return this.#cachedQuietOpts!;
		}
		this.#cachedQuietOptsBaseRef = base;
		this.#cachedQuietOptsBudget = pathBudget;
		this.#cachedQuietOpts = {
			...base,
			path: { ...base?.path, maxLength: pathBudget },
			model: { ...base?.model, roomy: true },
		};
		return this.#cachedQuietOpts;
	}

	// Layout of the last rendered quiet footline, for click hit-testing
	// (quietSegmentAt). Rewritten on every renderQuietLine call, so it always
	// matches the line currently on screen; empty when no footline rendered.
	#quietLineBounds: readonly QuietSegmentBounds[] = EMPTY_BOUNDS;

	// Set by a click on the location (togglePathExpanded). While true the location zone is
	// clamped to the row rather than the preset budget and spends the right group for the room,
	// weakest first. Not persisted: a new session opens unexpanded.
	#pathExpanded = false;

	/**
	 * Which half the click named, and therefore which one is shown whole while the other pays.
	 * Both halves are clickable and a click on either expands the row; this is only the order
	 * the cells are handed out in, so clicking the branch on a row too narrow for both reads
	 * the branch rather than re-reading the directory the reader did not ask about.
	 */
	#expandedHalf: StatusLineSegmentId = "path";

	/**
	 * How far the row is through the trade: 0 is the collapsed row, 1 the expanded one, and
	 * anything between is a frame of the travel. Without a repaint hook there is no travel and
	 * the answer is the toggle itself, so a caller that only renders sees the two end states
	 * and nothing in between.
	 */
	#expansionProgress(): number {
		return this.#expansion?.value ?? (this.#pathExpanded ? 1 : 0);
	}

	// Background-job badge animation state. Jobs ease in/out over
	// BADGE_ANIM_MS so a start or finish reads as an intentional merge instead
	// of the right group jumping sideways. The running-subagent count does not
	// enter this slot: it is persistent state and must update synchronously.
	// Between animations the slot is exactly the job badge's width, so there is
	// no permanent dead space either.
	#badgeSlotFromWidth = 0;
	#badgeSlotTargetWidth = 0;
	#badgeSlotAnimStartMs = 0;
	// The job badge text being clipped during a close; the running-job count
	// reaches zero before the slot finishes shrinking, so its text outlives it.
	#badgeSlotText = "";
	static readonly #BADGE_ANIM_MS = 240;

	/** The badge slot at its current animated width, or null when the slot is
	 * fully closed. The text slides in clipped to the easing width; the
	 * caller unshifts the slot so the group's left edge eases open instead of
	 * jumping. */
	#animatedBadgeSlot(badgeParts: string[]): string | null {
		const sep = stateSeparator();
		const joined = badgeParts.length > 0 ? badgeParts.join(sep) : "";
		const targetWidth = joined ? visibleWidth(joined) : 0;
		if (targetWidth !== this.#badgeSlotTargetWidth) {
			this.#badgeSlotFromWidth = this.#badgeSlotCurrentWidth();
			this.#badgeSlotTargetWidth = targetWidth;
			this.#badgeSlotAnimStartMs = Date.now();
			if (targetWidth > 0) this.#badgeSlotText = joined;
		}
		const width = this.#badgeSlotCurrentWidth();
		if (width === 0) return null;
		const clipped = truncateToWidth(this.#badgeSlotText, width);
		const clippedWidth = visibleWidth(clipped);
		return clippedWidth >= width ? clipped : clipped + padding(width - clippedWidth);
	}

	#badgeSlotCurrentWidth(): number {
		const elapsed = Date.now() - this.#badgeSlotAnimStartMs;
		if (elapsed >= StatusLineComponent.#BADGE_ANIM_MS) return this.#badgeSlotTargetWidth;
		const t = elapsed / StatusLineComponent.#BADGE_ANIM_MS;
		const eased = t * t * (3 - 2 * t);
		return Math.round(this.#badgeSlotFromWidth + (this.#badgeSlotTargetWidth - this.#badgeSlotFromWidth) * eased);
	}

	/**
	 * The composer's ONE metadata footline: location (path · git) on the left,
	 * capability (model · mode · badges · context, then MCP health via
	 * `extras.locationRight`) on the right. On narrow widths the right group
	 * sheds parts from the end before the middle gap closes; returns null when
	 * there is nothing to say (no empty chrome rows).
	 */
	/**
	 * Join the location group and append the MODEL RUN clock with a roomy gap.
	 * The clock is model runtime from the ONE active-processing meter (the
	 * same accounting behind `time_spent`), never wall time since launch:
	 * ONE clock, two states — while the agent runs it ticks the current run
	 * (`0:42`); once the run finishes it freezes as a quiet receipt of the
	 * completed run (`✓ 0:21`); before the model has ever started it says
	 * nothing at all. Chrome, not a configurable segment — it rides the
	 * location line whenever one renders (approved placement: next to the git
	 * branch, with a decent amount of space). Dim; the mode's 1s heartbeat
	 * keeps the running form ticking between agent events.
	 */
	#locationWithRunClock(location: string[], sep: string, gap: string = SESSION_CLOCK_GAP): string {
		const left = location.join(sep);
		if (!left) return left;
		const meter = this.#meter();
		const runningMs = meter.activeStartedAt === null ? null : Math.max(0, Date.now() - meter.activeStartedAt);
		const lastRunMs = meter.lastRunMs;
		const readout = runningMs !== null ? formatClock(runningMs) : lastRunMs > 0 ? `✓ ${formatClock(lastRunMs)}` : "";
		if (!readout) return left;
		return `${left}${gap}${theme.fg("dim", readout)}`;
	}

	/**
	 * The focus badge on its own, with no segments: the footline row a composer renders while
	 * `statusLine.enabled` is off. Null when nothing is proxied, so the zone drops the row.
	 *
	 * Esc means "leave this view" while the view is proxied onto an agent and "clear the line"
	 * everywhere else, and this badge is the only persistent thing on screen that says which one
	 * you are in. Turning standing status off must therefore not be able to strip the exit sign
	 * off a view whose edge is otherwise invisible, so the badge is outside the setting.
	 *
	 * The recorded footline layout is cleared, not kept: with no segments on the row there is
	 * nothing to hit-test, and stale bounds from an earlier render would resolve a click to a
	 * segment that is no longer there.
	 */
	renderFocusBadge(width: number): string | null {
		this.#quietLineBounds = EMPTY_BOUNDS;
		if (!this.#focusedAgentId) return null;
		return truncateToWidth(focusExitBadge(this.#focusedAgentId), Math.max(1, width));
	}

	renderQuietLine(width: number, extras?: { locationRight?: string | null }): string | null {
		// The focus badge rides the footline while the view is proxied onto an
		// agent. It was built for `getTopBorder`, but the borderless composer
		// never asks for a top border: the editor's border is hidden and this
		// quiet footline is the one persistent status surface, so an agent view
		// announced itself nowhere. Prefixed the same way `getTopBorder` does it:
		// the line is built into what the badge leaves, so no width pressure can
		// shed the one line of text that says whose session this is and that Esc
		// leaves it.
		const rawBadge = this.#focusedAgentId ? focusExitBadge(this.#focusedAgentId) : "";
		// The badge is prefixed verbatim, so it has to be clamped to the row exactly as
		// `renderFocusBadge` clamps it: an agent id long enough to outrun the terminal wrapped the
		// footline and pushed the composer up a row on every render.
		const badge = rawBadge === "" ? "" : truncateToWidth(rawBadge, Math.max(1, width));
		const badgeWidth = visibleWidth(badge);
		const { location, capLeft, capRight } = this.#gatherQuietSegments(Math.max(0, width - badgeWidth));
		const sep = segmentSeparator();
		// One cell of right margin, always — nothing kisses the terminal edge. Floored at ZERO, not
		// at one: a badge that already fills the row leaves no room to compete for, and clamping to
		// one cell is what let a 28-cell badge plus a segment render onto an 8-cell row.
		const budget = Math.max(0, width - 1 - badgeWidth);
		if (budget === 0) {
			this.#quietLineBounds = EMPTY_BOUNDS;
			return badge === "" ? null : badge;
		}
		const locationContents = this.#quietLocationContents;
		locationContents.length = location.length;
		for (let i = 0; i < location.length; i++) locationContents[i] = location[i]!.content;
		let left = this.#locationWithRunClock(locationContents, sep);
		const rightParts = this.#quietRightParts;
		rightParts.length = 0;
		for (let i = 0; i < capLeft.length; i++) rightParts.push(capLeft[i]!);
		for (let i = 0; i < capRight.length; i++) rightParts.push(capRight[i]!);
		if (extras?.locationRight) rightParts.push({ id: "location_right", content: extras.locationRight });
		let right = joinContents(rightParts, sep);
		// The run clock is comfort chrome; the capability segments (context
		// gauge, mode, badges) are operating data. On a tight width the clock
		// degrades FIRST — its roomy gap shrinks to two cells, then the clock
		// drops entirely — so it can never squeeze a segment off the line.
		let clockStage = 0;
		let locationShortened = false;
		// Painted extents of the location parts once the fitter has had them, or null while
		// the location is still whole and its parts sit where the join put them.
		let locationSlots: QuietSegmentBounds[] | null = null;
		// Whether the fitter had to cut the location below its own floors to fit it.
		let locationCramped = false;
		// Fit the location into the room the CURRENT right group leaves, for the caller to take.
		// Asked again every time the group loses a part on the zone's behalf, because the room a
		// shed frees belongs to the location: fitting once and latching a flag is what put an
		// empty zone on a row with twenty-one cells of slack. The zone was fitted to the budget
		// left by a right group that still held the session name and the context gauge -- a
		// budget of ZERO -- and when those two left a moment later nothing asked the fitter
		// again, so the row rendered the directory and the branch as nothing at all.
		const favour = this.#expansionProgress() > 0 ? this.#expandedHalf : undefined;
		while (rightParts.length > 0 && visibleWidth(left) + visibleWidth(right) + (left && right ? 2 : 0) > budget) {
			if (clockStage === 0) {
				clockStage = 1;
				left = this.#locationWithRunClock(locationContents, sep, "  ");
				continue;
			}
			if (clockStage === 1) {
				clockStage = 2;
				left = locationContents.join(sep);
				continue;
			}
			// Shed the LOWEST-RANKED remaining part, walking from the end so equally
			// ranked parts still go right-to-left. Everything unlisted ranks 0 and goes
			// first; see RIGHT_PART_SHED_RANK for why the four ranked ids outrank it.
			//
			// Every unranked part goes before the location is touched at all, so nothing here
			// has to be re-fitted: the zone is still whole.
			const weakest = weakestRightPart(rightParts);
			const dropIndex = weakest.index;
			const dropRank = weakest.rank;
			if (dropRank === 0 && dropIndex >= 0) {
				rightParts.splice(dropIndex, 1);
				right = joinContents(rightParts, sep);
				continue;
			}
			// Only ranked parts are left. Shorten the location before touching any of
			// them: a clipped path still says where you are, and these do not degrade.
			if (!locationShortened) {
				locationShortened = true;
				const fitted = fitLocation(
					location,
					sep,
					Math.max(0, budget - visibleWidth(right) - (right ? 2 : 0)),
					favour,
				);
				left = fitted.text;
				locationSlots = fitted.slots;
				locationCramped = fitted.cramped;
				continue;
			}
			// The ranked parts still do not fit, so the ranking has to resolve. Shedding the
			// weakest is the whole point of having one: the alternative is what shipped before
			// it existed, where the return below truncated the joined group and a budget of one
			// cell rendered a bare `…` — every ranked part destroyed at once, including the
			// persistent subagent count that outranks all of them.
			//
			// The zone is not re-fitted inside this branch: a shed that does not end the overflow
			// is followed by another, so there is nothing settled to fit against yet. The shed
			// that DOES end it is accounted for below, once the group has stopped moving.
			if (rightParts.length > 1 && dropIndex >= 0) {
				rightParts.splice(dropIndex, 1);
				right = joinContents(rightParts, sep);
				continue;
			}
			break;
		}
		// The group has stopped shedding, so the room it leaves is final -- and the shed that
		// ended the loop above freed cells nobody has handed over yet. The zone was fitted
		// against the group as it stood BEFORE that shed, which on a narrow row is two parts
		// wider, so it kept a width the row had already outgrown: the same latch as the reported
		// defect, one shed later. At 40 columns it left the zone blank with the model chip and a
		// mode rung standing in the middle of the row.
		if (locationShortened) {
			const settled = fitLocation(
				location,
				sep,
				Math.max(0, budget - visibleWidth(right) - (right ? 2 : 0)),
				favour,
			);
			left = settled.text;
			locationSlots = settled.slots;
			locationCramped = settled.cramped;
		}
		// A location squeezed under its floors is a zone that no longer reads: `…izer  ·  …g-path`
		// says neither where the session is nor what it is on. At that point the budget is what
		// has to move, so the row pays the zone out of what it can re-read on the next frame --
		// the context gauge, the draft token estimate, owner-pinned right content (see
		// FLOOR_SPENDABLE) -- and asks the fitter again after each one. It never pays with the
		// model chip, which is what this row exists to retain, never with a mode rung, which says
		// what the next keystroke does, and never with the running-subagent count, which the row
		// sheds last of everything.
		while (locationCramped && locationShortened && rightParts.length > 0) {
			const index = weakestSpendablePart(rightParts);
			if (index < 0) break;
			rightParts.splice(index, 1);
			right = joinContents(rightParts, sep);
			const fitted = fitLocation(location, sep, Math.max(0, budget - visibleWidth(right) - (right ? 2 : 0)), favour);
			left = fitted.text;
			locationSlots = fitted.slots;
			locationCramped = fitted.cramped;
		}
		// THE CLICK'S TRADE, settled last.
		//
		// A click says "show me this half". So the row shows it WHOLE, and it may spend the rest
		// of the bar to do it: the model chip first, then whatever is weakest, until the clicked
		// half is whole or the bar has nothing left to give. Only a half longer than the entire
		// row is still clipped. The second click returns every cell and every part.
		//
		// Settled AFTER the ladders above, and that ordering is the trade. The ladders decide
		// what the row holds while the right group is still standing at full width, so they
		// reach the same decisions the collapsed row reached, and the cells freed here have
		// nowhere to go but the location. Retracting first is what shipped, and at 78 columns it
		// moved the zone by ONE cell: the collapsed row had shed the context gauge under
		// pressure, the narrower chip took that pressure off, and the gauge came back and ate
		// all twenty cells. On screen the click flashed a gauge in and a chip out and left the
		// directory exactly where it was. Nothing the collapsed row gave up may return because
		// the click freed room -- the room is the location's.
		//
		// The spend TRAVELS with the progress value instead of switching on it. Whole parts
		// leaving the row the instant a click lands is the other way this reads as a flash: the
		// cells have to slide out of the group and into the zone across the same frames, so each
		// part in turn narrows and only then goes.
		const expansion = this.#expansionProgress();
		if (expansion > 0 && rightParts.length > 0) {
			// What the row is short of showing the CLICKED half whole, with the other half at the
			// width a name still reads at. Targeting both halves whole is the greedier answer and
			// the wrong one: it spent the mode rungs to lengthen a branch nobody pointed at. The
			// fitter hands any cells left over back to the other half afterwards, so this is a
			// floor on what it keeps, not a cap.
			const sepWidth = visibleWidth(sep);
			let wanted = 0;
			for (let i = 0; i < location.length; i++) {
				const part = location[i]!;
				wanted +=
					part.id === favour
						? visibleWidth(part.content)
						: Math.min(visibleWidth(part.content), MIN_LOCATION_PART);
			}
			wanted += sepWidth * Math.max(0, location.length - 1);
			const held = budget - visibleWidth(right) - (right ? 2 : 0);
			// The chip goes first: it is the biggest single readout and the one the reader is
			// trading away knowingly. After that the row gives up its weakest, which is the same
			// order it uses under width pressure.
			const order: number[] = [];
			let chip = -1;
			for (let i = 0; i < rightParts.length; i++) {
				if (rightParts[i]!.id === "model") {
					chip = i;
					break;
				}
			}
			if (chip >= 0) order.push(chip);
			const remaining: number[] = [];
			for (let i = 0; i < rightParts.length; i++) {
				if (i !== chip) remaining.push(i);
			}
			remaining.sort((a, b) => {
				const rankA = RIGHT_PART_SHED_RANK[rightParts[a]?.id ?? ""] ?? 0;
				const rankB = RIGHT_PART_SHED_RANK[rightParts[b]?.id ?? ""] ?? 0;
				return rankA === rankB ? b - a : rankA - rankB;
			});
			order.push(...remaining);
			let onOffer = 0;
			for (let i = 0; i < order.length; i++) {
				onOffer += visibleWidth(rightParts[order[i]!]?.content ?? "") + sepWidth;
			}
			// NOT scaled by the progress a second time. `wanted` is measured from the location's
			// CURRENT text, and that text is already on the curve -- the path's own clamp travels
			// from the preset budget out to the row. Scaling here as well put two interpolations
			// of one progress value in a race, and the text won it: the clamp lengthened the path
			// four cells before any room had been freed for it, so the ladders clipped the zone
			// and its right edge stepped BACKWARD at the start of every expansion. The room now
			// covers exactly what the text is asking for, frame by frame, which is one motion.
			const spend = Math.min(Math.max(0, wanted - held), onOffer);
			if (spend > 0) {
				let owed = spend;
				const spent: number[] = [];
				for (const index of order) {
					if (owed <= 0) break;
					const part = rightParts[index];
					if (part === undefined) continue;
					const width = visibleWidth(part.content);
					// A part is narrowed cell by cell while the row is travelling, because that is
					// the motion: the readout is visibly standing down. Where it lands is a
					// different question -- `clau…` is not a model name, and a row that RESTS on a
					// fragment has not stood the readout down, it has broken it. So at rest a part
					// that cannot keep the width a name reads at goes instead, and every cell it
					// was holding goes to the location.
					const floor = expansion >= 1 ? MIN_LOCATION_PART : MIN_READABLE_PART;
					if (owed >= width - floor) {
						spent.push(index);
						owed -= width + sepWidth;
						continue;
					}
					rightParts[index] = { ...part, content: truncateToWidth(part.content, width - owed) };
					owed = 0;
				}
				// Descending, so an earlier removal cannot shift a later index.
				for (const index of spent.sort((a, b) => b - a)) rightParts.splice(index, 1);
				right = joinContents(rightParts, sep);
				const widened = fitLocation(
					location,
					sep,
					Math.max(0, budget - visibleWidth(right) - (right ? 2 : 0)),
					favour,
				);
				left = widened.text;
				locationSlots = widened.slots;
				locationCramped = widened.cramped;
			}
		}
		if (!left && !right) {
			this.#quietLineBounds = EMPTY_BOUNDS;
			return badge === "" ? null : badge;
		}
		// Record where each surviving segment landed, in 0-based columns of the
		// returned line, so a footer click can be resolved back to a segment id
		// (see quietSegmentAt). The math mirrors the assembly exactly: location
		// parts start at column 0 and are sep-joined; the right group is
		// right-aligned at the budget when a left group exists, else it renders
		// from column 0 and truncates.
		const sepWidth = visibleWidth(sep);
		const bounds = this.#quietBounds;
		bounds.length = 0;
		if (left) {
			// Once the fitter has run it is the authority on where the parts landed: it is
			// what dropped a part and what clipped the head, so it knows the painted columns
			// and this loop would only be guessing at them. Otherwise the location is whole
			// and each part sits where the join put it.
			if (locationSlots !== null) {
				bounds.push(...locationSlots);
			} else {
				let col = 0;
				const leftWidth = visibleWidth(left);
				for (const part of location) {
					const partWidth = visibleWidth(part.content);
					if (col >= leftWidth) break;
					bounds.push({ id: part.id, start: col, end: Math.min(col + partWidth, leftWidth) });
					col += partWidth + sepWidth;
				}
			}
		}
		// The right group is anchored to the right edge whether or not a location shares the
		// row with it. Anchoring it only when a location survived is what left a row of state
		// hanging off the LEFT margin at the widths where the zone could not fit: the model
		// chip, the rungs and the counters all jumped a screen-width left, and the eye that
		// had learnt where to find them on every other row had to hunt for them on this one.
		const rightStart = right ? Math.max(0, budget - visibleWidth(right)) : 0;
		if (right) {
			let col = rightStart;
			for (const part of rightParts) {
				const partWidth = visibleWidth(part.content);
				bounds.push({ id: part.id, start: col, end: col + partWidth });
				col += partWidth + sepWidth;
			}
		}
		// Single-group lines truncate to the budget: clamp bounds the same way.
		// The badge shifts every segment right by its width; the recorded bounds
		// answer in columns of the RETURNED line (quietSegmentAt hit-testing), so
		// they shift with it.
		const shifted = this.#quietShiftedBounds;
		shifted.length = 0;
		for (let bi = 0; bi < bounds.length; bi++) {
			const entry = bounds[bi]!;
			if (entry.start >= budget) continue;
			shifted.push({
				id: entry.id,
				start: entry.start + badgeWidth,
				end: Math.min(entry.end, budget) + badgeWidth,
			});
		}
		this.#quietLineBounds = shifted;
		if (left && right) {
			return badge + left + padding(budget - visibleWidth(left) - visibleWidth(right)) + right;
		}
		// A location alone on the row is what a click on a name longer than the whole bar comes
		// to: the reader asked for that name, and the row spent every readout it had to show as
		// much of it as fits. Before the click could spend the last part this was unreachable --
		// the subagent badge is appended to `capRight` unconditionally, so `right` was never
		// empty -- and the lone-group return below dropped the location on the floor, painting
		// an empty row on the one click that most needed to answer.
		if (left) return badge + truncateToWidth(left, budget);
		// A lone right group has no head worth keeping, so it loses its tail -- and it keeps the
		// right edge, so the state it carries sits where the eye already looks for it.
		return badge + padding(rightStart) + truncateToWidth(right, budget);
	}

	/**
	 * Resolve a 0-based column of the LAST rendered quiet footline to the id of
	 * the segment occupying it, or null for gaps/padding. This is the one
	 * hit-test surface for status-line mouse routing (GMI-2b): the footline
	 * records its layout as it renders, so the answer is always in sync with
	 * what is actually on screen. Non-segment chrome reports as synthetic ids
	 * ("badges", "location_right"); the run clock is unaddressable chrome.
	 */
	quietSegmentAt(col: number): string | null {
		for (const entry of this.#quietLineBounds) {
			if (col >= entry.start && col < entry.end) return entry.id;
		}
		return null;
	}

	/**
	 * Toggle the expanded location. Clicking the directory, the branch or the pull request
	 * widens the zone to the row and spends the right group for the room, weakest first;
	 * clicking the same half again restores every part and every cell. Returns the new state so
	 * the caller can request a render without reading it back.
	 *
	 * `half` is the segment the click landed on. It is shown whole while the other pays, so the
	 * reader gets the name they pointed at. Clicking the OTHER half while the row is already
	 * expanded hands the room over rather than collapsing: the row is already wide, and
	 * collapsing it to answer a click on a second name would take the name away.
	 *
	 * The state lives here rather than in the caller because `renderQuietLine` is the only
	 * place that knows the row's budget, and the expansion is a property of the line, not
	 * of the session: a resize re-renders it and re-clips to the new width.
	 *
	 * A second click DURING the travel is retargeted rather than restarted, so the row turns
	 * around from wherever it had got to instead of jumping to the far end and easing back.
	 * `display.transitions: off` lands it on the same frame as the click, which is the hard
	 * cut this replaced, byte for byte.
	 */
	togglePathExpanded(half: StatusLineSegmentId = "path"): boolean {
		const handOver = this.#pathExpanded && half !== this.#expandedHalf;
		this.#expandedHalf = half;
		if (handOver) return true;
		this.#pathExpanded = !this.#pathExpanded;
		if (this.#expansion) {
			this.#expansion.set(this.#pathExpanded ? 1 : 0);
			if (!transitionsEnabled()) this.#expansion.finish();
		}
		return this.#pathExpanded;
	}

	/** Last rendered quiet-footline layout, for tests and debugging. */
	getQuietSegmentBounds(): readonly QuietSegmentBounds[] {
		return this.#quietLineBounds;
	}

	renderQuietLines(
		width: number,
		extras?: { locationRight?: string | null },
	): { locationLine: string | null; capabilityLine: string | null } {
		const gathered = this.#gatherQuietSegments(width);
		const location = new Array<string>(gathered.location.length);
		for (let i = 0; i < gathered.location.length; i++) location[i] = gathered.location[i]!.content;
		const capLeft = new Array<string>(gathered.capLeft.length);
		for (let i = 0; i < gathered.capLeft.length; i++) capLeft[i] = gathered.capLeft[i]!.content;
		const capRight = new Array<string>(gathered.capRight.length);
		for (let i = 0; i < gathered.capRight.length; i++) capRight[i] = gathered.capRight[i]!.content;
		const sep = segmentSeparator();
		// One cell of right margin, always — nothing kisses the terminal edge.
		const budget = Math.max(1, width - 1);
		let locationLine: string | null = null;
		if (location.length > 0) {
			const left = this.#locationWithRunClock(location, sep);
			const right = extras?.locationRight ?? null;
			if (right && visibleWidth(left) + visibleWidth(right) + 2 <= budget) {
				locationLine = left + padding(budget - visibleWidth(left) - visibleWidth(right)) + right;
			} else if (visibleWidth(left) <= budget) {
				locationLine = left;
			} else {
				// Same fitter as the one-line row: the branch goes before the directory does.
				// The run clock is dropped with it, since it is chrome and this row is full.
				locationLine = fitLocation(gathered.location, sep, budget).text;
			}
		}
		let capabilityLine: string | null = null;
		if (capLeft.length > 0 || capRight.length > 0) {
			const left = capLeft.join(sep);
			let right = capRight.join(sep);
			// Free space between the groups is the design; on narrow terminals the
			// right group sheds parts before the gap closes below breathing room.
			while (capRight.length > 0 && visibleWidth(left) + visibleWidth(right) + 2 > budget) {
				capRight.pop();
				right = capRight.join(sep);
			}
			if (left && right) {
				capabilityLine = left + padding(budget - visibleWidth(left) - visibleWidth(right)) + right;
			} else {
				capabilityLine = truncateToWidth(left || right, budget);
			}
		}
		return { locationLine, capabilityLine };
	}

	render(width: number): readonly string[] {
		// Only render hook statuses - main status is in editor's top border
		const showHooks = this.#settings.showHookStatus ?? true;
		if (!showHooks || this.#hookStatuses.size === 0) {
			if (this.#cachedHookRows.length !== 0) {
				this.#cachedHookSig = "";
				this.#cachedHookRows = EMPTY_HOOK_ROWS;
			}
			return this.#cachedHookRows;
		}

		// Cache by width + hook content signature so the TUI engine's stableRows
		// tracking can skip re-ingesting this row when hook statuses are unchanged.
		const entries = new Array<[string, string]>(this.#hookStatuses.size);
		let ei = 0;
		for (const entry of this.#hookStatuses) entries[ei++] = entry;
		entries.sort(([a], [b]) => a.localeCompare(b));
		let hookLine = "";
		for (let i = 0; i < entries.length; i++) {
			if (i > 0) hookLine += " ";
			hookLine += sanitizeStatusText(entries[i]![1]);
		}
		const sig = `${width}\0${hookLine}`;
		if (sig === this.#cachedHookSig) return this.#cachedHookRows;
		this.#cachedHookSig = sig;
		this.#cachedHookRows = [truncateToWidth(hookLine, width)];
		return this.#cachedHookRows;
	}
}
