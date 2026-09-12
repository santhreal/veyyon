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

import {
	COMPOSER_INSET_COLS,
	PRISTINE_COMPOSER_ACCENT_STATE,
	resolveComposerAccents,
} from "../../packages/coding-agent/src/modes/terminal/components/composer/composer-chrome";
import { BtwPanelComponent } from "../../packages/coding-agent/src/modes/terminal/components/dialogs/btw-panel";
import { OmfgPanelComponent } from "../../packages/coding-agent/src/modes/terminal/components/dialogs/omfg-panel";
import { mockTui, renderDemo, renderRuler } from "./render-args";

await renderDemo(({ width, hasFlag }) => {
	const ui = mockTui();
	const lines: string[] = [];
	if (hasFlag("ruler")) {
		lines.push(...renderRuler(width));
	}
	const accents = resolveComposerAccents(PRISTINE_COMPOSER_ACCENT_STATE);
	lines.push(`${accents.promptGutter}why does the parser reject an empty focus string?`, "");
	lines.push(
		`${" ".repeat(COMPOSER_INSET_COLS)}It validates before it trims, so the empty case never reaches the trim.`,
		"",
	);
	const btw = new BtwPanelComponent({ question: "what is a focus string?", tui: ui });
	btw.appendText(
		"A **focus string** names the subset of tests a run executes.\n\nIt is matched against the test name, not the file path.",
	);
	btw.markComplete();
	lines.push(...btw.render(width), "");
	const omfg = new OmfgPanelComponent({ complaint: "stop reformatting my imports", tui: ui });
	omfg.setRule("## Imports\n\nNever reorder an import block that the change does not otherwise touch.");
	omfg.setStatus("confirming", "Save this rule? y/n");
	lines.push(...omfg.render(width), "", `${accents.promptGutter}`);
	return lines;
});
