/**
 * Print the real `/settings` Appearance tab around the Status Line group, in one state.
 *
 * The differential this exists for is off-vs-on of the **Composer Footline**
 * (`statusLine.enabled`). Off is the shipped default: the quiet metadata row under the composer is
 * a permanent line of standing state, so it is asked for rather than assumed. The pair proves two
 * things at once, which is why it renders the GROUP and not one row:
 *
 *  - the toggle exists, is reachable, and reads `Off` then `On`;
 *  - the knobs that only describe that row appear only in the `on` shot. `Status Line Preset` is a
 *    layout for a row that is not on screen while the footline is off, so it carries
 *    `condition: "statusLineEnabled"` and is absent from the `off` shot entirely (not greyed, gone).
 *
 * Rendering the REAL `SettingsSelectorComponent` is the point: a mock-up of the rows would agree
 * with a condition that never reached the selector. The state is seeded through the real settings
 * store before the first render rather than by pressing the toggle, so a broken keybinding cannot
 * produce a passing capture, and the cursor is placed with `selectSetting` so the viewport lands on
 * the same group in both shots.
 *
 * Usage (see scripts/demos/record-footline-settings.sh for the pair):
 *
 *     bun scripts/demos/render-footline-settings.ts --footline on --width 100 --height 22
 */
import { Settings } from "../../packages/coding-agent/src/config/settings";
import { SettingsSelectorComponent } from "../../packages/coding-agent/src/modes/components/settings-selector";
import { flag, initRender, renderWidth } from "./render-args";

const themeName = flag("theme", "titanium");
const width = renderWidth();
const height = Number(flag("height", "22"));
const footline = flag("footline", "off") === "on";

Object.defineProperty(process.stdout, "rows", { configurable: true, value: height });
await initRender(themeName, { settings: true });
Settings.instance.set("statusLine.enabled", footline);

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

// The toggle itself is the one row present in both states, so selecting it puts the Status Line
// group in the viewport of both shots and makes the missing preset row visible as an absence.
selector.selectSetting("statusLine.enabled");
process.stdout.write(`${selector.render(width).join("\n")}\n`);
