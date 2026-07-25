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
import { SettingsSelectorComponent } from "../../packages/coding-agent/src/modes/components/settings-selector";
import { flag, initRender, renderWidth } from "./render-args";

const themeName = flag("theme", "titanium");
const width = renderWidth();

await initRender(themeName, { settings: true });

const selector = new SettingsSelectorComponent(
	{
		availableThinkingLevels: [],
		thinkingLevel: undefined,
		availableThemes: [themeName],
		availablePersonalities: ["default"],
		providers: ["anthropic"],
		cwd: process.cwd(),
	},
	// The installer is what makes the row appear at all, so the proof render has
	// to supply one; a no-op is enough, since nothing is selected here.
	{ onChange: () => {}, onCancel: () => {}, onRollback: async () => {} },
);

selector.openTab("interaction");
selector.selectSetting("__action:rollback");

process.stdout.write(`${selector.render(width).join("\n")}\n`);
