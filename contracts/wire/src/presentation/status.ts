/**
 * Status-line view-model: the host-neutral status presentation contract.
 *
 * Every field is reduced to explicit values — no model objects, no runtime handles,
 * no active timers. Renderers (terminal, browser, headless) draw from this snapshot
 * without coupling to the agent runtime.
 */

/**
 * The active model, reduced to what the row prints.
 */
export interface StatusModelFact {
	id: string;
	name: string;
	/** The model supports a thinking budget, so the effort tail may render. */
	supportsThinking: boolean;
}

export type ModelFact = StatusModelFact;
/**
 * Goal status fact for status line presentation.
 */
export interface StatusGoalFact {
	readonly status?: string;
	readonly tokensUsed?: number;
	readonly tokenBudget?: number;
	readonly objective?: string;
	readonly description?: string;
	readonly activeTask?: string;
}

/**
 * Everything the status row needs from a session, as VALUES.
 */
export interface SessionFacts {
	model: StatusModelFact | null;
	/** The configured effort. Ignored while {@link autoThinking} is set. */
	thinkingLevel: string;
	/**
	 * Auto-thinking's state when it is on, absent when it is off. `resolved` is
	 * null while the turn is still being classified, which the segment prints as
	 * its pending marker rather than as a level.
	 */
	autoThinking: { resolved: string | null } | null;
	advisorActive: boolean;
	fastMode: boolean;
	/** The active model is served by a subscription login rather than metered credit. */
	subscription: boolean;
	/** The agent is mid-response. Drives the gauge tip and the goal spinner. */
	streaming: boolean;
	approvalMode: string | undefined;
	/** `/yolo` is on: every prompt is off, whatever approvalMode says. */
	approvalBypassed: boolean;
	/** The session's working directory, or null to fall back to the process one. */
	cwd: string | null;
	sessionId: string | null;
	sessionName: string | null;
	goal: StatusGoalFact | null;
	goalModelBudgets: boolean;
	goalVerbose: boolean;
}

export interface StatusUsageStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	orchestrationInput: number;
	orchestrationOutput: number;
	orchestrationCacheRead: number;
	premiumRequests: number;
	cost: number;
	tokensPerSecond: number | null;
}

export interface StatusContextBreakdown {
	usedTokens: number | null;
	contextWindow: number;
	contextLimit: number;
	contextLimitKind: "window" | "compaction";
	contextPercent: number | null;
}

export interface StatusServingAccount {
	label: string;
	storedCount: number;
	isPrediction: boolean;
}

export interface StatusProviderUsage {
	tier?: string;
	fiveHour?: { percent: number; resetMinutes?: number };
	sevenDay?: { percent: number; resetHours?: number };
}

export interface StatusRunClock {
	runningMs: number | null;
	lastRunMs: number;
}

export interface StatusCollabStateOverride {
	readonly contextUsage?: {
		readonly contextWindow?: number | null;
		readonly percent?: number | null;
		readonly tokens?: number | null;
	} | null;
}

export interface StatusCollabStatus {
	readonly role: "host" | "guest";
	readonly participantCount: number;
	readonly stateOverride?: StatusCollabStateOverride | null;
}

/**
 * Complete host-neutral display data snapshot for status-line rendering.
 */
export interface StatusLineState {
	facts: SessionFacts;
	focusedAgentId?: string | undefined;
	/** Monotonic session revision incremented on session or source swap. */
	sessionRevision?: number;
	planMode?: { enabled: boolean; paused: boolean } | null;
	loopMode?: { enabled: boolean } | null;
	prewalk?: { enabled: boolean } | null;
	goalMode?: { enabled: boolean; paused: boolean } | null;
	vibeMode?: { enabled: boolean } | null;
	collab?: StatusCollabStatus | null;
	usageStats: StatusUsageStats;
	context: StatusContextBreakdown;
	account?: StatusServingAccount | null;
	backgroundJobCount: number;
	activeMs: number;
	runClock: StatusRunClock;
}

/**
 * Narrowly typed action/refresh capabilities for status presentation.
 */
export interface StatusCapabilities {
	/** Get context key for provider usage caching (provider + account identity). */
	getUsageContextKey?: () => string;
	/** Fetch and normalize provider usage (5-min TTL background refresh). */
	fetchUsage?: (signal: AbortSignal) => Promise<StatusProviderUsage | null>;
	/** Record launch facts for the next startup. */
	recordLaunchFacts?: (contextPercent: number | null, contextLimit: number) => void;
	/** Set the focused subagent ID for status presentation. */
	setFocusedAgentId?: (focusedAgentId?: string | null) => void;
}

/**
 * Producer interface providing status display data and capabilities to renderers.
 */
export interface StatusDataSource {
	getSnapshot(): StatusLineState;
	readonly capabilities?: StatusCapabilities;
	/** Monotonic revision number incremented on session or source swap. */
	getRevision?(): number;
	markActivityStart?(): void;
	markActivityEnd?(): void;
	resetActiveTime?(): void;
	getActiveMs?(): number;
	getRunClock?(): StatusRunClock;
	setAutoCompactEnabled?(enabled: boolean): void;
}
