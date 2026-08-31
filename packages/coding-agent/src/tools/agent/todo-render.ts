/**
 * Terminal drawing for the todo tool. The tool half in `todo.ts` decides what
 * happened; this half decides how a terminal shows it, and is the only one of the two
 * that reaches the TUI.
 */

import type { Component } from "@veyyon/tui";
import { Text } from "@veyyon/tui";
import { formatCount } from "@veyyon/utils";
import { isTodoListDone, TODO_DONE_SUMMARY } from "@veyyon/wire";
import chalk from "chalk";
import type { RenderResultOptions } from "../../extensibility/custom-tools/types";
import type { Theme } from "../../theme/theme";
import { framedBlock, renderStatusLine, renderTreeList } from "../../tui";
import { formatErrorDetail } from "../core/render-utils";
import {
	boundedTodoPreviewText,
	formatPhaseDisplayName,
	normalizeTodoArg,
	prioritizeTodoItems,
	strikethroughText,
	TODO_ITEM_PREVIEW_WIDTH,
	TODO_REMINDER_PREVIEW_LIMIT,
	TODO_TOTAL_PREVIEW_WIDTH,
	type TodoItem,
	type TodoRenderArgs,
	type TodoToolDetails,
	todoStrikeReveal,
} from "./todo";

const EMPTY_COMPLETION_KEYS = new Set<string>();
function formatTodoLine(
	item: TodoItem,
	uiTheme: Theme,
	prefix: string,
	completionKeys: Set<string>,
	frame: number | undefined,
): string {
	const safeContent = boundedTodoPreviewText(item.content, TODO_ITEM_PREVIEW_WIDTH);
	const checkbox = uiTheme.checkbox;
	switch (item.status) {
		case "completed": {
			const strikeFrame = completionKeys.has(item.content) ? frame : undefined;
			return uiTheme.fg("success", `${prefix}${checkbox.checked} ${todoStrikeReveal(safeContent, strikeFrame)}`);
		}
		case "in_progress":
			// Its own glyph, not the pending box in a different colour, and the
			// same one the HUD above the composer draws for this state.
			return uiTheme.fg("accent", `${prefix}${checkbox.progress} ${safeContent}`);
		case "abandoned":
			return uiTheme.fg("error", `${prefix}${checkbox.unchecked} ${strikethroughText(safeContent)}`);
		case "pending":
			return uiTheme.fg("dim", `${prefix}${checkbox.unchecked} ${safeContent}`);
		default:
			// A new status needs its own glyph and colour before the card can draw
			// it. Falling through to the pending box would paint closed work as
			// open, which is the collapse defect wearing a per-row disguise.
			item.status satisfies never;
			return uiTheme.fg("dim", `${prefix}${checkbox.unchecked} ${safeContent}`);
	}
}

export const todoToolRenderer = {
	renderCall(args: TodoRenderArgs, options: RenderResultOptions, uiTheme: Theme): Component {
		// `args` is the raw partially-parsed JSON from the streaming tool-call
		// delta and may not satisfy `TodoRenderArgs` at runtime:
		// `parseStreamingJson` can hand back `{ op: 1 }` mid-delta, or a legacy
		// `{ ops: "[" }` shape before fields stream. `normalizeTodoArg` guards
		// both the new single-op and legacy batch shapes so a malformed delta
		// never breaks the TUI render loop (#2005).
		const opsList = normalizeTodoArg(args);
		const visibleOps = opsList.slice(0, TODO_REMINDER_PREVIEW_LIMIT);
		const ops =
			visibleOps.length === 0
				? ["update"]
				: visibleOps.map(e => {
						const parts = [boundedTodoPreviewText(e.op ?? "update", 32)];
						if (e.task) parts.push(boundedTodoPreviewText(e.task, TODO_ITEM_PREVIEW_WIDTH));
						if (e.phase) parts.push(boundedTodoPreviewText(e.phase, TODO_ITEM_PREVIEW_WIDTH));
						if (Array.isArray(e.items) && e.items.length) {
							parts.push(`${formatCount("item", e.items.length)}`);
						}
						return parts.join(" ");
					});
		if (opsList.length > visibleOps.length)
			ops.push(`… ${formatCount("operation", opsList.length - visibleOps.length)} more`);
		// No body worth boxing while the call streams — a lone status line reads
		// cleaner than an empty frame. The container renders it without chrome.
		const header = renderStatusLine(
			{ icon: "pending", spinnerFrame: options?.spinnerFrame, title: "Todo", meta: ops },
			uiTheme,
		);
		return new Text(header, 0, 0);
	},

	renderResult(
		result: { content: Array<{ type: string; text?: string }>; details?: TodoToolDetails; isError?: boolean },
		options: RenderResultOptions,
		uiTheme: Theme,
		_args?: TodoRenderArgs,
	): Component {
		if (result.isError) {
			const errorText = result.content?.find(content => content.type === "text")?.text ?? "Todo operation failed";
			const header = renderStatusLine({ icon: "error", title: "Todo" }, uiTheme);
			return framedBlock(uiTheme, width => ({
				header,
				sections: [{ lines: formatErrorDetail(errorText, uiTheme).split("\n") }],
				state: "error",
				borderColor: "error",
				width,
			}));
		}

		const phases = (result.details?.phases ?? []).filter(phase => phase.tasks.length > 0);
		// A board with work on it and nothing left open is one green line: the
		// card is history the moment it is finished, and a finished plan redrawn
		// in full on every later turn is the bulk of a long transcript.
		//
		// Derived here, on the phases this render was handed, and stored nowhere.
		// The collapse is not a mode the widget can be left in — the next `append`
		// puts a pending task on the board and the full list comes straight back.
		if (isTodoListDone(phases)) {
			const doneTasks = phases.reduce((count, phase) => count + phase.tasks.length, 0);
			const summary = `${uiTheme.checkbox.checked} ${TODO_DONE_SUMMARY} · ${formatCount("task", doneTasks)}`;
			return new Text(uiTheme.fg("success", summary), 0, 0);
		}
		const completedTasks = result.details?.completedTasks ?? [];
		const completionKeysByPhase = new Map<string, Set<string>>();
		for (const task of completedTasks) {
			let keys = completionKeysByPhase.get(task.phase);
			if (!keys) {
				keys = new Set<string>();
				completionKeysByPhase.set(task.phase, keys);
			}
			keys.add(task.content);
		}
		const allTasks = phases.flatMap(phase => phase.tasks);
		const header = renderStatusLine(
			{
				iconOverride: uiTheme.styledSymbol("tool.todo", "accent"),
				title: "Todo",
				meta: [formatCount("task", allTasks.length)],
			},
			uiTheme,
		);
		if (allTasks.length === 0) {
			const fallback = boundedTodoPreviewText(
				result.content?.find(content => content.type === "text")?.text ?? "No todos",
				TODO_TOTAL_PREVIEW_WIDTH,
			);
			return new Text(`${header}\n  ${uiTheme.fg("dim", fallback)}`, 0, 0);
		}

		// An OPEN plan is drawn by the anchored board above the composer, which is
		// the live surface: it is rebuilt on every change, it carries the phase
		// tallies, and it is on screen for as long as the plan is. A card that
		// also drew every phase and every task put the same list on the screen
		// twice, one copy of it anchored, in the same glyphs, four rows apart.
		//
		// The card is the record of ONE write, so unexpanded it states what that
		// write did: the totals, the phase in play, and the task that moved.
		// Expanded (the block's own toggle) it is the full list, which is what a
		// reader scrolling back through history wants — by then the board is gone.
		if (!options.expanded) {
			const active = allTasks.find(task => task.status === "in_progress");
			const moved = active ?? completedTasks[completedTasks.length - 1];
			const phaseOf = phases.find(phase => phase.tasks.some(task => task.content === moved?.content));
			const parts = [
				uiTheme.fg("dim", formatCount("done", allTasks.filter(task => task.status === "completed").length)),
			];
			if (phaseOf && phases.length > 1) {
				parts.push(uiTheme.fg("muted", boundedTodoPreviewText(phaseOf.name, TODO_ITEM_PREVIEW_WIDTH)));
			}
			if (moved) {
				const mark = active ? uiTheme.checkbox.progress : uiTheme.checkbox.checked;
				const color = active ? "accent" : "success";
				parts.push(uiTheme.fg(color, `${mark} ${boundedTodoPreviewText(moved.content, TODO_ITEM_PREVIEW_WIDTH)}`));
			}
			return new Text(`${header} ${uiTheme.fg("dim", "·")} ${parts.join(uiTheme.fg("dim", " · "))}`, 0, 0);
		}

		return framedBlock(uiTheme, width => {
			const { expanded, spinnerFrame } = options;
			const multiPhase = phases.length > 1;
			let bodyLines: string[];
			if (!expanded && multiPhase) {
				const collapsed = prioritizeTodoItems(
					phases.flatMap(phase => phase.tasks.map(task => ({ ...task, phase: phase.name }))),
				);
				bodyLines = renderTreeList(
					{
						items: collapsed,
						expanded: false,
						maxCollapsed: TODO_REMINDER_PREVIEW_LIMIT,
						itemType: "todo",
						truncateFrom: "end",
						renderItem: todo => {
							const completionKeys = completionKeysByPhase.get(todo.phase) ?? EMPTY_COMPLETION_KEYS;
							const line = formatTodoLine(todo, uiTheme, "", completionKeys, spinnerFrame);
							const phase = boundedTodoPreviewText(todo.phase, TODO_ITEM_PREVIEW_WIDTH);
							return `${line} ${uiTheme.fg("dim", `(${phase})`)}`;
						},
					},
					uiTheme,
				);
			} else {
				bodyLines = [];
				for (let p = 0; p < phases.length; p++) {
					const phase = phases[p];
					if (multiPhase) {
						const name = boundedTodoPreviewText(phase.name, TODO_ITEM_PREVIEW_WIDTH);
						bodyLines.push(uiTheme.fg("accent", chalk.bold(formatPhaseDisplayName(name, p + 1))));
					}
					const completionKeys = completionKeysByPhase.get(phase.name) ?? EMPTY_COMPLETION_KEYS;
					const treeLines = renderTreeList(
						{
							items: expanded ? phase.tasks : prioritizeTodoItems(phase.tasks),
							expanded,
							maxCollapsed: TODO_REMINDER_PREVIEW_LIMIT,
							itemType: "todo",
							truncateFrom: "end",
							renderItem: todo => formatTodoLine(todo, uiTheme, "", completionKeys, spinnerFrame),
						},
						uiTheme,
					);
					bodyLines.push(...treeLines);
				}
			}
			return {
				header,
				sections: bodyLines.length > 0 ? [{ lines: bodyLines }] : [],
				state: options.isPartial ? "pending" : "success",
				borderColor: "borderMuted",
				applyBg: false,
				width,
			};
		});
	},
	mergeCallAndResult: true,
};
