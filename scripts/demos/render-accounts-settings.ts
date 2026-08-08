/**
 * Print the real `/settings` surface filtered to the Accounts group, in one state.
 *
 * The differential this exists for is off-vs-on of **Account Load Balancing**
 * (`accounts.loadBalancing`). Off is the shipped default and the honest one: moving a session onto a
 * second account of the same provider spends a second subscription, so the row has to be a knob the
 * operator can see and reach rather than a behaviour that happens on their behalf. The pair proves
 * the knob is wired: the same rendered row reads `Off` in one shot and `On` in the other, seeded
 * through the real settings store.
 *
 * Rendering the REAL `SettingsSelectorComponent` is the point. A mock-up of the row would agree with
 * a setting that never reached behaviour, which is the exact defect class the proof rule is aimed at.
 * The state is seeded with `Settings.instance.set` before the first render rather than by pressing
 * the toggle, so a broken keybinding cannot produce a passing capture.
 *
 * Usage (see scripts/demos/record-accounts-settings.sh for the pair):
 *
 *     bun scripts/demos/render-accounts-settings.ts --balancing on --width 100 --height 20
 */
import { Settings } from "../../packages/coding-agent/src/config/settings";
import { SettingsSelectorComponent } from "../../packages/coding-agent/src/modes/components/settings-selector";
import { flag, initRender, renderWidth } from "./render-args";

const themeName = flag("theme", "titanium");
const width = renderWidth();
const height = Number(flag("height", "20"));
const balancing = flag("balancing", "off") === "on";

Object.defineProperty(process.stdout, "rows", { configurable: true, value: height });
await initRender(themeName, { settings: true });
Settings.instance.set("accounts.loadBalancing", balancing);

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

// Type-to-search narrows to the row, which keeps the frame stable as unrelated provider settings
// are added around it.
for (const character of "balancing") selector.handleInput(character);
process.stdout.write(`${selector.render(width).join("\n")}\n`);
