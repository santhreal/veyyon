/**
 * Print the real `/settings` surface at a compact width and height.
 *
 * Usage:
 *
 *     bun scripts/demos/render-settings-compact.ts --width 70 --height 14 --down 10
 */
import { SettingsSelectorComponent } from "../../packages/coding-agent/src/modes/components/settings-selector";
import { flag, initRender, renderWidth } from "./render-args";

const themeName = flag("theme", "titanium");
const width = renderWidth();
const height = Number(flag("height", "14"));
const downCount = Number(flag("down", "10"));

Object.defineProperty(process.stdout, "rows", { configurable: true, value: height });
await initRender(themeName, { settings: true });

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
);

for (let step = 0; step < downCount; step++) selector.handleInput("\x1b[B");
process.stdout.write(`${selector.render(width).join("\n")}\n`);
