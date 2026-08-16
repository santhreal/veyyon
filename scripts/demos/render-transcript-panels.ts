/**
 * Print the `/btw` and `/omfg` transcript panels, one under the other.
 *
 * These two blocks own a turn in the transcript, so the question they answer is
 * whether they sit on the same left rail as everything above them. The demo
 * puts a real user prompt and a real assistant paragraph above the panels, at
 * the rail, so a panel that starts anywhere else is visible as a step in the
 * left edge rather than something you have to measure.
 *
 * Both panels are the REAL components, driven through their real state methods
 * (`appendText` / `markComplete`, `setRule` / `setStatus`), because a mock-up
 * would agree with whatever the layout is supposed to be.
 *
 * Run:
 *     bun scripts/demos/render-transcript-panels.ts --width 100 --ruler |
 *       bun scripts/demos/render-proof.ts --out /tmp/panels --width 100 --scale 2
 */
import { BtwPanelComponent } from "../../packages/coding-agent/src/modes/components/btw-panel";
import {
	COMPOSER_INSET_COLS,
	resolveComposerAccents,
} from "../../packages/coding-agent/src/modes/components/composer-chrome";
import { OmfgPanelComponent } from "../../packages/coding-agent/src/modes/components/omfg-panel";
import { initTheme, theme } from "../../packages/coding-agent/src/modes/theme/theme";
import type { TUI } from "../../packages/tui/src/index";
import { flag, hasFlag, renderWidth } from "./render-args";

const themeName = flag("theme", "titanium");
const width = renderWidth();
await initTheme(false, "unicode", false, themeName, themeName);

const ui = { requestRender() {}, requestComponentRender() {} } as unknown as TUI;
const lines: string[] = [];

if (hasFlag("ruler")) {
	let tens = "";
	let units = "";
	for (let col = 0; col < width; col++) {
		tens += col % 10 === 0 ? String(Math.floor(col / 10) % 10) : " ";
		units += String(col % 10);
	}
	lines.push(theme.fg("dim", tens), theme.fg("dim", units));
}

const accents = resolveComposerAccents({
	bypass: false,
	bashMode: false,
	pythonMode: false,
	planMode: false,
	focusedSubagent: false,
	sessionAccentAnsi: undefined,
	thinkingLevel: "off",
});
lines.push(`${accents.promptGutter}why does the parser reject an empty focus string?`);
lines.push("");
lines.push(`${" ".repeat(COMPOSER_INSET_COLS)}It validates before it trims, so the empty case never reaches the trim.`);
lines.push("");
const btw = new BtwPanelComponent({ question: "what is a focus string?", tui: ui });
btw.appendText(
	"A **focus string** names the subset of tests a run executes.\n\nIt is matched against the test name, not the file path.",
);
btw.markComplete();
lines.push(...btw.render(width));
lines.push("");

const omfg = new OmfgPanelComponent({ complaint: "stop reformatting my imports", tui: ui });
omfg.setRule("## Imports\n\nNever reorder an import block that the change does not otherwise touch.");
omfg.setStatus("confirming", "Save this rule? y/n");
lines.push(...omfg.render(width));
lines.push("");

lines.push(`${accents.promptGutter}`);

process.stdout.write(`${lines.join("\n")}\n`);
