/**
 * Everything the status row needs from a session, as VALUES.
 *
 * The row used to take `AgentSession` itself: `SegmentContext.session`, read at
 * fifteen sites across the segments for a model name, a boolean, a session id.
 * That one field is why the row could not be drawn before the session existed,
 * so the launch card grew a second renderer for the half of the row it could
 * reach — a hand-rolled `path · git` that had to be kept byte-identical to the
 * real one by hand, and that silently omitted every segment added since.
 *
 * A segment reads a fact here or it reads nothing. Two producers fill the
 * block: {@link factsFromSession} while a session is running, and
 * {@link factsAtLaunch} before one exists. The difference between the launch
 * row and the live row is therefore DATA, not code — the same segment table,
 * the same order, the same joining, the same clipping — so a segment added to
 * the preset appears on both rows the day it lands.
 *
 * Every field is a plain value read once per render. Nothing here is a method,
 * a handle, or a lazy accessor: a segment that could call back into the session
 * mid-render is how the row acquired its first dependency, and a value block
 * cannot grow a second one.
 */
import { ThinkingLevel } from "@veyyon/agent-core/thinking";
import { settings } from "../../../../config/settings-instance";
import type { Goal } from "../../../../goals/state";
import type { ApprovalMode } from "../../../../tools/core/approval-modes";
import { isKnownApprovalMode } from "../../../../tools/core/approval-modes";
import type { SegmentContext, StatusLineSegmentOptions } from "./types";

/**
 * The active model, reduced to what the row prints.
 *
 * `name` is the catalog's display name and `id` is the provider id. The model
 * segment prefers the name and falls back to the id, which is what makes a
 * launch row possible: config persists an id and nothing else, so
 * {@link factsAtLaunch} supplies an empty name and the SAME fallback the live
 * segment already runs picks the id up. No second formatting rule.
 */
export interface ModelFact {
	id: string;
	name: string;
	/** The model supports a thinking budget, so the effort tail may render. */
	supportsThinking: boolean;
}

/** Live secret protection in this directory, as the expansion authority counts it. */
export interface SecretsFact {
	count: number;
	named: number;
	nextExpiryAt: number | undefined;
}

export interface SessionFacts {
	model: ModelFact | null;
	/** The configured effort. Ignored while {@link autoThinking} is set. */
	thinkingLevel: ThinkingLevel;
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
	approvalMode: ApprovalMode | undefined;
	/** `/yolo` is on: every prompt is off, whatever {@link approvalMode} says. */
	approvalBypassed: boolean;
	/** The session's working directory, or null to fall back to the process one. */
	cwd: string | null;
	sessionId: string | null;
	sessionName: string | null;
	goal: Goal | null;
	goalModelBudgets: boolean;
	goalVerbose: boolean;
	secrets: SecretsFact | null;
}

/** What the row knows before a session exists and before config is read. */
export const NO_SESSION_FACTS: SessionFacts = {
	model: null,
	thinkingLevel: ThinkingLevel.Off,
	autoThinking: null,
	advisorActive: false,
	fastMode: false,
	subscription: false,
	streaming: false,
	approvalMode: undefined,
	approvalBypassed: false,
	cwd: null,
	sessionId: null,
	sessionName: null,
	goal: null,
	goalModelBudgets: false,
	goalVerbose: false,
	secrets: null,
};

/**
 * What config alone knows, for the row the launch card paints before a session
 * exists.
 *
 * CONFIG ONLY, and deliberately nothing else. This runs on the path whose whole
 * budget is the first frame, so it reads the settings store that is already
 * loaded and touches no registry, no catalog, no auth storage and no
 * filesystem. A fact that costs a lookup is left absent, and the segment that
 * wanted it renders its own absent state — the account chip and the secrets
 * chip are silent, the gauge says it does not know yet — until
 * `factsFromSession` replaces the block with the measured answer.
 *
 * The model is the persisted default ROLE, which is the id the session itself
 * starts from, so the row does not guess: it reads the same value the session
 * will resolve. `name` is left empty because config stores no display name, and
 * the model segment's existing name-or-id fallback prints the id.
 *
 * `approvalBypassed` is false rather than derived: `/yolo` is a runtime toggle
 * that no launch has had the chance to set. A configured `yolo` rung still
 * reaches the row through {@link approvalMode}, so the one state that must
 * never be understated is not.
 */
export function factsAtLaunch(): SessionFacts {
	const configuredMode = settings.getModelRole("default");
	const approvalMode = settings.get("tools.approvalMode");
	return {
		...NO_SESSION_FACTS,
		model: configuredMode ? { id: configuredMode, name: "", supportsThinking: false } : null,
		approvalMode: isKnownApprovalMode(approvalMode) ? approvalMode : undefined,
		goalModelBudgets: settings.get("goal.modelBudgetsEnabled") === true,
		goalVerbose: settings.get("goal.statusInFooter") === true,
	};
}

/** Nothing has been spent before the first frame; every counter is genuinely zero. */
const LAUNCH_USAGE_STATS = {
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
} as const;

/** What the caller varies per segment; everything else is fixed by launch. */
export interface LaunchContextRequest {
	width: number;
	options: StatusLineSegmentOptions;
	compactThinkingLevel: boolean;
	/** From `.git/HEAD` and its ref files, or null when the row shows no branch. */
	branch: string | null;
	/** Threshold compaction is configured on, which the gauge states as its limit kind. */
	autoCompactEnabled: boolean;
}

/**
 * The whole segment context at launch, from {@link factsAtLaunch} plus the
 * measured values that do not exist yet.
 *
 * The launch card is the only caller in the product, but it is not the owner:
 * the block belongs beside the facts it completes, so a field added to
 * `SegmentContext` is filled for launch HERE, once, rather than in a component
 * that would silently keep rendering without it.
 *
 * Every absent value is absent as itself, never as a zero. `contextPercent` is
 * null because nothing has been counted — `0%` would be a measurement — and the
 * gauge spells that as `? left` until the session's first paint replaces the
 * block.
 */
export function launchSegmentContext(request: LaunchContextRequest): SegmentContext {
	return {
		facts: factsAtLaunch(),
		activeRepo: null,
		width: request.width,
		options: request.options,
		compactThinkingLevel: request.compactThinkingLevel,
		planMode: null,
		prewalk: null,
		loopMode: null,
		goalMode: null,
		vibeMode: null,
		collab: null,
		usageStats: LAUNCH_USAGE_STATS,
		contextPercent: null,
		contextWindow: 0,
		contextLimit: 0,
		contextLimitKind: "window",
		autoCompactEnabled: request.autoCompactEnabled,
		subagentCount: 0,
		backgroundSessionCount: 0,
		activeMs: 0,
		git: { branch: request.branch, status: null, pr: null },
		worktree: null,
		account: null,
		usage: null,
	};
}
