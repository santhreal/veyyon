import type { CollabSessionState } from "../../../collab/protocol";
import type { StatusLinePreset, StatusLineSegmentId, StatusLineSeparatorStyle } from "../../../config/settings-schema";
import type { AgentSession } from "../../../session/agent-session";
import type { ActiveRepoContext } from "../../../utils/active-repo-context";
import type { GitStatusSummary } from "../../../utils/git";

export type { StatusLinePreset, StatusLineSegmentId, StatusLineSeparatorStyle };

/** Collab session indicator + (guest-only) host-state override for segments. */
export interface CollabStatus {
	role: "host" | "guest";
	participantCount: number;
	/** Guest only: host footer snapshot that overrides locally computed values. */
	stateOverride?: CollabSessionState | null;
}

export interface StatusLineSegmentOptions {
	model?: {
		showThinkingLevel?: boolean;
		/** Quiet zones: a wide gap between the model name and the effort tail. */
		roomy?: boolean;
	};
	path?: { abbreviate?: boolean; maxLength?: number; stripWorkPrefix?: boolean };
	git?: { showBranch?: boolean };
	time?: { format?: "12h" | "24h"; showSeconds?: boolean };
}

export interface StatusLineSettings {
	preset?: StatusLinePreset;
	leftSegments?: StatusLineSegmentId[];
	rightSegments?: StatusLineSegmentId[];
	/**
	 * DEAD as of the top-border removal: nothing renders a separator any more.
	 * The composer footline joins segments with its own fixed `  ·  `. The field
	 * survives only because `modes/controllers/selector-controller.ts` still
	 * passes it (that file is off limits); delete both together.
	 */
	separator?: StatusLineSeparatorStyle;
	segmentOptions?: StatusLineSegmentOptions;
	showHookStatus?: boolean;
	sessionAccent?: boolean;
	/**
	 * DEAD as of the top-border removal: there is no filled bar to make
	 * transparent. Same blocker as `separator` above.
	 */
	transparent?: boolean;
	/** Replace the model-segment icon with the thinking-level glyph and drop the
	 *  " · <level>" suffix, so the thinking level reads as a single compact icon. */
	compactThinkingLevel?: boolean;
}

export type EffectiveStatusLineSettings = Required<
	Pick<StatusLineSettings, "leftSegments" | "rightSegments" | "segmentOptions">
> &
	StatusLineSettings;

// ═══════════════════════════════════════════════════════════════════════════
// Segment Rendering
// ═══════════════════════════════════════════════════════════════════════════

export type RGB = readonly [number, number, number];

export interface SegmentContext {
	session: AgentSession;
	/** Focused subagent id while the view is proxied at its session, undefined otherwise. */
	focusedAgentId?: string | undefined;
	activeRepo: ActiveRepoContext | null;
	width: number;
	options: StatusLineSegmentOptions;
	/** Render the model segment's thinking level as a compact leading glyph. */
	compactThinkingLevel: boolean;
	planMode: {
		enabled: boolean;
		paused: boolean;
	} | null;
	prewalk: {
		enabled: boolean;
	} | null;
	loopMode: {
		enabled: boolean;
	} | null;
	goalMode: {
		enabled: boolean;
		paused: boolean;
	} | null;
	vibeMode: {
		enabled: boolean;
	} | null;
	collab: CollabStatus | null;
	// Cached values for performance (computed once per render)
	usageStats: {
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
	};
	/**
	 * Percent of {@link contextLimit} used, or null when unknown (e.g. right
	 * after compaction). Percent of the LIMIT, not of the window — with
	 * auto-compaction on those differ.
	 */
	contextPercent: number | null;
	contextTokens: number;
	/** The model's real context window. Always the window, never the trigger. */
	contextWindow: number;
	/**
	 * Where the context actually runs out: the auto-compaction fire point when
	 * auto-compaction is on, otherwise {@link contextWindow}. This is what the
	 * gauge measures against, and {@link contextLimitKind} says which it is.
	 *
	 * These were one field. The window was overwritten with the fire point
	 * before the segments ran, so `context_total` — a segment whose only job is
	 * to print the window — printed `170k` on a 200k model, and every other
	 * consumer that asked for the window silently got the trigger.
	 */
	contextLimit: number;
	contextLimitKind: "window" | "compaction";
	autoCompactEnabled: boolean;
	subagentCount: number;
	/**
	 * Active processing time accumulated this session, in ms — the union of
	 * every `agent_start`→`agent_end` window plus the currently-streaming
	 * window if the agent is running. Idle wall-clock never contributes, so
	 * this is what {@link StatusLineSegmentId.time_spent} renders instead of
	 * `Date.now() - sessionStart`.
	 */
	activeMs: number;
	git: {
		branch: string | null;
		status: GitStatusSummary | null;
		pr: { number: number; url: string } | null;
	};
	/**
	 * Set when the path cwd is a *linked* git worktree, naming the shared
	 * primary checkout (the project). Lets the path segment collapse the
	 * base-prefixed `<base>/<project>/<worktree>` path to the project name —
	 * the worktree/branch is already shown by the git segment.
	 */
	worktree: { projectName: string; worktreeName: string } | null;
	usage: {
		tier?: string;
		fiveHour?: { percent: number; resetMinutes?: number };
		sevenDay?: { percent: number; resetHours?: number };
	} | null;
}

export interface RenderedSegment {
	content: string; // The segment text (may include ANSI color codes)
	visible: boolean; // Whether to render (e.g., git hidden when not in repo)
}

export interface StatusLineSegment {
	id: StatusLineSegmentId;
	render(ctx: SegmentContext): RenderedSegment;
}

// ═══════════════════════════════════════════════════════════════════════════
// Preset Definition
// ═══════════════════════════════════════════════════════════════════════════

export interface PresetDef {
	leftSegments: StatusLineSegmentId[];
	rightSegments: StatusLineSegmentId[];
	segmentOptions?: StatusLineSegmentOptions;
}
