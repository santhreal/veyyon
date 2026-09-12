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
import { DEFAULT_MODEL_SETTING_ID } from "../../packages/coding-agent/src/modes/terminal/components/selectors/settings-defs";
import { renderDemo } from "./render-args";
import { createTestSettingsSelector } from "./render-settings-helper";

await renderDemo(
	({ width, flag, theme }) => {
		const state = flag("state", "default-model");
		const selector = createTestSettingsSelector(theme, { providers: ["anthropic", "openai"] });
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
		return selector.render(width);
	},
	{ settings: true },
);
