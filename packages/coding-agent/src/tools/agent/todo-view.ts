/**
 * What the todo tool shows, for any host.
 *
 * The tool half in `todo.ts` decides what happened and this half decides what a card says about it,
 * in tones, glyph keys and lists rather than in colours, symbols and tree connectors. The strike
 * that sweeps across a task as it closes is stated the same way: `todoStrikeSplit` says how far the
 * sweep has reached at the frame the surface is on, and the card marks that run struck.
 */

import { formatCount } from "@veyyon/utils";
import type {
	FramedBlockView,
	StatusRowView,
	TextBlockView,
	ToolView,
	ToolViewContext,
	ToolViewRenderer,
	ViewLine,
	ViewSection,
	ViewSpan,
	ViewTone,
} from "@veyyon/view";
import { isTodoListDone, TODO_DONE_SUMMARY } from "@veyyon/wire";
import { sanitizeErrorText } from "../core/render-utils";
import {
	boundedTodoPreviewText,
	formatPhaseDisplayName,
	normalizeTodoArg,
	TODO_ITEM_PREVIEW_WIDTH,
	TODO_REMINDER_PREVIEW_LIMIT,
	TODO_TOTAL_PREVIEW_WIDTH,
	type TodoItem,
	type TodoPhase,
	type TodoRenderArgs,
	type TodoToolDetails,
	todoStrikeSplit,
} from "./todo";

/** The emblem a settled todo card is titled by, instead of an outcome icon. */
const TODO_EMBLEM = "tool.todo";

/**
 * The mark a task state is drawn with and the tone it means, as a switch rather than a table.
 *
 * A board can carry a status this build has no case for -- a newer writer's, or a key off
 * `Object.prototype` that a record lookup answers with a function -- so the state is matched, never
 * indexed, and anything unmatched is drawn as an open task. A row with no tone reaches the host as
 * a colour it cannot resolve, and a row marked closed paints open work as finished.
 */
function taskMark(status: TodoItem["status"]): { symbol: string; tone: ViewTone } {
	switch (status) {
		case "completed":
			return { symbol: "checkbox.checked", tone: "success" };
		case "in_progress":
			return { symbol: "checkbox.progress", tone: "accent" };
		case "abandoned":
			return { symbol: "checkbox.unchecked", tone: "error" };
		case "pending":
			return { symbol: "checkbox.unchecked", tone: "dim" };
		default:
			status satisfies never;
			return { symbol: "checkbox.unchecked", tone: "dim" };
	}
}

/** The half of a tool result a todo card reads. */
export interface TodoViewResult {
	content?: Array<{ type: string; text?: string }>;
	details?: TodoToolDetails;
	isError?: boolean;
}

/**
 * One task as the line a host draws for it: the state's mark, then the task's own words.
 *
 * A closed task the surface is animating carries the sweep as two runs — the part the strike has
 * covered and the part it has not — so the host draws one struck run and one plain one and never
 * has to know how far along the sweep is. A task closed before this card was drawn has no frame and
 * is struck end to end.
 */
function taskLine(item: TodoItem, closing: boolean, frame: number | undefined): ViewLine {
	const { symbol, tone } = taskMark(item.status);
	const text = boundedTodoPreviewText(item.content, TODO_ITEM_PREVIEW_WIDTH);
	const mark: ViewSpan = { text: "", symbol, tone };
	const gap: ViewSpan = { text: " " };
	if (item.status === "completed") {
		const { struck, plain } = todoStrikeSplit(text, closing ? frame : undefined);
		const runs: ViewSpan[] = [];
		if (struck.length > 0) runs.push({ text: struck, tone, strike: true });
		if (plain.length > 0) runs.push({ text: plain, tone });
		return [mark, gap, ...runs];
	}
	if (item.status === "abandoned") return [mark, gap, { text, tone, strike: true }];
	return [mark, gap, { text, tone }];
}

/** The tasks whose closure this write is what animates: the ones the result reports as just moved. */
function closedByThisWrite(details: TodoToolDetails | undefined): Map<string, Set<string>> {
	const byPhase = new Map<string, Set<string>>();
	for (const task of details?.completedTasks ?? []) {
		let contents = byPhase.get(task.phase);
		if (!contents) {
			contents = new Set<string>();
			byPhase.set(task.phase, contents);
		}
		contents.add(task.content);
	}
	return byPhase;
}

/** The row a call shows while the write is still arriving: the operations it carries, in order. */
function callRow(args: TodoRenderArgs): StatusRowView {
	// `args` is the raw partially-parsed JSON from the streaming tool-call delta and may not satisfy
	// `TodoRenderArgs` at runtime: `parseStreamingJson` can hand back `{ op: 1 }` mid-delta, or a
	// legacy `{ ops: "[" }` shape before fields stream. `normalizeTodoArg` guards both the new
	// single-op and legacy batch shapes so a malformed delta never breaks a render (#2005).
	const opsList = normalizeTodoArg(args);
	const visible = opsList.slice(0, TODO_REMINDER_PREVIEW_LIMIT);
	const meta =
		visible.length === 0
			? ["update"]
			: visible.map(entry => {
					const parts = [boundedTodoPreviewText(entry.op ?? "update", 32)];
					if (entry.task) parts.push(boundedTodoPreviewText(entry.task, TODO_ITEM_PREVIEW_WIDTH));
					if (entry.phase) parts.push(boundedTodoPreviewText(entry.phase, TODO_ITEM_PREVIEW_WIDTH));
					if (Array.isArray(entry.items) && entry.items.length)
						parts.push(formatCount("item", entry.items.length));
					return parts.join(" ");
				});
	if (opsList.length > visible.length) {
		meta.push(`… ${formatCount("operation", opsList.length - visible.length)} more`);
	}
	return { kind: "statusRow", status: "pending", title: "Todo", meta: meta.map(text => [{ text }]) };
}

/** The row a settled card is titled by: the tool's own emblem and how many tasks the board holds. */
function settledRow(taskCount: number): StatusRowView {
	return {
		kind: "statusRow",
		emblem: TODO_EMBLEM,
		title: "Todo",
		meta: [[{ text: formatCount("task", taskCount) }]],
	};
}

/**
 * The one row a collapsed card shows, which is what THIS write did.
 *
 * An open plan is on screen already, drawn by the anchored board above the composer, so a card that
 * redrew every phase and every task would put the same list on the screen twice. Collapsed, the card
 * is the record of one write: how much is done, which phase it landed in, and the task that moved.
 */
function collapsedRow(
	phases: readonly TodoPhase[],
	details: TodoToolDetails | undefined,
	frame: number | undefined,
): StatusRowView {
	const tasks = phases.flatMap(phase => phase.tasks);
	const completed = details?.completedTasks ?? [];
	const active = tasks.find(task => task.status === "in_progress");
	const moved = active ?? completed[completed.length - 1];
	const phaseOf = phases.find(phase => phase.tasks.some(task => task.content === moved?.content));
	const meta: ViewLine[] = [
		[{ text: formatCount("task", tasks.length) }],
		[{ text: formatCount("done", tasks.filter(task => task.status === "completed").length), tone: "dim" }],
	];
	if (phaseOf && phases.length > 1) {
		meta.push([{ text: boundedTodoPreviewText(phaseOf.name, TODO_ITEM_PREVIEW_WIDTH), tone: "muted" }]);
	}
	if (moved) {
		const status: TodoItem["status"] = active ? "in_progress" : "completed";
		const closing =
			!active &&
			closedByThisWrite(details)
				.get(phaseOf?.name ?? "")
				?.has(moved.content) === true;
		meta.push(taskLine({ content: moved.content, status }, closing, frame));
	}
	return { kind: "statusRow", emblem: TODO_EMBLEM, title: "Todo", meta };
}

/** The sections an opened card shows: every phase, named when there is more than one, then its tasks. */
function boardSections(
	phases: readonly TodoPhase[],
	details: TodoToolDetails | undefined,
	frame: number | undefined,
): ViewSection[] {
	const closed = closedByThisWrite(details);
	const named = phases.length > 1;
	const sections: ViewSection[] = [];
	for (let index = 0; index < phases.length; index++) {
		const phase = phases[index]!;
		if (named) {
			const name = boundedTodoPreviewText(phase.name, TODO_ITEM_PREVIEW_WIDTH);
			sections.push({ lines: [[{ text: formatPhaseDisplayName(name, index + 1), tone: "accent", bold: true }]] });
		}
		const closing = closed.get(phase.name);
		sections.push({
			list: true,
			lines: phase.tasks.map(task => taskLine(task, closing?.has(task.content) === true, frame)),
		});
	}
	return sections;
}

/** The card a failed write shows, which is the failure the tool reported and nothing else. */
function failureCard(result: TodoViewResult): FramedBlockView {
	const text = result.content?.find(part => part.type === "text")?.text ?? "Todo operation failed";
	return {
		kind: "framedBlock",
		header: { kind: "statusRow", status: "error", title: "Todo" },
		state: "error",
		sections: [{ lines: [[{ text: "  " }, { text: sanitizeErrorText(text), tone: "error" }]] }],
	};
}

/**
 * The one green line a finished board collapses to.
 *
 * Derived from the phases this render was handed and stored nowhere: the next `append` puts a
 * pending task on the board and the full card comes straight back.
 */
function doneLine(phases: readonly TodoPhase[]): TextBlockView {
	const tasks = phases.reduce((count, phase) => count + phase.tasks.length, 0);
	return {
		kind: "textBlock",
		spans: [
			{ text: "", symbol: taskMark("completed").symbol, tone: "success" },
			{ text: ` ${TODO_DONE_SUMMARY} · ${formatCount("task", tasks)}`, tone: "success" },
		],
	};
}

export const todoToolView: Required<ToolViewRenderer<TodoRenderArgs, TodoViewResult>> = {
	renderCall(args: TodoRenderArgs): ToolView {
		return callRow(args);
	},

	renderResult(result: TodoViewResult, context: ToolViewContext): ToolView {
		if (result.isError) return failureCard(result);

		const phases = (result.details?.phases ?? []).filter(phase => phase.tasks.length > 0);
		if (isTodoListDone(phases)) return doneLine(phases);

		const tasks = phases.flatMap(phase => phase.tasks);
		if (tasks.length === 0) {
			const text = result.content?.find(part => part.type === "text")?.text ?? "No todos";
			return {
				kind: "headedBlock",
				header: settledRow(0),
				lines: [[{ text: boundedTodoPreviewText(text, TODO_TOTAL_PREVIEW_WIDTH), tone: "dim" }]],
			};
		}

		if (!context.expanded) return collapsedRow(phases, result.details, context.frame);

		return {
			kind: "framedBlock",
			header: settledRow(tasks.length),
			state: context.partial ? "pending" : "success",
			// The board is a record the tool keeps; the write's outcome is not a verdict on it.
			contents: "listing",
			sections: boardSections(phases, result.details, context.frame),
		};
	},
};
