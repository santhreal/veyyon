/**
 * Render status footlines across agent operating mode configurations.
 *
 * Builds mock sessions with combinations of approval bypass, plan mode, goal mode
 * with token budgets, vibe mode, loop mode, and active subagent counts. Renders the
 * status line component for each state combination and prints the resulting lines as
 * ANSI text.
 *
 * Usage:
 *   bun scripts/demos/render-mode-states.ts [--width 100] [--theme titanium]
 */

import { StatusLineComponent } from "../../packages/coding-agent/src/modes/terminal/components/status-line/component";
import { theme } from "../../packages/coding-agent/src/theme/theme";
import { createStubStatusSession, renderDemo, type StateLoad } from "./render-args";

const LOADS: StateLoad[] = [
	{ label: "1 state  (rung only)", approvalMode: "auto" },
	{ label: "1 state  (yolo only)", bypassed: true },
	{ label: "2 states (rung + goal)", approvalMode: "auto", goal: { enabled: true, paused: false } },
	{ label: "2 states (yolo + goal)", bypassed: true, goal: { enabled: true, paused: false } },
	{
		label: "3 states (yolo + goal + budget)",
		bypassed: true,
		goal: { enabled: true, paused: false },
		goalState: { tokensUsed: 12_345, tokenBudget: 50_000 },
	},
	{
		label: "3 states (yolo + plan + agents)",
		bypassed: true,
		plan: { enabled: false, paused: true },
		agents: 3,
	},
	{
		label: "4 states (yolo + goal + budget + agents)",
		bypassed: true,
		goal: { enabled: true, paused: false },
		goalState: { tokensUsed: 12_345, tokenBudget: 50_000 },
		agents: 3,
	},
];

await renderDemo(
	({ width }) => {
		const lines: string[] = [];
		for (const load of LOADS) {
			const statusLine = new StatusLineComponent(createStubStatusSession(load));
			statusLine.updateSettings({ preset: "default" });
			if (load.plan) statusLine.setPlanModeStatus(load.plan);
			if (load.goal) statusLine.setGoalModeStatus(load.goal);
			if (load.vibe) statusLine.setVibeModeStatus({ enabled: true });
			if (load.loop) statusLine.setLoopModeStatus({ enabled: true });
			statusLine.setAgentCount(load.agents ?? 0);
			lines.push(theme.fg("dim", `${load.label}:`));
			lines.push(statusLine.renderQuietLine(width) ?? theme.fg("error", "(no footline rendered)"));
			lines.push("");
		}
		return lines;
	},
	{ settings: true },
);
