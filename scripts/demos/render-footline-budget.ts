/**
 * Render status footline presets across terminal widths and column budgets.
 *
 * Evaluates status line presets across 80, 100, and 120 column terminal widths with
 * composer horizontal insets. Renders quiet lines for standard sessions or focused
 * subagent sessions, and prints each preset along with its segment allocations as
 * ANSI text.
 *
 * Usage:
 *   bun scripts/demos/render-footline-budget.ts [--focused] [--cwd <path>] [--theme titanium]
 */

import { COMPOSER_INSET_COLS } from "../../packages/coding-agent/src/modes/terminal/components/composer/composer-chrome";
import { StatusLineComponent } from "../../packages/coding-agent/src/modes/terminal/components/status-line/component";
import { STATUS_LINE_PRESETS } from "../../packages/coding-agent/src/modes/terminal/components/status-line/presets";
import type { StatusLinePreset } from "../../packages/coding-agent/src/modes/terminal/components/status-line/types";
import type { AgentSession } from "../../packages/coding-agent/src/session/agent-session";
import { theme } from "../../packages/coding-agent/src/theme/theme";
import { renderDemo } from "./render-args";

function stubSession(cwd: string): AgentSession {
	return {
		state: { messages: [{ role: "user", content: "hi" }], model: { contextWindow: 200_000 } },
		messages: [{ role: "user", content: "hi" }],
		model: { id: "gpt-5", name: "gpt-5", contextWindow: 200_000 },
		contextUsageRevision: 0,
		systemPrompt: ["You are helpful."],
		agent: { state: { tools: [] } },
		skills: [],
		isStreaming: false,
		isAutoThinking: false,
		autoResolvedThinkingLevel: () => undefined,
		isAdvisorActive: () => false,
		isFastModeActive: () => false,
		isFastModeEnabled: () => false,
		isApprovalBypassed: () => false,
		getGoalModeState: () => null,
		getAsyncJobSnapshot: () => ({ running: [] }),
		getCurrentModel: () => undefined,
		getContextUsage: () => ({ tokens: 84_000, contextWindow: 200_000, percent: 42 }),
		modelRegistry: { isUsingOAuth: () => false },
		settings: { getGroup: () => ({ enabled: false, strategy: "off", threshold: "85%" }) },
		sessionManager: {
			getSessionName: () => "parser-rewrite",
			getCwd: () => cwd,
			getUsageStatistics: () => ({
				input: 12_000,
				output: 5_000,
				cacheRead: 40_000,
				cacheWrite: 1_000,
				totalTokens: 17_000,
				orchestrationInput: 0,
				orchestrationOutput: 0,
				orchestrationCacheRead: 0,
				premiumRequests: 2,
				cost: 0.42,
			}),
		},
	} as unknown as AgentSession;
}

await renderDemo(
	({ flag, hasFlag }) => {
		const focused = hasFlag("focused");
		const cwd = flag("cwd", "/home/you/code/veyyon");
		const COLUMNS = [80, 100, 120];
		const presets = Object.keys(STATUS_LINE_PRESETS) as StatusLinePreset[];
		const lines: string[] = [];

		for (const columns of COLUMNS) {
			const given = columns - COMPOSER_INSET_COLS;
			lines.push(theme.fg("dim", `${columns} columns (budget ${given - 1}):`));
			for (const preset of presets) {
				const component = new StatusLineComponent(stubSession(cwd));
				component.updateSettings({ preset });
				if (focused) component.setSession(stubSession(cwd), "designer-3");
				const line = component.renderQuietLine(given);
				const label = theme.fg("muted", preset.padEnd(8));
				lines.push(`${label}${" ".repeat(COMPOSER_INSET_COLS)}${line ?? theme.fg("dim", "(nothing)")}`);
				const ids = component
					.getQuietSegmentBounds()
					.slice()
					.sort((a, b) => a.start - b.start)
					.map(slot => slot.id)
					.join(" ");
				lines.push(theme.fg("dim", `        ${" ".repeat(COMPOSER_INSET_COLS)}${ids}`));
			}
			lines.push("");
		}
		console.error("note: the `profile` and `git` segments read this machine; everything else is the fixed stub.");
		return lines;
	},
	{ settings: true },
);
