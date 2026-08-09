import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentMessage } from "@veyyon/agent-core";
import type { AssistantMessage, UsageLimit, UsageReport } from "@veyyon/ai";
import { type Component, padding, truncateToWidth, visibleWidth } from "@veyyon/tui";
import { formatClock, getProjectDir, scopedTimeoutSignal, withScopedTimeoutSignal } from "@veyyon/utils";
import { resolveContextLimit } from "../../../config/compaction-strategy";
// The slot leaf, not the 95-module store: this file reads settings, it does not fill them.
import { settings } from "../../../config/settings-instance";
import { accountDisplayLabel, accountsForProvider, buildAccountInventory } from "../../../session/account-inventory";
import type { AgentSession } from "../../../session/agent-session";
import type { OAuthAccountIdentity } from "../../../session/auth-storage";
import { limitMatchesActiveAccount } from "../../../slash-commands/helpers/active-oauth-account";
import { type ActiveRepoContext, resolveActiveRepoContextSync } from "../../../utils/active-repo-context";
import * as git from "../../../utils/git";
import { sanitizeStatusText } from "../../shared";
import { withIcon } from "../../theme/icon-label";
import { theme } from "../../theme/theme";
import { canReuseCachedPr, createPrCacheContext, isSamePrCacheContext, type PrCacheContext } from "./git-utils";
import { getPreset } from "./presets";
import { focusExitBadge, renderSegment, type SegmentContext } from "./segments";
import { calculateTokensPerSecond } from "./token-rate";
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

/**
 * One quiet-footline part: the segment id it came from plus its rendered
 * content. Ids are StatusLineSegmentId values, or the synthetic "badges"
 * (the animated badge slot) / "location_right" (owner-pinned right content).
 */
type QuietPart = { id: string; content: string };

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
 *
 * Why each of the four outranks a badge:
 *
 * `subagents` (4) is the persistent running count. It is the last thing standing by an older
 * contract than any of the rest: `status-line-running-subagents.test.ts` narrows the footline
 * to exactly the chip's width and requires the number to be what survives.
 *
 * `location_right` (3) is the owner-supplied zone holding the composer's draft token readout.
 * It is pushed LAST and the shed walks from the end, so without a rank it is always the FIRST
 * casualty however important it is. That is how the always-visible approval rung silently
 * evicted the draft counter at 100 columns: nothing removed the counter, the rung widened the
 * right group by one label and the counter fell off the end. Losing the count while the
 * operator is actively typing is a worse trade than dropping a badge they can re-read.
 *
 * `mode` (2) carries the approval rung — the one place that says whether the next command will
 * ask before it runs. The rule protecting it survived only in dead code: the deleted
 * `#buildStatusLine` refused to shed it ahead of the model name or the profile chip on exactly
 * that ground ("safety state outranks identity"), and that method had no production callers,
 * so the footline, which is what renders, shed `mode` first of the three.
 *
 * `context_pct` (1) is how much room is left before compaction fires — the footline's one live
 * value. `#gatherQuietSegments` appends it AFTER the right group on purpose, so it reads as the
 * line's last word, and the shed walks from the end: the deliberate placement made it the first
 * thing dropped at every width that did not fit, while `session_name`, a fixed string, was kept
 * ahead of it. On the DEFAULT preset at 80 columns that meant no gauge at all, and on `full` at
 * 160 it meant a cache-hit percentage on screen while the number that says when the session
 * ends was gone. It ranks lowest of the four because it is the only one that still reads as a
 * whole thought after the others are gone.
 */
const RIGHT_PART_SHED_RANK: Record<string, number> = {
	context_pct: 1,
	mode: 2,
	location_right: 3,
	subagents: 4,
};

/** One segment's slot on the rendered quiet footline (0-based columns, end exclusive). */
export interface QuietSegmentBounds {
	id: string;
	start: number;
	end: number;
}

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
	usedTokens: number;
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

function hasGitBackedSegment(segments: readonly StatusLineSegmentId[]): boolean {
	return hasGitSegment(segments) || hasPrSegment(segments);
}

// ═══════════════════════════════════════════════════════════════════════════
// StatusLineComponent
// ═══════════════════════════════════════════════════════════════════════════

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
	#subagentCount: number = 0;
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

	constructor(private session: AgentSession) {
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
			(async () => {
				const resolved = await git.branch.default(lookupCwd);
				if (this.#disposed || this.#defaultBranchCwd !== lookupCwd) return;
				if (resolved) {
					this.#defaultBranch = resolved;
					if (this.#onBranchChange) {
						this.#onBranchChange();
					}
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
	getCachedContextBreakdown(): { usedTokens: number; contextWindow: number } {
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
		const usedTokens = usage?.tokens ?? 0;
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
		let contextTokens = 0;
		if (includeContext) {
			const breakdown = this.getCachedContextBreakdown();
			contextTokens = breakdown.usedTokens;
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
			contextPercent = contextLimit > 0 ? (breakdown.usedTokens / contextLimit) * 100 : null;
		}

		// Collab guest: context comes from the host's state frames — the local
		// replica does no accounting of its own.
		const collabState = this.#collabStatus?.stateOverride;
		if (collabState?.contextUsage) {
			contextWindow = collabState.contextUsage.contextWindow || contextWindow;
			contextTokens = collabState.contextUsage.tokens ?? contextTokens;
			contextPercent = collabState.contextUsage.percent ?? contextPercent;
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
			session: this.session,
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
			contextTokens,
			contextWindow,
			contextLimit,
			contextLimitKind,
			autoCompactEnabled: this.#autoCompactEnabled,
			subagentCount: this.#subagentCount,
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

	#subagentBadgeText(): string {
		return theme.fg("statusLineSubagents", withIcon(theme.icon.agents, `${this.#subagentCount}`));
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
	#gatherQuietSegments(width: number): { location: QuietPart[]; capLeft: QuietPart[]; capRight: QuietPart[] } {
		const effectiveSettings = this.#resolveSettings();
		const gitEnabled = this.#gitEnabled();
		const leftCfg = effectiveSettings.leftSegments;
		const rightCfg = effectiveSettings.rightSegments;
		const includePath = hasPathSegment(leftCfg) || hasPathSegment(rightCfg);
		const includeContext = hasContextSegment(leftCfg) || hasContextSegment(rightCfg);
		const includeGit = gitEnabled && (hasGitSegment(leftCfg) || hasGitSegment(rightCfg));
		const includePr = gitEnabled && (hasPrSegment(leftCfg) || hasPrSegment(rightCfg));
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
		const quietOptions = {
			...effectiveSettings.segmentOptions,
			path: {
				...effectiveSettings.segmentOptions?.path,
				maxLength: effectiveSettings.segmentOptions?.path?.maxLength ?? 30,
			},
			model: { ...effectiveSettings.segmentOptions?.model, roomy: true },
		};
		const ctx = this.#buildSegmentContext(width, quietOptions, includePath, includeContext, includeGit, includePr);
		const LOCATION_IDS: Record<string, true> = { path: true, git: true, pr: true };
		const CONTEXT_IDS: Record<string, true> = { context_pct: true, context_total: true };
		const subagentBadge = this.#subagentBadgeText();
		const location: QuietPart[] = [];
		const capLeft: QuietPart[] = [];
		const capRight: QuietPart[] = [];
		const push = (id: StatusLineSegmentId, out: QuietPart[]) => {
			if (id === "subagents") return;
			const rendered = renderSegment(id, ctx);
			if (rendered.visible && rendered.content) out.push({ id, content: rendered.content });
		};
		// The context gauge is the footline's one LIVE value; everything else on the
		// right is standing state. A gauge configured on the left still belongs in the
		// right group (it is a capability reading, not a location), but pushing it there
		// during this first loop put it AHEAD of every right-configured segment, so the
		// default preset read `model · gauge · session-name`: the number that changes
		// every turn sandwiched between two that do not. Nobody chose that order; it
		// fell out of which loop ran first. Held aside and appended after the right
		// group instead, so the live value is the line's last word. A gauge the user
		// configured on the RIGHT keeps the position they gave it.
		const contextFromLeft: QuietPart[] = [];
		for (const id of leftCfg) {
			if (LOCATION_IDS[id]) push(id, location);
			else if (CONTEXT_IDS[id]) push(id, contextFromLeft);
			else push(id, capLeft);
		}
		for (const id of rightCfg) {
			if (LOCATION_IDS[id]) push(id, location);
			else push(id, capRight);
		}
		capRight.push(...contextFromLeft);
		const runningBackgroundJobs = this.#backgroundJobBadgeCount();
		const badgeParts: string[] = [];
		if (runningBackgroundJobs > 0) {
			badgeParts.push(theme.fg("statusLineSubagents", withIcon(theme.icon.job, `${runningBackgroundJobs}`)));
		}
		const badgeSlot = this.#animatedBadgeSlot(badgeParts);
		if (badgeSlot !== null) capRight.unshift({ id: "badges", content: badgeSlot });
		capRight.unshift({ id: "subagents", content: subagentBadge });
		return { location, capLeft, capRight };
	}

	// Layout of the last rendered quiet footline, for click hit-testing
	// (quietSegmentAt). Rewritten on every renderQuietLine call, so it always
	// matches the line currently on screen; empty when no footline rendered.
	#quietLineBounds: QuietSegmentBounds[] = [];

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
		const targetWidth = badgeParts.length > 0 ? visibleWidth(badgeParts.join(theme.fg("dim", " · "))) : 0;
		if (targetWidth !== this.#badgeSlotTargetWidth) {
			this.#badgeSlotFromWidth = this.#badgeSlotCurrentWidth();
			this.#badgeSlotTargetWidth = targetWidth;
			this.#badgeSlotAnimStartMs = Date.now();
			if (targetWidth > 0) this.#badgeSlotText = badgeParts.join(theme.fg("dim", " · "));
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
	#locationWithRunClock(location: string[], sep: string, gap: string = SESSION_CLOCK_GAP): string {
		const left = location.join(sep);
		if (!left) return left;
		const { runningMs, lastRunMs } = this.getRunClock();
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
		this.#quietLineBounds = [];
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
		const sep = theme.fg("dim", "  ·  ");
		// One cell of right margin, always — nothing kisses the terminal edge. Floored at ZERO, not
		// at one: a badge that already fills the row leaves no room to compete for, and clamping to
		// one cell is what let a 28-cell badge plus a segment render onto an 8-cell row.
		const budget = Math.max(0, width - 1 - badgeWidth);
		if (budget === 0) {
			this.#quietLineBounds = [];
			return badge === "" ? null : badge;
		}
		const locationContents = location.map(part => part.content);
		let left = this.#locationWithRunClock(locationContents, sep);
		const rightParts = [...capLeft, ...capRight];
		if (extras?.locationRight) rightParts.push({ id: "location_right", content: extras.locationRight });
		let right = rightParts.map(part => part.content).join(sep);
		// The run clock is comfort chrome; the capability segments (context
		// gauge, mode, badges) are operating data. On a tight width the clock
		// degrades FIRST — its roomy gap shrinks to two cells, then the clock
		// drops entirely — so it can never squeeze a segment off the line.
		let clockStage = 0;
		let locationShortened = false;
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
			let dropIndex = -1;
			let dropRank = Number.POSITIVE_INFINITY;
			for (let i = rightParts.length - 1; i >= 0; i--) {
				const rank = RIGHT_PART_SHED_RANK[rightParts[i]?.id ?? ""] ?? 0;
				if (rank < dropRank) {
					dropRank = rank;
					dropIndex = i;
				}
			}
			if (dropRank === 0 && dropIndex >= 0) {
				rightParts.splice(dropIndex, 1);
				right = rightParts.map(part => part.content).join(sep);
				continue;
			}
			// Only ranked parts are left. Shorten the location before touching any of
			// them: a clipped path still says where you are, and these do not degrade.
			if (!locationShortened) {
				locationShortened = true;
				const leftBudget = Math.max(0, budget - visibleWidth(right) - (right ? 2 : 0));
				left = truncateToWidth(locationContents.join(sep), leftBudget);
				continue;
			}
			// The location is gone too and the ranked parts still do not fit, so the
			// ranking has to resolve. Shedding the weakest is the whole point of having
			// one: the alternative is what shipped before it existed, where the return
			// below truncated the joined group and a budget of one cell rendered a bare
			// `…` — every ranked part destroyed at once, including the persistent
			// subagent count that outranks all of them.
			if (rightParts.length > 1 && dropIndex >= 0) {
				rightParts.splice(dropIndex, 1);
				right = rightParts.map(part => part.content).join(sep);
				continue;
			}
			break;
		}
		if (!left && !right) {
			this.#quietLineBounds = [];
			return badge === "" ? null : badge;
		}
		// Record where each surviving segment landed, in 0-based columns of the
		// returned line, so a footer click can be resolved back to a segment id
		// (see quietSegmentAt). The math mirrors the assembly exactly: location
		// parts start at column 0 and are sep-joined; the right group is
		// right-aligned at the budget when a left group exists, else it renders
		// from column 0 and truncates.
		const sepWidth = visibleWidth(sep);
		const bounds: QuietSegmentBounds[] = [];
		if (left) {
			let col = 0;
			for (const part of location) {
				const partWidth = visibleWidth(part.content);
				bounds.push({ id: part.id, start: col, end: col + partWidth });
				col += partWidth + sepWidth;
			}
		}
		const rightStart = left && right ? budget - visibleWidth(right) : 0;
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
		this.#quietLineBounds = bounds
			.filter(entry => entry.start < budget)
			.map(entry => ({
				...entry,
				start: entry.start + badgeWidth,
				end: Math.min(entry.end, budget) + badgeWidth,
			}));
		if (left && right) {
			return badge + left + padding(budget - visibleWidth(left) - visibleWidth(right)) + right;
		}
		return badge + truncateToWidth(left || right, budget);
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

	/** Last rendered quiet-footline layout, for tests and debugging. */
	getQuietSegmentBounds(): readonly QuietSegmentBounds[] {
		return this.#quietLineBounds;
	}

	renderQuietLines(
		width: number,
		extras?: { locationRight?: string | null },
	): { locationLine: string | null; capabilityLine: string | null } {
		const gathered = this.#gatherQuietSegments(width);
		const location = gathered.location.map(part => part.content);
		const capLeft = gathered.capLeft.map(part => part.content);
		const capRight = gathered.capRight.map(part => part.content);
		const sep = theme.fg("dim", "  ·  ");
		// One cell of right margin, always — nothing kisses the terminal edge.
		const budget = Math.max(1, width - 1);
		let locationLine: string | null = null;
		if (location.length > 0) {
			const left = this.#locationWithRunClock(location, sep);
			const right = extras?.locationRight ?? null;
			if (right && visibleWidth(left) + visibleWidth(right) + 2 <= budget) {
				locationLine = left + padding(budget - visibleWidth(left) - visibleWidth(right)) + right;
			} else {
				locationLine = truncateToWidth(left, budget);
			}
		}
		let capabilityLine: string | null = null;
		if (capLeft.length > 0 || capRight.length > 0) {
			const left = capLeft.join(sep);
			const rightParts = [...capRight];
			let right = rightParts.join(sep);
			// Free space between the groups is the design; on narrow terminals the
			// right group sheds parts before the gap closes below breathing room.
			while (rightParts.length > 0 && visibleWidth(left) + visibleWidth(right) + 2 > budget) {
				rightParts.pop();
				right = rightParts.join(sep);
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
			return [];
		}

		const sortedStatuses = Array.from(this.#hookStatuses.entries())
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([, text]) => sanitizeStatusText(text));
		const hookLine = sortedStatuses.join(" ");
		return [truncateToWidth(hookLine, width)];
	}
}
