import { stripVTControlCharacters } from "node:util";
import { Settings } from "../../packages/coding-agent/src/config/settings";
import { AgentsSceneController } from "../../packages/coding-agent/src/modes/setup-wizard/scenes/agents";
import { initTheme, theme } from "../../packages/coding-agent/src/modes/theme/theme";
import { loadBundledAgents } from "../../packages/coding-agent/src/task/agents";
import { setAnsiPolicy } from "../../packages/tui/src/index";
import { flag, renderWidth } from "./render-args";

const width = renderWidth();
const enabled = new Set(
	flag("enabled", "task")
		.split(",")
		.map(name => name.trim())
		.filter(Boolean),
);

await initTheme(false, "unicode", false, "titanium", "light");
setAnsiPolicy("full");

const agents = loadBundledAgents().toSorted((left, right) =>
	left.name === "task" ? -1 : right.name === "task" ? 1 : left.name.localeCompare(right.name),
);
const known = new Set(agents.map(agent => agent.name));
for (const name of enabled) {
	if (!known.has(name)) throw new Error(`unknown bundled agent "${name}"`);
}

const settings = Settings.isolated({
	"subagent.agents": Object.fromEntries(agents.map(agent => [agent.name, { enabled: enabled.has(agent.name) }])),
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
const output = [theme.fg("accent", controller.title), theme.fg("muted", controller.subtitle), "", ...body].join("\n");

if (flag("plain", "false") === "true") {
	process.stdout.write(`${stripVTControlCharacters(output)}\n`);
} else {
	process.stdout.write(`${output}\n`);
}
