import { stripVTControlCharacters } from "node:util";
import { Settings } from "../../packages/coding-agent/src/config/settings";
import { AgentsSceneController } from "../../packages/coding-agent/src/modes/terminal/setup-wizard/scenes/agents";
import { loadBundledAgents } from "../../packages/coding-agent/src/task/agents";
import { theme } from "../../packages/coding-agent/src/theme/theme";
import { renderDemo } from "./render-args";

await renderDemo(
	({ width, flag }) => {
		const enabled = new Set(
			flag("enabled", "task")
				.split(",")
				.map(name => name.trim())
				.filter(Boolean),
		);
		const agents = loadBundledAgents().toSorted((left, right) =>
			left.name === "task" ? -1 : right.name === "task" ? 1 : left.name.localeCompare(right.name),
		);
		const known = new Set(agents.map(agent => agent.name));
		for (const name of enabled) {
			if (!known.has(name)) throw new Error(`unknown bundled agent "${name}"`);
		}
		const settings = Settings.isolated({
			"agent.agents": Object.fromEntries(agents.map(agent => [agent.name, { enabled: enabled.has(agent.name) }])),
		});
		const controller = new AgentsSceneController(
			{
				ctx: { settings } as never,
				requestRender: () => {},
				finish: () => {},
				skipSetup: () => {},
				setFocus: () => {},
				restoreFocus: () => {},
			},
			agents,
		);
		const body = controller.render(width);
		const output = [theme.fg("accent", controller.title), theme.fg("muted", controller.subtitle), "", ...body].join(
			"\n",
		);
		return flag("plain", "false") === "true" ? stripVTControlCharacters(output) : output;
	},
	{ defaultTheme: "titanium" },
);
