import { getPaddingX, Text } from "@veyyon/tui";
import { isTerminalTodoStatus, isTodoListDone } from "@veyyon/wire";
import { settings } from "../../config/settings";
import { type TodoItem, type TodoPhase, todoMatchesAnyDescription } from "../../tools/todo";
import {
	paintRailMotion,
	RAIL_IDLE_STEP_MS,
	RAIL_SETTLE_FRAMES,
	type RailMotion,
	railClockMs,
	railIdleHeadAtMs,
} from "../../tui/rail-motion";
import { renderSubagentHudLines } from "../components/subagent-hud";
import {
	renderTodoBoardLines,
	TODO_BOARD_FRAME_DIVISOR,
	type TodoBoardMotion,
	todoBoardIsLive,
	todoBoardMarkerAnimates,
	todoBoardRailTravels,
} from "../components/todo-board";
import type { InteractiveMode } from "../interactive-mode";
import { transitionsEnabled } from "../theme/shimmer";
import { theme } from "../theme/theme";

export const ANCHORED_BLOCK_PADDING_X = 1;

export class TodoBoardManager {
	#host: InteractiveMode;
	#anchoredStep = 0;
	#anchoredMotionInterval: NodeJS.Timeout | undefined;
	#todoSettleFrame: number | undefined;
	#todoSettlePhases: TodoPhase[] | undefined;
	#todoBoardLive = false;
	#todoAutoClearTimer: NodeJS.Timeout | undefined;

	constructor(host: InteractiveMode) {
		this.#host = host;
	}

	get todoBoardLive(): boolean {
		return this.#todoBoardLive;
	}

	reconcileTodosWithSubagents(): void {
		const completedDescs: string[] = [];
		const observerRegistry = this.#host.observerRegistry;
		const sessions = observerRegistry?.getSessionsSpawnedBy(this.#host.focusedAgentId) ?? [];
		for (const session of sessions) {
			if (session.status !== "completed") continue;
			const candidate =
				session.description?.trim() || session.progress?.description?.trim() || session.label?.trim();
			if (candidate) completedDescs.push(candidate);
		}
		if (completedDescs.length === 0) return;

		let mutated = false;
		const next: TodoPhase[] = this.#host.todoPhases.map(phase => ({
			name: phase.name,
			tasks: phase.tasks.map(task => {
				if (task.status !== "pending" && task.status !== "in_progress") return task;
				if (!todoMatchesAnyDescription(task.content, completedDescs)) return task;
				mutated = true;
				return { ...task, status: "completed" as const };
			}),
		}));
		if (!mutated) return;
		this.#host.viewSession.setTodoPhases(next);
		this.setTodos(next);
	}

	cancelTodoAutoClearTimer(): void {
		if (!this.#todoAutoClearTimer) return;
		clearTimeout(this.#todoAutoClearTimer);
		this.#todoAutoClearTimer = undefined;
	}

	isClosedTodo(task: TodoItem): boolean {
		return isTerminalTodoStatus(task.status);
	}

	hasClosedTodos(phases: TodoPhase[]): boolean {
		return phases.some(phase => phase.tasks.some(task => this.isClosedTodo(task)));
	}

	removeClosedTodos(phases: TodoPhase[]): TodoPhase[] {
		const next: TodoPhase[] = [];
		for (const phase of phases) {
			const tasks = phase.tasks.filter(task => !this.isClosedTodo(task));
			if (tasks.length > 0) next.push({ name: phase.name, tasks });
		}
		return next;
	}

	syncTodoAutoClearTimer(): void {
		this.cancelTodoAutoClearTimer();
		const delaySeconds = this.#host.settings.get("tasks.todoClearDelay");
		if (!Number.isFinite(delaySeconds) || delaySeconds < 0 || !this.hasClosedTodos(this.#host.todoPhases)) return;
		if (delaySeconds === 0) {
			this.#host.todoPhases = this.removeClosedTodos(this.#host.todoPhases);
			return;
		}

		this.#todoAutoClearTimer = setTimeout(() => {
			this.#todoAutoClearTimer = undefined;
			this.#host.todoPhases = this.removeClosedTodos(this.#host.todoPhases);
			this.renderTodoList();
			this.#host.ui.requestRender();
		}, delaySeconds * 1000);
		this.#todoAutoClearTimer.unref?.();
	}

	renderTodoList(): void {
		this.buildTodoBoard();
		this.syncAnchoredMotionTimer();
	}

	buildTodoBoard(): void {
		this.#host.todoContainer.clear();
		const settling = this.#todoSettleFrame !== undefined ? this.#todoSettlePhases : undefined;
		const phases = (settling ?? this.#host.todoPhases).filter(phase => phase.tasks.length > 0);
		this.#todoBoardLive = false;
		if (phases.length === 0) return;
		if (settling === undefined && isTodoListDone(phases)) return;

		const owned = this.todoOwnedTasks();
		this.#todoBoardLive = todoBoardIsLive(phases, owned);
		const lines = renderTodoBoardLines(phases, {
			columns: this.anchoredColumns(),
			maxRows: this.anchoredRowBudget(),
			expanded: this.#host.todoExpanded,
			owned,
			frame: Math.floor(this.#anchoredStep / TODO_BOARD_FRAME_DIVISOR),
			animate: todoBoardMarkerAnimates(this.todoMotion()),
			live: this.#todoBoardLive,
		});
		if (lines.length === 0) return;
		const motion = this.todoRailMotion();
		const painted = motion ? paintRailMotion(lines, motion, theme) : lines;
		this.#host.todoContainer.addChild(new Text(painted.join("\n"), ANCHORED_BLOCK_PADDING_X, 0));
	}

	anchoredColumns(): number {
		return Math.max(1, (this.#host.ui.terminal.columns || 80) - getPaddingX(ANCHORED_BLOCK_PADDING_X) * 2);
	}

	anchoredRowBudget(): number {
		const rows = this.#host.ui.terminal.rows || 24;
		return Math.max(4, Math.min(14, Math.floor(rows / 3)));
	}

	todoOwnedTasks(): Set<string> {
		const owned = new Set<string>();
		const observerRegistry = this.#host.observerRegistry;
		const active = (observerRegistry?.getSessionsSpawnedBy(this.#host.focusedAgentId) ?? []).filter(
			session => session.status === "active",
		);
		if (active.length === 0) return owned;
		const descriptions: string[] = [];
		for (const session of active) {
			const description =
				session.description?.trim() || session.progress?.description?.trim() || session.label?.trim();
			if (description) descriptions.push(description);
		}
		if (descriptions.length === 0) return owned;
		for (const phase of this.#host.todoPhases) {
			for (const task of phase.tasks) {
				if (task.status !== "pending" || owned.has(task.content)) continue;
				if (todoMatchesAnyDescription(task.content, descriptions)) owned.add(task.content);
			}
		}
		return owned;
	}

	todoRailMotion(): RailMotion | undefined {
		if (this.#todoSettleFrame !== undefined) return { kind: "settle", frame: this.#todoSettleFrame };
		if (!todoBoardRailTravels(this.todoMotion())) return undefined;
		return { kind: "idle", head: railIdleHeadAtMs(railClockMs()) };
	}

	todoMotion(): TodoBoardMotion {
		return {
			transitions: transitionsEnabled(),
			agentInMotion:
				this.#host.session.isStreaming || this.#host.session.isCompacting || this.#host.session.hasPostPromptWork,
			live: this.#todoBoardLive,
		};
	}

	renderSubagentList(): void {
		this.#host.subagentContainer.clear();
		const observerRegistry = this.#host.observerRegistry;
		const sessions = observerRegistry?.getSessionsSpawnedBy(this.#host.focusedAgentId) ?? [];
		const lines = renderSubagentHudLines(sessions, {
			columns: this.anchoredColumns(),
			showModelBadge: settings.get("subagent.showResolvedModelBadge"),
		});
		this.syncAnchoredMotionTimer();
		if (lines.length === 0) return;
		const painted = transitionsEnabled()
			? paintRailMotion(lines, { kind: "idle", head: railIdleHeadAtMs(railClockMs()) }, theme)
			: lines;
		this.#host.subagentContainer.addChild(new Text(painted.join("\n"), ANCHORED_BLOCK_PADDING_X, 0));
	}

	syncAnchoredMotionTimer(): void {
		const isFrozen = this.#host.lifecycleManager?.isFrameProductionFrozen ?? false;
		const wanted =
			!isFrozen && transitionsEnabled() && (this.anchoredMotionOwed() || this.#todoSettleFrame !== undefined);
		if (!wanted) {
			this.cancelAnchoredMotionTimer();
			return;
		}
		if (this.#anchoredMotionInterval) return;
		this.#anchoredMotionInterval = setInterval(() => {
			this.#anchoredStep++;
			this.advanceTodoSettle();
			this.renderTodoList();
			this.renderSubagentList();
			this.#host.ui.requestRender();
		}, RAIL_IDLE_STEP_MS);
		this.#anchoredMotionInterval.unref?.();
	}

	cancelAnchoredMotionTimer(): void {
		if (!this.#anchoredMotionInterval) return;
		clearInterval(this.#anchoredMotionInterval);
		this.#anchoredMotionInterval = undefined;
	}

	anchoredMotionOwed(): boolean {
		if (todoBoardRailTravels(this.todoMotion())) return true;
		const observerRegistry = this.#host.observerRegistry;
		return (observerRegistry?.getSessionsSpawnedBy(this.#host.focusedAgentId) ?? []).some(
			session => session.kind === "subagent" && session.status === "active" && session.detached === true,
		);
	}

	advanceTodoSettle(): void {
		if (this.#todoSettleFrame === undefined) return;
		if (this.#todoSettleFrame >= RAIL_SETTLE_FRAMES) {
			this.#todoSettleFrame = undefined;
			this.#todoSettlePhases = undefined;
			return;
		}
		this.#todoSettleFrame++;
	}

	noteTodoTransitions(before: TodoPhase[], after: TodoPhase[]): void {
		const nonEmptyBefore = before.filter(phase => phase.tasks.length > 0);
		const nonEmptyAfter = after.filter(phase => phase.tasks.length > 0);
		const closedNow =
			nonEmptyAfter.length > 0 &&
			isTodoListDone(nonEmptyAfter) &&
			nonEmptyBefore.length > 0 &&
			!isTodoListDone(nonEmptyBefore);
		if (closedNow && transitionsEnabled()) {
			this.#todoSettlePhases = nonEmptyAfter;
			this.#todoSettleFrame = 1;
		}
		this.syncAnchoredMotionTimer();
	}

	syncTodoSurfaceToView(): void {
		this.#host.todoPhases = this.#host.viewSession.getTodoPhases();
		this.syncTodoAutoClearTimer();
		this.renderTodoList();
	}

	setTodos(phases: TodoPhase[]): void {
		const previous = this.#host.todoPhases;
		this.#host.todoPhases = phases;
		this.noteTodoTransitions(previous, phases);
		this.syncTodoAutoClearTimer();
		this.renderTodoList();
		this.#host.ui.requestRender();
	}

	reloadTodos(): void {
		this.setTodos(this.#host.viewSession.getTodoPhases());
	}

	toggleTodoExpansion(): boolean {
		this.#host.todoExpanded = !this.#host.todoExpanded;
		this.renderTodoList();
		this.#host.ui.requestRender();
		return this.#host.todoExpanded;
	}

	dispose(): void {
		this.cancelTodoAutoClearTimer();
		this.cancelAnchoredMotionTimer();
	}
}
