import type { SessionContext } from "@veyyon/kernel/session/session-context";
import { errorMessage } from "@veyyon/utils";
import { sanitizeStatusText } from "@veyyon/utils/sanitize-status-text";
import { type GoalContinuationBlock, GoalDriver, type GoalDriverPort, summarizeObjective } from "../../../goals/driver";
import { type GuidedGoalMessage, newGuidedGoalSessionId, runGuidedGoalTurn } from "../../../goals/guided-setup";
import type { GoalStatus } from "../../../goals/state";
import { GOAL_SUBCOMMANDS, type GoalSubcommand, parseGoalSubcommand } from "../../../goals/subcommands";
import { formatDurationCoarse } from "../../../session/account-format";
import type { AgentSession } from "../../../session/agent-session";
import type { InteractiveModeContext } from "../types";

export type { GoalContinuationBlock, GoalDriverPort };
export { GoalDriver };

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

/** Interview turns a guided goal takes before it gives up and salvages the draft. */
const GUIDED_GOAL_TURN_LIMIT = 6;

/**
 * The status field of the goal report: the goal's own status, and the mode's state only when the
 * status does not already carry it.
 */
function goalStatusField(status: GoalStatus, modeEnabled: boolean): string {
	if (modeEnabled) return status;
	const advancing = status === "active" || status === "budget-limited";
	return advancing ? `${status} (mode off)` : status;
}

export type { GoalSubcommand };
export { GOAL_SUBCOMMANDS };

/**
 * Goal mode as the terminal sees it: the `/goal` and `/guided-goal` commands, the
 * status-line badge, and terminal UI interactions (menus, prompts, status displays).
 *
 * Implements `GoalDriverPort` to connect the terminal environment to the shared `GoalDriver`.
 */
export class GoalModeController implements GoalDriverPort {
	readonly #context: GoalModeControllerContext;
	readonly #host: GoalModeHost;
	readonly #driver: GoalDriver;

	constructor(context: GoalModeControllerContext, host: GoalModeHost) {
		this.#context = context;
		this.#host = host;
		this.#driver = new GoalDriver(this);
	}

	get driver(): GoalDriver {
		return this.#driver;
	}

	// --- GoalDriverPort implementation ---

	get session(): AgentSession {
		return this.#context.session;
	}

	blockingMode(): "plan" | "vibe" | "loop" | undefined {
		if (this.#host.isPlanModeActive()) return "plan";
		if (this.#context.vibeModeEnabled) return "vibe";
		if (this.#context.loopModeEnabled) return "loop";
		return undefined;
	}

	hasUnsentInput(): boolean {
		return this.#context.editor.getText().trim().length > 0 || (this.#context.editor.pendingImages?.length ?? 0) > 0;
	}

	isAutoSubmitBlocked(): boolean {
		return this.#host.isAutoSubmitBlocked();
	}

	hasPendingSubmission(): boolean {
		return this.#host.hasPendingSubmission();
	}

	hasPendingVisibleUserSubmission(): boolean {
		return this.#host.hasPendingVisibleUserSubmission();
	}

	canSubmit(): boolean {
		return this.#context.onInputCallback !== undefined;
	}

	submitContinuation(prompt: string): void {
		this.#context.onInputCallback?.(
			this.#context.startPendingSubmission({
				text: prompt,
				customType: "goal-continuation",
				display: false,
			}),
		);
	}

	warn(message: string): void {
		this.#context.showWarning(message);
	}

	changed(): void {
		this.updateStatus();
	}

	// --- Delegated public members ---

	get enabled(): boolean {
		return this.#driver.enabled;
	}

	set enabled(value: boolean) {
		this.#driver.enabled = value;
	}

	get paused(): boolean {
		return this.#driver.paused;
	}

	set paused(value: boolean) {
		this.#driver.paused = value;
	}

	get active(): boolean {
		return this.#driver.active;
	}

	noteVisibleUserTurnStarted(): void {
		this.#driver.noteVisibleUserTurnStarted();
	}

	noteVisibleUserTurnCancelled(): void {
		this.#driver.noteVisibleUserTurnCancelled();
	}

	noteContinuationTurnSettled(): void {
		this.#driver.noteContinuationTurnSettled();
	}

	subscribeToSession(): void {
		this.#driver.subscribeToSession();
	}

	unsubscribeFromSession(): void {
		this.#driver.unsubscribeFromSession();
	}

	scheduleContinuation(): void {
		this.#driver.scheduleContinuation();
	}

	cancelContinuation(): void {
		this.#driver.cancelContinuation();
	}

	resetContinuationSuppression(): void {
		this.#driver.resetContinuationSuppression();
	}

	updateStatus(): void {
		const status = this.active ? { enabled: this.enabled, paused: this.paused } : undefined;
		this.#context.statusLine?.setGoalModeStatus(status);
		this.#context.ui?.requestRender();
	}

	async clearTransientState(): Promise<void> {
		await this.#driver.clearTransientState();
	}

	async restoreFromSession(
		sessionContext: SessionContext,
		options?: { preserveActiveGoal?: boolean },
	): Promise<"handled" | "not-a-goal"> {
		return this.#driver.restoreFromSession(sessionContext, options);
	}

	get sessionGoalIsExiting(): boolean {
		return this.#driver.sessionGoalIsExiting;
	}

	async exitCompletedGoal(): Promise<void> {
		await this.#driver.exitCompletedGoal();
	}

	// --- Terminal-specific commands, menus, prompts ---

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
			const pausedState = this.#driver.pausedGoalState();
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
			if (this.#driver.pausedGoalState()) {
				this.#context.showWarning("Resume the current goal first, or drop it before setting a new objective.");
				return;
			}

			const initial = rest?.trim() ? rest.trim() : (await this.#promptForObjective("Guided goal"))?.trim();
			if (!initial) return;

			const messages: GuidedGoalMessage[] = [{ role: "user", content: initial }];
			let latestDraftObjective: string | undefined;
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

	async openDetail(): Promise<void> {
		if (this.enabled) {
			await this.#openMenu("active");
			return;
		}
		if (this.#driver.pausedGoalState()) {
			await this.#openMenu("paused");
		}
	}

	#promptForObjective(title: string, initial?: string): Promise<string | undefined> {
		return this.#context.showHookEditor(title, initial, undefined, { promptStyle: true });
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
		const summary = summarizeObjective(goal.objective);
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
			`Objective: ${sanitizeStatusText(goal.objective)}`,
			`Status: ${goalStatusField(goal.status, state?.enabled === true)}`,
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
		await this.#driver.pause();
		this.#context.showStatus("Goal mode paused.");
	}

	async #resume(): Promise<void> {
		if (!this.#driver.pausedGoalState()) {
			this.#context.showWarning("No paused goal to resume.");
			return;
		}
		await this.#driver.resume();
		this.#context.showStatus("Goal mode resumed.");
	}

	async #confirmAndDrop(): Promise<void> {
		if (!this.enabled && !this.#driver.pausedGoalState()) {
			this.#context.showWarning("No goal to drop.");
			return;
		}
		const confirmed = await this.#context.showHookConfirm(
			"Drop goal?",
			"This removes the goal record. Accumulated usage stays in the session log.",
		);
		if (!confirmed) return;
		await this.#driver.drop();
		this.#context.showStatus("Goal dropped.");
	}

	async #startFromObjective(objective: string): Promise<void> {
		await this.#driver.enter({ objective });
		this.#driver.resetContinuationSuppression();
		if (!this.#context.session.isStreaming && this.#context.onInputCallback) {
			this.#context.onInputCallback(this.#context.startPendingSubmission({ text: objective }));
		}
	}

	async #replaceFromObjective(objective: string): Promise<void> {
		await this.#driver.replaceGoal({ objective });
		if (!this.#context.session.isStreaming && this.#context.onInputCallback) {
			this.#context.onInputCallback(this.#context.startPendingSubmission({ text: objective }));
		}
	}

	async #handleSetSubcommand(rest: string): Promise<void> {
		if (!this.enabled && this.#driver.pausedGoalState()) {
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
