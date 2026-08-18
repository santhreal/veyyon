/**
 * The todo board as a session commits it, at one width, in both chromes.
 *
 * A board is the object a long session redraws most often after a tool block, and
 * it is the one the agent looks at to decide what to do next. So the questions a
 * demo has to answer are: where does the eye land, how much of the block is closed
 * work, and what does a multi-phase plan cost in rows.
 *
 * Both arms drive the REAL `todoToolRenderer.renderResult` with the same board, so
 * the pair differs in the chrome and in nothing else.
 *
 * Run:
 *
 *     bun scripts/demos/render-todo-board.ts --width 100 --ground '#1e2127' |
 *       bun scripts/demos/render-proof.ts --out /tmp/todo --width 100
 *
 * `--expanded` renders the expanded form (ctrl+o) instead of the collapsed one.
 * `--single` renders a one-phase board; the default shows a phased plan.
 * `--theme <name>` renders another theme; the default is titanium.
 */
import type { RenderResultOptions } from "../../packages/coding-agent/src/extensibility/custom-tools/types";
import { theme } from "../../packages/coding-agent/src/modes/theme/theme";
import type { TodoPhase, TodoToolDetails } from "../../packages/coding-agent/src/tools/todo";
import { todoToolRenderer } from "../../packages/coding-agent/src/tools/todo";
import { flag, hasFlag, initRender, renderWidth } from "./render-args";

const themeName = flag("theme", "titanium");
const width = renderWidth();
await initRender(themeName, { settings: true });

/** A plan mid-flight: closed work behind, one task running, the rest waiting. */
const PHASED: TodoPhase[] = [
	{
		name: "Foundation",
		tasks: [
			{ content: "Scaffold the crate and wire the workspace", status: "completed" },
			{ content: "Port the credential store", status: "completed" },
			{ content: "Move the settings domain onto the new reader", status: "completed" },
		],
	},
	{
		name: "Auth",
		tasks: [
			{ content: "Wire the OAuth providers", status: "completed" },
			{ content: "Refresh a stored token before it expires", status: "in_progress" },
			{ content: "Reject a credential whose scope no longer resolves", status: "pending" },
			{ content: "Fail closed when the vault is locked", status: "pending" },
		],
	},
	{
		name: "Verification",
		tasks: [
			{ content: "Mutation-gate the refresh path", status: "pending" },
			{ content: "Run the focused auth suites", status: "pending" },
		],
	},
];

const SINGLE: TodoPhase[] = [
	{
		name: "default",
		tasks: [
			{ content: "Reproduce the runaway with one delta per repeat", status: "completed" },
			{ content: "Raise the two thresholds together", status: "in_progress" },
			{ content: "Mutation-gate each constant independently", status: "pending" },
			{ content: "Add the changelog bullet", status: "pending" },
		],
	},
];

const phases = hasFlag("single") ? SINGLE : PHASED;
const details: TodoToolDetails = {
	op: "done",
	phases,
	storage: "session",
	// The task that just closed: this is what drives the strike-through reveal, so a
	// demo without it renders a frame no live board ever shows.
	completedTasks: [{ phase: "Auth", content: "Wire the OAuth providers" }],
};

// The settled board is `spinnerFrame` absent. `--frame N` renders one frame of the
// entrance instead, which is the only way to look at a single step of it: the live
// envelope is 14 frames at 65 ms and a still capture cannot catch a chosen one.
const frame = flag("frame", "");
const options: RenderResultOptions = {
	expanded: hasFlag("expanded"),
	isPartial: false,
	spinnerFrame: frame === "" ? undefined : Number(frame),
};

const component = todoToolRenderer.renderResult(
	{ content: [{ type: "text", text: "Todo updated" }], details },
	options,
	theme,
);

process.stdout.write(`${component.render(width).join("\n")}\n`);
