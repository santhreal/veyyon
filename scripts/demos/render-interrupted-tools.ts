/**
 * Render tool execution transcript blocks across interrupted and terminal lifecycle states.
 *
 * Constructs tool execution components for bash commands under multiple execution states,
 * including active execution without results, sealed by interrupt, aborted mid-execution,
 * synthetic loop aborts before dispatch, successful completion, and exit errors. Prints each
 * rendered block with section headers as ANSI text.
 *
 * Usage:
 *   bun scripts/demos/render-interrupted-tools.ts [--width 100] [--theme titanium]
 */

import type { TUI } from "../../hosts/terminal/engine/src/tui";
import { ToolExecutionComponent } from "../../packages/coding-agent/src/modes/terminal/components/transcript/tool-execution";
import { theme } from "../../packages/coding-agent/src/theme/theme";
import { renderDemo } from "./render-args";

await renderDemo(
	({ width }) => {
		const ui = { requestRender: () => {}, requestComponentRender: () => {} } as unknown as TUI;
		const lines: string[] = [];

		function show(label: string, component: ToolExecutionComponent): void {
			lines.push(theme.fg("dim", label));
			for (const row of component.render(width)) lines.push(row);
			lines.push("");
		}

		{
			const block = new ToolExecutionComponent("bash", { command: "npm run migrate:up" }, {}, undefined, ui);
			block.setArgsComplete();
			show("running (no result yet):", block);
		}
		{
			const block = new ToolExecutionComponent("bash", { command: "npm run migrate:up" }, {}, undefined, ui);
			block.setArgsComplete();
			block.seal();
			show("sealed by interrupt (no result, none coming):", block);
		}
		{
			const block = new ToolExecutionComponent("bash", { command: "npm run migrate:up" }, {}, undefined, ui);
			block.setArgsComplete();
			block.updateResult({ content: [{ type: "text", text: "aborted" }], isError: true });
			show("interrupted mid-execution (real loop output):", block);
		}
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
		{
			const block = new ToolExecutionComponent("bash", { command: "npm run migrate:up" }, {}, undefined, ui);
			block.setArgsComplete();
			block.updateResult({ content: [{ type: "text", text: "migrated 3 tables" }] });
			show("completed:", block);
		}
		{
			const block = new ToolExecutionComponent("bash", { command: "npm run migrate:up" }, {}, undefined, ui);
			block.setArgsComplete();
			block.updateResult({ content: [{ type: "text", text: "exit 1: relation already exists" }], isError: true });
			show("completed with an error:", block);
		}
		return lines;
	},
	{ settings: true },
);
