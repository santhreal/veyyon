import type { AssistantMessage } from "@veyyon/ai";
import type { SessionContext } from "@veyyon/kernel/session/session-context";
import { errorMessage, formatCount, logger } from "@veyyon/utils";
import { sanitizeStatusText } from "@veyyon/utils/sanitize-status-text";
import type { AgentSession } from "../session/agent-session";
import type { AgentSessionEvent } from "../session/agent-session-types";
import type { Goal, GoalModeState } from "./state";

export interface GoalDriverPort {
	/** The session the goal drives. */
	readonly session: AgentSession;
	/** Another mode holds the session, so the goal must neither activate nor drive. */
	blockingMode(): "plan" | "vibe" | "loop" | undefined;
	/** The operator has unsent input in this host's composer. */
	hasUnsentInput(): boolean;
	/** Mid-turn, compacting, or draining post-turn maintenance. */
	isAutoSubmitBlocked(): boolean;
	/** A submission is queued and has not started. */
	hasPendingSubmission(): boolean;
	/** That queued submission is a visible user turn rather than a synthetic one. */
	hasPendingVisibleUserSubmission(): boolean;
	/** This host can open a turn at all right now. */
	canSubmit(): boolean;
	/** Open the goal's continuation turn, hidden from the transcript. */
	submitContinuation(prompt: string): void;
	/** Say something to the operator in this host's register. */
	warn(message: string): void;
	/** State an outcome of the goal to the operator in this host's register. */
	status(message: string): void;
	/** The goal's flags or record moved: repaint whatever states them. */
	changed(): void;
}

/**
 * Consecutive provider-killed goal turns tolerated before goal mode stops
 * driving on its own. A transport fault is routinely retried and recovered, so
 * one is not a reason to stand down; a provider that is genuinely gone must not
 * let the goal spin forever.
 */
export const GOAL_FAILED_TURN_LIMIT = 3;

/** How long the composer stays idle before goal mode opens a continuation turn. */
export const GOAL_CONTINUATION_DELAY_MS = 800;

/**
 * How long goal mode keeps waiting for a busy session to go idle before it gives up on the
 * continuation it owes. Post-turn maintenance — a compaction of a large context, a queued
 * hook — routinely outlasts one delay window, and the goal must still be driving afterwards.
 */
export const GOAL_CONTINUATION_BUSY_WAIT_MS = 300_000;

/** The objective cap used by the one-line notices. */
export const GOAL_SUMMARY_MAX_LENGTH = 48;

export const GOAL_CONTINUATION_BLOCKS = [
	"loop-mode",
	"plan-mode",
	"vibe-mode",
	"no-input-callback",
	"continuation-mode-off",
	"goal-mode-off",
	"suppressed",
	"busy",
	"submission-pending",
	"draft-in-composer",
	"goal-not-active",
	"no-prompt",
] as const;

/** Why goal mode is not opening a continuation turn right now. */
export type GoalContinuationBlock = (typeof GOAL_CONTINUATION_BLOCKS)[number];

/**
 * Blocks that are an ordinary handoff rather than a goal declining to drive. `no-input-callback`
 * is the common one: every `agent_end` arms the continuation before the loop has returned to
 * `getUserInput`, and that call is expected to do nothing.
 */
export const GOAL_CONTINUATION_QUIET_BLOCKS: Partial<Record<GoalContinuationBlock, true>> = {
	"loop-mode": true,
	"no-input-callback": true,
	"continuation-mode-off": true,
	"goal-mode-off": true,
};

/**
 * Whether the turn that just ended died rather than finished. An aborted turn is
 * the user's own interrupt and is handled by the goal runtime's pause path, so
 * only a provider/transport error counts here.
 */
export function goalTurnEndedInError(event: Extract<AgentSessionEvent, { type: "agent_end" }>): boolean {
	const lastAssistant = [...event.messages]
		.reverse()
		.find((message): message is AssistantMessage => message.role === "assistant");
	return lastAssistant?.stopReason === "error";
}

/** Every way goal mode stops driving, so a host can sweep them. */
export const GOAL_EXIT_REASONS = ["completed", "paused", "dropped"] as const;

/** Why goal mode stopped driving. */
export type GoalExitReason = (typeof GOAL_EXIT_REASONS)[number];

/** What leaving goal mode is called, one line per way out. */
export function goalExitNotice(options?: { paused?: boolean; reason?: GoalExitReason }): string {
	if (options?.reason === "completed") return "Goal mode completed.";
	if (options?.reason === "dropped") return "Goal dropped.";
	if (options?.reason === "paused" || options?.paused === true) return "Goal mode paused.";
	return "Goal mode disabled.";
}

export function summarizeObjective(objective: string): string {
	const plain = sanitizeStatusText(objective);
	return plain.length > GOAL_SUMMARY_MAX_LENGTH ? `${plain.slice(0, GOAL_SUMMARY_MAX_LENGTH - 1)}…` : plain;
}

export function goalFromModeData(modeData: SessionContext["modeData"]): Goal | undefined {
	const goal = modeData?.goal;
	if (!goal || typeof goal !== "object") return undefined;
	const value = goal as Record<string, unknown>;
	if (
		typeof value.id !== "string" ||
		typeof value.objective !== "string" ||
		typeof value.status !== "string" ||
		typeof value.tokensUsed !== "number" ||
		typeof value.timeUsedSeconds !== "number" ||
		typeof value.createdAt !== "number" ||
		typeof value.updatedAt !== "number"
	) {
		return undefined;
	}
	return {
		id: value.id,
		objective: value.objective,
		status: value.status as Goal["status"],
		tokenBudget: typeof value.tokenBudget === "number" ? value.tokenBudget : undefined,
		tokensUsed: value.tokensUsed,
		timeUsedSeconds: value.timeUsedSeconds,
		turnsCompleted: typeof value.turnsCompleted === "number" ? value.turnsCompleted : 0,
		createdAt: value.createdAt,
		updatedAt: value.updatedAt,
	};
}

/**
 * Host-agnostic goal driver: manages enabled/paused flags, autonomous
 * continuation scheduling with arm/fire checks, busy-waiting, failed-turn
 * stand-down, tool set swap, and session lifecycle event handling.
 */
export class GoalDriver {
	readonly #port: GoalDriverPort;
	/** Goal mode is driving: the goal tool is installed and continuations arm. */
	enabled = false;
	/** A goal exists and is paused: no continuations, and other modes still refuse. */
	paused = false;
	#previousTools: string[] | undefined;
	#continuationTimer: NodeJS.Timeout | undefined;
	#turnHadToolCalls = false;
	#failedTurns = 0;
	#turnRetrying = false;
	#continuationTurnInFlight = false;
	#suppressNextContinuation = false;
	#userContinuationSuppressed = false;
	#userTurnInFlight = false;
	#continuationBusyUntil: number | undefined;
	#unsubscribe?: () => void;

	constructor(port: GoalDriverPort) {
		this.#port = port;
	}

	/** Whether a goal exists at all, active or paused. Other modes refuse while it does. */
	get active(): boolean {
		return this.enabled || this.paused;
	}

	/** Number of consecutive failed turns currently counted towards the stand-down limit. */
	get failedTurns(): number {
		return this.#failedTurns;
	}

	/**
	 * A visible user turn was queued: the operator is driving, so the goal stops
	 * opening turns of its own until a turn resumes execution.
	 */
	noteVisibleUserTurnStarted(): void {
		this.#userTurnInFlight = true;
		this.#userContinuationSuppressed = true;
		this.#cancelContinuation();
	}

	/** A queued visible user turn was cancelled, so the goal may drive again. */
	noteVisibleUserTurnCancelled(): void {
		this.resetContinuationSuppression();
		this.#userTurnInFlight = false;
		this.scheduleContinuation();
	}

	/** The goal's own continuation turn has settled, whether it ran or was cancelled. */
	noteContinuationTurnSettled(): void {
		this.#continuationTurnInFlight = false;
	}

	/** Subscribe goal bookkeeping to the session currently displayed. */
	subscribeToSession(): void {
		this.#unsubscribe = this.#port.session.subscribe(event => {
			return this.handleSessionEvent(event).catch(error => {
				logger.warn("Goal mode session event handler failed", {
					event: event.type,
					error: errorMessage(error),
				});
				this.#port.warn(`Goal mode update failed: ${errorMessage(error)}`);
			});
		});
	}

	/** Drop the current session subscription, before a handoff or on teardown. */
	unsubscribeFromSession(): void {
		this.#unsubscribe?.();
		this.#unsubscribe = undefined;
	}

	/** Arm the continuation timer from a clean slate, discarding any busy wait. */
	scheduleContinuation(): void {
		this.#cancelContinuation();
		this.#continuationBusyUntil = undefined;
		this.#armContinuation();
	}

	/** Cancel a pending continuation tick. */
	cancelContinuation(): void {
		this.#cancelContinuation();
	}

	/** Clear the suppression a visible user turn installed. */
	resetContinuationSuppression(): void {
		this.#suppressNextContinuation = false;
		this.#userContinuationSuppressed = false;
	}

	/**
	 * Tear the mode's transient state down for a session switch or resume,
	 * restoring the tool set the goal displaced. Nothing here touches the stored
	 * goal record: this clears what the driver was doing about it.
	 */
	async clearTransientState(): Promise<void> {
		if (!this.active) return;
		if (this.#previousTools !== undefined) {
			await this.#port.session.setActiveToolsByName(this.#previousTools);
		}
		this.#port.session.setGoalModeState(undefined);
		this.enabled = false;
		this.paused = false;
		this.#previousTools = undefined;
		this.#turnHadToolCalls = false;
		this.#continuationTurnInFlight = false;
		this.resetContinuationSuppression();
		this.#userTurnInFlight = false;
		this.#cancelContinuation();
		this.#port.changed();
	}

	/**
	 * Restore goal mode from the resumed session's mode entry.
	 *
	 * Returns `handled` when the entry was a goal one, so the caller stops
	 * reconciling: the remaining mode branches are mutually exclusive with this
	 * one, and the goal runtime's accounting has already been settled here.
	 */
	async restoreFromSession(
		sessionContext: SessionContext,
		options?: { preserveActiveGoal?: boolean },
	): Promise<"handled" | "not-a-goal"> {
		const isGoalEntry = sessionContext.mode === "goal" || sessionContext.mode === "goal_paused";
		if (!isGoalEntry) return "not-a-goal";
		if (!this.#port.session.settings.get("goal.enabled")) {
			this.#port.session.goalRuntime.clearAccounting();
			const stored = goalFromModeData(sessionContext.modeData);
			logger.warn("goal mode is disabled; the session's stored goal stays inactive", {
				mode: sessionContext.mode,
				readable: stored !== undefined,
				goalId: stored?.id,
			});
			this.#port.warn(
				stored
					? `Goal Mode is off in settings, so "${summarizeObjective(stored.objective)}" stays stored and inactive.`
					: "Goal Mode is off in settings, so this session's stored goal stays inactive.",
			);
			return "handled";
		}
		const goal = goalFromModeData(sessionContext.modeData);
		if (!goal) {
			logger.warn("stored goal record is unreadable; clearing goal mode", { mode: sessionContext.mode });
			this.#port.warn("This session's stored goal could not be read and was cleared.");
			this.#port.session.sessionManager.appendModeChange("none");
			return "handled";
		}
		this.#port.session.setGoalModeState({
			enabled: sessionContext.mode === "goal",
			mode: "active",
			goal,
		});
		const restored = await this.#port.session.goalRuntime.onThreadResumed({
			preserveActiveGoal: options?.preserveActiveGoal,
		});
		this.enabled = restored?.enabled === true;
		this.paused = restored?.enabled !== true && restored?.goal.status === "paused";
		if (restored?.goal) {
			const previousTools = this.#port.session.getActiveToolNames();
			this.#previousTools = previousTools;
			await this.#port.session.setActiveToolsByName([...new Set([...previousTools, "goal"])]);
		}
		this.#port.changed();
		return "handled";
	}

	/**
	 * Whether the session reports a goal that is exiting, which has to be left
	 * before the next user input.
	 */
	get sessionGoalIsExiting(): boolean {
		return this.#port.session.getGoalModeState()?.mode === "exiting";
	}

	/** Leave a goal the session reports as exiting. Call behind `sessionGoalIsExiting`. */
	async exitCompletedGoal(): Promise<void> {
		await this.exit({ reason: "completed" });
	}

	pausedGoalState(): GoalModeState | undefined {
		const state = this.#port.session.getGoalModeState();
		if (!state?.goal || state.enabled || state.goal.status !== "paused") {
			return undefined;
		}
		return state;
	}

	/**
	 * Why goal mode must not open a continuation turn at this instant, or `undefined` when it may.
	 */
	continuationBlock(phase: "arm" | "fire"): GoalContinuationBlock | undefined {
		const blocking = this.#port.blockingMode();
		if (blocking === "loop") return "loop-mode";
		if (blocking === "plan") return "plan-mode";
		if (blocking === "vibe") return "vibe-mode";
		if (!this.#port.canSubmit()) return "no-input-callback";
		if (!this.#port.session.settings.get("goal.continuationModes").includes("interactive")) {
			return "continuation-mode-off";
		}
		if (!this.enabled || this.paused) return "goal-mode-off";
		if (this.#suppressNextContinuation || this.#userContinuationSuppressed) return "suppressed";
		if (phase === "fire" && this.#port.isAutoSubmitBlocked()) return "busy";
		if (this.#port.hasPendingSubmission()) return "submission-pending";
		if (this.#port.hasUnsentInput()) return "draft-in-composer";
		const state = this.#port.session.getGoalModeState();
		if (!state?.enabled || state.goal.status !== "active") return "goal-not-active";
		return undefined;
	}

	#reportContinuationBlock(reason: GoalContinuationBlock, phase: "arm" | "fire"): void {
		if (GOAL_CONTINUATION_QUIET_BLOCKS[reason]) return;
		logger.debug("Goal mode is not opening a continuation turn", {
			reason,
			phase,
			goalId: this.#port.session.getGoalModeState()?.goal.id,
		});
	}

	#armContinuation(): void {
		this.#cancelContinuation();
		const blocked = this.continuationBlock("arm");
		if (blocked) {
			this.#reportContinuationBlock(blocked, "arm");
			return;
		}
		const prompt = this.#port.session.goalRuntime.buildContinuationPrompt();
		if (!prompt) {
			this.#reportContinuationBlock("no-prompt", "arm");
			return;
		}
		this.#continuationTimer = setTimeout(() => {
			this.#continuationTimer = undefined;
			const blockedNow = this.continuationBlock("fire");
			if (blockedNow === "busy") {
				this.#continuationBusyUntil ??= Date.now() + GOAL_CONTINUATION_BUSY_WAIT_MS;
				if (Date.now() < this.#continuationBusyUntil) {
					this.#armContinuation();
					return;
				}
				this.#continuationBusyUntil = undefined;
				this.#reportContinuationBlock("busy", "fire");
				this.#port.warn("Goal mode stopped waiting for the session to go idle. Send a message to resume it.");
				// Standing down IS a state change: a host that states the goal on a surface rather
				// than in a passing line has nothing else to repaint on.
				this.#port.changed();
				return;
			}
			this.#continuationBusyUntil = undefined;
			if (blockedNow) {
				this.#reportContinuationBlock(blockedNow, "fire");
				return;
			}
			if (!this.#port.canSubmit()) return;
			this.#continuationTurnInFlight = true;
			this.#port.submitContinuation(prompt);
		}, GOAL_CONTINUATION_DELAY_MS);
	}

	#cancelContinuation(): void {
		if (this.#continuationTimer) {
			clearTimeout(this.#continuationTimer);
			this.#continuationTimer = undefined;
		}
	}

	async handleSessionEvent(event: AgentSessionEvent): Promise<void> {
		if (event.type === "auto_retry_start") {
			this.#turnRetrying = true;
			return;
		}
		if (event.type === "agent_start") {
			if (this.#turnRetrying) {
				this.#turnRetrying = false;
			} else {
				this.#turnHadToolCalls = false;
			}
			this.#cancelContinuation();
			return;
		}
		if (event.type === "tool_execution_start") {
			this.#turnHadToolCalls = true;
			if (this.#userTurnInFlight || this.#port.hasPendingVisibleUserSubmission()) {
				this.resetContinuationSuppression();
			}
			return;
		}
		if (event.type === "message_start" && event.message.role === "user" && !event.message.synthetic) {
			this.noteVisibleUserTurnStarted();
			return;
		}
		if (event.type === "goal_updated") {
			if (event.state?.goal?.status === "dropped") {
				await this.exit({ reason: "dropped" });
				return;
			}
			const activating = !this.enabled && event.state?.enabled === true;
			if (activating) {
				this.resetContinuationSuppression();
				this.#failedTurns = 0;
			}
			this.enabled = event.state?.enabled === true;
			this.paused = event.state?.enabled !== true && event.state?.goal?.status === "paused";
			if (!event.state?.enabled) {
				this.#cancelContinuation();
			}
			this.#port.changed();
			return;
		}
		if (event.type !== "agent_end") {
			return;
		}
		this.#userTurnInFlight = false;
		this.#turnRetrying = false;
		if (goalTurnEndedInError(event)) {
			if (!this.enabled) return;
			this.#failedTurns += 1;
			if (this.#failedTurns >= GOAL_FAILED_TURN_LIMIT) {
				this.#continuationTurnInFlight = false;
				this.#suppressNextContinuation = true;
				this.#port.warn(
					`Goal mode stopped driving after ${formatCount("failed turn", this.#failedTurns)}. Send a message to resume it.`,
				);
				this.#port.changed();
				return;
			}
			this.scheduleContinuation();
			return;
		}
		this.#failedTurns = 0;
		if (this.#continuationTurnInFlight) {
			this.#suppressNextContinuation = !this.#turnHadToolCalls;
			this.#continuationTurnInFlight = false;
		}
		if (this.#port.session.getGoalModeState()?.mode === "exiting") {
			await this.exit({ reason: "completed" });
			return;
		}
		this.scheduleContinuation();
	}

	async enter(options?: { objective?: string; tokenBudget?: number; resume?: boolean }): Promise<void> {
		if (this.enabled) {
			return;
		}
		const blocking = this.#port.blockingMode();
		if (blocking) {
			this.#port.warn(`Exit ${blocking} mode first.`);
			return;
		}
		const previousTools = this.#port.session.getActiveToolNames();
		const goalTools = [...new Set([...previousTools, "goal"])];
		this.#previousTools = previousTools;
		this.paused = false;
		const state = options?.resume
			? await this.#port.session.goalRuntime.resumeGoal()
			: await this.#port.session.goalRuntime.createGoal({
					objective: options?.objective ?? "",
					tokenBudget: options?.tokenBudget,
				});
		await this.#port.session.setActiveToolsByName(goalTools);
		this.#port.session.setGoalModeState(state);
		this.enabled = true;
		this.resetContinuationSuppression();
		this.#port.changed();
		if (this.#port.session.isStreaming) {
			await this.#port.session.sendGoalModeContext({ deliverAs: "steer" });
		}
	}

	async exit(options?: { paused?: boolean; reason?: GoalExitReason }): Promise<void> {
		// A goal that is already out is left by more than one path: `drop()` exits, and the
		// `goal_updated` event that drop raises reaches the session handler and exits again. The
		// notice belongs to the exit that ended the driving, so the second call states nothing.
		const wasDriving = this.enabled || this.paused;
		const previousTools = this.#previousTools;
		if (this.enabled && previousTools) {
			await this.#port.session.setActiveToolsByName(previousTools);
		}
		const currentState = this.#port.session.getGoalModeState();
		if (options?.reason === "completed") {
			this.#port.session.setGoalModeState(undefined);
			this.#port.session.sessionManager.appendModeChange("none");
			this.#port.session.sessionManager.appendCustomEntry("goal-completed", {
				objective: currentState?.goal?.objective,
				tokensUsed: currentState?.goal?.tokensUsed,
				tokenBudget: currentState?.goal?.tokenBudget,
				timeUsedSeconds: currentState?.goal?.timeUsedSeconds,
			});
		}
		this.enabled = false;
		this.paused = options?.paused ?? false;
		this.#previousTools = undefined;
		this.#continuationTurnInFlight = false;
		this.resetContinuationSuppression();
		this.#userTurnInFlight = false;
		this.#cancelContinuation();
		this.#port.changed();
		if (wasDriving) {
			this.#port.status(goalExitNotice(options));
		}
	}

	async pause(): Promise<void> {
		if (!this.enabled) {
			return;
		}
		await this.#port.session.goalRuntime.pauseGoal();
		await this.exit({ paused: true, reason: "paused" });
	}

	async resume(): Promise<void> {
		if (!this.pausedGoalState()) {
			return;
		}
		await this.enter({ resume: true });
		this.scheduleContinuation();
	}

	async drop(): Promise<void> {
		await this.#port.session.goalRuntime.dropGoal();
		await this.exit({ reason: "dropped" });
	}

	async replaceGoal(options: { objective: string; tokenBudget?: number }): Promise<void> {
		const state = await this.#port.session.goalRuntime.replaceGoal({
			objective: options.objective,
			tokenBudget: options.tokenBudget,
		});
		this.#port.session.setGoalModeState(state);
		this.enabled = true;
		this.paused = false;
		this.resetContinuationSuppression();
		this.#port.changed();
		if (this.#port.session.isStreaming) {
			await this.#port.session.sendGoalModeContext({ deliverAs: "steer" });
		}
	}
}
