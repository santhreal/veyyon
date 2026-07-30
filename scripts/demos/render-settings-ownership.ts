/**
 * Print `/settings` source ownership states using the real selector component.
 *
 * Usage:
 *
 *     bun scripts/demos/render-settings-ownership.ts --state default-model --width 110
 *     bun scripts/demos/render-settings-ownership.ts --state shadowed --width 110
 */
import { DEFAULT_MODEL_SLOT } from "../../packages/coding-agent/src/config/model-roles";
import { Settings } from "../../packages/coding-agent/src/config/settings";
import { DEFAULT_MODEL_SETTING_ID } from "../../packages/coding-agent/src/modes/components/settings-defs";
import { SettingsSelectorComponent } from "../../packages/coding-agent/src/modes/components/settings-selector";
import { flag, initRender, renderWidth } from "./render-args";

const themeName = flag("theme", "titanium");
const state = flag("state", "default-model");
const width = renderWidth();

await initRender(themeName, { settings: true });

const selector = new SettingsSelectorComponent(
	{
		availableThinkingLevels: [],
		thinkingLevel: undefined,
		availableThemes: [themeName, "light"],
		availablePersonalities: ["default"],
		providers: ["anthropic", "openai"],
		cwd: process.cwd(),
	},
	{ onChange: () => {}, onCancel: () => {} },
);

if (state === "shadowed") {
	Settings.instance.override("contextPromotion.enabled", true);
	selector.openTab("context");
	selector.selectSetting("contextPromotion.enabled");
	selector.handleInput("\x1b[C");
} else {
	Settings.instance.setPersistedModelRole(DEFAULT_MODEL_SLOT, "anthropic/claude-sonnet-4-5");
	Settings.instance.override("modelRoles", { [DEFAULT_MODEL_SLOT]: "openai/gpt-5.2" });
	selector.openTab("model");
	selector.selectSetting(DEFAULT_MODEL_SETTING_ID);
}

process.stdout.write(`${selector.render(width).join("\n")}\n`);
