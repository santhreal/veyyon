/**
 * Film a real overlay's entrance, frame by frame, without a terminal.
 *
 *     bun scripts/demos/render-overlay-entrance.ts --out /tmp/entrance --frames 14 --step 33
 *
 * The component is the one `/settings` constructs and the frames come out of its
 * own `render(width)`, so what is rasterized is the production path: the modal
 * shell, `applyModalReveal`, the surface fill, the per-row cascade and the sweep.
 * Nothing here draws a picture of a card.
 *
 * Time is supplied rather than waited for. The shared motion clock takes an
 * explicit `tick(now)`, so this walks the entrance in exact 60Hz-sized steps and
 * writes one PNG pair per frame — which is the only way to look at a 260ms
 * animation honestly, since a still taken from inside the animation always lands
 * after it has finished.
 *
 * `--variant flat` renders the same frames with the surface treatment bypassed, so
 * the pair is a differential of the treatment rather than a picture of it.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { motionClock } from "../../packages/tui/src/motion";
import type { SettingTab } from "../../packages/coding-agent/src/config/settings-schema";
import { setDetectedTerminalGround } from "../../packages/coding-agent/src/modes/theme/ground-tints";
import { SettingsSelectorComponent } from "../../packages/coding-agent/src/modes/components/settings-selector";
import { ansiToGrid } from "./lib/ansi-grid";
import { BLACK_GROUND, GREY_GROUND, type Ground, rasterizeGrid } from "./lib/ansi-raster";
import { flag, hasFlag, initRender, renderWidth } from "./render-args";

const out = hasFlag("out") ? flag("out", "") : "";
if (!out) {
	console.error("usage: bun scripts/demos/render-overlay-entrance.ts --out <prefix> [--frames N] [--step MS] [--scale N] [--tab NAME]");
	process.exit(2);
}
const frames = Number(flag("frames", "14"));
const stepMs = Number(flag("step", "33"));
const scale = Number(flag("scale", "2"));
const themeName = flag("theme", "titanium");
const tab = flag("tab", "subagents") as SettingTab;
const height = Number(flag("height", "26"));
const groundHex = flag("ground", `#${GREY_GROUND.background.map((c) => c.toString(16).padStart(2, "0")).join("")}`);
const width = renderWidth();

const flat = hasFlag("flat");

Object.defineProperty(process.stdout, "rows", { configurable: true, value: height });
await initRender(themeName, { settings: true });
// Declare the ground the images are rasterized on. In a real terminal this value
// arrives from the OSC 11 answer, and every fade and fill mixes out of it; a
// headless script gets no answer, falls back to the theme's DECLARED ground —
// black for titanium — and would film a black slab sitting on a grey page.
//
// `--flat` withholds it, which is the OFF arm of the differential: with no known
// ground the card takes no material and no light, and the frames are the bytes the
// product drew before any of this — not a mock-up of them.
if (!flat) setDetectedTerminalGround(groundHex);

const selector = new SettingsSelectorComponent(
	{
		availableThinkingLevels: [],
		thinkingLevel: undefined,
		availableThemes: [themeName, "light"],
		availablePersonalities: ["default"],
		providers: ["anthropic"],
		cwd: process.cwd(),
	},
	{ onChange: () => {}, onCancel: () => {} },
	undefined,
	// The fourth argument is the open unfold. Passing it is what a show site does
	// when the terminal can take motion; the component honors it blindly.
	true,
);
selector.openTab(tab);

await fs.mkdir(path.dirname(out), { recursive: true });
const unmapped = new Set<string>();
const written: string[] = [];

// The clock's first tick is taken relative to the moment the animation registered,
// which is the first render below. Every later frame is placed by hand.
let now = 0;
for (let frame = 0; frame < frames; frame++) {
	const lines = selector.render(width);
	const grid = ansiToGrid([...lines], width);
	for (const ground of [GREY_GROUND, BLACK_GROUND] as Ground[]) {
		const result = rasterizeGrid(grid, ground, { scale });
		const file = `${out}-f${String(frame).padStart(2, "0")}-${ground.name}.png`;
		await fs.writeFile(file, result.png);
		for (const char of result.unmapped) unmapped.add(char);
		written.push(file);
	}
	now += stepMs;
	motionClock.tick(now);
}

console.error(`wrote ${written.length} images: ${out}-f00…f${String(frames - 1).padStart(2, "0")}`);
if (unmapped.size > 0) console.error(`no glyph for: ${[...unmapped].join(" ")}`);
