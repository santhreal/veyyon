/**
 * Print one tab of the real `/settings` surface.
 *
 * `render-settings-compact.ts` answers a sizing question and always lands on the
 * first tab. This one opens a NAMED tab through the selector's own `openTab`
 * hook, so a change to a tab's sections, row labels or row order can be proved
 * as a before/after pair of the same surface:
 *
 *     bun scripts/demos/render-settings-tab.ts --tab agents --height 26 |
 *       bun scripts/demos/render-proof.ts --out /tmp/agents --width 100
 *
 * The component is the one `/settings` constructs, not a drawing of it, so the
 * rows in the image are the rows the schema produces.
 */
import type { SettingTab } from "@veyyon/settings";
import { renderDemo } from "./render-args";
import { createTestSettingsSelector } from "./render-settings-helper";

await renderDemo(
	({ width, flag, theme }) => {
		const tab = flag("tab", "agents") as SettingTab;
		const downCount = Number(flag("down", "0"));
		const selector = createTestSettingsSelector(theme);
		selector.openTab(tab);
		for (let step = 0; step < downCount; step++) selector.handleInput("\x1b[B");
		return selector.render(width);
	},
	{ settings: true, defaultHeight: 26 },
);
