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
import { BashExecutionComponent } from "../../packages/coding-agent/src/modes/components/bash-execution";
import {
	COMPOSER_INSET_COLS,
	resolveComposerAccents,
} from "../../packages/coding-agent/src/modes/components/composer-chrome";
import { ToolExecutionComponent } from "../../packages/coding-agent/src/modes/components/tool-execution";
import { initTheme, theme } from "../../packages/coding-agent/src/modes/theme/theme";
import type { TUI } from "../../packages/tui/src/index";
import { flag, hasFlag, renderWidth } from "./render-args";

const themeName = flag("theme", "titanium");
const width = renderWidth();
await initTheme(false, "unicode", false, themeName, themeName);

const ui = { requestRender() {}, requestComponentRender() {} } as unknown as TUI;
const lines: string[] = [];

if (hasFlag("ruler")) {
	// Tens on one row, units on the next, so a block's start column is readable.
	let tens = "";
	let units = "";
	for (let col = 0; col < width; col++) {
		tens += col % 10 === 0 ? String(Math.floor(col / 10) % 10) : " ";
		units += String(col % 10);
	}
	lines.push(theme.fg("dim", tens), theme.fg("dim", units));
}

// A user turn, as the transcript writes it: the prompt glyph on the rail.
const accents = resolveComposerAccents({
	bypass: false,
	bashMode: false,
	pythonMode: false,
	planMode: false,
	focusedSubagent: false,
	sessionAccentAnsi: undefined,
	thinkingLevel: "off",
});
lines.push(`${accents.promptGutter}run the failing test and tell me why it fails`);
lines.push("");

// An assistant paragraph. Plain text on the rail, which is the thing every other
// block is supposed to line up with.
lines.push(`${" ".repeat(COMPOSER_INSET_COLS)}The parser rejects an empty focus string, so the run aborts.`);
lines.push("");

const bash = new BashExecutionComponent("bun test test/parser.test.ts", ui);
bash.appendOutput("1 pass\n1 fail\n");
bash.setComplete(1, false);
lines.push(...bash.render(width));
lines.push("");

const tool = new ToolExecutionComponent("read", { path: "src/parser.ts" }, {}, undefined, ui);
tool.updateResult({ content: [{ type: "text", text: "export function parse() {}" }], isError: false } as never, false);
lines.push(...tool.render(width));
lines.push("");

// The composer's own gutter, last, because it is the rail everything else is
// measured against.
lines.push(`${accents.promptGutter}`);

process.stdout.write(`${lines.join("\n")}\n`);
