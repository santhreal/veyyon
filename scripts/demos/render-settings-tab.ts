/**
 * Print one tab of the real `/settings` surface.
 *
 * `render-settings-compact.ts` answers a sizing question and always lands on the
 * first tab. This one opens a NAMED tab through the selector's own `openTab`
 * hook, so a change to a tab's sections, row labels or row order can be proved
 * as a before/after pair of the same surface:
 *
 *     bun scripts/demos/render-settings-tab.ts --tab subagents --height 26 |
 *       bun scripts/demos/render-proof.ts --out /tmp/subagents --width 100
 *
 * The component is the one `/settings` constructs, not a drawing of it, so the
 * rows in the image are the rows the schema produces.
 */
import type { SettingTab } from "../../packages/coding-agent/src/config/settings-schema";
import { SettingsSelectorComponent } from "../../packages/coding-agent/src/modes/components/settings-selector";
import { flag, initRender, renderWidth } from "./render-args";

const themeName = flag("theme", "titanium");
const width = renderWidth();
const height = Number(flag("height", "26"));
const tab = flag("tab", "subagents") as SettingTab;
const downCount = Number(flag("down", "0"));

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

selector.openTab(tab);
for (let step = 0; step < downCount; step++) selector.handleInput("\x1b[B");
process.stdout.write(`${selector.render(width).join("\n")}\n`);
