/**
 * Bench for the setup wizard's Agents scene.
 *
 * Renders the scene at 100 columns twice, once with only `task` enabled and once
 * with `task`, `reviewer`, and `scout`, then times 500 renders of each and
 * prints both timings.
 *
 * The timings are the smaller half of the point. The layout check runs first:
 * the two states must produce the same display width on every line, so ticking
 * a specialist cannot reflow the list under the cursor. A mismatch throws before
 * any timing is taken. The theme and the ANSI policy are pinned so those widths
 * do not depend on the terminal you run it in.
 *
 * Takes no arguments.
 *
 * Run:
 *     bun scripts/demos/bench-setup-subagents.ts
 */
import { stripVTControlCharacters } from "node:util";
import { Settings } from "../../packages/coding-agent/src/config/settings";
import { AgentsSceneController } from "../../packages/coding-agent/src/modes/setup-wizard/scenes/agents";
import type { SetupSceneHost } from "../../packages/coding-agent/src/modes/setup-wizard/scenes/types";
import { initTheme } from "../../packages/coding-agent/src/modes/theme/theme";
import { loadBundledAgents } from "../../packages/coding-agent/src/task/agents";
import { setAnsiPolicy } from "../../packages/tui/src/index";

const ITERATIONS = 500;
const WIDTH = 100;

await initTheme(false, "unicode", false, "titanium", "light");
setAnsiPolicy("full");

const agents = loadBundledAgents().toSorted((left, right) =>
	left.name === "task" ? -1 : right.name === "task" ? 1 : left.name.localeCompare(right.name),
);

function settingsFor(enabled: ReadonlySet<string>): Settings {
	return Settings.isolated({
		"subagent.agents": Object.fromEntries(agents.map(agent => [agent.name, { enabled: enabled.has(agent.name) }])),
	});
}

function render(settings: Settings): readonly string[] {
	const host = {
		ctx: { settings },
		requestRender: () => {},
		finish: () => {},
		setFocus: () => {},
		restoreFocus: () => {},
	} as unknown as SetupSceneHost;
	return new AgentsSceneController(host, agents).render(WIDTH);
}

function lineWidths(lines: readonly string[]): number[] {
	return lines.map(line => Bun.stringWidth(stripVTControlCharacters(line)));
}

const defaultSettings = settingsFor(new Set(["task"]));
const specialistsSettings = settingsFor(new Set(["task", "reviewer", "scout"]));
const defaultProjection = lineWidths(render(defaultSettings));
const specialistsProjection = lineWidths(render(specialistsSettings));
if (!Bun.deepEquals(defaultProjection, specialistsProjection)) {
	throw new Error("Enabling specialist agents changed selector line count or display widths");
}

const defaultStart = performance.now();
for (let index = 0; index < ITERATIONS; index += 1) render(defaultSettings);
const defaultMs = performance.now() - defaultStart;

const specialistsStart = performance.now();
for (let index = 0; index < ITERATIONS; index += 1) render(specialistsSettings);
const specialistsMs = performance.now() - specialistsStart;

process.stdout.write(
	`${JSON.stringify(
		{
			agents: agents.length,
			iterations: ITERATIONS,
			defaultMs: Number(defaultMs.toFixed(3)),
			specialistsMs: Number(specialistsMs.toFixed(3)),
			lineWidths: defaultProjection,
			layoutParity: true,
		},
		null,
		2,
	)}\n`,
);
