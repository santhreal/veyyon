/**
 * Turn styled terminal output into a pair of PNG proofs.
 *
 * Use this whenever a change alters what the TUI LOOKS like. It reads the render on
 * stdin, so it composes with every existing demo:
 *
 *     bun scripts/demos/render-update-notice.ts --variant after |
 *       bun scripts/demos/render-proof.ts --out /tmp/proof/notice-after --width 100
 *
 * It writes `<out>-grey.png` and `<out>-black.png`. Look at BOTH: an explicit dark
 * fill is invisible against black and reads as a slab against grey, so a change
 * judged on one ground has been half judged. For a before/after, run the pair and
 * compare the four images.
 *
 * FORCE THE COLOUR ON. A renderer piped into this script has no TTY on stdout, and
 * several shells here also export `NO_COLOR`, so the theme emits plain text and the
 * proof comes out monochrome. It still looks like a proof, which is the dangerous
 * part: a colourless image cannot show a fill, a contrast, or a selection-highlight
 * bug, and those are most of what a proof is for. Run the renderer as:
 *
 *     env -u NO_COLOR FORCE_COLOR=3 bun scripts/demos/render-<surface>.ts … | bun scripts/demos/render-proof.ts …
 *
 * If the image has no colour in it anywhere, the capture is wrong, not the component.
 *
 * Why not capture a terminal: a capture renders on the capturing terminal's ground,
 * strips or distorts styling, and drops trailing styled cells, which is precisely
 * the information a fill or spacing change lives in. These images come from the
 * component's own bytes and are identical on every machine.
 */
import * as path from "node:path";
import { proofsForLines } from "./lib/ansi-raster";
import { flag, hasFlag } from "./render-args";

const out = hasFlag("out") ? flag("out", "") : "";
if (!out) {
	console.error(
		"usage: <renderer emitting ANSI> | bun scripts/demos/render-proof.ts --out <path prefix> [--width N] [--scale N]",
	);
	process.exit(2);
}

const scale = Number.parseInt(flag("scale", "2"), 10);
const text = await Bun.stdin.text();
// A trailing newline is a line terminator, not an empty final row: keeping it would
// add a row of ground to every proof and make two identical renders differ in height.
const lines = text.replace(/\n$/, "").split("\n");
// `renderWidth` is deliberately NOT used here: its default is the capture width for
// a renderer, while a proof of piped input must default to the input's own measured
// width or it would pad every short render out to 100 columns of ground.
const widthFlag = hasFlag("width") ? flag("width", "") : undefined;
const measured = Math.max(
	1,
	...lines.map(line => line.replace(/\x1b\[[0-9;]*[@-~]/g, "").replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, "").length),
);
const width = widthFlag ? Number.parseInt(widthFlag, 10) : measured;

const written: string[] = [];
const unmapped = new Set<string>();
for (const proof of proofsForLines(lines, width, { scale })) {
	const file = `${out}-${proof.ground.name}.png`;
	await Bun.write(file, proof.png);
	written.push(`${file} (${proof.width}x${proof.height})`);
	for (const char of proof.unmapped) unmapped.add(char);
}

console.error(`wrote ${written.length} proofs at ${width} columns, ${lines.length} rows:`);
for (const line of written) console.error(`  ${path.resolve(line.split(" ")[0])} ${line.split(" ")[1]}`);
if (unmapped.size > 0) {
	// Said out loud rather than left in the image: a proof full of unexplained boxes
	// reads as a bug in the component being proved.
	console.error(
		`NOTE: ${unmapped.size} character(s) have no 5x7 glyph and are drawn as hollow boxes: ` +
			[...unmapped]
				.map(char => `${JSON.stringify(char)} (U+${char.codePointAt(0)?.toString(16).toUpperCase()})`)
				.join(", "),
	);
	console.error("Add them to scripts/demos/lib/glyphs.ts if they matter to what you are proving.");
}
