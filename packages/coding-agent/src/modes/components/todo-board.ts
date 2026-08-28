import { visibleWidth } from "@veyyon/tui";
import type { TodoItem, TodoPhase } from "../../tools/todo";
import { boundedTodoPreviewText, formatPhaseDisplayName, todoStrikeReveal } from "../../tools/todo";
import { renderTreeList } from "../../tui/tree-list";
import { theme } from "../theme/theme";

const SUBSEQUENT_PHASE_CAP = 4;
const ACTIVE_TASK_CAP = 5;
const DONE_TASK_CAP = 2;
const TASK_TEXT_FLOOR = 8;
export const TODO_BOARD_FRAME_DIVISOR = 4;

export interface TodoBoardMotion {
	transitions: boolean;
	agentInMotion: boolean;
	live: boolean;
}

export function todoBoardMarkerAnimates(motion: TodoBoardMotion): boolean {
	if (!motion.transitions) return false;
	return motion.agentInMotion;
}

export function todoBoardRailTravels(motion: TodoBoardMotion): boolean {
	if (!motion.transitions) return false;
	return motion.live && motion.agentInMotion;
}
export interface TodoBoardOptions {
	columns: number;
	maxRows: number;
	expanded: boolean;
	owned: ReadonlySet<string>;
	frame: number;
	animate: boolean;
	live: boolean;
}

function isClosed(task: TodoItem): boolean {
	return task.status === "completed" || task.status === "abandoned";
}

function workingMark(frame: number, animate: boolean): string {
	const filled = theme.symbol("status.done");
	if (!animate) return filled;
	return frame % 2 === 0 ? theme.symbol("status.shadowed") : filled;
}

function taskLine(task: TodoItem, options: TodoBoardOptions, width: number): string {
	const checkbox = theme.checkbox;
	const content = boundedTodoPreviewText(task.content, width);
	switch (task.status) {
		case "completed":
			return theme.fg("success", `${checkbox.checked} ${todoStrikeReveal(content, undefined)}`);
		case "in_progress":
			return theme.fg("accent", `${workingMark(options.frame, options.animate)} ${content}`);
		case "abandoned":
			return theme.fg("error", `${checkbox.unchecked} ${todoStrikeReveal(content, undefined)}`);
		default:
			if (options.owned.has(task.content)) {
				return theme.fg("accent", `${workingMark(options.frame, options.animate)} ${content}`);
			}
			return theme.fg("dim", `${checkbox.unchecked} ${content}`);
	}
}

function collapsedTasks(phase: TodoPhase): TodoItem[] {
	const closed: TodoItem[] = [];
	const open: TodoItem[] = [];
	for (let ti = 0; ti < phase.tasks.length; ti++) {
		const task = phase.tasks[ti]!;
		if (isClosed(task)) closed.push(task);
		else open.push(task);
	}
	if (open.length === 0) return closed.slice(-ACTIVE_TASK_CAP);
	const keep = new Set<TodoItem>();
	const closedStart = Math.max(0, closed.length - DONE_TASK_CAP);
	for (let ci = closedStart; ci < closed.length; ci++) keep.add(closed[ci]!);
	for (let oi = 0; oi < Math.min(open.length, ACTIVE_TASK_CAP); oi++) keep.add(open[oi]!);
	const result: TodoItem[] = [];
	for (let ti = 0; ti < phase.tasks.length; ti++) {
		if (keep.has(phase.tasks[ti]!)) result.push(phase.tasks[ti]!);
	}
	return result;
}

export function activeTodoPhaseIndex(phases: readonly TodoPhase[]): number {
	for (let pi = 0; pi < phases.length; pi++) {
		const tasks = phases[pi]!.tasks;
		for (let ti = 0; ti < tasks.length; ti++) {
			if (!isClosed(tasks[ti]!)) return pi;
		}
	}
	return Math.max(0, phases.length - 1);
}

export function todoBoardIsLive(phases: readonly TodoPhase[], owned: ReadonlySet<string>): boolean {
	for (let pi = 0; pi < phases.length; pi++) {
		const tasks = phases[pi]!.tasks;
		for (let ti = 0; ti < tasks.length; ti++) {
			const task = tasks[ti]!;
			if (task.status === "in_progress" || (task.status === "pending" && owned.has(task.content))) return true;
		}
	}
	return false;
}

export function renderTodoBoardLines(phases: readonly TodoPhase[], options: TodoBoardOptions): string[] {
	const live: TodoPhase[] = [];
	for (let pi = 0; pi < phases.length; pi++) {
		if (phases[pi]!.tasks.length > 0) live.push(phases[pi]!);
	}
	if (live.length === 0) return [];

	const rail = theme.symbol("block.rail");
	const usable = Math.max(1, options.columns - 1);
	const content = usable - visibleWidth(rail) - 1;
	const glyphColumns = Math.max(
		visibleWidth(theme.checkbox.checked),
		visibleWidth(theme.checkbox.unchecked),
		visibleWidth(theme.symbol("status.done")),
		visibleWidth(theme.symbol("status.shadowed")),
	);
	const taskWidth = content - 6 - glyphColumns - 1;
	if (taskWidth < TASK_TEXT_FLOOR) return [];

	const multiPhase = live.length > 1;
	const activeIdx = activeTodoPhaseIndex(live);

	const phaseLines = (phase: TodoPhase, oneBased: number, active: boolean): string[] => {
		let done = 0;
		for (let ti = 0; ti < phase.tasks.length; ti++) {
			if (phase.tasks[ti]!.status === "completed") done++;
		}
		const tally = ` · ${done}/${phase.tasks.length}`;
		const label = boundedTodoPreviewText(
			multiPhase ? formatPhaseDisplayName(phase.name, oneBased) : phase.name,
			Math.max(1, content - 3 - visibleWidth(tally)),
		);
		const header = active
			? theme.bold(theme.fg("accent", label)) + theme.fg("dim", tally)
			: theme.fg("muted", label) + theme.fg("dim", tally);
		if (!active && !options.expanded) return [header];
		return [
			header,
			...renderTreeList(
				{
					items: options.expanded ? phase.tasks : collapsedTasks(phase),
					expanded: true,
					renderItem: task => taskLine(task, options, taskWidth),
				},
				theme,
			),
		];
	};

	const baseIdx = options.expanded ? 0 : activeIdx;
	const slice = options.expanded ? live.slice(baseIdx) : live.slice(baseIdx, baseIdx + 1 + SUBSEQUENT_PHASE_CAP);
	const body = renderTreeList(
		{
			items: slice,
			expanded: true,
			renderItem: (phase, ctx) => phaseLines(phase, baseIdx + ctx.index + 1, baseIdx + ctx.index === activeIdx),
		},
		theme,
	);

	const railCell = theme.fg(options.live ? "accent" : "dim", rail);
	const header =
		theme.bold(theme.fg("accent", "Todos")) +
		(multiPhase ? theme.fg("dim", ` · phase ${activeIdx + 1}/${live.length}`) : "");

	const budget = Math.max(1, options.maxRows - 1);
	let shown = body;
	let hidden = 0;
	if (body.length > budget) {
		shown = body.slice(0, Math.max(0, budget - 1));
		hidden = body.length - shown.length;
	}

	const lines = new Array<string>(shown.length + 1);
	lines[0] = `${railCell} ${header}`;
	for (let li = 0; li < shown.length; li++) {
		lines[li + 1] = `${railCell} ${shown[li]!}`.trimEnd();
	}
	if (hidden > 0) {
		lines.push(`${railCell} ${theme.fg("dim", boundedTodoPreviewText(`… ${hidden} more`, content))}`);
	}
	const result = new Array<string>(lines.length + 1);
	result[0] = "";
	for (let li = 0; li < lines.length; li++) result[li + 1] = lines[li]!;
	return result;
}
