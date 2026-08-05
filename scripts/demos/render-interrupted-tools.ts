/**
 * Print the three states a tool block can be in around an interrupt, stacked at one width.
 *
 * The question this answers is the only one that matters when an operator hits Esc on a
 * run that is going wrong: which of these calls actually touched the machine. A tool that
 * finished says so. A tool that was still running when the abort landed gets `seal()`ed by
 * `EventController` and never receives a result, so it freezes in whatever shape it had.
 * Rendering the sealed block beside the running one and the completed one is what shows
 * whether the freeze reads as "did not run" or merely as "stopped moving".
 *
 * Run:
 *     bun scripts/demos/render-interrupted-tools.ts --width 80 |
 *       bun scripts/demos/render-proof.ts --out /tmp/interrupt --width 80
 */
import { ToolExecutionComponent } from "../../packages/coding-agent/src/modes/components/tool-execution";
import { theme } from "../../packages/coding-agent/src/modes/theme/theme";
import type { TUI } from "../../packages/tui/src/tui";
import { flag, initRender, renderWidth } from "./render-args";

const themeName = flag("theme", "titanium");
const width = renderWidth();
await initRender(themeName, { settings: true });

// A TUI stub: these blocks only ever ask it to schedule a repaint, and there is no
// frame loop here. Keeping it inert makes the render a pure function of block state.
const ui = { requestRender: () => {}, requestComponentRender: () => {} } as unknown as TUI;

const lines: string[] = [];

function show(label: string, component: ToolExecutionComponent): void {
	lines.push(theme.fg("dim", label));
	for (const row of component.render(width)) lines.push(row);
	lines.push("");
}

// 1. Still running: args complete, no result yet. What the operator sees the instant
//    before pressing Esc.
{
	const block = new ToolExecutionComponent("bash", { command: "npm run migrate:up" }, {}, undefined, ui);
	block.setArgsComplete();
	show("running (no result yet):", block);
}

// 2. Interrupted: the same block after `EventController` sealed it because the turn
//    aborted. No result will ever arrive.
{
	const block = new ToolExecutionComponent("bash", { command: "npm run migrate:up" }, {}, undefined, ui);
	block.setArgsComplete();
	block.seal();
	show("sealed by interrupt (no result, none coming):", block);
}

// 2b. What a mid-flight Esc actually produces. Measured against the real loop: a tool
//     whose body was running when the signal fired throws, and the thrown error's own
//     message becomes the tool result verbatim. For an `AbortError` that message is the
//     bare word "aborted".
{
	const block = new ToolExecutionComponent("bash", { command: "npm run migrate:up" }, {}, undefined, ui);
	block.setArgsComplete();
	block.updateResult({ content: [{ type: "text", text: "aborted" }], isError: true });
	show("interrupted mid-execution (real loop output):", block);
}

// 2c. What a call that never reached dispatch produces: the loop's own placeholder,
//     with the `SyntheticToolResultDetails` discriminator agent-core stamps on it.
{
	const block = new ToolExecutionComponent("bash", { command: "npm run migrate:up" }, {}, undefined, ui);
	block.setArgsComplete();
	block.updateResult({
		content: [{ type: "text", text: "Tool execution was aborted." }],
		details: { __synthetic: true, source: "assistant_stop_aborted", executed: false },
		isError: true,
	});
	show("never dispatched (loop placeholder):", block);
}

// 3. Completed normally, for contrast.
{
	const block = new ToolExecutionComponent("bash", { command: "npm run migrate:up" }, {}, undefined, ui);
	block.setArgsComplete();
	block.updateResult({ content: [{ type: "text", text: "migrated 3 tables" }] });
	show("completed:", block);
}

// 4. Completed with an error, so the error styling can be told apart from the sealed shape.
{
	const block = new ToolExecutionComponent("bash", { command: "npm run migrate:up" }, {}, undefined, ui);
	block.setArgsComplete();
	block.updateResult({ content: [{ type: "text", text: "exit 1: relation already exists" }], isError: true });
	show("completed with an error:", block);
}

process.stdout.write(`${lines.join("\n")}\n`);
