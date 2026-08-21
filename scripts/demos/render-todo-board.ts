/**
 * Render the anchored Todos block the way interactive mode draws it, so the
 * board's rail, its glyph ramp and its completion sweep can be LOOKED AT while
 * they are being built.
 *
 * This is a debugging aid and not a proof: it draws a fixture written here, at a
 * width chosen here, through a call constructed here, so it cannot show that the
 * block is reachable, that the state is real, or that a session positions and
 * clips it this way. The proof is a capture taken the way
 * docs/handbook/src/foundations/verification.md says. Output goes to a temporary
 * path and never into assets/, a README, or a handbook page.
 *
 *     bun scripts/demos/render-todo-board.ts --width 100 |
 *       bun scripts/demos/render-proof.ts --out /tmp/todo --width 100 --scale 3
 *
 * `--frame N` renders one frame of the animation, so a sequence of proofs is a
 * sequence of frames: the rail sweep, the breathing glyph on the task in flight,
 * and the strike travelling across a task that just closed all count in the same
 * frames the product counts in. `--settle N` renders frame N of the exit pass a
 * closed plan goes out through. `--waiting` drops the in-flight task so the board
 * is open but idle, which is the state whose rail does not move. `--before`
 * reproduces the tree this replaced. Flags take the space form.
 */

import { visibleWidth } from "@veyyon/tui";
import chalk from "chalk";
import { renderTodoBoardLines, type TodoBoardOwner } from "../../packages/coding-agent/src/modes/components/todo-board";
import { theme } from "../../packages/coding-agent/src/modes/theme/theme";
import type { TodoItem, TodoPhase } from "../../packages/coding-agent/src/tools/todo";
import { boundedTodoPreviewText, formatPhaseDisplayName } from "../../packages/coding-agent/src/tools/todo";
import { paintRailMotion, railIdleHeadAt } from "../../packages/coding-agent/src/tui/rail-motion";
import { renderTreeList } from "../../packages/coding-agent/src/tui/tree-list";
import { flag, hasFlag, initRender, renderWidth } from "./render-args";

const columns = renderWidth();
const before = hasFlag("before");
const waiting = hasFlag("waiting");
const frame = Number.parseInt(flag("frame", "0"), 10);
const settleFrame = hasFlag("settle") ? Number.parseInt(flag("settle", "0"), 10) : undefined;
const striking = hasFlag("striking");

/** The agent whose lane sits under this board, so the two proofs share an id. */
const OWNER: TodoBoardOwner = { id: "SecretModularityAudit", accentHex: "#f0863a" };
/** The pending task that agent picked up. */
const DELEGATED = "Audit the secrets subsystem for dead exports";
/** The task the driving agent is on, and the one whose completion the sweep proves. */
const IN_FLIGHT = "Refresh a stored token before it expires";

/**
 * A plan mid-flight: one phase closed, the active phase carrying a completed
 * task, the task the agent itself is on, and two pending — one of which a
 * detached subagent picked up.
 */
function phases(): TodoPhase[] {
	const active: TodoItem[] = [
		{ content: "Move the settings domain onto the new reader", status: "completed" },
		{ content: IN_FLIGHT, status: striking ? "completed" : waiting ? "pending" : "in_progress" },
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

/**
 * The shape this replaced: `renderTreeList` connectors, `■ □ ◧` with completed
 * work in full-brightness success green, and a matched pending task in ember.
 * Reproduced here rather than kept alive in the product, so the before half of a
 * proof pair stays available without the dead renderer staying in the shipped
 * tree.
 */
function treeLines(): string[] {
	const usable = Math.max(24, columns - 1);
	const contentWidth = Math.max(16, usable - 8 - visibleWidth(theme.checkbox.checked) - 1);
	const checkbox = theme.checkbox;
	// These four branches are `#formatTodoLine` as it shipped, byte for byte: a
	// delegated row took `accent` and the UNCHECKED box, which is exactly the
	// complaint — `accent` is what an in-progress row already draws, so the one
	// row on the board that somebody else was working on was either identical to
	// the row above it or one shade off dim. A "before" that flattered the old
	// render with its own colour would make the pair prove less than it does.
	const row = (todo: TodoItem): string => {
		const content = boundedTodoPreviewText(todo.content, contentWidth);
		if (todo.status === "completed") {
			return theme.fg("success", `${checkbox.checked} ${chalk.strikethrough(content)}`);
		}
		if (todo.status === "in_progress") return theme.fg("accent", `${checkbox.progress} ${content}`);
		if (todo.status === "abandoned") {
			return theme.fg("error", `${checkbox.unchecked} ${chalk.strikethrough(content)}`);
		}
		if (todo.content === DELEGATED) return theme.fg("accent", `${checkbox.unchecked} ${content}`);
		return theme.fg("dim", `${checkbox.unchecked} ${content}`);
	};
	const all = phases();
	const tree = renderTreeList(
		{
			items: all,
			expanded: true,
			renderItem: (phase, ctx) => {
				const done = phase.tasks.filter(task => task.status === "completed").length;
				const progress = theme.fg("dim", ` · ${done}/${phase.tasks.length}`);
				const label = formatPhaseDisplayName(phase.name, ctx.index + 1);
				const header =
					ctx.index === 1 ? theme.bold(theme.fg("accent", label)) + progress : theme.fg("muted", label) + progress;
				return [header, ...renderTreeList({ items: phase.tasks, expanded: true, renderItem: row }, theme)];
			},
		},
		theme,
	);
	const root = theme.bold(theme.fg("accent", "Todos")) + theme.fg("dim", " · phase 2/3");
	return ["", root, ...tree.map(line => ` ${line}`)];
}

await initRender(flag("theme", "titanium"));

if (before) {
	process.stdout.write(`${treeLines().join("\n")}\n`);
} else {
	const board = phases();
	const owners = new Map<string, TodoBoardOwner>([[DELEGATED, OWNER]]);
	const lines = renderTodoBoardLines(board, {
		columns,
		maxRows: 12,
		expanded: false,
		owners,
		striking: striking ? new Map([[IN_FLIGHT, frame]]) : new Map(),
		frame,
		animate: true,
		live: !waiting,
	});
	// The same painting interactive mode does, from the same owner: a settle pass
	// while a closed plan goes out, the idle sweep while the board is being
	// worked, and nothing at all while it waits on the operator.
	const painted = settleFrame
		? paintRailMotion(lines, { kind: "settle", frame: settleFrame }, theme)
		: waiting
			? lines
			: paintRailMotion(lines, { kind: "idle", head: railIdleHeadAt(frame) }, theme);
	process.stdout.write(`${painted.join("\n")}\n`);
}
