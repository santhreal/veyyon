import type { AssistantMessage } from "@veyyon/ai";
import { errorMessage, logger } from "@veyyon/utils";
import { type GuidedGoalMessage, newGuidedGoalSessionId, runGuidedGoalTurn } from "../../goals/guided-setup";
import type { Goal, GoalModeState } from "../../goals/state";
import type { AgentSessionEvent } from "../../session/agent-session";
import type { SessionContext } from "../../session/session-context";
import { formatDurationCoarse } from "../../slash-commands/helpers/format";
import type { InteractiveMode } from "../interactive-mode";

export const GOAL_FAILED_TURN_LIMIT = 3;
export const GOAL_CONTINUATION_DELAY_MS = 800;
export const GOAL_CONTINUATION_BUSY_WAIT_MS = 300_000;

export type GoalContinuationBlock =
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

export const GOAL_CONTINUATION_QUIET_BLOCKS: ReadonlySet<GoalContinuationBlock> = new Set([
	"loop-mode",
	"no-input-callback",
	"continuation-mode-off",
	"goal-mode-off",
]);

export type GoalSubcommand = "set" | "show" | "pause" | "resume" | "drop";

export function goalTurnEndedInError(event: Extract<AgentSessionEvent, { type: "agent_end" }>): boolean {
	let lastAssistant: AssistantMessage | undefined;
	for (let i = event.messages.length - 1; i >= 0; i--) {
		const message = event.messages[i]!;
		if (message.role === "assistant") {
			lastAssistant = message;
			break;
		}
	}
	return lastAssistant?.stopReason === "error";
}

export function parseGoalSubcommand(args: string): { sub: GoalSubcommand | undefined; rest: string } {
	const trimmed = args.trim();
	if (!trimmed) return { sub: undefined, rest: "" };
	const match = /^(\S+)(?:\s+([\s\S]*))?$/.exec(trimmed);
	if (!match) return { sub: undefined, rest: trimmed };
	const verb = match[1]?.toLowerCase();
	const rest = (match[2] ?? "").trim();
	if (verb === "set" || verb === "show" || verb === "pause" || verb === "resume" || verb === "drop") {
		return { sub: verb, rest };
	}
	return { sub: undefined, rest: trimmed };
}

export class GoalModeController {
	#host: InteractiveMode;
	goalModeEnabled = false;
	goalModePaused = false;
	#goalModePreviousTools: string[] | undefined;
	#goalSuppressNextContinuation = false;
	#goalUserContinuationSuppressed = false;
	#goalTurnHadToolCalls = false;
	#goalTurnRetrying = false;
	#goalFailedTurns = 0;
	#goalUserTurnInFlight = false;
	#goalContinuationTurnInFlight = false;
	#goalContinuationTimer: NodeJS.Timeout | undefined;
	#goalContinuationBusyUntil: number | undefined;

	constructor(host: InteractiveMode) {
		this.#host = host;
	}

	get goalUserTurnInFlight(): boolean {
		return this.#goalUserTurnInFlight;
	}

	set goalUserTurnInFlight(val: boolean) {
		this.#goalUserTurnInFlight = val;
	}

	get goalContinuationTurnInFlight(): boolean {
		return this.#goalContinuationTurnInFlight;
	}

	set goalContinuationTurnInFlight(val: boolean) {
		this.#goalContinuationTurnInFlight = val;
	}

	get goalSuppressNextContinuation(): boolean {
		return this.#goalSuppressNextContinuation;
	}

	set goalSuppressNextContinuation(val: boolean) {
		this.#goalSuppressNextContinuation = val;
	}

	get goalUserContinuationSuppressed(): boolean {
		return this.#goalUserContinuationSuppressed;
	}

	set goalUserContinuationSuppressed(val: boolean) {
		this.#goalUserContinuationSuppressed = val;
	}

	get goalModePreviousTools(): string[] | undefined {
		return this.#goalModePreviousTools;
	}

	updateGoalModeStatus(): void {
		const status =
			this.goalModeEnabled || this.goalModePaused
				? { enabled: this.goalModeEnabled, paused: this.goalModePaused }
				: undefined;
		this.#host.statusLine.setGoalModeStatus(status);
		this.#host.ui.requestRender();
	}

	resetGoalContinuationSuppression(): void {
		this.#goalSuppressNextContinuation = false;
		this.#goalUserContinuationSuppressed = false;
	}

	getPausedGoalState(): GoalModeState | undefined {
		const state = this.#host.session.getGoalModeState();
		if (!state?.goal || state.enabled || state.goal.status !== "paused") {
			return undefined;
		}
		return state;
	}

	goalFromModeData(modeData: SessionContext["modeData"]): Goal | undefined {
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

	goalSummary(objective: string): string {
		return objective.length > 48 ? `${objective.slice(0, 47)}…` : objective;
	}

	async handleGoalSessionEvent(event: AgentSessionEvent): Promise<void> {
		if (event.type === "auto_retry_start") {
			this.#goalTurnRetrying = true;
			return;
		}
		if (event.type === "agent_start") {
			if (this.#goalTurnRetrying) {
				this.#goalTurnRetrying = false;
			} else {
				this.#goalTurnHadToolCalls = false;
			}
			this.cancelGoalContinuation();
			return;
		}
		if (event.type === "tool_execution_start") {
			this.#goalTurnHadToolCalls = true;
			const pendingVisibleUserTurn =
				this.#host.pendingSubmittedInput !== undefined && !this.#host.pendingSubmittedInput.customType;
			if (this.#goalUserTurnInFlight || pendingVisibleUserTurn) {
				this.resetGoalContinuationSuppression();
			}
			return;
		}
		if (event.type === "agent_end") {
			const turnHadToolCalls = this.#goalTurnHadToolCalls;
			this.#goalTurnHadToolCalls = false;
			this.#goalTurnRetrying = false;
			const wasUserTurn = this.#goalUserTurnInFlight;
			const wasContinuationTurn = this.#goalContinuationTurnInFlight;
			this.#goalUserTurnInFlight = false;
			this.#goalContinuationTurnInFlight = false;

			const goalState = this.#host.session.getGoalModeState();
			if (!goalState?.enabled || goalState.goal.status !== "active") {
				this.cancelGoalContinuation();
				return;
			}

			if (goalTurnEndedInError(event)) {
				this.#goalFailedTurns++;
				if (this.#goalFailedTurns >= GOAL_FAILED_TURN_LIMIT) {
					this.#goalFailedTurns = 0;
					await this.#host.session.goalRuntime.pauseGoal();
					await this.exitGoalMode({ paused: true, reason: "paused" });
					this.#host.showWarning(
						`Goal mode paused after ${GOAL_FAILED_TURN_LIMIT} consecutive turn errors. Run /goal resume to try again.`,
					);
					return;
				}
			} else {
				this.#goalFailedTurns = 0;
			}

			if (wasUserTurn && !turnHadToolCalls) {
				this.#goalUserContinuationSuppressed = true;
			}

			if (this.#goalSuppressNextContinuation || this.#goalUserContinuationSuppressed) {
				return;
			}

			if (wasContinuationTurn && !turnHadToolCalls) {
				await this.#host.session.goalRuntime.pauseGoal();
				await this.exitGoalMode({ paused: true, reason: "paused" });
				this.#host.showStatus("Goal mode paused (no further actions queued).");
				return;
			}

			this.scheduleGoalContinuation();
		}
	}

	async enterGoalMode(options: { objective?: string; resume?: boolean; silent?: boolean }): Promise<void> {
		if (this.goalModeEnabled) {
			return;
		}
		if (this.#host.planModeEnabled || this.#host.planModePaused) {
			this.#host.showWarning("Exit plan mode first.");
			return;
		}
		if (this.#host.vibeModeEnabled) {
			this.#host.showWarning("Exit vibe mode first.");
			return;
		}
		const previousTools = this.#host.session.getActiveToolNames();
		const goalToolSet = new Set(previousTools);
		goalToolSet.add("goal");
		const goalTools = Array.from(goalToolSet);
		this.#goalModePreviousTools = previousTools;
		this.goalModePaused = false;
		const state = options.resume
			? await this.#host.session.goalRuntime.resumeGoal()
			: await this.#host.session.goalRuntime.createGoal({ objective: options.objective ?? "" });
		await this.#host.session.setActiveToolsByName(goalTools);
		this.#host.session.setGoalModeState(state);
		this.goalModeEnabled = true;
		this.resetGoalContinuationSuppression();
		this.updateGoalModeStatus();
		if (this.#host.session.isStreaming) {
			await this.#host.session.sendGoalModeContext({ deliverAs: "steer" });
		}
		if (!options.silent) {
			this.#host.showStatus(options.resume ? "Goal mode resumed." : "Goal mode enabled.");
		}
	}

	async exitGoalMode(options?: {
		silent?: boolean;
		paused?: boolean;
		reason?: "completed" | "paused" | "dropped";
	}): Promise<void> {
		const previousTools = this.#goalModePreviousTools;
		if (this.goalModeEnabled && previousTools) {
			await this.#host.session.setActiveToolsByName(previousTools);
		}
		const currentState = this.#host.session.getGoalModeState();
		if (options?.reason === "completed") {
			this.#host.session.setGoalModeState(undefined);
			this.#host.sessionManager.appendModeChange("none");
			this.#host.sessionManager.appendCustomEntry("goal-completed", {
				objective: currentState?.goal?.objective,
				tokensUsed: currentState?.goal?.tokensUsed,
				tokenBudget: currentState?.goal?.tokenBudget,
				timeUsedSeconds: currentState?.goal?.timeUsedSeconds,
			});
		}
		this.goalModeEnabled = false;
		this.goalModePaused = options?.paused ?? false;
		this.#goalModePreviousTools = undefined;
		this.#goalContinuationTurnInFlight = false;
		this.resetGoalContinuationSuppression();
		this.#goalUserTurnInFlight = false;
		this.cancelGoalContinuation();
		this.updateGoalModeStatus();
		if (!options?.silent) {
			if (options?.reason === "completed") {
				this.#host.showStatus("Goal mode completed.");
			} else if (options?.reason === "dropped") {
				this.#host.showStatus("Goal dropped.");
			} else if (options?.paused) {
				this.#host.showStatus("Goal mode paused.");
			} else {
				this.#host.showStatus("Goal mode disabled.");
			}
		}
	}

	async handleGoalModeCommand(rest?: string): Promise<void> {
		try {
			if (this.#host.planModeEnabled || this.#host.planModePaused) {
				this.#host.showWarning("Exit plan mode first.");
				return;
			}
			if (this.#host.vibeModeEnabled) {
				this.#host.showWarning("Exit vibe mode first.");
				return;
			}
			if (!this.#host.session.settings.get("goal.enabled")) {
				this.#host.showWarning("Goal mode is disabled. Enable it in settings (goal.enabled).");
				return;
			}
			const { sub, rest: subRest } = parseGoalSubcommand(rest ?? "");
			if (sub) {
				await this.dispatchGoalSubcommand(sub, subRest);
				return;
			}
			if (this.goalModeEnabled) {
				if (subRest) {
					this.#host.showStatus(
						"Goal mode is already active. Use /goal to manage it, or /goal drop to start over.",
					);
					return;
				}
				await this.openGoalMenu("active");
				return;
			}
			const pausedState = this.getPausedGoalState();
			if (pausedState) {
				if (subRest) {
					this.#host.showWarning("Resume the current goal first, or drop it before setting a new objective.");
					return;
				}
				await this.openGoalMenu("paused");
				return;
			}
			if (subRest) {
				await this.startGoalFromObjective(subRest);
				return;
			}
			const objective = (
				await this.#host.showHookEditor("Goal objective", undefined, undefined, { promptStyle: true })
			)?.trim();
			if (!objective) return;
			await this.startGoalFromObjective(objective);
		} catch (error) {
			this.#host.showError(errorMessage(error));
		}
	}

	async handleGuidedGoalCommand(rest?: string): Promise<void> {
		try {
			if (this.#host.planModeEnabled || this.#host.planModePaused) {
				this.#host.showWarning("Exit plan mode first.");
				return;
			}
			if (!this.#host.session.settings.get("goal.enabled")) {
				this.#host.showWarning("Goal mode is disabled. Enable it in settings (goal.enabled).");
				return;
			}
			if (this.goalModeEnabled) {
				this.#host.showStatus("Goal mode is already active. Use /goal to manage it, or /goal drop to start over.");
				return;
			}
			if (this.getPausedGoalState()) {
				this.#host.showWarning("Resume the current goal first, or drop it before setting a new objective.");
				return;
			}

			const initial = rest?.trim()
				? rest.trim()
				: (await this.#host.showHookEditor("Guided goal", undefined, undefined, { promptStyle: true }))?.trim();
			if (!initial) return;

			const messages: GuidedGoalMessage[] = [{ role: "user", content: initial }];
			let latestDraftObjective: string | undefined;
			const guidedGoalSessionId = newGuidedGoalSessionId(this.#host.session);
			for (let turn = 0; turn < 6; turn++) {
				const result = await this.#host.workingLoaderManager.withGuidedGoalProgress(
					turn === 0 ? "Refining the objective" : "Reading your answer",
					() => runGuidedGoalTurn(this.#host.session, { messages, sideSessionId: guidedGoalSessionId }),
				);
				if (result.objective?.trim()) latestDraftObjective = result.objective.trim();
				if (result.kind === "question") {
					messages.push({ role: "assistant", content: result.question });
					const answer = (
						await this.#host.showHookEditor(result.question, undefined, undefined, { promptStyle: true })
					)?.trim();
					if (!answer) return;
					messages.push({ role: "user", content: answer });
					continue;
				}

				const finalObjective = (
					await this.#host.showHookEditor("Review guided goal", result.objective, undefined, { promptStyle: true })
				)?.trim();
				if (!finalObjective) return;
				await this.startGoalFromObjective(finalObjective);
				return;
			}

			if (latestDraftObjective) {
				const finalObjective = (
					await this.#host.showHookEditor("Review guided goal", latestDraftObjective, undefined, {
						promptStyle: true,
					})
				)?.trim();
				if (finalObjective) {
					await this.startGoalFromObjective(finalObjective);
					return;
				}
			}
			this.#host.showWarning(
				"Guided goal setup needs more detail. Run /guided-goal again with a narrower objective.",
			);
		} catch (error) {
			this.#host.showError(errorMessage(error));
		}
	}

	async dispatchGoalSubcommand(sub: GoalSubcommand, rest: string): Promise<void> {
		switch (sub) {
			case "set":
				await this.handleGoalSetSubcommand(rest);
				return;
			case "show":
				this.showGoalDetails();
				return;
			case "pause":
				await this.pauseGoalAction();
				return;
			case "resume":
				await this.resumeGoalAction();
				return;
			case "drop":
				await this.confirmAndDropGoal();
				return;
		}
	}

	async openGoalMenu(state: "active" | "paused"): Promise<void> {
		const goal = this.#host.session.getGoalModeState()?.goal;
		if (!goal) return;
		const summary = this.goalSummary(goal.objective);
		const title = state === "active" ? `Goal: ${summary} (${goal.status})` : `Goal paused: ${summary}`;
		const items = state === "active" ? ["Show details", "Pause", "Drop"] : ["Resume", "Show details", "Drop"];
		const choice = await this.#host.showHookSelector(title, items);
		if (!choice) return;
		switch (choice) {
			case "Show details":
				this.showGoalDetails();
				return;
			case "Pause":
				await this.pauseGoalAction();
				return;
			case "Resume":
				await this.resumeGoalAction();
				return;
			case "Drop":
				await this.confirmAndDropGoal();
				return;
		}
	}

	showGoalDetails(): void {
		const state = this.#host.session.getGoalModeState();
		const goal = state?.goal;
		if (!goal) {
			this.#host.showStatus("No goal set.");
			return;
		}
		const used = goal.tokensUsed.toLocaleString();
		let tokensLine = used;
		if (this.#host.session.settings.get("goal.modelBudgetsEnabled") && goal.tokenBudget !== undefined) {
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
		this.#host.showStatus(lines.join("\n"));
	}

	async openGoalDetail(): Promise<void> {
		if (this.goalModeEnabled) {
			await this.openGoalMenu("active");
			return;
		}
		if (this.getPausedGoalState()) {
			await this.openGoalMenu("paused");
		}
	}

	async pauseGoalAction(): Promise<void> {
		if (!this.goalModeEnabled) {
			this.#host.showWarning("No active goal to pause.");
			return;
		}
		await this.#host.session.goalRuntime.pauseGoal();
		await this.exitGoalMode({ paused: true, reason: "paused" });
	}

	async resumeGoalAction(): Promise<void> {
		if (!this.getPausedGoalState()) {
			this.#host.showWarning("No paused goal to resume.");
			return;
		}
		await this.enterGoalMode({ resume: true, silent: true });
		this.#host.showStatus("Goal mode resumed.");
		this.scheduleGoalContinuation();
	}

	async confirmAndDropGoal(): Promise<void> {
		if (!this.goalModeEnabled && !this.getPausedGoalState()) {
			this.#host.showWarning("No goal to drop.");
			return;
		}
		const confirmed = await this.#host.showHookConfirm(
			"Drop goal?",
			"This removes the goal record. Accumulated usage stays in the session log.",
		);
		if (!confirmed) return;
		await this.#host.session.goalRuntime.dropGoal();
		await this.exitGoalMode({ reason: "dropped" });
	}

	async startGoalFromObjective(objective: string): Promise<void> {
		await this.enterGoalMode({ objective, silent: true });
		this.resetGoalContinuationSuppression();
		if (!this.#host.session.isStreaming && this.#host.onInputCallback) {
			this.#host.onInputCallback(this.#host.startPendingSubmission({ text: objective }));
		}
	}

	async replaceGoalFromObjective(objective: string): Promise<void> {
		const state = await this.#host.session.goalRuntime.replaceGoal({ objective });
		this.#host.session.setGoalModeState(state);
		this.goalModeEnabled = true;
		this.goalModePaused = false;
		this.resetGoalContinuationSuppression();
		this.updateGoalModeStatus();
		if (this.#host.session.isStreaming) {
			await this.#host.session.sendGoalModeContext({ deliverAs: "steer" });
		}
		if (!this.#host.session.isStreaming && this.#host.onInputCallback) {
			this.#host.onInputCallback(this.#host.startPendingSubmission({ text: objective }));
		}
	}

	async handleGoalSetSubcommand(rest: string): Promise<void> {
		if (!this.goalModeEnabled && this.getPausedGoalState()) {
			this.#host.showWarning("Resume the current goal first, or drop it before setting a new objective.");
			return;
		}
		const objective = rest.trim()
			? rest.trim()
			: (await this.#host.showHookEditor("Goal objective", undefined, undefined, { promptStyle: true }))?.trim();
		if (!objective) return;
		if (this.goalModeEnabled) {
			await this.replaceGoalFromObjective(objective);
			return;
		}
		await this.startGoalFromObjective(objective);
	}

	goalContinuationBlock(phase: "arm" | "fire"): GoalContinuationBlock | undefined {
		if (this.#host.loopModeEnabled) return "loop-mode";
		if (!this.#host.onInputCallback) return "no-input-callback";
		if (!this.#host.session.settings.get("goal.continuationModes").includes("interactive")) {
			return "continuation-mode-off";
		}
		if (this.#host.planModeEnabled || this.#host.planModePaused) return "plan-mode";
		if (!this.goalModeEnabled || this.goalModePaused) return "goal-mode-off";
		if (this.#goalSuppressNextContinuation || this.#goalUserContinuationSuppressed) return "suppressed";
		if (phase === "fire" && this.#isAutoSubmitBlocked()) return "busy";
		if (this.#host.pendingSubmittedInput) return "submission-pending";
		if (this.#host.editor.getText().trim().length > 0) return "draft-in-composer";
		if ((this.#host.editor.pendingImages?.length ?? 0) > 0) return "images-attached";
		const state = this.#host.session.getGoalModeState();
		if (!state?.enabled || state.goal.status !== "active") return "goal-not-active";
		return undefined;
	}

	#isAutoSubmitBlocked(): boolean {
		return this.#host.session.isStreaming || this.#host.session.isCompacting || this.#host.session.hasPostPromptWork;
	}

	reportGoalContinuationBlock(reason: GoalContinuationBlock, phase: "arm" | "fire"): void {
		if (GOAL_CONTINUATION_QUIET_BLOCKS.has(reason)) return;
		logger.debug("Goal mode is not opening a continuation turn", {
			reason,
			phase,
			goalId: this.#host.session.getGoalModeState()?.goal.id,
		});
	}

	scheduleGoalContinuation(): void {
		this.cancelGoalContinuation();
		this.#goalContinuationBusyUntil = undefined;
		this.armGoalContinuation();
	}

	armGoalContinuation(): void {
		this.cancelGoalContinuation();
		const blocked = this.goalContinuationBlock("arm");
		if (blocked) {
			this.reportGoalContinuationBlock(blocked, "arm");
			return;
		}
		const promptText = this.#host.session.goalRuntime.buildContinuationPrompt();
		if (!promptText) {
			this.reportGoalContinuationBlock("no-prompt", "arm");
			return;
		}
		this.#goalContinuationTimer = setTimeout(() => {
			this.#goalContinuationTimer = undefined;
			const blockedNow = this.goalContinuationBlock("fire");
			if (blockedNow === "busy") {
				this.#goalContinuationBusyUntil ??= Date.now() + GOAL_CONTINUATION_BUSY_WAIT_MS;
				if (Date.now() < this.#goalContinuationBusyUntil) {
					this.armGoalContinuation();
					return;
				}
				this.#goalContinuationBusyUntil = undefined;
				this.reportGoalContinuationBlock("busy", "fire");
				this.#host.showWarning(
					"Goal mode stopped waiting for the session to go idle. Send a message to resume it.",
				);
				return;
			}
			this.#goalContinuationBusyUntil = undefined;
			if (blockedNow) {
				this.reportGoalContinuationBlock(blockedNow, "fire");
				return;
			}
			const submit = this.#host.onInputCallback;
			if (!submit) return;
			this.#goalContinuationTurnInFlight = true;
			submit(
				this.#host.startPendingSubmission({
					text: promptText,
					customType: "goal-continuation",
					display: false,
				}),
			);
		}, GOAL_CONTINUATION_DELAY_MS);
	}

	cancelGoalContinuation(): void {
		if (this.#goalContinuationTimer) {
			clearTimeout(this.#goalContinuationTimer);
			this.#goalContinuationTimer = undefined;
		}
	}

	dispose(): void {
		this.cancelGoalContinuation();
	}
}
