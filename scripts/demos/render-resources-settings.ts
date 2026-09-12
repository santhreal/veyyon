/**
 * Print the real `/settings` Resources tab around the Disk group, in one state.
 *
 * The differential this exists for is off-vs-on of the **Session Write Budget**
 * (`session.writeBudgetGb`), which ships at 0, meaning nothing is metered. The pair proves three
 * things at once, which is why it renders the tab rather than one row:
 *
 *  - the Resources tab exists and is reachable, which is the whole point of the change: the only
 *    resource limit veyyon had was `session.cpuLimitCores`, buried under Shell in a group called
 *    "CPU Limit", and a budget an operator cannot find is a budget nobody sets;
 *  - the budget row itself reads `Off` and then a real number of gigabytes;
 *  - `Kill Over-Budget Writers` carries `condition: "writeBudgetEnabled"` and is therefore absent
 *    from the `off` shot entirely, not greyed out but gone. A kill policy for a budget that does
 *    not exist is a control with nothing behind it.
 *
 * Rendering the REAL `SettingsSelectorComponent` is the point: a mock-up of the rows would agree
 * with a condition that never reached the selector. The state is seeded through the real settings
 * store before the first render rather than by pressing the row, so a broken keybinding cannot
 * produce a passing capture, and the cursor is placed with `selectSetting` so the viewport lands on
 * the same group in both shots.
 *
 * Usage (see scripts/demos/record-resources-settings.sh for the pair):
 *
 *     bun scripts/demos/render-resources-settings.ts --budget on --width 100 --height 24
 */
import { Settings } from "../../packages/coding-agent/src/config/settings";
import { renderDemo } from "./render-args";
import { createTestSettingsSelector } from "./render-settings-helper";

await renderDemo(
	({ width, flag, theme }) => {
		Settings.instance.set("session.writeBudgetGb", flag("budget", "off") === "on" ? 25 : 0);
		const selector = createTestSettingsSelector(theme);
		selector.openTab("resources");
		if (!selector.selectSetting("session.writeBudgetGb")) {
			throw new Error("the write budget row is not on the resources tab, so this proof is not of it");
		}
		return selector.render(width);
	},
	{ settings: true, defaultHeight: 24 },
);
