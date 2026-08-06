/**
 * The composer footline at the widths people actually run, one row per preset.
 *
 * The footline sheds parts from the right group when the line will not fit, so a
 * segment can be configured, rendered, measured and then thrown away before it ever
 * reaches the screen. Reading `renderQuietLine` cannot tell you that happened: the
 * only way to see it is to render the same preset at several widths and compare which
 * segments survived. 80, 100 and 120 columns are the sizes a terminal actually is.
 *
 * The width passed here is the TERMINAL width. The composer insets by
 * `COMPOSER_INSET_COLS`, and the footline keeps one cell of right margin, so the
 * budget a segment competes for is `columns - 3`. Rendering at `columns` and eyeballing
 * the result would over-report the room by three cells and hide a shed at the boundary.
 *
 * Run:
 *
 *     bun scripts/demos/render-footline-budget.ts |
 *       bun scripts/demos/render-proof.ts --out /tmp/footline-budget --width 120
 *
 * `--focused` prefixes the agent-focus badge, which is the widest thing that can ever
 * ride the line and therefore the case where shedding starts earliest.
 *
 * The session is a FIXED stub so two runs are byte-comparable. `profile` and `git` still
 * read this machine; a note goes to stderr so nobody reads a hostname difference as a
 * change to the layout.
 */
import { COMPOSER_INSET_COLS } from "../../packages/coding-agent/src/modes/components/composer-chrome";
import { StatusLineComponent } from "../../packages/coding-agent/src/modes/components/status-line/component";
import { STATUS_LINE_PRESETS } from "../../packages/coding-agent/src/modes/components/status-line/presets";
import type { StatusLinePreset } from "../../packages/coding-agent/src/modes/components/status-line/types";
import { theme } from "../../packages/coding-agent/src/modes/theme/theme";
import type { AgentSession } from "../../packages/coding-agent/src/session/agent-session";
import { flag, hasFlag, initRender } from "./render-args";

const themeName = flag("theme", "titanium");
const focused = hasFlag("focused");
// A short path never exercises the preset's `path.maxLength`, so the budgets that differ
// between presets (30 on `minimal`, 60 on `nerd`) are invisible until the path is long.
const cwd = flag("cwd", "/home/you/code/veyyon");
await initRender(themeName, { settings: true });

/** Every value the footline can read, all of them fixed. */
function stubSession(): AgentSession {
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

const COLUMNS = [80, 100, 120];
const presets = Object.keys(STATUS_LINE_PRESETS) as StatusLinePreset[];
const lines: string[] = [];

for (const columns of COLUMNS) {
	// The width the footline is actually handed, and the budget it lays out into.
	const given = columns - COMPOSER_INSET_COLS;
	lines.push(theme.fg("dim", `${columns} columns (budget ${given - 1}):`));
	for (const preset of presets) {
		const component = new StatusLineComponent(stubSession());
		component.updateSettings({ preset });
		if (focused) component.setSession(stubSession(), "designer-3");
		const line = component.renderQuietLine(given);
		const label = theme.fg("muted", preset.padEnd(8));
		lines.push(`${label}${" ".repeat(COMPOSER_INSET_COLS)}${line ?? theme.fg("dim", "(nothing)")}`);
		// What SURVIVED, by segment id, so a shed reads as a missing name rather than
		// as text that happens to be shorter.
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

process.stdout.write(`${lines.join("\n")}\n`);
console.error("note: the `profile` and `git` segments read this machine; everything else is the fixed stub.");
