/**
 * Print the `/settings` Interaction tab, scrolled to Startup & Updates.
 *
 * Proves the "Roll back version" row in place: next to the auto-update toggle
 * it qualifies, rather than as a screenshot of the row on its own, because
 * where it sits IS the design claim.
 *
 * Usage:
 *
 *     bun scripts/demos/render-settings-rollback.ts [--theme titanium] [--width 130]
 */
import { renderDemo } from "./render-args";
import { createTestSettingsSelector } from "./render-settings-helper";

await renderDemo(
	({ width, theme }) => {
		const selector = createTestSettingsSelector(theme, { availableThemes: [theme] }, { onRollback: async () => {} });
		selector.openTab("interaction");
		selector.selectSetting("__action:rollback");
		return selector.render(width);
	},
	{ settings: true },
);
