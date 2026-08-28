/**
 * Render the anchored Todos block the way interactive mode draws it, so the
 * board's rail and the mark on the task in flight can be LOOKED AT while they
 * are being built.
 *
 * This is a debugging aid and not a proof: it draws a fixture written here, at a
 * width chosen here, through a call constructed here, so it cannot show that the
 * block is reachable, that the state is real, or that a session positions and
 * clips it this way. The proof is a capture taken the way
 * docs/handbook/src/foundations/verification.md says. Output goes to a temporary
 * path and never into assets/, a README, or a handbook page.
 *
 * Run:
 *
 *     bun scripts/demos/render-todo-board.ts --width 100 |
 *       bun scripts/demos/render-proof.ts --out /tmp/todo --width 100 --scale 3
 *
 * `--frame N` renders one frame, so a sequence of proofs is a sequence of frames:
 * the rail sweep and the mark on the task in flight both count in the frames the
 * product counts in. `--settle N` renders frame N of the exit pass a closed plan
 * goes out through. `--waiting` drops the in-flight task so the board is open but
 * idle, which is the state whose rail does not move and whose mark is still.
 * `--expanded` lists every phase with its tasks. Flags take the space form.
 */

import { renderTodoBoardLines } from "../../packages/coding-agent/src/modes/terminal/components/dashboard/todo-board";
import { theme } from "../../packages/coding-agent/src/theme/theme";
import type { TodoItem, TodoPhase } from "../../packages/coding-agent/src/tools/todo";
import { paintRailMotion, railIdleHeadAt } from "../../packages/coding-agent/src/tui/rail-motion";
import { flag, hasFlag, initRender, renderWidth } from "./render-args";

const columns = renderWidth();
const waiting = hasFlag("waiting");
const expanded = hasFlag("expanded");
const frame = Number.parseInt(flag("frame", "0"), 10);
const settleFrame = hasFlag("settle") ? Number.parseInt(flag("settle", "0"), 10) : undefined;

/** The pending task a detached subagent picked up. */
const DELEGATED = "Audit the secrets subsystem for dead exports";
/** The task the driving agent is on. */
const IN_FLIGHT = "Refresh a stored token before it expires";

/**
 * A plan mid-flight: one phase closed, the active phase carrying a completed
 * task, the task the agent itself is on, and two pending — one of which a
 * detached subagent picked up.
 */
function phases(): TodoPhase[] {
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

await initRender(flag("theme", "titanium"));

const lines = renderTodoBoardLines(phases(), {
	columns,
	maxRows: 12,
	expanded,
	owned: new Set([DELEGATED]),
	frame,
	animate: !waiting,
	live: !waiting,
});
// The same painting interactive mode does, from the same owner: an exit pass
// while a closed plan goes out, the idle sweep while the board is being worked,
// and nothing at all while the agent is not working.
const painted = settleFrame
	? paintRailMotion(lines, { kind: "settle", frame: settleFrame }, theme)
	: waiting
		? lines
		: paintRailMotion(lines, { kind: "idle", head: railIdleHeadAt(frame) }, theme);
process.stdout.write(`${painted.join("\n")}\n`);
