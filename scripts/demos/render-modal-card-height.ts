/**
 * Print a short list in the shared modal card, before and after content sizing.
 *
 * The defect this proves is a shape, not a string: a seven-row list inside a
 * card tall enough for twenty, so most of the card is empty and the list reads
 * as one that failed to load the rest. No assertion shows that; only looking at
 * it does.
 *
 * Both variants call the SHIPPED `renderModalShell` with identical rows and the
 * identical sizing. `before` omits `preferredBodyRows`, which is exactly what
 * every caller did previously; `after` passes the row count the way
 * `ModalSelectListComponent` now does. So the pair differs by the one field
 * under test and nothing else.
 *
 * Usage:
 *
 *     bun scripts/demos/render-modal-card-height.ts --variant before|after [--theme titanium] [--width 100]
 */
import {
	MODAL_SIZING_MEDIUM,
	renderModalShell,
	SELECT_LIST_SHORTCUTS,
} from "../../packages/coding-agent/src/modes/components/modal-shell";
import { initTheme } from "../../packages/coding-agent/src/modes/theme/theme";
import { flag, renderWidth } from "./render-args";

/** Rows short enough that the empty space below them is the whole point. */
const ROWS = [
	"1.6.0    20 Jul 2026",
	"1.5.2    11 Jul 2026",
	"1.5.1    02 Jul 2026   current",
	"1.5.0    24 Jun 2026   previously run",
	"1.4.0    10 Jun 2026   previously run",
	"1.3.1    29 May 2026",
	"1.3.0    14 May 2026",
];

/** Tall enough that the fixed-height card has somewhere to be wrong. */
const AREA_HEIGHT = 34;

const variant = flag("variant", "after");
const themeName = flag("theme", "titanium");
const width = renderWidth();

await initTheme(false, "unicode", false, themeName, themeName);

const shell = renderModalShell({
	title: "Version · takes effect on restart",
	sizing: MODAL_SIZING_MEDIUM,
	areaWidth: width,
	areaHeight: AREA_HEIGHT,
	body: ROWS,
	preferredBodyRows: variant === "before" ? undefined : ROWS.length,
	shortcuts: SELECT_LIST_SHORTCUTS,
	showClose: true,
});

process.stdout.write(`${shell.lines.join("\n")}\n`);
