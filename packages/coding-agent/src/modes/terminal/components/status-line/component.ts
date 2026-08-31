import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentMessage } from "@veyyon/agent-core";
import { ThinkingLevel } from "@veyyon/agent-core/thinking";
import type { AssistantMessage, UsageLimit, UsageReport } from "@veyyon/ai";
import type { OAuthAccountIdentity } from "@veyyon/kernel/session/auth-storage";
import type { Component } from "@veyyon/tui/tui";
import { getProjectDir } from "@veyyon/utils/dirs";
import { formatClock } from "@veyyon/utils/format";
import { MOTION, type MotionClock, SettleValue } from "@veyyon/utils/motion";
import { scopedTimeoutSignal, withScopedTimeoutSignal } from "@veyyon/utils/scoped-timeout";
import { truncateToWidth, visibleWidth } from "@veyyon/utils/width";
import { resolveContextLimit } from "../../../../config/compaction-strategy";
// The slot leaf, not the 95-module store: this file reads settings, it does not fill them.
import { settings } from "../../../../config/settings-instance";
import { accountDisplayLabel, accountsForProvider, buildAccountInventory } from "../../../../session/account-inventory";
import type { AgentSession } from "../../../../session/agent-session";
import { limitMatchesActiveAccount } from "../../../../slash-commands/helpers/active-oauth-account";
import { withIcon } from "../../../../theme/icon-label";
import { transitionsEnabled } from "../../../../theme/shimmer";
import { theme } from "../../../../theme/theme";
import { type ActiveRepoContext, resolveActiveRepoContextSync } from "../../../../utils/active-repo-context";
import * as git from "../../../../utils/git";
import { sanitizeStatusText } from "../../shared";
import { isTreeDirty } from "./branch";
import { canReuseCachedPr, createPrCacheContext, isSamePrCacheContext, type PrCacheContext } from "./git-utils";
import {
	composeQuietLines,
	composeQuietRow,
	effectiveStatusLineSettings,
	gatherQuietSegments,
	hasGitSegment,
	hasPrSegment,
	type QuietRowInput,
	type QuietSegmentBounds,
	subagentBadgeText,
} from "./quiet-row";
import { focusExitBadge, type SegmentContext } from "./segments";
import type { SessionFacts } from "./session-facts";
import { stateSeparator } from "./state-grammar";
import { calculateTokensPerSecond } from "./token-rate";
import type { CollabStatus, EffectiveStatusLineSettings, StatusLineSegmentId, StatusLineSettings } from "./types";

// ═══════════════════════════════════════════════════════════════════════════
// Context-usage memo
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Allocation-free structural size of a tool call's arguments: the sum of every
 * nested string length plus a fixed weight per primitive and per key. Tool-call
 * arguments come from JSON (acyclic), so a plain recursive walk is safe. This
 * replaces a per-redraw `JSON.stringify` of the full arguments object — a
 * streaming Write with a 100KB file body was re-serialized on every render
 * tick just to detect in-place growth of the tail.
 */
function structuralTextSize(value: unknown): number {
	if (typeof value === "string") return value.length;
	if (typeof value === "number" || typeof value === "bigint") return 8;
	if (typeof value === "boolean" || value === null || value === undefined) return 1;
	if (Array.isArray(value)) {
		let sum = 2;
		for (const item of value) sum += 1 + structuralTextSize(item);
		return sum;
	}
	if (typeof value === "object") {
		let sum = 2;
		for (const key in value as Record<string, unknown>) {
			sum += key.length + 1 + structuralTextSize((value as Record<string, unknown>)[key]);
		}
		return sum;
	}
	return 1;
}

/**
 * Cheap structural fingerprint of a message's tokenizable content. O(blocks) —
 * only reads string `.length` and primitives, never copies or serializes.
 * Detects in-place growth of the streaming tail (and other in-place mutations)
 * so the cached `getContextUsage()` result is recomputed when — and only when —
 * the numbers it depends on change. Exported for its dedicated test suite.
 */
export function messageFingerprint(msg: AgentMessage): string {
	const role = (msg as { role?: string }).role ?? "";
	const ts = (msg as { timestamp?: number }).timestamp ?? 0;
	let textLen = 0;
	let blocks = 0;
	let images = 0;
	if (role === "bashExecution") {
		const b = msg as { command?: unknown; output?: unknown };
		if (typeof b.command === "string") textLen += b.command.length;
		if (typeof b.output === "string") textLen += b.output.length;
	} else if (role === "user") {
		const content = (msg as { content?: unknown }).content;
		if (typeof content === "string") {
			textLen += content.length;
		} else if (Array.isArray(content)) {
			blocks = content.length;
			for (const block of content) {
				if (block?.type === "text" && typeof block.text === "string") textLen += block.text.length;
			}
		}
	} else if (role === "assistant") {
		const assistantMsg = msg as AssistantMessage;
		const usageExt = assistantMsg.usage as unknown as { promptTokensDetails?: unknown };
		const usageTotal = assistantMsg.usage?.totalTokens ?? 0;
		const promptBuckets = usageExt?.promptTokensDetails ? 1 : 0;
		const stopReason = assistantMsg.stopReason ?? "";

		let signatureLen = 0;
		let redactedLen = 0;
		const msgExt = assistantMsg as unknown as {
			thinkingSignature?: string;
			textSignature?: string;
			thoughtSignature?: string;
			redactedThinking?: { data?: string };
		};
		const thinkingSignature = msgExt.thinkingSignature;
		if (typeof thinkingSignature === "string") {
			signatureLen += thinkingSignature.length;
		}
		const textSignature = msgExt.textSignature;
		if (typeof textSignature === "string") {
			signatureLen += textSignature.length;
		}
		const thoughtSignature = msgExt.thoughtSignature;
		if (typeof thoughtSignature === "string") {
			signatureLen += thoughtSignature.length;
		}
		const redactedData = msgExt.redactedThinking?.data;
		if (typeof redactedData === "string") {
			redactedLen += redactedData.length;
		}

		const content = (msg as { content?: unknown }).content;
		if (Array.isArray(content)) {
			blocks = content.length;
			for (const block of content) {
				if (!block || typeof block !== "object") continue;
				const b = block as {
					type?: string;
					text?: string;
					thinking?: string;
					thinkingSignature?: string;
					signature?: string;
					textSignature?: string;
					thoughtSignature?: string;
					data?: string;
					name?: string;
					arguments?: unknown;
				};
				if (b.type === "text" && typeof b.text === "string") textLen += b.text.length;
				else if (b.type === "thinking") {
					if (typeof b.thinking === "string") textLen += b.thinking.length;
					if (typeof b.thinkingSignature === "string") signatureLen += b.thinkingSignature.length;
					if (typeof b.signature === "string") signatureLen += b.signature.length;
					if (typeof b.textSignature === "string") signatureLen += b.textSignature.length;
					if (typeof b.thoughtSignature === "string") signatureLen += b.thoughtSignature.length;
				} else if (b.type === "redactedThinking" && typeof b.data === "string") {
					redactedLen += b.data.length;
				} else if (b.type === "toolCall") {
					if (typeof b.name === "string") textLen += b.name.length;
					if (b.arguments !== undefined) {
						textLen += structuralTextSize(b.arguments);
					}
				}
			}
		}
		return `${role}:${ts}:${textLen}:${blocks}:${images}:${signatureLen}:${redactedLen}:${usageTotal}:${promptBuckets}:${stopReason}`;
	} else if (role === "toolResult" || role === "hookMessage") {
		const content = (msg as { content?: unknown }).content;
		if (typeof content === "string") {
			textLen += content.length;
		} else if (Array.isArray(content)) {
			blocks = content.length;
			for (const block of content) {
				if (!block || typeof block !== "object") continue;
				const b = block as { type?: string; text?: string };
				if (b.type === "text" && typeof b.text === "string") textLen += b.text.length;
				else if (b.type === "image") images++;
			}
		}
	} else if (role === "branchSummary" || role === "compactionSummary") {
		const s = (msg as { summary?: unknown }).summary;
		if (typeof s === "string") textLen += s.length;
	}
	return `${role}:${ts}:${textLen}:${blocks}:${images}`;
}

interface ContextUsageMemo {
	messagesRef: readonly AgentMessage[];
	length: number;
	lastFingerprint: string | undefined;
	modelContextWindow: number;
	contextUsageRevision: number;
	usedTokens: number | null;
	contextWindow: number;
	systemPromptRef: readonly string[] | undefined;
	toolsRef: readonly any[] | undefined;
	skillsRef: readonly any[] | undefined;
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

function hasGitBackedSegment(segments: readonly StatusLineSegmentId[]): boolean {
	return hasGitSegment(segments) || hasPrSegment(segments);
}

// ═══════════════════════════════════════════════════════════════════════════
// StatusLineComponent
// ═══════════════════════════════════════════════════════════════════════════

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
	/**
	 * Repaint the row, because something the git segments read has landed.
	 *
	 * Named for the callers rather than for the watcher that came first: a
	 * HEAD change fires it, and so do the three lookups that cannot answer on
	 * the frame that asked — the default branch, the pull request, and
	 * `git status`. All four leave a row on screen that no longer matches what
	 * the component would render, and the host has no other reason to repaint
	 * a resting session.
	 *
	 * `dispose()` clears it, and that is the whole of how a landing that
	 * arrives after the row is gone is stopped: the callback re-renders the
	 * host, the re-render reads `settings`, and a test has usually reset those
	 * by then. A second `#disposed` check at each call site would be a
	 * mechanism that can disagree with this one.
	 */
	#onGitStateChange: (() => void) | null = null;
	#disposed = false;
	#autoCompactEnabled: boolean = true;
	#hookStatuses: Map<string, string> = new Map();
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
	#lastTokensPerSecondTimestamp: number | null = null;

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
		if (this.#onGitStateChange) this.#setupGitWatcher();
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

	/**
	 * Register the row's repaint request and start watching HEAD.
	 *
	 * One callback for every git-backed reason the row goes stale, so a host
	 * wires a repaint once instead of learning which of the four lookups it has
	 * to subscribe to.
	 */
	watchGitState(onChange: () => void): void {
		this.#onGitStateChange = onChange;
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
				this.#onGitStateChange?.();
			});
		} catch {
			this.#invalidateGitCaches();
		}
	}

	dispose(): void {
		this.#disposed = true;
		this.#onGitStateChange = null;
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
	}
	#invalidateSessionCaches(): void {
		this.#clearUsageStartTimer();
		this.#cachedUsage = null;
		this.#usageFetchedAt = 0;
		this.#usageInFlight = false;
		this.#contextUsageCache = undefined;
		this.#lastTokensPerSecond = null;
		this.#lastTokensPerSecondTimestamp = null;
	}

	#invalidateGitCaches(): void {
		this.#cachedBranch = undefined;
		this.#cachedBranchRepoId = undefined;
		this.#cachedBranchCwd = undefined;
		this.#cachedPrContext = undefined;
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
						this.#onGitStateChange?.();
					}
				} catch {
					// Keep the `"main"` fallback; a decoration cannot fail a render.
				}
			})();
		}
		return branch === this.#defaultBranch;
	}

	/**
	 * The working tree's dirtiness, or `null` while nothing has asked git yet.
	 *
	 * `git status` is a subprocess and cannot answer on the frame that asked,
	 * so the row renders clean until it lands. The landing repaints. Without
	 * that the marker waited for whatever redrew next, which in a resting
	 * session is the next keystroke: the two lookups beside this one already
	 * repaint, and this was the one that did not.
	 *
	 * The repaint is conditional on {@link isTreeDirty} moving, not on the
	 * counts moving, so a refetch triggered by that very repaint cannot ask for
	 * another one and spin.
	 */
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
					const moved = isTreeDirty(this.#cachedGitStatus) !== isTreeDirty(nextStatus);
					this.#cachedGitStatus = nextStatus;
					this.#cachedGitStatusCwd = gitCwd;
					this.#gitStatusLastFetch = Date.now();
					this.#gitStatusInFlightCwd = undefined;
					if (moved) this.#onGitStateChange?.();
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
				this.#onGitStateChange?.();
			}
		})();

		return stalePr ?? null;
	}

	#getTokensPerSecond(): number | null {
		let lastAssistantTimestamp: number | null = null;
		for (let i = this.session.state.messages.length - 1; i >= 0; i--) {
			const message = this.session.state.messages[i];
			if (message?.role === "assistant") {
				lastAssistantTimestamp = message.timestamp;
				break;
			}
		}

		if (lastAssistantTimestamp === null) {
			this.#lastTokensPerSecond = null;
			this.#lastTokensPerSecondTimestamp = null;
			return null;
		}

		const rate = calculateTokensPerSecond(this.session.state.messages, this.session.isStreaming);
		if (rate !== null) {
			this.#lastTokensPerSecond = rate;
			this.#lastTokensPerSecondTimestamp = lastAssistantTimestamp;
			return rate;
		}

		if (this.#lastTokensPerSecondTimestamp === lastAssistantTimestamp) {
			return this.#lastTokensPerSecond;
		}

		return null;
	}

	#getUsageContextKey(session: AgentSession): string {
		const activeProvider = session.state.model?.provider ?? session.model?.provider ?? "";
		if (!activeProvider) return "";
		const identity = session.modelRegistry?.authStorage?.getOAuthAccountIdentity(activeProvider, session.sessionId);
		// orgId is part of the key: rotating between two same-email Anthropic
		// subscriptions must invalidate the cached usage immediately instead of
		// showing the previous org's quota for the rest of the cache TTL.
		return [
			activeProvider,
			identity?.accountId ?? "",
			identity?.email ?? "",
			identity?.projectId ?? "",
			identity?.orgId ?? "",
		].join("\0");
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
		const key = [
			activeProvider,
			servingId,
			stored.length,
			authStorage.getAccountName(activeProvider, servingId) ?? "",
			routing?.activeIsPrediction === true ? "next" : "serving",
		].join("\0");
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

	/**
	 * The session, reduced to the values the segments read.
	 *
	 * THE ONE PLACE the status row touches `AgentSession`. Every segment used to
	 * reach through `ctx.session` for a boolean or a name, which is what made the
	 * row unrenderable before a session existed and forced the launch card to
	 * keep a hand-written copy of half of it. Read once per render, like every
	 * other cached value on the context: a segment cannot call back into the
	 * session, so it cannot observe a state that changed mid-row.
	 */
	#facts(): SessionFacts {
		const state = this.session.state;
		const model = state.model;
		const sessionManager = this.session.sessionManager;
		return {
			model: model ? { id: model.id, name: model.name ?? "", supportsThinking: Boolean(model.thinking) } : null,
			thinkingLevel: state.thinkingLevel ?? ThinkingLevel.Off,
			autoThinking: this.session.isAutoThinking
				? { resolved: this.session.autoResolvedThinkingLevel() ?? null }
				: null,
			advisorActive: this.session.isAdvisorActive(),
			fastMode: this.session.isFastModeActive(),
			subscription: model ? this.session.modelRegistry.isUsingOAuth(model) : false,
			streaming: this.session.isStreaming,
			// Optional-called: the accessor is non-optional on `AgentSession`, but
			// embedders and test stubs satisfy the narrower shape, and a rung is
			// worth defaulting rather than throwing the whole row.
			approvalMode: this.session.effectiveApprovalMode?.(),
			approvalBypassed: this.session.isApprovalBypassed(),
			cwd: sessionManager?.getCwd?.() ?? null,
			sessionId: sessionManager?.getSessionId?.() ?? null,
			sessionName: sessionManager?.getSessionName() ?? null,
			goal: this.session.getGoalModeState()?.goal ?? null,
			goalModelBudgets: this.session.settings.get("goal.modelBudgetsEnabled") === true,
			goalVerbose: this.session.settings.get("goal.statusInFooter") === true,
			secrets: this.session.obfuscator?.liveSecrets() ?? null,
		};
	}

	#buildSegmentContext(
		width: number,
		segmentOptions: StatusLineSettings["segmentOptions"],
		includePath: boolean,
		includeContext: boolean,
		includeGit: boolean,
		includePr: boolean,
	): SegmentContext {
		const state = this.session.state;

		// Trigger background fetch (5-min TTL); render uses cached value
		this.refreshUsageInBackground();

		// Get usage statistics
		const aggregateUsageStats = this.session.sessionManager?.getUsageStatistics() ?? {
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
		const usageStats = {
			...aggregateUsageStats,
			tokensPerSecond: this.#getTokensPerSecond(),
		};

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
		return {
			facts: this.#facts(),
			focusedAgentId: this.#focusedAgentId,
			activeRepo: activeRepoCache.activeRepo,
			width,
			options: segmentOptions ?? {},
			compactThinkingLevel: this.#resolveSettings().compactThinkingLevel ?? false,
			planMode: this.#planModeStatus,
			loopMode: this.#loopModeStatus,
			prewalk:
				typeof this.session.getPrewalkState === "function" && this.session.getPrewalkState()
					? { enabled: true }
					: null,
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
			activeMs: this.getActiveMs(),
			git: {
				branch: gitBranch,
				status: gitStatus,
				pr: gitPr,
			},
			worktree: activeRepoCache.worktree,
			account: this.#servingAccount(this.session),
			usage: this.#cachedUsage,
		};
	}

	#resolveSettings(): EffectiveStatusLineSettings {
		if (this.#effectiveSettings === undefined) {
			this.#effectiveSettings = this.#computeEffectiveSettings();
		}
		return this.#effectiveSettings;
	}

	#computeEffectiveSettings(): EffectiveStatusLineSettings {
		return effectiveStatusLineSettings(this.#settings);
	}

	#subagentBadgeText(): string {
		return subagentBadgeText(this.#subagentCount);
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
		const running = this.session.getAsyncJobSnapshot()?.running;
		if (!running) return 0;
		return running.reduce((count, job) => (job.type === "task" ? count : count + 1), 0);
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

	// Layout of the last rendered quiet footline, for click hit-testing
	// (quietSegmentAt). Rewritten on every renderQuietLine call, so it always
	// matches the line currently on screen; empty when no footline rendered.
	#quietLineBounds: QuietSegmentBounds[] = [];

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
		const targetWidth = badgeParts.length > 0 ? visibleWidth(badgeParts.join(stateSeparator())) : 0;
		if (targetWidth !== this.#badgeSlotTargetWidth) {
			this.#badgeSlotFromWidth = this.#badgeSlotCurrentWidth();
			this.#badgeSlotTargetWidth = targetWidth;
			this.#badgeSlotAnimStartMs = Date.now();
			if (targetWidth > 0) this.#badgeSlotText = badgeParts.join(stateSeparator());
		}
		const width = this.#badgeSlotCurrentWidth();
		if (width === 0) return null;
		const clipped = truncateToWidth(this.#badgeSlotText, width);
		const clippedWidth = visibleWidth(clipped);
		return clippedWidth >= width ? clipped : clipped + " ".repeat(width - clippedWidth);
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
		this.#quietLineBounds = [];
		if (!this.#focusedAgentId) return null;
		return truncateToWidth(focusExitBadge(this.#focusedAgentId), Math.max(1, width));
	}

	/**
	 * The composer's ONE metadata footline: location (path · git) on the left,
	 * capability (model · mode · badges · context, then MCP health via
	 * `extras.locationRight`) on the right.
	 *
	 * The live state is gathered here and the LAYOUT belongs to `quiet-row.ts`,
	 * which the launch card renders the pre-session row through. Two renderers
	 * for one row is what let the card ship a hand-written `path · git` that
	 * omitted every segment added after it was written.
	 */
	renderQuietLine(width: number, extras?: { locationRight?: string | null }): string | null {
		// The focus badge rides the footline while the view is proxied onto an
		// agent, clamped to the row exactly as `renderFocusBadge` clamps it: an
		// agent id long enough to outrun the terminal wrapped the footline and
		// pushed the composer up a row on every render.
		const rawBadge = this.#focusedAgentId ? focusExitBadge(this.#focusedAgentId) : "";
		const badge = rawBadge === "" ? "" : truncateToWidth(rawBadge, Math.max(1, width));
		const row = composeQuietRow(this.#rowInput(width, badge, extras?.locationRight));
		this.#quietLineBounds = row.bounds;
		return row.line;
	}

	/**
	 * This session's live values, gathered into the shape both row layouts take.
	 *
	 * The gather runs against the width the badge leaves, because a segment
	 * budget measured against the whole row is a budget the badge has already
	 * spent. The two-line layout carries no badge and passes an empty one.
	 */
	#rowInput(width: number, badge: string, locationRight?: string | null): QuietRowInput {
		const runningBackgroundJobs = this.#backgroundJobBadgeCount();
		const badgeParts: string[] = [];
		if (runningBackgroundJobs > 0) {
			badgeParts.push(theme.fg("statusLineSubagents", withIcon(theme.icon.job, `${runningBackgroundJobs}`)));
		}
		const expansion = this.#expansionProgress();
		const groups = gatherQuietSegments({
			width: Math.max(0, width - visibleWidth(badge)),
			effectiveSettings: this.#resolveSettings(),
			gitEnabled: this.#gitEnabled(),
			expansion,
			buildContext: request =>
				this.#buildSegmentContext(
					request.width,
					request.options,
					request.includePath,
					request.includeContext,
					request.includeGit,
					request.includePr,
				),
			subagentBadge: this.#subagentBadgeText(),
			badgeSlot: this.#animatedBadgeSlot(badgeParts),
		});
		const { runningMs, lastRunMs } = this.getRunClock();
		return {
			...groups,
			width,
			badge,
			clock: runningMs !== null ? formatClock(runningMs) : lastRunMs > 0 ? `✓ ${formatClock(lastRunMs)}` : "",
			expansion,
			expandedHalf: this.#expandedHalf,
			locationRight,
		};
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
		return composeQuietLines(this.#rowInput(width, "", extras?.locationRight));
	}

	render(width: number): readonly string[] {
		// Only render hook statuses - main status is in editor's top border
		const showHooks = this.#settings.showHookStatus ?? true;
		if (!showHooks || this.#hookStatuses.size === 0) {
			return [];
		}

		const sortedStatuses = Array.from(this.#hookStatuses.entries())
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([, text]) => sanitizeStatusText(text));
		const hookLine = sortedStatuses.join(" ");
		return [truncateToWidth(hookLine, width)];
	}
}
