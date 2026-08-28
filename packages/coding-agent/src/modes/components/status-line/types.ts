import type { CollabSessionState } from "../../../collab/protocol";
import type { StatusLinePreset, StatusLineSegmentId, StatusLineSeparatorStyle } from "../../../config/settings-schema";
import type { AgentSession } from "../../../session/agent-session";
import type { ActiveRepoContext } from "../../../utils/active-repo-context";
import type { GitStatusSummary } from "../../../utils/git";

export type { StatusLinePreset, StatusLineSegmentId, StatusLineSeparatorStyle };

export interface CollabStatus {
	role: "host" | "guest";
	participantCount: number;
	stateOverride?: CollabSessionState | null;
}

export interface StatusLineSegmentOptions {
	model?: {
		showThinkingLevel?: boolean;
		roomy?: boolean;
	};
	path?: {
		abbreviate?: boolean;
		maxLength?: number;
		stripWorkPrefix?: boolean;
		displayRoots?: string[];
	};
	git?: { showBranch?: boolean };
	time?: { format?: "12h" | "24h"; showSeconds?: boolean };
}

export interface StatusLineSettings {
	preset?: StatusLinePreset;
	leftSegments?: StatusLineSegmentId[];
	rightSegments?: StatusLineSegmentId[];
	separator?: StatusLineSeparatorStyle;
	segmentOptions?: StatusLineSegmentOptions;
	showHookStatus?: boolean;
	sessionAccent?: boolean;
	transparent?: boolean;
	compactThinkingLevel?: boolean;
}

export type EffectiveStatusLineSettings = Required<
	Pick<StatusLineSettings, "leftSegments" | "rightSegments" | "segmentOptions">
> &
	StatusLineSettings;

export type RGB = readonly [number, number, number];

export interface SegmentContext {
	session: AgentSession;
	focusedAgentId?: string | undefined;
	activeRepo: ActiveRepoContext | null;
	width: number;
	options: StatusLineSegmentOptions;
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
	contextPercent: number | null;
	contextWindow: number;
	contextLimit: number;
	contextLimitKind: "window" | "compaction";
	autoCompactEnabled: boolean;
	subagentCount: number;
	backgroundSessionCount: number;
	activeMs: number;
	git: {
		branch: string | null;
		status: GitStatusSummary | null;
		pr: { number: number; url: string } | null;
	};
	worktree: { projectName: string; worktreeName: string } | null;
	account: { label: string; storedCount: number; isPrediction: boolean } | null;
	usage: {
		tier?: string;
		fiveHour?: { percent: number; resetMinutes?: number };
		sevenDay?: { percent: number; resetHours?: number };
	} | null;
}

export interface RenderedSegment {
	content: string; // The segment text (may include ANSI color codes)
	visible: boolean; // Whether to render (e.g., git hidden when not in repo)
	pin?: number;
}

export interface StatusLineSegment {
	id: StatusLineSegmentId;
	render(ctx: SegmentContext): RenderedSegment;
}

export interface PresetDef {
	leftSegments: StatusLineSegmentId[];
	rightSegments: StatusLineSegmentId[];
	segmentOptions?: StatusLineSegmentOptions;
}
