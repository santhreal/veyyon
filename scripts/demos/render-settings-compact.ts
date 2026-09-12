/**
 * Print the real `/settings` surface at a compact width and height.
 *
 * Usage:
 *
 *     bun scripts/demos/render-settings-compact.ts --width 70 --height 14 --down 10
 */
import { renderDemo } from "./render-args";
import { createTestSettingsSelector } from "./render-settings-helper";

await renderDemo(
	({ width, flag, theme }) => {
		const downCount = Number(flag("down", "10"));
		const selector = createTestSettingsSelector(theme);
		for (let step = 0; step < downCount; step++) selector.handleInput("\x1b[B");
		return selector.render(width);
	},
	{ settings: true, defaultHeight: 14 },
);
