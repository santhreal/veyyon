import * as fs from "node:fs";
import * as path from "node:path";
import type { Component } from "@veyyon/tui/tui";
import { getProjectDir } from "@veyyon/utils/dirs";
import { formatClock } from "@veyyon/utils/format";
import { MOTION, type MotionClock, SettleValue } from "@veyyon/utils/motion";
import { sanitizeStyledStatusText } from "@veyyon/utils/sanitize-status-text";
import { scopedTimeoutSignal, withScopedTimeoutSignal } from "@veyyon/utils/scoped-timeout";
import { truncateToWidth, visibleWidth } from "@veyyon/utils/width";
import type { StatusDataSource, StatusLineState, StatusProviderUsage, StatusRunClock } from "@veyyon/wire/presentation";
import { settings } from "../../../../config/settings-instance";
import { StatusPresentationProducer } from "../../../../presentation/status-producer";
import { withIcon } from "../../../../theme/icon-label";
import { transitionsEnabled } from "../../../../theme/shimmer";
import { theme } from "../../../../theme/theme-binding";
import * as git from "../../../../utils/git";
import { readLaunchFacts, recordLaunchFacts } from "../../../launch-facts";
import { isTreeDirty } from "./branch";
import { canReuseCachedPr, createPrCacheContext, isSamePrCacheContext, type PrCacheContext } from "./git-utils";
import { type LocationContext, resolveLocationContext } from "./location-context";
import {
	agentBadgeText,
	composeQuietLines,
	composeQuietRow,
	effectiveStatusLineSettings,
	gatherQuietSegments,
	hasGitSegment,
	hasPrSegment,
	type QuietRowInput,
	type QuietSegmentBounds,
	statusLineSettingsFromConfig,
} from "./quiet-row";
import { focusExitBadge, type SegmentContext } from "./segments";
import { stateSeparator } from "./state-grammar";
import type { CollabStatus, EffectiveStatusLineSettings, StatusLineSegmentId, StatusLineSettings } from "./types";

export { messageFingerprint } from "../../../../presentation/status-producer";

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
	#source: StatusDataSource;
	#snapshot: StatusLineState | undefined;
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
	 */
	#onGitStateChange: (() => void) | null = null;
	#disposed = false;
	#autoCompactEnabled: boolean = true;
	#hookStatuses: Map<string, string> = new Map();
	#agentCount: number = 0;
	#backgroundSessionCount: number = 0;
	#planModeStatus: { enabled: boolean; paused: boolean } | null = null;
	#loopModeStatus: { enabled: boolean } | null = null;
	#goalModeStatus: { enabled: boolean; paused: boolean } | null = null;
	#vibeModeStatus: { enabled: boolean } | null = null;
	#collabStatus: CollabStatus | null = null;
	#focusedAgentId: string | undefined;
	#activeRepoCache: LocationContext | undefined;

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

	// Provider usage caching (5-min TTL)
	#cachedUsage: StatusProviderUsage | null = null;
	#cachedUsageContextKey: string | null = null;
	#usageFetchedAt = 0;
	#usageInFlight = false;
	#usageStartTimer: Timer | null = null;
	#lastSourceRevision: number | undefined = undefined;
	#lastUsageRevision: number | undefined = undefined;

	/**
	 * The path expansion, as a value between the collapsed row and the expanded one, or
	 * undefined when the host gave no repaint hook.
	 */
	readonly #expansion: SettleValue | undefined;

	constructor(source: unknown, motion: StatusLineMotionOptions = {}) {
		if (typeof source === "function") {
			this.#source = { getSnapshot: source as () => StatusLineState };
		} else if (
			source &&
			typeof source === "object" &&
			"getSnapshot" in source &&
			typeof (source as StatusDataSource).getSnapshot === "function"
		) {
			this.#source = source as StatusDataSource;
		} else {
			this.#source = new StatusPresentationProducer(source as never);
		}
		if (motion.requestRender) {
			this.#expansion = new SettleValue({
				requestRender: motion.requestRender,
				clock: motion.clock,
				curve: MOTION.reflow,
			});
			this.#expansion.set(0);
		}
		this.#settings = statusLineSettingsFromConfig();
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

	setSnapshot(snapshot: StatusLineState): void {
		if (this.#focusedAgentId !== snapshot.focusedAgentId) {
			this.setSource(this.#source, snapshot.focusedAgentId);
		}
		this.#snapshot = snapshot;
		this.#checkSourceRevision(snapshot);
		this.invalidate();
	}

	#getSnapshot(): StatusLineState {
		return this.#snapshot ?? this.#source.getSnapshot();
	}

	#resolveActiveRepoCache(snapshot?: StatusLineState): LocationContext {
		const snapshotCwd = (snapshot ?? this.#getSnapshot()).facts.cwd;
		const projectDir = snapshotCwd ?? getProjectDir();
		if (this.#activeRepoCache?.projectDir === projectDir) {
			return this.#activeRepoCache;
		}

		this.#activeRepoCache = resolveLocationContext(projectDir);
		return this.#activeRepoCache;
	}

	/**
	 * Re-point the status line at another data source (focus proxy / session swap).
	 */
	setSource(source: StatusDataSource | (() => StatusLineState), focusedAgentId?: string): void {
		const nextSource = typeof source === "function" ? { getSnapshot: source } : source;
		const sourceChanged = this.#source !== nextSource || this.#snapshot !== undefined;
		this.#snapshot = undefined;
		const focusChanged = this.#focusedAgentId !== focusedAgentId;
		if (!sourceChanged && !focusChanged) return;
		this.#source = nextSource;
		this.#focusedAgentId = focusedAgentId;
		this.#source.capabilities?.setFocusedAgentId?.(focusedAgentId);
		this.#lastSourceRevision = this.#source.getRevision?.();
		this.#lastUsageRevision = this.#source.getRevision?.() ?? 0;
		this.#cachedUsageContextKey = this.#source.capabilities?.getUsageContextKey?.() ?? "";
		this.#cachedUsage = null;
		this.#usageFetchedAt = 0;
		if (this.#usageStartTimer) {
			clearTimeout(this.#usageStartTimer);
			this.#usageStartTimer = null;
		}
		this.#usageInFlight = false;
		this.#invalidateSessionCaches();
		this.invalidate();
	}

	setSession(sessionOrSource: unknown, focusedAgentId?: string): void {
		if (
			typeof sessionOrSource === "function" ||
			(sessionOrSource &&
				typeof sessionOrSource === "object" &&
				"getSnapshot" in sessionOrSource &&
				typeof (sessionOrSource as StatusDataSource).getSnapshot === "function")
		) {
			this.setSource(sessionOrSource as StatusDataSource | (() => StatusLineState), focusedAgentId);
			return;
		}
		if (this.#source instanceof StatusPresentationProducer) {
			this.#source.setSession(sessionOrSource as never, focusedAgentId);
			this.setSource(this.#source, focusedAgentId);
		} else {
			this.setSource(new StatusPresentationProducer(sessionOrSource as never, focusedAgentId), focusedAgentId);
		}
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
		this.#source.setAutoCompactEnabled?.(enabled);
	}

	setAgentCount(count: number): void {
		this.#agentCount = Number.isFinite(count) ? Math.max(0, Math.trunc(count)) : 0;
	}

	/** Currently executing agents shown on every interactive status surface. */
	get agentCount(): number {
		return this.#agentCount;
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

	resetActiveTime(): void {
		this.#source.resetActiveTime?.();
	}

	markActivityStart(): void {
		this.#source.markActivityStart?.();
	}

	markActivityEnd(): void {
		this.#source.markActivityEnd?.();
	}

	getRunClock(): StatusRunClock {
		if (this.#snapshot) return this.#snapshot.runClock;
		if (this.#source.getRunClock) return this.#source.getRunClock();
		return this.#getSnapshot().runClock;
	}

	getActiveMs(): number {
		if (this.#snapshot) return this.#snapshot.activeMs;
		if (this.#source.getActiveMs) return this.#source.getActiveMs();
		return this.#getSnapshot().activeMs;
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
				try {
					const resolved = await git.branch.default(lookupCwd);
					if (this.#disposed || this.#defaultBranchCwd !== lookupCwd) return;
					if (resolved) {
						this.#defaultBranch = resolved;
						this.#onGitStateChange?.();
					}
				} catch {
					// Keep the "main" fallback
				}
			})();
		}
		return branch === this.#defaultBranch;
	}

	#getGitStatus(effectiveGitCwd?: string): git.GitStatusSummary | null {
		if (!this.#gitEnabled()) return null;

		const gitCwd = effectiveGitCwd ?? this.#resolveActiveRepoCache().effectiveGitCwd;
		if (this.#cachedGitStatusCwd === undefined && gitCwd === getProjectDir()) {
			this.#cachedGitStatusCwd = gitCwd;
			this.#cachedGitStatus = readLaunchFacts().gitStatus;
		}
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
				const parsed = JSON.parse(result.stdout);
				if (
					parsed &&
					typeof parsed === "object" &&
					typeof parsed.number === "number" &&
					typeof parsed.url === "string"
				) {
					setCachedPr({ number: parsed.number, url: parsed.url });
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

	refreshUsageInBackground(): void {
		const capabilities = this.#source.capabilities;
		if (!capabilities?.fetchUsage) return;
		const now = Date.now();
		const usageContextKey = capabilities.getUsageContextKey ? capabilities.getUsageContextKey() : "";
		const revision = this.#source.getRevision?.() ?? 0;
		if (this.#cachedUsageContextKey !== usageContextKey || this.#lastUsageRevision !== revision) {
			this.#cachedUsage = null;
			this.#usageFetchedAt = 0;
			this.#cachedUsageContextKey = usageContextKey;
			this.#lastUsageRevision = revision;
			if (this.#usageStartTimer) {
				clearTimeout(this.#usageStartTimer);
				this.#usageStartTimer = null;
			}
			this.#usageInFlight = false;
		}
		if (this.#usageInFlight || this.#usageStartTimer) return;
		if (this.#usageFetchedAt > 0 && now - this.#usageFetchedAt < 5 * 60_000) return;
		this.#usageInFlight = true;
		const source = this.#source;
		const fetchUsage = capabilities.fetchUsage;
		const contextKey = usageContextKey;
		this.#usageStartTimer = setTimeout(() => {
			this.#usageStartTimer = null;
			void this.#runUsageRefresh(source, fetchUsage, revision, contextKey);
		}, STATUS_USAGE_START_DELAY_MS);
	}

	async #runUsageRefresh(
		source: StatusDataSource,
		fetchUsage: (signal: AbortSignal) => Promise<StatusProviderUsage | null>,
		revision: number,
		contextKey: string,
	): Promise<void> {
		const isStale = () =>
			this.#disposed ||
			this.#source !== source ||
			(this.#source.getRevision?.() ?? 0) !== revision ||
			this.#cachedUsageContextKey !== contextKey;

		if (isStale()) {
			return;
		}
		const { signal, cancel } = scopedTimeoutSignal(STATUS_USAGE_REFRESH_TIMEOUT_MS);
		let usagePromise: Promise<StatusProviderUsage | null> | undefined;
		try {
			usagePromise = fetchUsage(signal);
			const result = await this.#raceUsageRefreshWithSignal(usagePromise, signal);
			if (isStale()) return;
			this.#cachedUsage = result;
			this.#usageFetchedAt = Date.now();
			this.#onGitStateChange?.();
		} catch {
			if (isStale()) return;
			this.#usageFetchedAt = Date.now();
			if (signal.aborted && usagePromise) {
				this.#observeLateUsageRefresh(source, usagePromise, revision, contextKey);
			}
		} finally {
			cancel();
			if (!isStale()) {
				this.#usageInFlight = false;
			}
		}
	}

	#observeLateUsageRefresh(
		source: StatusDataSource,
		usagePromise: Promise<StatusProviderUsage | null>,
		revision: number,
		contextKey: string,
	): void {
		const isStale = () =>
			this.#disposed ||
			this.#source !== source ||
			(this.#source.getRevision?.() ?? 0) !== revision ||
			this.#cachedUsageContextKey !== contextKey;

		void usagePromise
			.then(result => {
				if (isStale()) return;
				this.#cachedUsage = result;
				this.#usageFetchedAt = Date.now();
				this.#onGitStateChange?.();
			})
			.catch(() => {
				if (isStale()) return;
				this.#usageFetchedAt = Date.now();
			});
	}

	async #raceUsageRefreshWithSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
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

	getCachedContextBreakdown(): { usedTokens: number | null; contextWindow: number } {
		const { usedTokens, contextWindow } = this.#getSnapshot().context;
		return { usedTokens, contextWindow };
	}

	#recordLaunchFacts(contextPercent: number | null, contextLimit: number, isCollabGuest: boolean): void {
		if (isCollabGuest) return;
		this.#source.capabilities?.recordLaunchFacts?.(contextPercent, contextLimit);
		if (this.#cachedGitStatus) void recordLaunchFacts({ gitStatus: this.#cachedGitStatus });
	}

	#buildSegmentContext(
		snapshot: StatusLineState,
		width: number,
		segmentOptions: StatusLineSettings["segmentOptions"],
		includePath: boolean,
		includeContext: boolean,
		includeGit: boolean,
		includePr: boolean,
	): SegmentContext {
		this.refreshUsageInBackground();

		let contextWindow = 0;
		let contextLimit = 0;
		let contextLimitKind: "window" | "compaction" = "window";
		let contextPercent: number | null = null;

		if (includeContext) {
			contextWindow = snapshot.context.contextWindow;
			contextLimit = snapshot.context.contextLimit;
			contextLimitKind = snapshot.context.contextLimitKind;
			contextPercent = snapshot.context.contextPercent;
		}

		const collabStatus = this.#collabStatus ?? snapshot.collab;
		const collabOverride = collabStatus?.stateOverride;
		if (
			collabOverride &&
			typeof collabOverride === "object" &&
			"contextUsage" in collabOverride &&
			collabOverride.contextUsage &&
			typeof collabOverride.contextUsage === "object"
		) {
			const cu = collabOverride.contextUsage as { contextWindow?: number; percent: number | null };
			contextWindow = cu.contextWindow || contextWindow;
			contextPercent = cu.percent;
			contextLimit = contextWindow;
			contextLimitKind = "window";
		}

		if (includeContext) {
			this.#recordLaunchFacts(contextPercent, contextLimit, collabOverride != null);
		}

		const shouldResolveActiveRepo = this.#gitEnabled() && (includePath || includeGit || includePr);
		const projectDir = snapshot.facts.cwd ?? getProjectDir();
		const activeRepoCache = shouldResolveActiveRepo
			? this.#resolveActiveRepoCache(snapshot)
			: { projectDir, activeRepo: null, effectiveGitCwd: projectDir, worktree: null, repository: null };
		const gitBranch = includeGit || includePr ? this.#getCurrentBranch(activeRepoCache.effectiveGitCwd) : null;
		const gitStatus = includeGit ? this.#getGitStatus(activeRepoCache.effectiveGitCwd) : null;
		const gitPr = includePr ? this.#lookupPr(activeRepoCache.effectiveGitCwd) : null;
		return {
			facts: snapshot.facts,
			focusedAgentId: this.#focusedAgentId ?? snapshot.focusedAgentId,
			activeRepo: activeRepoCache.activeRepo,
			width,
			options: segmentOptions ?? {},
			compactThinkingLevel: this.#resolveSettings().compactThinkingLevel ?? false,
			planMode: this.#planModeStatus ?? snapshot.planMode ?? null,
			loopMode: this.#loopModeStatus ?? snapshot.loopMode ?? null,
			prewalk: snapshot.prewalk ?? null,
			goalMode: this.#goalModeStatus ?? snapshot.goalMode ?? null,
			vibeMode: this.#vibeModeStatus ?? snapshot.vibeMode ?? null,
			collab: collabStatus ?? null,
			usageStats: snapshot.usageStats,
			contextPercent,
			contextWindow,
			contextLimit,
			contextLimitKind,
			autoCompactEnabled: this.#autoCompactEnabled,
			agentCount: this.#agentCount,
			backgroundSessionCount: this.#backgroundSessionCount,
			activeMs: this.getActiveMs(),
			git: {
				branch: gitBranch,
				status: gitStatus,
				pr: gitPr,
			},
			worktree: activeRepoCache.worktree,
			account: snapshot.account ?? null,
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

	#agentBadgeText(): string {
		return agentBadgeText(this.#agentCount);
	}

	#quietLineBounds: QuietSegmentBounds[] = [];
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

	renderFocusBadge(width: number): string | null {
		this.#quietLineBounds = [];
		if (!this.#focusedAgentId) return null;
		return truncateToWidth(focusExitBadge(this.#focusedAgentId), Math.max(1, width));
	}

	#checkSourceRevision(snapshot?: StatusLineState): void {
		const revision = snapshot?.sessionRevision ?? this.#source.getRevision?.();
		if (revision !== undefined && this.#lastSourceRevision !== undefined && revision !== this.#lastSourceRevision) {
			this.#lastSourceRevision = revision;
			this.#invalidateSessionCaches();
		} else if (revision !== undefined && this.#lastSourceRevision === undefined) {
			this.#lastSourceRevision = revision;
		}
	}

	renderQuietLine(width: number, extras?: { locationRight?: string | null }): string | null {
		const rawBadge = this.#focusedAgentId ? focusExitBadge(this.#focusedAgentId) : "";
		const badge = rawBadge === "" ? "" : truncateToWidth(rawBadge, Math.max(1, width));
		const row = composeQuietRow(this.#rowInput(width, badge, extras?.locationRight));
		this.#quietLineBounds = row.bounds;
		return row.line;
	}

	#rowInput(width: number, badge: string, locationRight?: string | null): QuietRowInput {
		const snapshot = this.#getSnapshot();
		this.#checkSourceRevision(snapshot);
		const runningBackgroundJobs = snapshot.backgroundJobCount ?? 0;
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
					snapshot,
					request.width,
					request.options,
					request.includePath,
					request.includeContext,
					request.includeGit,
					request.includePr,
				),
			agentBadge: this.#agentBadgeText(),
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
		return composeQuietLines(this.#rowInput(width, "", extras?.locationRight));
	}

	render(width: number): readonly string[] {
		const showHooks = this.#settings.showHookStatus ?? true;
		if (!showHooks || this.#hookStatuses.size === 0) {
			return [];
		}

		const entries = Array.from(this.#hookStatuses.entries());
		entries.sort(([a], [b]) => a.localeCompare(b));
		let hookLine = "";
		for (let si = 0; si < entries.length; si++) {
			const sanitized = sanitizeStyledStatusText(entries[si]![1]);
			hookLine = si === 0 ? sanitized : `${hookLine} ${sanitized}`;
		}
		return [truncateToWidth(hookLine, width)];
	}
}
