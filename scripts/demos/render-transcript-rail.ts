/**
 * Print a transcript slice whose only subject is the LEFT RAIL.
 *
 * The transcript is supposed to sit on one rail: every block starts at the same
 * column as the composer's prompt gutter, so the eye follows a single edge down the
 * screen. Whether it actually does is a question about pixels, and the insets are
 * decided per component, so the only way to answer it is to put the real components
 * one under another at one width and look at where each of them starts.
 *
 * Pipe this into `render-proof.ts` to get the images:
 *
 *     bun scripts/demos/render-transcript-rail.ts --width 100 |
 *       bun scripts/demos/render-proof.ts --out /tmp/rail --width 100
 *
 * Each block is a REAL component, constructed the way the session constructs it, not
 * a mock-up of one: a mock-up would agree with whatever the rail is supposed to be
 * and prove nothing. `--ruler` prefixes a column ruler so a misaligned block can be
 * read off the image directly instead of estimated.
 */

import {
	COMPOSER_INSET_COLS,
	PRISTINE_COMPOSER_ACCENT_STATE,
	resolveComposerAccents,
} from "../../packages/coding-agent/src/modes/terminal/components/composer/composer-chrome";
import { BashExecutionComponent } from "../../packages/coding-agent/src/modes/terminal/components/transcript/bash-execution";
import { ToolExecutionComponent } from "../../packages/coding-agent/src/modes/terminal/components/transcript/tool-execution";
import { mockTui, renderDemo, renderRuler } from "./render-args";

await renderDemo(({ width, hasFlag }) => {
	const ui = mockTui();
	const lines: string[] = [];
	if (hasFlag("ruler")) {
		lines.push(...renderRuler(width));
	}
	const accents = resolveComposerAccents(PRISTINE_COMPOSER_ACCENT_STATE);
	lines.push(`${accents.promptGutter}run the failing test and tell me why it fails`, "");
	lines.push(`${" ".repeat(COMPOSER_INSET_COLS)}The parser rejects an empty focus string, so the run aborts.`, "");
	const bash = new BashExecutionComponent("bun test test/parser.test.ts", ui);
	bash.appendOutput("1 pass\n1 fail\n");
	bash.setComplete(1, false);
	lines.push(...bash.render(width), "");
	const tool = new ToolExecutionComponent("read", { path: "src/parser.ts" }, {}, undefined, ui);
	tool.updateResult(
		{ content: [{ type: "text", text: "export function parse() {}" }], isError: false } as never,
		false,
	);
	lines.push(...tool.render(width), "", `${accents.promptGutter}`);
	return lines;
});
