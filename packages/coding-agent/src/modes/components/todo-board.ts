/** The anchored todo board above the composer. The list is the tree list this board has had for its whole life: a header */

import { visibleWidth } from "@veyyon/tui";
import type { TodoItem, TodoPhase } from "../../tools/todo";
import { boundedTodoPreviewText, formatPhaseDisplayName, todoStrikeReveal } from "../../tools/todo";
import { renderTreeList } from "../../tui/tree-list";
import { theme } from "../theme/theme";

/** Stages listed after the active one when the board is collapsed. */
const SUBSEQUENT_PHASE_CAP = 4;
/** Open tasks previewed for the active stage when the board is collapsed. */
const ACTIVE_TASK_CAP = 5;
/** Recently finished tasks kept alongside them, so a stage that just closed work shows it. */
const DONE_TASK_CAP = 2;
/** Cells a task's text needs before the board is worth drawing at all. */
const TASK_TEXT_FLOOR = 8;
/** Shared clock steps per board frame. The anchored clock is the tool rail's, at `RAIL_IDLE_STEP_MS`; a task marker on that clock changes several times a */
export const TODO_BOARD_FRAME_DIVISOR = 4;

/** What the board is allowed to move on. The three motion sites — the task mark, the rail, and the anchored clock that */
export interface TodoBoardMotion {
	/** `display.transitions`. Off means the block is a still image. */
	transitions: boolean;
	/** Whether the agent is streaming, compacting, or running post-prompt work. */
	agentInMotion: boolean;
	/** Whether the plan has open work at all. */
	live: boolean;
}

/** Whether the in-flight task mark alternates. */
export function todoBoardMarkerAnimates(motion: TodoBoardMotion): boolean {
	if (!motion.transitions) return false;
	return motion.agentInMotion;
}

/** Whether the rail highlight travels. Unlike the mark this needs open work: the rail states that the plan is being worked, and a settled plan is not. */
export function todoBoardRailTravels(motion: TodoBoardMotion): boolean {
	if (!motion.transitions) return false;
	return motion.live && motion.agentInMotion;
}
export interface TodoBoardOptions {
	columns: number;
	/** Hard cap on drawn rows, header included. The board is an anchored region above the composer, so it cannot be allowed to grow without bound: a */
	maxRows: number;
	expanded: boolean;
	/** Task contents a detached subagent is working on right now. */
	owned: ReadonlySet<string>;
	/** Board frame, already divided down from the shared anchored clock. */
	frame: number;
	/** Whether the in-flight mark alternates, decided by the caller so this stays pure. */
	animate: boolean;
	/** Whether anything is in flight, which is what the rail's colour states. */
	live: boolean;
}

function isClosed(task: TodoItem): boolean {
	return task.status === "completed" || task.status === "abandoned";
}

/** The mark on the task in flight: a small square, hollow on one frame and filled on the next. */
function workingMark(frame: number, animate: boolean): string {
	const filled = theme.symbol("status.done");
	if (!animate) return filled;
	return frame % 2 === 0 ? theme.symbol("status.shadowed") : filled;
}

/** One task row. Every state is separated by its glyph before it is separated by colour, so the */
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

/** The tasks a collapsed phase previews: the open ones, plus the few most recently closed. Showing only remaining work meant a stage that had just */
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

/** The phase the plan is on: the first with open work, else the last one. */
export function activeTodoPhaseIndex(phases: readonly TodoPhase[]): number {
	for (let pi = 0; pi < phases.length; pi++) {
		const tasks = phases[pi]!.tasks;
		for (let ti = 0; ti < tasks.length; ti++) {
			if (!isClosed(tasks[ti]!)) return pi;
		}
	}
	return Math.max(0, phases.length - 1);
}

/** Whether a board with this state has anything in flight, which is what the rail means. */
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

/** Build the anchored todo board. Returns an empty array when there is nothing to draw, so the container clears */
export function renderTodoBoardLines(phases: readonly TodoPhase[], options: TodoBoardOptions): string[] {
	const live: TodoPhase[] = [];
	for (let pi = 0; pi < phases.length; pi++) {
		if (phases[pi]!.tasks.length > 0) live.push(phases[pi]!);
	}
	if (live.length === 0) return [];

	const rail = theme.symbol("block.rail");
	// The last column is left clear: a row that fills it arms the terminal's
	// pending wrap. Chrome is the rail, the space after it, and the connectors
	// `renderTreeList` puts in front of a nested row (three cells per level).
	const usable = Math.max(1, options.columns - 1);
	const content = usable - visibleWidth(rail) - 1;
	const glyphColumns = Math.max(
		visibleWidth(theme.checkbox.checked),
		visibleWidth(theme.checkbox.unchecked),
		visibleWidth(theme.symbol("status.done")),
		visibleWidth(theme.symbol("status.shadowed")),
	);
	// A task row is two levels deep, so it carries six connector cells, then the checkbox, a space, and the text. Below the width that leaves the text
	const taskWidth = content - 6 - glyphColumns - 1;
	if (taskWidth < TASK_TEXT_FLOOR) return [];

	const multiPhase = live.length > 1;
	const activeIdx = activeTodoPhaseIndex(live);

	// One phase node. The stage being worked carries its tasks and its label in accent; a stage nobody has reached is one muted row, and its tasks are
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

	// Collapsed: the active stage and a bounded number of the stages after it. The stages already finished are not drawn — the header's `phase n/total`
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

	// The header is inside the row budget, and so is the overflow row when there is one, so `maxRows` is the height of the block rather than the height of
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
