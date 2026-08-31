/**
 * One complete stub session for the status-row suites.
 *
 * The row reads a session through exactly one adapter now
 * (`StatusLineComponent`'s `#facts()`), and that adapter reads EVERY fact on
 * every render rather than only the ones a given preset happens to reach. Nine
 * suites carried their own partial fake of `AgentSession`, each missing
 * whichever accessors its preset never touched, so widening the preset — or
 * adding a fact — crashed each of them on a different missing method.
 *
 * This is the one fake, and it is complete. A fact added to the adapter is
 * added HERE, once, and either every suite keeps working or the omission fails
 * in this file, where it is visible, instead of in nine that each look correct.
 *
 * It is not a mock framework: it answers with the resting values a launched
 * session answers with, and a suite that needs a different answer overrides that
 * one key. It asserts nothing and records no calls, so a suite can never come to
 * depend on how the row reached a value rather than on what the row printed.
 *
 * WHAT IT DOES NOT CATCH: it cannot prove the real `AgentSession` still answers
 * these names. `factsFromSession` is typed against the real class, so a rename
 * fails the type check rather than these suites.
 */
import type { AgentSession } from "@veyyon/coding-agent/session/agent-session";

const CONTEXT_WINDOW = 128_000;

/** The spend counters the row reads, named so a partial override keeps each type. */
export interface SessionUsage {
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
	/** Null until a turn has streamed long enough to measure one. */
	tokensPerSecond: number | null;
}

/** A session that has spent nothing: every counter zero, no rate yet. */
const RESTING_USAGE: SessionUsage = {
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
};

export interface ContextUsage {
	tokens: number;
	contextWindow: number;
}

export interface StubSessionOptions {
	/** Working directory the path segment renders. Read per render, so a suite may move it. */
	cwd?: () => string;
	modelId?: string;
	/** Display name; defaults to the id, which is what a listing without one gives. */
	modelName?: string;
	contextWindow?: number;
	/**
	 * The anchored context reading. `undefined` is the real pre-first-turn state,
	 * where the gauge has no number and must say so rather than print a zero.
	 */
	contextUsage?: ContextUsage | undefined;
	/** Spend counters, for the suites that assert cost, premium requests or rate. */
	usage?: Partial<SessionUsage>;
	/** Explicit `undefined` means an unnamed session, which the chip must hide rather than clamp. */
	sessionName?: string | undefined;
	/** Transcript the row fingerprints and counts. */
	messages?: unknown[];
	/** Prewalk's armed target, which the mode segment annotates. */
	prewalk?: { target: { id: string; provider: string } };
	/** `/yolo`: the bypass marker stands beside the mode label and replaces the rung. */
	approvalBypassed?: boolean;
	advisorActive?: boolean;
	fastMode?: boolean;
	streaming?: boolean;
	/** The live obfuscator, whose `liveSecrets()` the secrets chip counts. */
	obfuscator?: unknown;
}

/**
 * The same session as an open record, for a suite that needs a member this
 * option set does not carry — a usage fetcher, a credential store, a running-job
 * snapshot. Spread it and override the one key:
 *
 * ```ts
 * { ...statusLineSessionParts(), fetchUsageReports } as unknown as AgentSession
 * ```
 *
 * The base stays complete either way, so the suite states only what it varies
 * and inherits every fact added later.
 */
export function statusLineSessionParts(options: StubSessionOptions = {}): Record<string, unknown> {
	const contextWindow = options.contextWindow ?? CONTEXT_WINDOW;
	const id = options.modelId ?? "claude-3-7-sonnet";
	const model = { id, name: options.modelName ?? id, contextWindow };
	const messages = options.messages ?? [];
	const usage = options.usage ? { ...RESTING_USAGE, ...options.usage } : RESTING_USAGE;
	// `contextUsage` distinguishes "absent" from "not passed": a suite proving the
	// unknown-count path passes `undefined` explicitly, so the key's presence, not
	// its value, decides.
	const sessionName = "sessionName" in options ? options.sessionName : "test-session";
	const contextUsage = "contextUsage" in options ? options.contextUsage : { tokens: 16_000, contextWindow };

	return {
		messages,
		model,
		contextUsageRevision: 0,
		systemPrompt: [],
		agent: { state: { tools: [] } },
		skills: [],
		getContextUsage: () => contextUsage,
		state: { messages, model },
		sessionManager: {
			getCwd: options.cwd ?? (() => "/repo"),
			getSessionId: () => undefined,
			getSessionName: () => sessionName,
			getUsageStatistics: () => usage,
		},
		getPrewalkState: () => options.prewalk,
		getAsyncJobSnapshot: () => undefined,
		getGoalModeState: () => undefined,
		// Auto-compaction off: the gauge denominates against the raw model window,
		// so a percentage a suite asserts is the arithmetic and nothing else.
		settings: { getGroup: () => ({ enabled: false }), get: () => undefined },
		obfuscator: options.obfuscator,
		isAdvisorActive: () => options.advisorActive ?? false,
		isApprovalBypassed: () => options.approvalBypassed ?? false,
		isFastModeActive: () => options.fastMode ?? false,
		isAutoThinking: false,
		isStreaming: options.streaming ?? false,
		autoResolvedThinkingLevel: () => undefined,
		configuredThinkingLevel: () => undefined,
		effectiveApprovalMode: () => undefined,
		modelRegistry: { isUsingOAuth: () => false, authStorage: { listStoredCredentials: () => [] } },
	};
}

/** The stub as an `AgentSession`, which is what a component constructor takes. */
export function makeStatusLineSession(options: StubSessionOptions = {}): AgentSession {
	return statusLineSessionParts(options) as unknown as AgentSession;
}
