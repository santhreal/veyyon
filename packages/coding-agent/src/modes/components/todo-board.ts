/**
 * The anchored todo board, drawn as a railed block.
 *
 * WHY a rail and not a tree. `renderTreeList` drew this board for its whole life
 * and the connectors were never the problem on their own — `├─ │ └─` is the
 * right shape for an ordered, nested, finite list, which is exactly what a plan
 * is. The problem is that a tree cannot be ALIVE. Every other live region in this
 * product hangs off `block.rail` and says it is working by moving light down
 * that rail ({@link paintRailMotion}), and `findRailCell` can only find the rail
 * when it is the first non-space on the row. A board whose rows begin with a
 * connector is, mechanically, a board no house animation can reach. Railing it
 * is not a restyle; it is the precondition for the block being able to say
 * anything about its own state.
 *
 * WHAT the motion says, and it is two things a reader could not previously ask
 * this block:
 *
 *   - The RAIL is the block: light travels down it while the plan is being
 *     worked, and the rail is flat and dim while it is not. A board waiting on
 *     the operator and a board being worked used to render byte-identically,
 *     which made the loudest region on the screen the one that could not tell
 *     you whether it was your turn.
 *   - The GLYPH is the row: the task in flight draws the breathing pixel — the
 *     same `· : ░ ▒ ▓ █ ▓ ▒ ░ :` density ramp the status spinner runs, which the
 *     symbol table calls "the brand compressed into one quiet cell". Nothing
 *     rotates and nothing new was invented: this is `formatStatusIcon`'s own
 *     substitution (a spinner frame while a frame exists, the static symbol
 *     otherwise) applied to the one row that is actually running.
 *
 * WHY the glyphs are all square. Every load-bearing glyph in this product is a
 * square cell modulated by ink: the rail is a block partial, `BAR_RAMPS` is
 * `▏▎▍▌▋▊▉█`, the spinner is a density ramp, the checkboxes are `■ □ ◧`. The ink
 * ramp here runs the other way from the old board's, which spent its heaviest
 * mark (`■`) on completed work: a finished task is context, so it recedes to
 * `status.done`, and the ink on screen tracks what is LEFT.
 *
 * WHY completion is a gesture and not a state flip. A task closing is the only
 * event this block has, and it used to be a single frame: the strike appeared
 * whole, the box flipped, done. Now the same 14-frame envelope the transcript
 * card already sweeps ({@link todoStrikeReveal}) runs here too, the glyph
 * exhales down the density ramp as the strike travels, and the row's colour
 * cools from `success` to `dim` behind it. One gesture, read three ways, on one
 * clock — and the card and the board finally agree about what a completion looks
 * like.
 *
 * WHY a delegated row names its agent. The board already computed which pending
 * task a detached subagent is on, then threw the agent away and kept a boolean,
 * so it could say "someone is on this" and never "who" — while the block one row
 * below it said who and never which task. The owner's id, in that agent's own
 * session accent, is the join. It costs columns only on rows that have an owner
 * and comes off before it wraps.
 */

import { blendHex, visibleWidth } from "@veyyon/tui";
import type { TodoItem, TodoPhase } from "../../tools/todo";
import {
	boundedTodoPreviewText,
	formatPhaseDisplayName,
	TODO_STRIKE_TOTAL_FRAMES,
	todoStrikeReveal,
} from "../../tools/todo";
import { theme } from "../theme/theme";

/** Stages listed after the active one when the board is collapsed. */
const SUBSEQUENT_PHASE_CAP = 4;
/** Open tasks previewed for the active stage when the board is collapsed. */
const ACTIVE_TASK_CAP = 5;
/** Recently finished tasks kept alongside them, so a stage that just closed work shows it. */
const DONE_TASK_CAP = 2;
/** Task rows are indented under their phase. Two cells: the rail is the block's only rule. */
const TASK_INDENT = 2;
/** Gap before a right-aligned tally or owner id. */
const RIGHT_GAP = 2;

/** The agent a delegated row belongs to. */
export interface TodoBoardOwner {
	/** Already formatted for display (`formatTaskId`). */
	id: string;
	/** That agent's stable session accent, so the row and its lane match. */
	accentHex: string;
}

export interface TodoBoardOptions {
	columns: number;
	/**
	 * Hard cap on drawn rows, header included. The board is an anchored region
	 * above the composer, so it cannot be allowed to grow without bound: the
	 * expanded board used to list every phase and every task, which on a long
	 * plan is a region taller than the viewport that does not scroll away.
	 */
	maxRows: number;
	expanded: boolean;
	/** Task content → the detached subagent working on it right now. */
	owners: ReadonlyMap<string, TodoBoardOwner>;
	/** Task content → frames since it closed, for tasks still inside the strike window. */
	striking: ReadonlyMap<string, number>;
	/** Wall step for the breathing glyph. */
	frame: number;
	/** `display.transitions`, read by the caller so this stays pure. */
	animate: boolean;
	/** Whether anything is in flight, which is what the rail's colour means. */
	live: boolean;
}

/** One row of the block, before the rail is attached. */
interface BoardRow {
	/** Cells of indent under the phase. */
	indent: number;
	glyph: string;
	text: string;
	/** Right-aligned tally or owner id, dropped before the row would overflow. */
	right?: string;
	/** Which phase this row belongs to, so a trim knows what to drop first. */
	phase: number;
}

function isClosed(task: TodoItem): boolean {
	return task.status === "completed" || task.status === "abandoned";
}

/**
 * The breathing pixel at `frame`, or the static half-square when motion is off.
 *
 * `formatStatusIcon` makes exactly this substitution for a running tool, so a
 * running task and a running tool are the same glyph on the same clock. With
 * `display.transitions` off, or on the ASCII preset, the static symbol is what
 * draws and the cell never churns.
 */
function breathGlyph(frame: number, animate: boolean): string {
	if (!animate) return theme.checkbox.progress;
	const frames = theme.spinnerFrames;
	if (frames.length === 0) return theme.checkbox.progress;
	return frames[((frame % frames.length) + frames.length) % frames.length]!;
}

/**
 * The density ramp exhaling, for a task inside its completion window.
 *
 * The ramp's first half is its rise, so walking it backwards is the fall, and the
 * row lands on `status.done` when the strike reaches the end of the text. A
 * preset whose frames are not a density ramp (`ascii`: `| / - \`) still gets a
 * bounded countdown that terminates on the same glyph, rather than a special
 * case that would only ever be read as a missing animation.
 */
function exhaleGlyph(frame: number, animate: boolean): string {
	if (!animate) return theme.symbol("status.done");
	const frames = theme.spinnerFrames;
	const half = Math.max(1, Math.floor(frames.length / 2));
	const progress = Math.min(1, Math.max(0, frame / TODO_STRIKE_TOTAL_FRAMES));
	const step = Math.min(half - 1, Math.floor(progress * half));
	return frames[half - 1 - step] ?? theme.symbol("status.done");
}

function paintHex(hex: string, text: string): string {
	const ansi = theme.fgHexAnsi(hex);
	return ansi ? `${ansi}${text}\x1b[39m` : text;
}

/**
 * One task row's glyph and painted text.
 *
 * Every state is separated by its GLYPH before it is separated by colour, so the
 * board still reads in a low-contrast theme and in any capture that dropped
 * every SGR. The one place two states share a glyph is a delegated row, which IS
 * an in-progress row — the only difference is who observed it — so it takes the
 * same shape in its owner's accent and names the owner outright.
 */
function taskRow(task: TodoItem, options: TodoBoardOptions, width: number): Omit<BoardRow, "phase"> {
	const content = boundedTodoPreviewText(task.content, width);
	const striking = options.striking.get(task.content);
	switch (task.status) {
		case "completed": {
			// Past the last frame of the envelope the row IS settled, and it must be
			// settled in the same BYTES: `blendHex` at t=1 and `theme.fg("dim", …)`
			// are the same colour spelled two ways, and the ramp's own last step is
			// its faintest cell rather than the done glyph. A caller that keeps
			// counting therefore has to fall through here, or the block repaints a
			// row that differs from its own static render forever.
			if (striking !== undefined && striking < TODO_STRIKE_TOTAL_FRAMES) {
				// Heat behind the sweep: the row lands on `success` and cools to the
				// colour it settles at, so a completion is visible for its envelope and
				// then stops asking for attention.
				const t = Math.min(1, striking / TODO_STRIKE_TOTAL_FRAMES);
				const hex = blendHex(theme.getColorHex("success"), theme.getColorHex("dim"), t);
				return {
					indent: TASK_INDENT,
					glyph: paintHex(hex, exhaleGlyph(striking, options.animate)),
					text: paintHex(hex, todoStrikeReveal(content, striking)),
				};
			}
			return {
				indent: TASK_INDENT,
				glyph: theme.fg("dim", theme.symbol("status.done")),
				text: theme.fg("dim", todoStrikeReveal(content, undefined)),
			};
		}
		case "abandoned":
			return {
				indent: TASK_INDENT,
				glyph: theme.fg("error", theme.symbol("status.aborted")),
				text: theme.fg("error", todoStrikeReveal(content, undefined)),
			};
		case "in_progress":
			return {
				indent: TASK_INDENT,
				glyph: theme.fg("accent", breathGlyph(options.frame, options.animate)),
				text: theme.fg("accent", content),
			};
		default: {
			const owner = options.owners.get(task.content);
			if (owner) {
				return {
					indent: TASK_INDENT,
					glyph: paintHex(owner.accentHex, breathGlyph(options.frame, options.animate)),
					text: paintHex(owner.accentHex, content),
					right: paintHex(owner.accentHex, owner.id),
				};
			}
			return {
				indent: TASK_INDENT,
				glyph: theme.fg("dim", theme.checkbox.unchecked),
				text: theme.fg("dim", content),
			};
		}
	}
}

/**
 * A phase's row. Its glyph is the same vocabulary its tasks use, so one glance
 * down the glyph column reads the shape of the whole plan rather than of one
 * stage: a closed phase is a tick of ink, the one being worked breathes, and a
 * phase nobody has reached is a hollow box.
 */
function phaseRow(
	phase: TodoPhase,
	oneBased: number,
	multiPhase: boolean,
	options: TodoBoardOptions,
	width: number,
): Omit<BoardRow, "phase"> {
	const done = phase.tasks.filter(task => task.status === "completed").length;
	const tally = `${done}/${phase.tasks.length}`;
	const open = phase.tasks.filter(task => !isClosed(task));
	const working = phase.tasks.some(task => task.status === "in_progress" || options.owners.has(task.content));
	const label = boundedTodoPreviewText(
		multiPhase ? formatPhaseDisplayName(phase.name, oneBased) : phase.name,
		Math.max(1, width - visibleWidth(tally) - RIGHT_GAP),
	);
	if (open.length === 0) {
		return {
			indent: 0,
			glyph: theme.fg("dim", theme.symbol("status.done")),
			text: theme.fg("dim", label),
			right: theme.fg("dim", tally),
		};
	}
	if (working) {
		return {
			indent: 0,
			glyph: theme.fg("accent", breathGlyph(options.frame, options.animate)),
			text: theme.bold(theme.fg("accent", label)),
			right: theme.fg("dim", tally),
		};
	}
	return {
		indent: 0,
		glyph: theme.fg("muted", theme.checkbox.unchecked),
		text: theme.fg("muted", label),
		right: theme.fg("dim", tally),
	};
}

/**
 * The tasks a collapsed phase previews: the open ones, plus the few most
 * recently closed. Showing only remaining work meant a stage that had just
 * closed three tasks looked exactly like one that had done nothing.
 */
function collapsedTasks(phase: TodoPhase): TodoItem[] {
	const closed = phase.tasks.filter(isClosed);
	const open = phase.tasks.filter(task => !isClosed(task));
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
export function todoBoardIsLive(phases: readonly TodoPhase[], owners: ReadonlyMap<string, unknown>): boolean {
	return phases.some(phase =>
		phase.tasks.some(
			task => task.status === "in_progress" || (task.status === "pending" && owners.has(task.content)),
		),
	);
}

/**
 * Build the anchored todo board.
 *
 * Returns an empty array when there is nothing to draw, so the container clears
 * itself. Whether a CLOSED plan is worth drawing is the caller's decision, not
 * this function's: a finished board is history and belongs in the transcript,
 * but it is drawn for the length of its exit animation, and a renderer that
 * refused a closed plan could not draw that exit.
 */
export function renderTodoBoardLines(phases: readonly TodoPhase[], options: TodoBoardOptions): string[] {
	const live = phases.filter(phase => phase.tasks.length > 0);
	if (live.length === 0) return [];

	const rail = theme.symbol("block.rail");
	// The last column is left clear: a row that fills it arms the terminal's
	// pending wrap, and a wrapped row in an anchored region does not scroll away,
	// it makes the region taller on every rebuild. Chrome is the Text's own left
	// padding, the rail, and the space after it.
	const usable = Math.max(1, options.columns - 1);
	const content = usable - 1 - visibleWidth(rail) - 1;
	if (content < 4) return [];

	const multiPhase = live.length > 1;
	const activeIdx = activeTodoPhaseIndex(live);

	// Every phase gets its row, including the ones already finished: a closed
	// phase costs exactly one row now, and its tally is the only thing on screen
	// that says the plan has come this far. The old board sliced them away and a
	// stage that had just closed three tasks looked exactly like one that had done
	// nothing. Tasks are drawn only for the phase being worked and the few after
	// it, so the body stays bounded by what is ahead rather than by what is done.
	const rows: BoardRow[] = [];
	for (let i = 0; i < live.length; i++) {
		const phase = live[i]!;
		rows.push({ ...phaseRow(phase, i + 1, multiPhase, options, content - 2), phase: i });
		if (phase.tasks.every(isClosed)) continue;
		if (!options.expanded && (i < activeIdx || i > activeIdx + SUBSEQUENT_PHASE_CAP)) continue;
		const tasks = options.expanded ? phase.tasks : collapsedTasks(phase);
		for (const task of tasks) {
			rows.push({ ...taskRow(task, options, content - TASK_INDENT - 2), phase: i });
		}
	}

	// Header included in the budget, and the overflow row too when there is one,
	// so `maxRows` is the height of the block and not the height of its body.
	//
	// What a trim drops is the whole question. Trimming the tail of the row list
	// spends the budget on whatever the plan happens to have finished and cuts the
	// work in flight, which on a ten-phase plan sitting in phase eight means a
	// board of nothing but closed tallies. Finished phases come off the TOP
	// instead, oldest first, and the active phase onward is what the budget is
	// there to protect; only when that alone overflows does the tail go, with the
	// overflow row saying how much.
	const budget = Math.max(1, options.maxRows - 1);
	const firstLive = rows.findIndex(row => row.phase >= activeIdx);
	const head = firstLive < 0 ? rows.length : firstLive;
	let shown = rows;
	let hidden = 0;
	if (rows.length > budget) {
		const dropFromTop = Math.min(head, rows.length - budget + 1);
		shown = rows.slice(dropFromTop);
		hidden = dropFromTop;
		if (shown.length > budget - 1) {
			hidden += shown.length - (budget - 1);
			shown = shown.slice(0, Math.max(0, budget - 1));
		}
	}
	const trimmed = hidden > 0;

	const railFor = (): string => theme.fg(options.live ? "accent" : "dim", rail);
	const draw = (row: BoardRow): string => {
		const indent = " ".repeat(row.indent);
		const left = `${indent}${row.glyph} ${row.text}`;
		if (!row.right) return `${railFor()} ${left}`.trimEnd();
		const room = content - visibleWidth(left) - RIGHT_GAP;
		if (room < visibleWidth(row.right)) return `${railFor()} ${left}`.trimEnd();
		const pad = " ".repeat(content - visibleWidth(left) - visibleWidth(row.right));
		return `${railFor()} ${left}${pad}${row.right}`.trimEnd();
	};

	const lines = [`${railFor()} ${theme.bold(theme.fg("accent", "Todos"))}`, ...shown.map(draw)];
	if (trimmed) {
		lines.push(`${railFor()} ${theme.fg("dim", boundedTodoPreviewText(`… ${hidden} more`, content))}`);
	}
	return ["", ...lines];
}
