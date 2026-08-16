/**
 * Print the real hook selector — the list an extension shows when it asks the
 * operator to choose — as it is painted on screen.
 *
 * The selector used to draw its own rule-and-title chrome and ignore the
 * pointer. It is a ModalShell card now, with the shared title bar, the shared
 * shortcut chips and row-level hover, so the before/after pair is a pair of
 * images of this one component:
 *
 *     bun scripts/demos/render-hook-selector.ts --width 100 |
 *       bun scripts/demos/render-proof.ts --out /tmp/hook-selector --width 100
 *
 * `--hover <n>` points at the nth option row (0-based) the way a pointer would,
 * so the hover band is proved rather than described.
 */
import { HookSelectorComponent } from "../../packages/coding-agent/src/modes/components/hook-selector";
import { flag, initRender, renderWidth } from "./render-args";

const themeName = flag("theme", "titanium");
const width = renderWidth();
const hover = flag("hover", "");
await initRender(themeName, { settings: true });

const selector = new HookSelectorComponent(
	"Which hook should run on this event?",
	[
		{ label: "format-on-save", description: "run biome over the touched files" },
		{ label: "run-tests", description: "run the package's own bucket" },
		{ label: "changelog-check", description: "fail when shipped source has no entry" },
		{ label: "skip", description: "do nothing this turn" },
	],
	() => {},
	() => {},
	{ maxVisible: 8 },
);

// Paint once so the component knows its geometry, then aim the pointer at a row
// from the frame it just painted rather than at a guessed coordinate.
const first = selector.render(width);
if (hover !== "") {
	const index = Number(hover);
	const rows = first.map(row => row.replace(/\x1b\[[0-9;]*m/g, ""));
	const labels = ["format-on-save", "run-tests", "changelog-check", "skip"];
	const label = labels[index] ?? labels[0]!;
	const row = rows.findIndex(text => text.includes(label));
	const col = rows[row]?.indexOf(label) ?? 0;
	if (row >= 0) selector.handleInput(`\x1b[<35;${col + 1};${row + 1}M`);
}

const frame = [...selector.render(width)];
while (frame.length > 0 && frame[frame.length - 1]?.trim() === "") frame.pop();
process.stdout.write(`${frame.join("\n")}\n`);
