/**
 * The anchored todo board above the composer.
 *
 * The list is the tree list this board has had for its whole life: a header
 * carrying the phase the plan is on, one row per phase with its own tally, and
 * the tasks of the phase being worked nested under it with `renderTreeList`'s
 * connectors. Two things are added to it, and nothing else.
 *
 * The RAIL is the side bar. `block.rail` is the first non-space cell of every
 * row, which is the one arrangement {@link paintRailMotion} and `findRailCell`
 * can reach, so the block can carry the same travelling light every other live
 * region in this product carries. A row that began with a connector was a row
 * no house animation could find.
 *
 * The MARK is the row in flight: one small square alternating between hollow and
 * filled, at the task it belongs to. It replaces nothing else — every other row
 * keeps the checkbox vocabulary (`■` done, `□` open, `◧` unused here) and every
 * other row is still.
 *
 * Both stop when the agent stops. Motion states that the agent is working, and a
 * task stays marked in progress across the turn boundary, so a board keyed on
 * task state alone moved for as long as the operator sat reading it.
 * {@link todoBoardMarkerAnimates} and {@link todoBoardRailTravels} are where
 * that is decided, once, for all three motion sites.
 */

import { visibleWidth } from "@veyyon/tui";
import { countWhere, partition } from "@veyyon/utils";
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
/**
 * Shared clock steps per board frame. The anchored clock is the tool rail's, at
 * `RAIL_IDLE_STEP_MS`; a task marker on that clock changes several times a
 * second, which is faster than anything a reader is tracking on a plan. Four
 * steps is a change roughly every quarter second.
 */
export const TODO_BOARD_FRAME_DIVISOR = 4;

/**
 * What the board is allowed to move on.
 *
 * The three motion sites — the task mark, the rail, and the anchored clock that
 * has to keep ticking for either to be seen — read one decision from here
 * instead of each recomposing it. They disagreed once: the mark animated off
 * task state alone, so a plan with a task marked in progress moved while the
 * session sat idle waiting for input.
 */
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

/**
 * Whether the rail highlight travels. Unlike the mark this needs open work: the
 * rail states that the plan is being worked, and a settled plan is not.
 */
export function todoBoardRailTravels(motion: TodoBoardMotion): boolean {
	if (!motion.transitions) return false;
	return motion.live && motion.agentInMotion;
}
export interface TodoBoardOptions {
	columns: number;
	/**
	 * Hard cap on drawn rows, header included. The board is an anchored region
	 * above the composer, so it cannot be allowed to grow without bound: a
	 * wrapped or overlong row does not scroll away, it makes the region taller on
	 * every rebuild.
	 */
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

/**
 * The mark on the task in flight: a small square, hollow on one frame and filled
 * on the next.
 *
 * Small and square by construction. The density ramp (`░ ▒ ▓ █`) fills the whole
 * cell, and a terminal cell is half as wide as it is tall, so a ramp cell at the
 * task indent reads as a rectangle switching on and off — louder than the row it
 * marks. `▫`/`▪` are the two smallest marks the symbol table carries and they
 * differ only in ink, so the alternation reads as one mark pulsing. Still, it is
 * the filled one, which is the same mark a reader is already tracking.
 */
function workingMark(frame: number, animate: boolean): string {
	const filled = theme.symbol("status.done");
	if (!animate) return filled;
	return frame % 2 === 0 ? theme.symbol("status.shadowed") : filled;
}

/**
 * One task row.
 *
 * Every state is separated by its glyph before it is separated by colour, so the
 * row still reads in a low-contrast theme and in a capture that dropped every
 * SGR. A pending task a detached subagent is working on takes the accent, which
 * is the only thing on the board that states someone else is on it.
 */
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

/**
 * The tasks a collapsed phase previews: the open ones, plus the few most
 * recently closed. Showing only remaining work meant a stage that had just
 * closed three tasks looked exactly like one that had done nothing.
 */
function collapsedTasks(phase: TodoPhase): TodoItem[] {
	const [closed, open] = partition(phase.tasks, isClosed);
	if (open.length === 0) return closed.slice(-ACTIVE_TASK_CAP);
	const keep = new Set<TodoItem>([...closed.slice(-DONE_TASK_CAP), ...open.slice(0, ACTIVE_TASK_CAP)]);
	return phase.tasks.filter(task => keep.has(task));
}

/** The phase the plan is on: the first with open work, else the last one. */
export function activeTodoPhaseIndex(phases: readonly TodoPhase[]): number {
	const index = phases.findIndex(phase => phase.tasks.some(task => !isClosed(task)));
	return index >= 0 ? index : Math.max(0, phases.length - 1);
}

/** Whether a board with this state has anything in flight, which is what the rail means. */
export function todoBoardIsLive(phases: readonly TodoPhase[], owned: ReadonlySet<string>): boolean {
	return phases.some(phase =>
		phase.tasks.some(task => task.status === "in_progress" || (task.status === "pending" && owned.has(task.content))),
	);
}

/**
 * Build the anchored todo board.
 *
 * Returns an empty array when there is nothing to draw, so the container clears
 * itself. Whether a CLOSED plan is worth drawing is the caller's decision, not
 * this function's: a finished board is history and belongs in the transcript,
 * but it is drawn for the length of its exit pass, and a renderer that refused a
 * closed plan could not draw that exit.
 */
export function renderTodoBoardLines(phases: readonly TodoPhase[], options: TodoBoardOptions): string[] {
	const live = phases.filter(phase => phase.tasks.length > 0);
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
	// A task row is two levels deep, so it carries six connector cells, then the
	// checkbox, a space, and the text. Below the width that leaves the text
	// `TASK_TEXT_FLOOR` cells there is nothing to read, and a clamped row would
	// be wider than the mount and wrap outside the rail.
	const taskWidth = content - 6 - glyphColumns - 1;
	if (taskWidth < TASK_TEXT_FLOOR) return [];

	const multiPhase = live.length > 1;
	const activeIdx = activeTodoPhaseIndex(live);

	// One phase node. The stage being worked carries its tasks and its label in
	// accent; a stage nobody has reached is one muted row, and its tasks are
	// listed only when the board is expanded. This is what keeps the block short:
	// the plan has as many phases as it has, and the board is a region above the
	// composer that does not scroll.
	const phaseLines = (phase: TodoPhase, oneBased: number, active: boolean): string[] => {
		const done = countWhere(phase.tasks, task => task.status === "completed");
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

	// Collapsed: the active stage and a bounded number of the stages after it.
	// The stages already finished are not drawn — the header's `phase n/total`
	// states how far the plan has come, and a column of closed tallies is what
	// made the block read as one undifferentiated chunk. Expanded lists every
	// stage from the top. Roman numerals stay tied to the real phase index.
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

	// The header is inside the row budget, and so is the overflow row when there
	// is one, so `maxRows` is the height of the block rather than the height of
	// its body. The tail is what goes: the rows are the active stage first, so
	// what a trim drops is the stages furthest ahead of the work.
	const budget = Math.max(1, options.maxRows - 1);
	let shown = body;
	let hidden = 0;
	if (body.length > budget) {
		shown = body.slice(0, Math.max(0, budget - 1));
		hidden = body.length - shown.length;
	}

	const lines = [`${railCell} ${header}`, ...shown.map(line => `${railCell} ${line}`.trimEnd())];
	if (hidden > 0) {
		lines.push(`${railCell} ${theme.fg("dim", boundedTodoPreviewText(`… ${hidden} more`, content))}`);
	}
	return ["", ...lines];
}
