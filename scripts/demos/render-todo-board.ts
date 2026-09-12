/**
 * Render structured todo phase boards with status indicators and rail animations.
 *
 * Constructs multi-phase todo lists containing completed, in-progress, pending, and
 * delegated items. Renders the todo board lines with options for expanded view, waiting
 * status, idle frame animation, and settle rail motion, printing the result as ANSI text.
 *
 * Usage:
 *   bun scripts/demos/render-todo-board.ts [--waiting] [--expanded] [--frame <n>] [--settle <n>] [--width 100] [--theme titanium]
 */

import { renderTodoBoardLines } from "../../packages/coding-agent/src/modes/terminal/components/dashboard/todo-board";
import { paintRailMotion, railIdleHeadAt } from "../../packages/coding-agent/src/modes/terminal/draw/rail-motion";
import { theme } from "../../packages/coding-agent/src/theme/theme";
import type { TodoItem, TodoPhase } from "../../packages/coding-agent/src/tools/agent/todo";
import { renderDemo } from "./render-args";

const DELEGATED = "Audit the secrets subsystem for dead exports";
const IN_FLIGHT = "Refresh a stored token before it expires";

/**
 * A plan mid-flight: one phase closed, the active phase carrying a completed
 * task, the task the agent itself is on, and two pending — one of which a
 * detached agent picked up.
 */
function phases(waiting: boolean): TodoPhase[] {
	const active: TodoItem[] = [
		{ content: "Move the settings domain onto the new reader", status: "completed" },
		{ content: IN_FLIGHT, status: waiting ? "pending" : "in_progress" },
		{ content: DELEGATED, status: "pending" },
		{ content: "Fail closed when the vault is locked", status: "pending" },
	];
	return [
		{
			name: "Foundation",
			tasks: [
				{ content: "Scaffold the crate and wire the workspace", status: "completed" },
				{ content: "Port the credential store", status: "completed" },
			],
		},
		{ name: "Auth", tasks: active },
		{
			name: "Verification",
			tasks: [
				{ content: "Mutation-gate the refresh path", status: "pending" },
				{ content: "Run the focused auth suites", status: "pending" },
			],
		},
	];
}

await renderDemo(({ width, flag, hasFlag }) => {
	const waiting = hasFlag("waiting");
	const expanded = hasFlag("expanded");
	const frame = Number.parseInt(flag("frame", "0"), 10);
	const settleFrame = hasFlag("settle") ? Number.parseInt(flag("settle", "0"), 10) : undefined;

	const lines = renderTodoBoardLines(phases(waiting), {
		columns: width,
		maxRows: 12,
		expanded,
		owned: new Set([DELEGATED]),
		frame,
		animate: !waiting,
		live: !waiting,
	});

	return settleFrame
		? paintRailMotion(lines, { kind: "settle", frame: settleFrame }, theme)
		: waiting
			? lines
			: paintRailMotion(lines, { kind: "idle", head: railIdleHeadAt(frame) }, theme);
});
