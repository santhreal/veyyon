import { stripVTControlCharacters } from "node:util";
import { Settings } from "../../packages/coding-agent/src/config/settings";
import { SETTING_TABS } from "../../packages/coding-agent/src/config/settings-schema";
import { renderDemo } from "./render-args";
import { createTestSettingsSelector } from "./render-settings-helper";

await renderDemo(
	async ({ theme, width, flag }) => {
		const tab = flag("tab", "rules");
		if (!SETTING_TABS.includes(tab as (typeof SETTING_TABS)[number])) {
			throw new Error(`unknown tab ${JSON.stringify(tab)}; one of: ${SETTING_TABS.join(", ")}`);
		}
		const agentDir = flag("agent-dir", "");
		if (agentDir.length > 0) await Settings.init({ agentDir });

		const selector = createTestSettingsSelector(theme);

		async function settle(ready: () => boolean, attempts = 200): Promise<void> {
			for (let attempt = 0; attempt < attempts; attempt++) {
				if (ready()) return;
				const tick = Promise.withResolvers<void>();
				setImmediate(tick.resolve);
				await tick.promise;
			}
			throw new Error("the rule list never finished loading");
		}

		selector.openTab(tab as (typeof SETTING_TABS)[number]);
		const open = flag("open", "");
		if (open.length > 0) {
			for (const character of open) selector.handleInput(character);
			selector.handleInput("\r");
			await settle(() => !selector.render(width).join("\n").includes("Reading rules"));
		}

		const section = flag("section", "");
		if (section.length > 0) {
			if (open.length === 0) throw new Error("--section needs --open to reach the rule list first");
			const CURSOR = "\u203a";
			for (let step = 0; ; step++) {
				const landed = selector.render(width).some(line => {
					const columns = stripVTControlCharacters(line).split("\u2502");
					const pane = columns.at(-2) ?? "";
					return columns.length >= 3 && pane.trimStart().startsWith(CURSOR) && pane.includes(section);
				});
				if (landed) break;
				if (step >= 40) throw new Error(`no section row matching ${JSON.stringify(section)}`);
				selector.handleInput("\x1b[B");
			}
			selector.handleInput("\r");
			if (selector.render(width).join("\n").includes("Rules by section")) {
				throw new Error(`Enter on ${JSON.stringify(section)} did not open a section`);
			}
		}
		return selector.render(width);
	},
	{ settings: true, defaultHeight: 26 },
);
