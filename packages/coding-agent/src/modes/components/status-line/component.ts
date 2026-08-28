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

function joinContents(parts: readonly QuietPart[], sep: string): string {
	if (parts.length === 0) return "";
	let result = parts[0]!.content;
	for (let i = 1; i < parts.length; i++) {
		result += sep + parts[i]!.content;
	}
	return result;
}

function pushQuietPart(id: StatusLineSegmentId, ctx: SegmentContext, out: QuietPart[]): void {
	if (id === "subagents") return;
	const rendered = renderSegment(id, ctx);
	if (!rendered.visible || !rendered.content) return;
	out.push({ id, content: rendered.content, pin: rendered.pin });
}

const RIGHT_PART_SHED_RANK: Record<string, number> = {
	context_pct: 1,
	model: 2,
	mode: 3,
	location_right: 4,
	subagents: 5,
	background: 6,
};

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
	worktree: WorktreeContext | null;
}

interface WorktreeContext {
	projectName: string;
	worktreeName: string;
}

function resolveWorktreeContext(cwd: string): WorktreeContext | null {
	const worktree = git.repo.linkedWorktreeSync(cwd);
	if (!worktree) return null;
	const base = path.basename(worktree.primaryRoot);
	const projectName = base.endsWith(".git") ? base.slice(0, -4) : base;
	if (!projectName) return null;
	return { projectName, worktreeName: path.basename(worktree.root) };
}

interface ActiveMeter {
	activeMs: number;
	activeStartedAt: number | null;
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

export interface StatusLineMotionOptions {
	requestRender?: () => void;
	clock?: MotionClock;
}

const EMPTY_HOOK_ROWS: readonly string[] = [];
const EMPTY_BOUNDS: readonly QuietSegmentBounds[] = [];

export class StatusLineComponent implements Component {
	#settings: StatusLineSettings = {};
	#effectiveSettings: EffectiveStatusLineSettings | undefined;
	#cachedBranch: string | null | undefined = undefined;
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
	#activeMeters: WeakMap<AgentSession, ActiveMeter> = new WeakMap();
	#planModeStatus: { enabled: boolean; paused: boolean } | null = null;
	#loopModeStatus: { enabled: boolean } | null = null;
	#goalModeStatus: { enabled: boolean; paused: boolean } | null = null;
	#vibeModeStatus: { enabled: boolean } | null = null;
	#collabStatus: CollabStatus | null = null;
	#focusedAgentId: string | undefined;
	#activeRepoCache: ActiveRepoCache | undefined;

	#cachedGitStatus: git.GitStatusSummary | null = null;
	#cachedGitStatusCwd: string | undefined = undefined;
	#gitStatusLastFetch = 0;
	#gitStatusInFlightCwd: string | undefined = undefined;

	#cachedPr: { number: number; url: string } | null | undefined = undefined;
	#cachedPrContext: PrCacheContext | undefined = undefined;
	#prLookupInFlight = false;
	#defaultBranch?: string;
	#defaultBranchCwd: string | undefined = undefined;
	#lastTokensPerSecond: number | null = null;
	#lastTokensPerSecondMsg: { timestamp: number } | null = null;

	#cachedUsage: {
		tier?: string;
		fiveHour?: { percent: number; resetMinutes?: number };
		sevenDay?: { percent: number; resetHours?: number };
	} | null = null;
	#cachedUsageContextKey: string | null = null;
	#usageFetchedAt = 0;
	#usageInFlight = false;
	#usageStartTimer: Timer | null = null;
	#cachedServingAccount: {
		key: string;
		value: { label: string; storedCount: number; isPrediction: boolean } | null;
	} | null = null;
	#contextUsageCache: ContextUsageMemo | undefined;
	#ctx: SegmentContext | undefined;
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
		const worktree = activeRepo ? null : resolveWorktreeContext(effectiveGitCwd);
		this.#activeRepoCache = { projectDir, activeRepo, effectiveGitCwd, worktree };
		return this.#activeRepoCache;
	}

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

	get subagentCount(): number {
		return this.#subagentCount;
	}

	setBackgroundSessionCount(count: number): void {
		const next = Number.isFinite(count) ? Math.max(0, Math.trunc(count)) : 0;
		if (next === this.#backgroundSessionCount) return;
		this.#backgroundSessionCount = next;
		this.invalidate();
	}

	get backgroundSessionCount(): number {
		return this.#backgroundSessionCount;
	}

	resetActiveTime(): void {
		const meter = this.#meter();
		meter.activeMs = 0;
		meter.activeStartedAt = null;
		meter.lastRunMs = 0;
	}

	markActivityStart(): void {
		const meter = this.#meter();
		if (meter.activeStartedAt !== null) return;
		meter.activeStartedAt = Date.now();
	}

	markActivityEnd(): void {
		const meter = this.#meter();
		if (meter.activeStartedAt === null) return;
		const windowMs = Math.max(0, Date.now() - meter.activeStartedAt);
		meter.activeMs += windowMs;
		meter.lastRunMs = windowMs;
		meter.activeStartedAt = null;
	}

	getRunClock(): { runningMs: number | null; lastRunMs: number } {
		const meter = this.#meter();
		return {
			runningMs: meter.activeStartedAt === null ? null : Math.max(0, Date.now() - meter.activeStartedAt),
			lastRunMs: meter.lastRunMs,
		};
	}

	getActiveMs(): number {
		const meter = this.#meter();
		if (meter.activeStartedAt === null) return meter.activeMs;
		return meter.activeMs + Math.max(0, Date.now() - meter.activeStartedAt);
	}

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
				} catch {}
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

		const lookupBranch = this.#cachedPrBranch;
		if (!lookupBranch || this.#isDefaultBranch(lookupBranch, gitCwd) || this.#prLookupInFlight) {
			return stalePr ?? null;
		}

		this.#prLookupInFlight = true;
		const lookupContext = currentContext;
		const lookupCwd = gitCwd;

		(async () => {
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
		return `${activeProvider}\0${identity?.accountId ?? ""}\0${identity?.email ?? ""}\0${identity?.projectId ?? ""}\0${identity?.orgId ?? ""}`;
	}

	#servingAccount(session: AgentSession): { label: string; storedCount: number; isPrediction: boolean } | null {
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
		const effectiveTier = fiveHourTier ?? sevenDayTier;
		return { tier: effectiveTier, fiveHour, sevenDay };
	}

	getCachedContextBreakdown(): { usedTokens: number | null; contextWindow: number } {
		const messages = this.session.messages ?? EMPTY_MESSAGES;
		const modelContextWindow = this.session.model?.contextWindow ?? 0;
		const length = messages.length;
		const lastFingerprint = length > 0 ? messageFingerprint(messages[length - 1]!) : undefined;
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

		this.refreshUsageInBackground();

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
			if (this.#autoCompactEnabled) {
				const limit = resolveContextLimit(contextWindow, this.session.settings.getGroup("compaction"));
				contextLimit = limit.tokens;
				contextLimitKind = limit.kind;
			}
			contextPercent =
				breakdown.usedTokens === null
					? null
					: contextLimit > 0
						? (breakdown.usedTokens / contextLimit) * 100
						: null;
		}

		const collabState = this.#collabStatus?.stateOverride;
		if (collabState?.contextUsage) {
			contextWindow = collabState.contextUsage.contextWindow || contextWindow;
			contextPercent = collabState.contextUsage.percent;
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

	#backgroundJobBadgeCount(): number {
		return this.session.getRunningNonTaskJobCount();
	}

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
		const expansion = this.#expansionProgress();
		const collapsedPathBudget = effectiveSettings.segmentOptions?.path?.maxLength ?? 30;
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
	#quietLineBounds: readonly QuietSegmentBounds[] = EMPTY_BOUNDS;
	#pathExpanded = false;
	#expandedHalf: StatusLineSegmentId = "path";

	#expansionProgress(): number {
		return this.#expansion?.value ?? (this.#pathExpanded ? 1 : 0);
	}

	#badgeSlotFromWidth = 0;
	#badgeSlotTargetWidth = 0;
	#badgeSlotAnimStartMs = 0;
	#badgeSlotText = "";
	static readonly #BADGE_ANIM_MS = 240;

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

	renderFocusBadge(width: number): string | null {
		this.#quietLineBounds = EMPTY_BOUNDS;
		if (!this.#focusedAgentId) return null;
		return truncateToWidth(focusExitBadge(this.#focusedAgentId), Math.max(1, width));
	}

	renderQuietLine(width: number, extras?: { locationRight?: string | null }): string | null {
		const rawBadge = this.#focusedAgentId ? focusExitBadge(this.#focusedAgentId) : "";
		const badge = rawBadge === "" ? "" : truncateToWidth(rawBadge, Math.max(1, width));
		const badgeWidth = visibleWidth(badge);
		const { location, capLeft, capRight } = this.#gatherQuietSegments(Math.max(0, width - badgeWidth));
		const sep = segmentSeparator();
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
		let clockStage = 0;
		let locationShortened = false;
		let locationSlots: QuietSegmentBounds[] | null = null;
		let locationCramped = false;
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
			const weakest = weakestRightPart(rightParts);
			const dropIndex = weakest.index;
			const dropRank = weakest.rank;
			if (dropRank === 0 && dropIndex >= 0) {
				rightParts.splice(dropIndex, 1);
				right = joinContents(rightParts, sep);
				continue;
			}
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
			if (rightParts.length > 1 && dropIndex >= 0) {
				rightParts.splice(dropIndex, 1);
				right = joinContents(rightParts, sep);
				continue;
			}
			break;
		}
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
		const expansion = this.#expansionProgress();
		if (expansion > 0 && rightParts.length > 0) {
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
			const spend = Math.min(Math.max(0, wanted - held), onOffer);
			if (spend > 0) {
				let owed = spend;
				const spent: number[] = [];
				for (const index of order) {
					if (owed <= 0) break;
					const part = rightParts[index];
					if (part === undefined) continue;
					const width = visibleWidth(part.content);
					const floor = expansion >= 1 ? MIN_LOCATION_PART : MIN_READABLE_PART;
					if (owed >= width - floor) {
						spent.push(index);
						owed -= width + sepWidth;
						continue;
					}
					rightParts[index] = { ...part, content: truncateToWidth(part.content, width - owed) };
					owed = 0;
				}
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
		const sepWidth = visibleWidth(sep);
		const bounds = this.#quietBounds;
		bounds.length = 0;
		if (left) {
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
		const rightStart = right ? Math.max(0, budget - visibleWidth(right)) : 0;
		if (right) {
			let col = rightStart;
			for (const part of rightParts) {
				const partWidth = visibleWidth(part.content);
				bounds.push({ id: part.id, start: col, end: col + partWidth });
				col += partWidth + sepWidth;
			}
		}
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
		if (left) return badge + truncateToWidth(left, budget);
		return badge + padding(rightStart) + truncateToWidth(right, budget);
	}

	quietSegmentAt(col: number): string | null {
		for (const entry of this.#quietLineBounds) {
			if (col >= entry.start && col < entry.end) return entry.id;
		}
		return null;
	}

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
				locationLine = fitLocation(gathered.location, sep, budget).text;
			}
		}
		let capabilityLine: string | null = null;
		if (capLeft.length > 0 || capRight.length > 0) {
			const left = capLeft.join(sep);
			let right = capRight.join(sep);
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
		const showHooks = this.#settings.showHookStatus ?? true;
		if (!showHooks || this.#hookStatuses.size === 0) {
			if (this.#cachedHookRows.length !== 0) {
				this.#cachedHookSig = "";
				this.#cachedHookRows = EMPTY_HOOK_ROWS;
			}
			return this.#cachedHookRows;
		}

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
