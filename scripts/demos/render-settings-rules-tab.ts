/**
 * Print the real `/settings` surface parked on a named sidebar section.
 *
 * `--tab` goes through the component's own `openTab`, so the frame is the one a
 * user reaches by clicking that sidebar entry. Use it to prove a section exists
 * AND that its contents are what the sidebar entry promises — a section that
 * renders empty is the failure mode worth catching.
 *
 * Usage:
 *
 *     bun scripts/demos/render-settings-rules-tab.ts --tab rules --width 92 --height 26
 */
import { SETTING_TABS } from "../../packages/coding-agent/src/config/settings-schema";
import { SettingsSelectorComponent } from "../../packages/coding-agent/src/modes/components/settings-selector";
import { flag, initRender, renderWidth } from "./render-args";

const themeName = flag("theme", "titanium");
const width = renderWidth();
const height = Number(flag("height", "26"));
const tab = flag("tab", "rules");

if (!SETTING_TABS.includes(tab as (typeof SETTING_TABS)[number])) {
	throw new Error(`unknown tab ${JSON.stringify(tab)}; one of: ${SETTING_TABS.join(", ")}`);
}

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

selector.openTab(tab as (typeof SETTING_TABS)[number]);
process.stdout.write(`${selector.render(width).join("\n")}\n`);
