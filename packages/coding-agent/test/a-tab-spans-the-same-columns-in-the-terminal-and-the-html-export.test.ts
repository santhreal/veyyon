/**
 * WHY: `@veyyon/tool-render`, which draws the HTML export and the collab web transcript, declared
 * its own `replaceTabs` with a three-space literal beside the one the terminal expands tabs with.
 * The two agreed by coincidence, so changing either tab width moved a tabbed command or output in
 * one surface and not the other. `tool-render` now expands tabs with `@veyyon/utils/tab-width`.
 *
 * CLASS: a tab in tool arguments or tool output that spans a different number of columns in the
 * HTML export than in the terminal card for the same call. The same `ssh` call, whose command and
 * output both carry a tab, is drawn by the terminal card and by the export's React renderer, and the
 * gap between the text on each side of the tab must be the same width in both, and must be
 * `DEFAULT_TAB_WIDTH` columns.
 *
 * GAP: a browser applies CSS `tab-size` to a literal tab; this suite checks the text the renderer
 * emits, which holds no literal tab, not the pixels a browser draws.
 */
import { beforeAll, describe, expect, it } from "bun:test";
import { initTheme } from "@veyyon/coding-agent/theme/theme";
import { resolveToolRenderer } from "@veyyon/tool-render/registry";
import type { ToolRenderProps } from "@veyyon/tool-render/types";
import type { TUI } from "@veyyon/tui";
import { stripAnsi } from "@veyyon/utils";
import { DEFAULT_TAB_WIDTH } from "@veyyon/utils/tab-width";
import { visibleWidth } from "@veyyon/utils/width";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createToolExecution } from "./helpers/tool-execution";

const mockUi = {
	requestRender() {},
	requestComponentRender() {},
	resetDisplay() {},
} as unknown as TUI;

const COMMAND = "echo\tcmdtail";
const OUTPUT = "left\touttail";
const args = { host: "remote-server", command: COMMAND };
const result = { content: [{ type: "text" as const, text: `${OUTPUT}\n` }], isError: false };

/** Columns between the end of `before` and the start of `after` on the first line holding both. */
function gapColumns(lines: readonly string[], before: string, after: string): number {
	for (const line of lines) {
		const start = line.indexOf(before);
		const end = line.indexOf(after, start + before.length);
		if (start !== -1 && end !== -1) return visibleWidth(line.slice(start + before.length, end));
	}
	throw new Error(`no line holds ${before} followed by ${after}:\n${lines.join("\n")}`);
}

function terminalLines(): string[] {
	const card = createToolExecution("ssh", args, {}, undefined, mockUi, "/home/tester", "call-1");
	card.updateResult(result, false, "call-1");
	return card.render(160).map(line => stripAnsi(line));
}

/**
 * The export card's body as text. The one-line summary above it collapses whitespace, so the tab is
 * compared in the command block and the output, where the card prints it expanded.
 */
function htmlLines(): string[] {
	const Body = resolveToolRenderer("ssh").Body;
	if (!Body) throw new Error("the ssh web renderer has no Body");
	const html = renderToStaticMarkup(createElement(Body, { name: "ssh", args, result } as ToolRenderProps));
	return html
		.replace(/<\/(?:div|pre|p|li)>/g, "\n")
		.replace(/<[^>]*>/g, "")
		.replace(/&nbsp;/g, " ")
		.replace(/&amp;/g, "&")
		.split("\n");
}

describe("a tab spans the same columns in the terminal and the HTML export", () => {
	beforeAll(async () => {
		await initTheme();
	});

	for (const [what, before, after] of [
		["the command", "echo", "cmdtail"],
		["the output", "left", "outtail"],
	] as const) {
		it(`${what}: both surfaces expand the tab to DEFAULT_TAB_WIDTH columns`, () => {
			const terminal = gapColumns(terminalLines(), before, after);
			const html = gapColumns(htmlLines(), before, after);
			expect({ terminal, html }).toEqual({ terminal: DEFAULT_TAB_WIDTH, html: DEFAULT_TAB_WIDTH });
		});
	}
});
