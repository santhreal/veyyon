/**
 * Print the composer footline's capability group under a rising number of
 * simultaneous states, one row per load.
 *
 * WHY THIS DEMO EXISTS. Every part of the footline is separated by `  ·  `
 * except the states packed INSIDE the mode segment, which used to be joined
 * with a single space. With one state active that reads fine; with three
 * (`YOLO`, a mode label, a goal readout) the row degenerates into a run of
 * words with no visible boundary, and the boundary that does exist — the dot
 * between segments — sits at the wrong strength. The bug is therefore not
 * visible in any single screenshot: it only appears as the state COUNT rises,
 * so the proof has to be a ladder rather than a snapshot.
 *
 * Run:
 *     bun scripts/demos/render-mode-states.ts --width 100
 *     bun scripts/demos/render-mode-states.ts --width 100 |
 *       bun scripts/demos/render-proof.ts --out /tmp/mode-states --width 100
 *
 * Every value is fixed, so two runs of the same build produce the same bytes.
 */
import { StatusLineComponent } from "../../packages/coding-agent/src/modes/components/status-line/component";
import { theme } from "../../packages/coding-agent/src/modes/theme/theme";
import type { AgentSession } from "../../packages/coding-agent/src/session/agent-session";
import { flag, initRender, renderWidth } from "./render-args";

const themeName = flag("theme", "titanium");
const width = renderWidth();
await initRender(themeName, { settings: true });

interface StateLoad {
	readonly label: string;
	readonly bypassed?: boolean;
	readonly approvalMode?: string;
	readonly plan?: { enabled: boolean; paused: boolean };
	readonly goal?: { enabled: boolean; paused: boolean };
	readonly goalState?: { tokensUsed: number; tokenBudget?: number; status?: string };
	readonly vibe?: boolean;
	readonly loop?: boolean;
	readonly subagents?: number;
}

function stubSession(load: StateLoad): AgentSession {
	const usage = {
		input: 12_000,
		output: 3_400,
		cacheRead: 48_000,
		cacheWrite: 1_200,
		totalTokens: 64_600,
		orchestrationInput: 0,
		orchestrationOutput: 0,
		orchestrationCacheRead: 0,
		premiumRequests: 2,
		cost: 0.42,
		tokensPerSecond: 58.4,
	};
	const goal = load.goalState
		? {
				goal: {
					tokensUsed: load.goalState.tokensUsed,
					tokenBudget: load.goalState.tokenBudget,
					status: load.goalState.status ?? "active",
				},
			}
		: undefined;
	return {
		messages: [],
		model: { contextWindow: 200_000, id: "gpt-5", name: "gpt-5", provider: "openai" },
		contextUsageRevision: 0,
		systemPrompt: [],
		agent: { state: { tools: [] } },
		skills: [],
		getContextUsage: () => ({ tokens: 84_000, contextWindow: 200_000 }),
		state: { messages: [], model: { contextWindow: 200_000, id: "gpt-5", name: "gpt-5" } },
		sessionManager: {
			getUsageStatistics: () => usage,
			getSessionName: () => "parser-rewrite",
			getCwd: () => "/home/you/code/veyyon",
		},
		getPrewalkState: () => undefined,
		getAsyncJobSnapshot: () => undefined,
		getGoalModeState: () => goal,
		settings: {
			getGroup: () => ({ enabled: false }),
			get: (path: string) => (path === "goal.modelBudgetsEnabled" ? true : undefined),
		},
		isAdvisorActive: () => false,
		isApprovalBypassed: () => load.bypassed === true,
		effectiveApprovalMode: () => load.approvalMode ?? "auto",
		isFastModeActive: () => false,
		isStreaming: false,
		configuredThinkingLevel: () => "medium",
		modelRegistry: { isUsingOAuth: () => false },
	} as unknown as AgentSession;
}

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
		label: "3 states (yolo + plan + subagents)",
		bypassed: true,
		plan: { enabled: false, paused: true },
		subagents: 3,
	},
	{
		label: "4 states (yolo + goal + budget + subagents)",
		bypassed: true,
		goal: { enabled: true, paused: false },
		goalState: { tokensUsed: 12_345, tokenBudget: 50_000 },
		subagents: 3,
	},
];

const lines: string[] = [];
for (const load of LOADS) {
	const statusLine = new StatusLineComponent(stubSession(load));
	statusLine.updateSettings({ preset: "default" });
	if (load.plan) statusLine.setPlanModeStatus(load.plan);
	if (load.goal) statusLine.setGoalModeStatus(load.goal);
	if (load.vibe) statusLine.setVibeModeStatus({ enabled: true });
	if (load.loop) statusLine.setLoopModeStatus({ enabled: true });
	statusLine.setSubagentCount(load.subagents ?? 0);
	lines.push(theme.fg("dim", `${load.label}:`));
	lines.push(statusLine.renderQuietLine(width) ?? theme.fg("error", "(no footline rendered)"));
	lines.push("");
}

process.stdout.write(`${lines.join("\n")}\n`);
