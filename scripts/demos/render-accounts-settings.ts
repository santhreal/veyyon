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
import { renderDemo } from "./render-args";
import { createTestSettingsSelector } from "./render-settings-helper";

await renderDemo(
	({ width, flag, theme }) => {
		Settings.instance.set("accounts.loadBalancing", flag("balancing", "off") === "on");
		const selector = createTestSettingsSelector(theme);
		// Type-to-search narrows to the row, which keeps the frame stable as unrelated provider settings
		// are added around it.
		for (const character of "balancing") selector.handleInput(character);
		return selector.render(width);
	},
	{ settings: true, defaultHeight: 20 },
);
