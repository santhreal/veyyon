/**
 * WHY: the ssh renderer was copied from bash and then bash moved on.
 *
 * Three drifts, all in the collapsed result — the state a remote command spends
 * almost all of its life in:
 *
 * 1. The collapsed branch read `renderContext.visualLines`. Nothing populates
 *    that for `ssh`: `ToolExecutionComponent.#buildRenderContext()` builds the
 *    output/truncation context under `if (this.#toolName === "bash")`. So the
 *    width-aware branch was unreachable and every collapsed remote result fell
 *    through to a flat `slice(0, 5)` that counted newlines rather than the rows
 *    a wrapped line occupies, overflowing the frame it was sizing for.
 * 2. The cap was a literal `5` where every other collapsed output reads
 *    `PREVIEW_LIMITS.OUTPUT_COLLAPSED`.
 *
 * A third drift was investigated and is NOT a defect: output lines skipped
 * `replaceTabs`, which the command beside them applies. Rendering `col\tone`
 * with and without it produces byte-identical frames, because the tab is
 * expanded downstream when `Text` measures the line. The call is kept, since it
 * matches the bash renderer and the repo's sanitization rule, but no test here
 * asserts it: a test that cannot fail on the bug it names is worse than none.
 *
 * THE CLASS. A second renderer holding its own copy of a decision the shared
 * helpers own. It closes by `ssh` calling `truncateToVisualLines` at the box's
 * inner width and the shared limit — the same helpers the bash renderer calls. The assertions are on rendered frames, so a
 * renderer that stops calling one of them turns this red.
 *
 * WHAT THIS DOES NOT CATCH. It renders through `createToolExecution`, the same
 * seam `tool-execution-ssh-repaint.test.ts` drives, so it proves the renderer
 * and not the transport underneath it. It also does not pin the exact wording of
 * the "earlier lines" banner beyond the counts, which are what a reader acts on.
 */
import { beforeAll, describe, expect, it, vi } from "bun:test";
import type { ToolExecutionComponent } from "@veyyon/coding-agent/modes/terminal/components/transcript/tool-execution";
import { initTheme } from "@veyyon/coding-agent/theme/theme";
import { PREVIEW_LIMITS } from "@veyyon/coding-agent/tools/core/render-utils";
import type { TUI } from "@veyyon/tui";
import { createToolExecution } from "./helpers/tool-execution";

const WIDTH = 40;

function plain(component: ToolExecutionComponent, width = WIDTH): string[] {
	return [...component.render(width)].map(row => Bun.stripANSI(row).trimEnd());
}

function sshComponent(output: string): ToolExecutionComponent {
	const ui = { requestRender() {}, requestComponentRender() {}, resetDisplay() {} } as unknown as TUI;
	const component = createToolExecution("ssh", { host: "h", command: "run", i: "Running" }, {}, undefined, ui);
	component.updateResult({ content: [{ type: "text", text: output }] }, false, "call-ssh");
	return component;
}

describe("an ssh result is rendered the way a bash result is", () => {
	beforeAll(async () => {
		await initTheme();
		vi.restoreAllMocks();
	});

	/**
	 * A line longer than the frame occupies several rows. Counting newlines
	 * instead of rows let five long lines claim five rows and paint many more,
	 * which is the overflow this closes.
	 */
	it("spends the collapsed budget on rows, not on newlines", () => {
		const long = "x".repeat(WIDTH * 3);
		const component = sshComponent([long, long, long, long, long].join("\n"));

		const rows = plain(component);
		const outputRows = rows.filter(row => row.includes("xxx"));

		expect(outputRows.length).toBeLessThanOrEqual(PREVIEW_LIMITS.OUTPUT_COLLAPSED);
		expect(rows.some(row => row.includes("earlier lines"))).toBe(true);
	});

	it("caps a collapsed result at the shared limit rather than a local number", () => {
		const component = sshComponent(Array.from({ length: 20 }, (_, i) => `line-${i}`).join("\n"));

		const outputRows = plain(component).filter(row => /line-\d+$/.test(row));

		expect(outputRows).toHaveLength(PREVIEW_LIMITS.OUTPUT_COLLAPSED);
		// The tail, the way every other collapsed output shows it: the newest
		// lines, with the count of what was dropped above them.
		expect(outputRows.at(-1)?.endsWith("line-19")).toBe(true);
	});

	it("shows every line once expanded", () => {
		const component = sshComponent(Array.from({ length: 20 }, (_, i) => `line-${i}`).join("\n"));
		component.setExpanded(true);

		const outputRows = plain(component).filter(row => /line-\d+$/.test(row));

		expect(outputRows).toHaveLength(20);
	});
});
