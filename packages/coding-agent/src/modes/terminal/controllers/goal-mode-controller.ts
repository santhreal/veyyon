import type { AssistantMessage } from "@veyyon/ai";
import { errorMessage, formatCount, logger } from "@veyyon/utils";
import { type GuidedGoalMessage, newGuidedGoalSessionId, runGuidedGoalTurn } from "../../../goals/guided-setup";
import type { Goal, GoalModeState } from "../../../goals/state";
import type { AgentSessionEvent } from "../../../session/agent-session-types";
import type { SessionContext } from "../../../session/session-context";
import { formatDurationCoarse } from "../../../slash-commands/helpers/format";
import type { InteractiveModeContext } from "../types";

/**
 * The slice of the interactive context this controller uses: 14 members of the
 * 215 `InteractiveModeContext` declares. Naming the slice keeps the dependency
 * legible and lets a test build one without the `as unknown as
 * InteractiveModeContext` cast the full interface forces.
 */
export type GoalModeControllerContext = Pick<
	InteractiveModeContext,
	| "editor"
	| "loopModeEnabled"
	| "onInputCallback"
	| "session"
	| "sessionManager"
	| "showError"
	| "showHookConfirm"
	| "showHookEditor"
	| "showHookSelector"
	| "showStatus"
	| "showWarning"
	| "startPendingSubmission"
	| "statusLine"
	| "ui"
	| "vibeModeEnabled"
>;

/**
 * The three questions about the mode's own submission bookkeeping that goal mode
 * has to ask and that no context member answers, because the answers live in
 * private state the mode owns.
 */
export interface GoalModeHost {
	/** The session is mid-turn, compacting, or draining post-turn maintenance. */
	isAutoSubmitBlocked(): boolean;
	/** A submission is queued and has not started yet. */
	hasPendingSubmission(): boolean;
	/** The queued submission is a visible user turn rather than a synthetic one. */
	hasPendingVisibleUserSubmission(): boolean;
	/** Plan mode is enabled or paused; goal mode refuses to activate while it is. */
	isPlanModeActive(): boolean;
	/** Run `work` behind a spinner in the status area. */
	withProgress<T>(label: string, work: () => Promise<T>): Promise<T>;
}

/**
 * Consecutive provider-killed goal turns tolerated before goal mode stops
 * driving on its own. A transport fault is routinely retried and recovered, so
 * one is not a reason to stand down; a provider that is genuinely gone must not
 * let the goal spin forever.
 */
const GOAL_FAILED_TURN_LIMIT = 3;

/** How long the composer stays idle before goal mode opens a continuation turn. */
const GOAL_CONTINUATION_DELAY_MS = 800;

/**
 * How long goal mode keeps waiting for a busy session to go idle before it gives up on the
 * continuation it owes. Post-turn maintenance — a compaction of a large context, a queued
 * hook — routinely outlasts one delay window, and the goal must still be driving afterwards.
 */
const GOAL_CONTINUATION_BUSY_WAIT_MS = 300_000;

/** Why goal mode is not opening a continuation turn right now. */
type GoalContinuationBlock =
	| "loop-mode"
	| "no-input-callback"
	| "continuation-mode-off"
	| "plan-mode"
	| "goal-mode-off"
	| "suppressed"
	| "busy"
	| "submission-pending"
	| "draft-in-composer"
	| "images-attached"
	| "goal-not-active"
	| "no-prompt";

/**
 * Blocks that are an ordinary handoff rather than a goal declining to drive. `no-input-callback`
 * is the common one: every `agent_end` arms the continuation before the loop has returned to
 * `getUserInput`, and that call is expected to do nothing.
 */
const GOAL_CONTINUATION_QUIET_BLOCKS: ReadonlySet<GoalContinuationBlock> = new Set([
	"loop-mode",
	"no-input-callback",
	"continuation-mode-off",
	"goal-mode-off",
]);

/** The objective cap used by the one-line notices. */
const GOAL_SUMMARY_MAX_LENGTH = 48;

/** Interview turns a guided goal takes before it gives up and salvages the draft. */
const GUIDED_GOAL_TURN_LIMIT = 6;

/**
 * Whether the turn that just ended died rather than finished. An aborted turn is
 * the user's own interrupt and is handled by the goal runtime's pause path, so
 * only a provider/transport error counts here.
 */
function goalTurnEndedInError(event: Extract<AgentSessionEvent, { type: "agent_end" }>): boolean {
	const lastAssistant = [...event.messages]
		.reverse()
		.find((message): message is AssistantMessage => message.role === "assistant");
	return lastAssistant?.stopReason === "error";
}

type GoalSubcommand = "set" | "show" | "pause" | "resume" | "drop";

const GOAL_SUBCOMMANDS: Record<GoalSubcommand, true> = {
	set: true,
	show: true,
	pause: true,
	resume: true,
	drop: true,
};

function parseGoalSubcommand(args: string): { sub: GoalSubcommand | undefined; rest: string } {
	const trimmed = args.trim();
	if (!trimmed) return { sub: undefined, rest: "" };
	const match = /^(\S+)(?:\s+([\s\S]*))?$/.exec(trimmed);
	if (!match) return { sub: undefined, rest: trimmed };
	const first = match[1].toLowerCase();
	if (first in GOAL_SUBCOMMANDS) {
		return { sub: first as GoalSubcommand, rest: match[2]?.trim() ?? "" };
	}
	return { sub: undefined, rest: trimmed };
}

/**
 * Goal mode as the terminal sees it: the `/goal` and `/guided-goal` commands, the
 * status-line badge, the tool set the mode installs, and the autonomous
 * continuation turn that keeps an active goal driving while the composer is idle.
 *
 * The goal record itself lives in `session.goalRuntime`; what is here is the
 * decision of when the terminal may open a turn on the goal's behalf, and the
 * two flags (`enabled`, `paused`) that every other mode reads to refuse to
 * activate. Both flags are exposed as mutable state because the session's own
 * `goal_updated` event, a session resume, and the commands all set them.
 */
export class GoalModeController {
	#context: GoalModeControllerContext;
	#host: GoalModeHost;
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

	constructor(context: GoalModeControllerContext, host: GoalModeHost) {
		this.#context = context;
		this.#host = host;
	}

	/** Whether a goal exists at all, active or paused. Other modes refuse while it does. */
	get active(): boolean {
		return this.enabled || this.paused;
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
		// Return the async handler so AgentSession can attach its rejection
		// guard; a detached goal bookkeeping failure must not crash the TUI.
		this.#unsubscribe = this.#context.session.subscribe(event => {
			return this.#handleSessionEvent(event).catch(error => {
				logger.warn("Goal mode session event handler failed", {
					event: event.type,
					error: errorMessage(error),
				});
				this.#context.showWarning(`Goal mode update failed: ${errorMessage(error)}`);
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

	/** Repaint the status-line goal badge. */
	updateStatus(): void {
		const status = this.active ? { enabled: this.enabled, paused: this.paused } : undefined;
		this.#context.statusLine.setGoalModeStatus(status);
		this.#context.ui.requestRender();
	}

	/**
	 * Tear the mode's transient state down for a session switch or resume,
	 * restoring the tool set the goal displaced. Nothing here touches the stored
	 * goal record: this clears what the terminal was doing about it.
	 */
	async clearTransientState(): Promise<void> {
		if (!this.active) return;
		if (this.#previousTools !== undefined) {
			await this.#context.session.setActiveToolsByName(this.#previousTools);
		}
		this.#context.session.setGoalModeState(undefined);
		this.enabled = false;
		this.paused = false;
		this.#previousTools = undefined;
		this.#turnHadToolCalls = false;
		this.#continuationTurnInFlight = false;
		this.resetContinuationSuppression();
		this.#userTurnInFlight = false;
		this.#cancelContinuation();
		this.updateStatus();
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
		if (!this.#context.session.settings.get("goal.enabled")) {
			// Goal mode is off, so nothing activates here — but the stored objective
			// is not this setting's to destroy. Recording `none` dropped it for
			// good, and in silence: a session came back with no goal and nothing
			// saying that a settings toggle had taken it. The record stays on the
			// branch, inert, so turning Goal Mode back on restores it. Plan mode
			// still clears in the caller, because its entry can come from a startup
			// default nobody chose.
			this.#context.session.goalRuntime.clearAccounting();
			const stored = this.#goalFromModeData(sessionContext.modeData);
			logger.warn("goal mode is disabled; the session's stored goal stays inactive", {
				mode: sessionContext.mode,
				readable: stored !== undefined,
				goalId: stored?.id,
			});
			this.#context.showWarning(
				stored
					? `Goal Mode is off in settings, so "${this.#summary(stored.objective)}" stays stored and inactive.`
					: "Goal Mode is off in settings, so this session's stored goal stays inactive.",
			);
			return "handled";
		}
		const goal = this.#goalFromModeData(sessionContext.modeData);
		if (!goal) {
			// A record that cannot be parsed cannot be restored, so it goes —
			// out loud. Silence here read as the goal unsetting itself.
			logger.warn("stored goal record is unreadable; clearing goal mode", { mode: sessionContext.mode });
			this.#context.showWarning("This session's stored goal could not be read and was cleared.");
			this.#context.sessionManager.appendModeChange("none");
			return "handled";
		}
		this.#context.session.setGoalModeState({
			enabled: sessionContext.mode === "goal",
			mode: "active",
			goal,
		});
		const restored = await this.#context.session.goalRuntime.onThreadResumed({
			preserveActiveGoal: options?.preserveActiveGoal,
		});
		this.enabled = restored?.enabled === true;
		this.paused = restored?.enabled !== true && restored?.goal.status === "paused";
		// The goal tool is part of the normal enabled tool set. Retain the
		// pre-goal set so leaving or dropping the restored goal preserves it.
		if (restored?.goal) {
			const previousTools = this.#context.session.getActiveToolNames();
			this.#previousTools = previousTools;
			await this.#context.session.setActiveToolsByName([...new Set([...previousTools, "goal"])]);
		}
		this.updateStatus();
		return "handled";
	}

	/** Leave a goal the session reports as exiting, before the next user input. */
	async exitIfSessionIsExiting(): Promise<void> {
		if (this.#context.session.getGoalModeState()?.mode !== "exiting") return;
		await this.#exit({ reason: "completed", silent: true });
	}

	/** `/goal`: the toggle, the subcommands, and the management menu. */
	async handleCommand(rest?: string): Promise<void> {
		try {
			if (this.#host.isPlanModeActive()) {
				this.#context.showWarning("Exit plan mode first.");
				return;
			}
			if (this.#context.vibeModeEnabled) {
				this.#context.showWarning("Exit vibe mode first.");
				return;
			}
			if (!this.#context.session.settings.get("goal.enabled")) {
				this.#context.showWarning("Goal mode is disabled. Enable it in settings (goal.enabled).");
				return;
			}
			const { sub, rest: subRest } = parseGoalSubcommand(rest ?? "");
			if (sub) {
				await this.#dispatchSubcommand(sub, subRest);
				return;
			}
			if (this.enabled) {
				if (subRest) {
					this.#context.showStatus(
						"Goal mode is already active. Use /goal to manage it, or /goal drop to start over.",
					);
					return;
				}
				await this.#openMenu("active");
				return;
			}
			const pausedState = this.#pausedGoalState();
			if (pausedState) {
				if (subRest) {
					this.#context.showWarning("Resume the current goal first, or drop it before setting a new objective.");
					return;
				}
				await this.#openMenu("paused");
				return;
			}
			if (subRest) {
				await this.#startFromObjective(subRest);
				return;
			}
			const objective = (await this.#promptForObjective("Goal objective"))?.trim();
			if (!objective) return;
			await this.#startFromObjective(objective);
		} catch (error) {
			this.#context.showError(errorMessage(error));
		}
	}

	/** `/guided-goal`: interview the operator until the objective is sharp enough to run. */
	async handleGuidedCommand(rest?: string): Promise<void> {
		try {
			if (this.#host.isPlanModeActive()) {
				this.#context.showWarning("Exit plan mode first.");
				return;
			}
			if (!this.#context.session.settings.get("goal.enabled")) {
				this.#context.showWarning("Goal mode is disabled. Enable it in settings (goal.enabled).");
				return;
			}
			if (this.enabled) {
				this.#context.showStatus(
					"Goal mode is already active. Use /goal to manage it, or /goal drop to start over.",
				);
				return;
			}
			if (this.#pausedGoalState()) {
				this.#context.showWarning("Resume the current goal first, or drop it before setting a new objective.");
				return;
			}

			const initial = rest?.trim() ? rest.trim() : (await this.#promptForObjective("Guided goal"))?.trim();
			if (!initial) return;

			const messages: GuidedGoalMessage[] = [{ role: "user", content: initial }];
			let latestDraftObjective: string | undefined;
			// One Codex side session for the whole interview: every follow-up turn
			// reuses it so a multi-question interview shares a single websocket-only
			// Codex socket instead of leaking one per turn (#5471 review).
			const guidedGoalSessionId = newGuidedGoalSessionId(this.#context.session);
			for (let turn = 0; turn < GUIDED_GOAL_TURN_LIMIT; turn++) {
				const result = await this.#host.withProgress(
					turn === 0 ? "Refining the objective" : "Reading your answer",
					() => runGuidedGoalTurn(this.#context.session, { messages, sideSessionId: guidedGoalSessionId }),
				);
				if (result.objective?.trim()) latestDraftObjective = result.objective.trim();
				if (result.kind === "question") {
					messages.push({ role: "assistant", content: result.question });
					const answer = (await this.#promptForObjective(result.question))?.trim();
					if (!answer) return;
					messages.push({ role: "user", content: answer });
					continue;
				}

				const finalObjective = (await this.#promptForObjective("Review guided goal", result.objective))?.trim();
				if (!finalObjective) return;
				await this.#startFromObjective(finalObjective);
				return;
			}

			// Hit the turn cap without an explicit `ready`. Rather than discard the whole interview,
			// salvage the latest non-empty model objective draft seen on any earlier turn. A final
			// question turn may omit `objective`; that must not erase a usable draft.
			if (latestDraftObjective) {
				const finalObjective = (await this.#promptForObjective("Review guided goal", latestDraftObjective))?.trim();
				if (finalObjective) {
					await this.#startFromObjective(finalObjective);
					return;
				}
			}
			this.#context.showWarning(
				"Guided goal setup needs more detail. Run /guided-goal again with a narrower objective.",
			);
		} catch (error) {
			this.#context.showError(errorMessage(error));
		}
	}

	/**
	 * Open the goal detail/action menu for the current goal (active or paused)
	 * without typing `/goal`. A no-op when no goal is set. This is the target of
	 * the down-arrow status affordance and the footline's `mode` segment click.
	 */
	async openDetail(): Promise<void> {
		if (this.enabled) {
			await this.#openMenu("active");
			return;
		}
		if (this.#pausedGoalState()) {
			await this.#openMenu("paused");
		}
	}

	#promptForObjective(title: string, initial?: string): Promise<string | undefined> {
		return this.#context.showHookEditor(title, initial, undefined, { promptStyle: true });
	}

	/** The objective as it appears in a one-line notice. One owner for the cap. */
	#summary(objective: string): string {
		return objective.length > GOAL_SUMMARY_MAX_LENGTH
			? `${objective.slice(0, GOAL_SUMMARY_MAX_LENGTH - 1)}…`
			: objective;
	}

	#pausedGoalState(): GoalModeState | undefined {
		const state = this.#context.session.getGoalModeState();
		if (!state?.goal || state.enabled || state.goal.status !== "paused") {
			return undefined;
		}
		return state;
	}

	#goalFromModeData(modeData: SessionContext["modeData"]): Goal | undefined {
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
			// Back-compat: goals persisted before turn accounting existed lack this.
			turnsCompleted: typeof value.turnsCompleted === "number" ? value.turnsCompleted : 0,
			createdAt: value.createdAt,
			updatedAt: value.updatedAt,
		};
	}

	/**
	 * Why goal mode must not open a continuation turn at this instant, or `undefined` when it may.
	 *
	 * ONE owner for the question, asked when the timer is armed and again when it fires. The two
	 * lists used to be separate copies that disagreed on one entry, and that entry was the defect:
	 * `busy` existed only at fire time, where it discarded the tick and left a comment saying the
	 * next `agent_end` would reschedule. For a goal whose post-turn maintenance outlives the delay
	 * window there is no next `agent_end` — the turn that armed this tick was the last one — so the
	 * goal sat `active` with every re-arm edge already behind it.
	 */
	#continuationBlock(phase: "arm" | "fire"): GoalContinuationBlock | undefined {
		if (this.#context.loopModeEnabled) return "loop-mode";
		if (!this.#context.onInputCallback) return "no-input-callback";
		if (!this.#context.session.settings.get("goal.continuationModes").includes("interactive")) {
			return "continuation-mode-off";
		}
		if (this.#host.isPlanModeActive()) return "plan-mode";
		if (!this.enabled || this.paused) return "goal-mode-off";
		if (this.#suppressNextContinuation || this.#userContinuationSuppressed) return "suppressed";
		// The one transient block: mid-turn, compacting, or draining post-turn maintenance, each of
		// which ends on its own. Asked at fire time only — at arm time the turn that scheduled this
		// tick is still settling, which is what the delay is for.
		if (phase === "fire" && this.#host.isAutoSubmitBlocked()) return "busy";
		if (this.#host.hasPendingSubmission()) return "submission-pending";
		if (this.#context.editor.getText().trim().length > 0) return "draft-in-composer";
		if ((this.#context.editor.pendingImages?.length ?? 0) > 0) return "images-attached";
		const state = this.#context.session.getGoalModeState();
		if (!state?.enabled || state.goal.status !== "active") return "goal-not-active";
		return undefined;
	}

	#reportContinuationBlock(reason: GoalContinuationBlock, phase: "arm" | "fire"): void {
		if (GOAL_CONTINUATION_QUIET_BLOCKS.has(reason)) return;
		logger.debug("Goal mode is not opening a continuation turn", {
			reason,
			phase,
			goalId: this.#context.session.getGoalModeState()?.goal.id,
		});
	}

	#armContinuation(): void {
		this.#cancelContinuation();
		const blocked = this.#continuationBlock("arm");
		if (blocked) {
			this.#reportContinuationBlock(blocked, "arm");
			return;
		}
		const prompt = this.#context.session.goalRuntime.buildContinuationPrompt();
		if (!prompt) {
			this.#reportContinuationBlock("no-prompt", "arm");
			return;
		}
		this.#continuationTimer = setTimeout(() => {
			this.#continuationTimer = undefined;
			const blockedNow = this.#continuationBlock("fire");
			if (blockedNow === "busy") {
				this.#continuationBusyUntil ??= Date.now() + GOAL_CONTINUATION_BUSY_WAIT_MS;
				if (Date.now() < this.#continuationBusyUntil) {
					this.#armContinuation();
					return;
				}
				this.#continuationBusyUntil = undefined;
				this.#reportContinuationBlock("busy", "fire");
				this.#context.showWarning(
					"Goal mode stopped waiting for the session to go idle. Send a message to resume it.",
				);
				return;
			}
			this.#continuationBusyUntil = undefined;
			if (blockedNow) {
				this.#reportContinuationBlock(blockedNow, "fire");
				return;
			}
			const submit = this.#context.onInputCallback;
			if (!submit) return;
			this.#continuationTurnInFlight = true;
			submit(
				this.#context.startPendingSubmission({
					text: prompt,
					customType: "goal-continuation",
					display: false,
				}),
			);
		}, GOAL_CONTINUATION_DELAY_MS);
	}

	#cancelContinuation(): void {
		if (this.#continuationTimer) {
			clearTimeout(this.#continuationTimer);
			this.#continuationTimer = undefined;
		}
	}

	async #handleSessionEvent(event: AgentSessionEvent): Promise<void> {
		if (event.type === "auto_retry_start") {
			// The next `agent_start` is this same turn resuming, not a new one. The
			// session's retry supersedes the killed attempt's `agent_end`, so this is
			// the only notice the mode gets that the work continues.
			this.#turnRetrying = true;
			return;
		}
		if (event.type === "agent_start") {
			// A retried turn keeps the tool calls its killed attempt already made:
			// the work happened, and a retry that only talks afterwards is not the
			// model saying it has nothing left to do.
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
			// A visible user turn pauses autonomous goal continuation unless the
			// turn actually resumes execution. Merely producing prose is not
			// evidence that the user intended goal mode to take control again.
			if (this.#userTurnInFlight || this.#host.hasPendingVisibleUserSubmission()) {
				this.resetContinuationSuppression();
			}
			return;
		}
		if (event.type === "message_start" && event.message.role === "user" && !event.message.synthetic) {
			this.noteVisibleUserTurnStarted();
			return;
		}
		if (event.type === "goal_updated") {
			// Handle drop before clearing `enabled` so `#exit` can restore the
			// pre-goal tool set while the flag is still true.
			if (event.state?.goal?.status === "dropped") {
				await this.#exit({ reason: "dropped", silent: true });
				return;
			}
			const activating = !this.enabled && event.state?.enabled === true;
			if (activating) {
				this.resetContinuationSuppression();
			}
			this.enabled = event.state?.enabled === true;
			this.paused = event.state?.enabled !== true && event.state?.goal?.status === "paused";
			if (!event.state?.enabled) {
				this.#cancelContinuation();
			}
			this.updateStatus();
			return;
		}
		if (event.type !== "agent_end") {
			return;
		}
		this.#userTurnInFlight = false;
		// A retry that never resumed (aborted, cancelled) must not make the NEXT turn
		// inherit this one's tool-call evidence.
		this.#turnRetrying = false;
		if (goalTurnEndedInError(event)) {
			// A turn the provider killed neither finished the goal's work nor showed
			// that the model had nothing left to call, so its tool-call count says
			// nothing about whether the goal should keep driving. Latching
			// suppression from it is what left a recovered session idle: the retry
			// landed, the suppression stayed, and a human had to type "keep going".
			// The continuation stays owed, and the tolerance is bounded.
			this.#failedTurns += 1;
			if (this.#failedTurns >= GOAL_FAILED_TURN_LIMIT) {
				this.#continuationTurnInFlight = false;
				this.#suppressNextContinuation = true;
				this.#context.showWarning(
					`Goal mode stopped driving after ${formatCount("failed turn", this.#failedTurns)}. Send a message to resume it.`,
				);
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
		if (this.#context.session.getGoalModeState()?.mode === "exiting") {
			await this.#exit({ reason: "completed", silent: true });
			return;
		}
		this.scheduleContinuation();
	}

	async #enter(options: { objective?: string; resume?: boolean; silent?: boolean }): Promise<void> {
		if (this.enabled) {
			return;
		}
		if (this.#host.isPlanModeActive()) {
			this.#context.showWarning("Exit plan mode first.");
			return;
		}
		if (this.#context.vibeModeEnabled) {
			this.#context.showWarning("Exit vibe mode first.");
			return;
		}
		const previousTools = this.#context.session.getActiveToolNames();
		const goalTools = [...new Set([...previousTools, "goal"])];
		this.#previousTools = previousTools;
		this.paused = false;
		const state = options.resume
			? await this.#context.session.goalRuntime.resumeGoal()
			: await this.#context.session.goalRuntime.createGoal({ objective: options.objective ?? "" });
		await this.#context.session.setActiveToolsByName(goalTools);
		this.#context.session.setGoalModeState(state);
		this.enabled = true;
		this.resetContinuationSuppression();
		this.updateStatus();
		if (this.#context.session.isStreaming) {
			await this.#context.session.sendGoalModeContext({ deliverAs: "steer" });
		}
		if (!options.silent) {
			this.#context.showStatus(options.resume ? "Goal mode resumed." : "Goal mode enabled.");
		}
	}

	async #exit(options?: {
		silent?: boolean;
		paused?: boolean;
		reason?: "completed" | "paused" | "dropped";
	}): Promise<void> {
		const previousTools = this.#previousTools;
		if (this.enabled && previousTools) {
			await this.#context.session.setActiveToolsByName(previousTools);
		}
		const currentState = this.#context.session.getGoalModeState();
		if (options?.reason === "completed") {
			this.#context.session.setGoalModeState(undefined);
			this.#context.sessionManager.appendModeChange("none");
			this.#context.sessionManager.appendCustomEntry("goal-completed", {
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
		this.updateStatus();
		if (!options?.silent) {
			if (options?.reason === "completed") {
				this.#context.showStatus("Goal mode completed.");
			} else if (options?.reason === "dropped") {
				this.#context.showStatus("Goal dropped.");
			} else if (options?.paused) {
				this.#context.showStatus("Goal mode paused.");
			} else {
				this.#context.showStatus("Goal mode disabled.");
			}
		}
	}

	async #dispatchSubcommand(sub: GoalSubcommand, rest: string): Promise<void> {
		switch (sub) {
			case "set":
				await this.#handleSetSubcommand(rest);
				return;
			case "show":
				this.#showDetails();
				return;
			case "pause":
				await this.#pause();
				return;
			case "resume":
				await this.#resume();
				return;
			case "drop":
				await this.#confirmAndDrop();
				return;
		}
	}

	async #openMenu(state: "active" | "paused"): Promise<void> {
		const goal = this.#context.session.getGoalModeState()?.goal;
		if (!goal) return;
		const summary = this.#summary(goal.objective);
		const title = state === "active" ? `Goal: ${summary} (${goal.status})` : `Goal paused: ${summary}`;
		const items = state === "active" ? ["Show details", "Pause", "Drop"] : ["Resume", "Show details", "Drop"];
		const choice = await this.#context.showHookSelector(title, items);
		if (!choice) return;
		switch (choice) {
			case "Show details":
				this.#showDetails();
				return;
			case "Pause":
				await this.#pause();
				return;
			case "Resume":
				await this.#resume();
				return;
			case "Drop":
				await this.#confirmAndDrop();
				return;
		}
	}

	#showDetails(): void {
		const state = this.#context.session.getGoalModeState();
		const goal = state?.goal;
		if (!goal) {
			this.#context.showStatus("No goal set.");
			return;
		}
		const used = goal.tokensUsed.toLocaleString();
		let tokensLine = used;
		if (this.#context.session.settings.get("goal.modelBudgetsEnabled") && goal.tokenBudget !== undefined) {
			const left = Math.max(0, goal.tokenBudget - goal.tokensUsed);
			const pct = goal.tokenBudget > 0 ? Math.min(999, Math.round((goal.tokensUsed / goal.tokenBudget) * 100)) : 0;
			tokensLine = `${used} / ${goal.tokenBudget.toLocaleString()} (${pct}%, ${left.toLocaleString()} left)`;
		}
		const lines = [
			`Objective: ${goal.objective}`,
			`Status: ${goal.status}${state?.enabled ? "" : " (paused)"}`,
			`Tokens: ${tokensLine}`,
			`Turns: ${goal.turnsCompleted}`,
			`Time spent: ${formatDurationCoarse(goal.timeUsedSeconds * 1000)}`,
		];
		this.#context.showStatus(lines.join("\n"));
	}

	async #pause(): Promise<void> {
		if (!this.enabled) {
			this.#context.showWarning("No active goal to pause.");
			return;
		}
		await this.#context.session.goalRuntime.pauseGoal();
		await this.#exit({ paused: true, reason: "paused" });
	}

	async #resume(): Promise<void> {
		if (!this.#pausedGoalState()) {
			this.#context.showWarning("No paused goal to resume.");
			return;
		}
		await this.#enter({ resume: true, silent: true });
		this.#context.showStatus("Goal mode resumed.");
		this.scheduleContinuation();
	}

	async #confirmAndDrop(): Promise<void> {
		if (!this.enabled && !this.#pausedGoalState()) {
			this.#context.showWarning("No goal to drop.");
			return;
		}
		const confirmed = await this.#context.showHookConfirm(
			"Drop goal?",
			"This removes the goal record. Accumulated usage stays in the session log.",
		);
		if (!confirmed) return;
		await this.#context.session.goalRuntime.dropGoal();
		await this.#exit({ reason: "dropped" });
	}

	async #startFromObjective(objective: string): Promise<void> {
		await this.#enter({ objective, silent: true });
		this.resetContinuationSuppression();
		if (!this.#context.session.isStreaming && this.#context.onInputCallback) {
			this.#context.onInputCallback(this.#context.startPendingSubmission({ text: objective }));
		}
	}

	async #replaceFromObjective(objective: string): Promise<void> {
		const state = await this.#context.session.goalRuntime.replaceGoal({ objective });
		this.#context.session.setGoalModeState(state);
		this.enabled = true;
		this.paused = false;
		this.resetContinuationSuppression();
		this.updateStatus();
		if (this.#context.session.isStreaming) {
			await this.#context.session.sendGoalModeContext({ deliverAs: "steer" });
		}
		if (!this.#context.session.isStreaming && this.#context.onInputCallback) {
			this.#context.onInputCallback(this.#context.startPendingSubmission({ text: objective }));
		}
	}

	async #handleSetSubcommand(rest: string): Promise<void> {
		if (!this.enabled && this.#pausedGoalState()) {
			this.#context.showWarning("Resume the current goal first, or drop it before setting a new objective.");
			return;
		}
		const objective = rest.trim() ? rest.trim() : (await this.#promptForObjective("Goal objective"))?.trim();
		if (!objective) return;
		if (this.enabled) {
			await this.#replaceFromObjective(objective);
			return;
		}
		await this.#startFromObjective(objective);
	}
}
