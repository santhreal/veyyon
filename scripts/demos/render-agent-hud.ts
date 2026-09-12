/**
 * Render the agent heads-up display lines with model badges and rail animations.
 *
 * Render the Agents HUD block the way interactive mode draws it, so the block
 * and its rail sweep can be LOOKED AT while they are being built.
 *
 * Builds mock observable subagent sessions with tool executions, model descriptions, and
 * retry states. Renders the subagent HUD lines and optionally applies idle rail motion
 * styling for a designated frame index, printing the result as ANSI text.
 *
 * Usage:
 *   bun scripts/demos/render-agent-hud.ts [--frame <n>] [--width 100] [--theme titanium]
 *
 * The fixtures are four running agents: one deep in a long command, one that
 * just opened a file, one waiting on the model, and one with no description at
 * all.
 *
 * `--frame N` renders one frame of the rail sweep, so a sequence of proofs is a
 * sequence of frames; without it the block is static, which is what a terminal
 * with `display.transitions: off` draws.
 */

import { renderAgentHudLines } from "../../packages/coding-agent/src/modes/terminal/components/dashboard/agent-hud";
import { paintRailMotion, railIdleHeadAt } from "../../packages/coding-agent/src/modes/terminal/draw/rail-motion";
import type { ObservableSession } from "../../packages/coding-agent/src/modes/terminal/session-observer-registry";
import type { AgentProgress } from "../../packages/coding-agent/src/task";
import { theme } from "../../packages/coding-agent/src/theme/theme";
import { renderDemo } from "./render-args";

const BASE_MS = 1_700_000_000_000;

const AGENTS: Array<{
	id: string;
	description: string;
	model: string;
	tool?: string;
	toolArgs?: string;
	retry?: { attempt: number; maxAttempts: number; delaySec: number; errorMessage: string };
}> = [
	{
		id: "DockerSecretHarness",
		description: "Build containerized harness for /secret flow",
		model: "anthropic/claude-opus-5:high",
		tool: "bash",
		toolArgs: "cargo test --workspace --all-targets",
	},
	{
		id: "SecretModeFlowUX",
		description: "Surface secret-use signals in yolo mode transcripts",
		model: "anthropic/claude-opus-5:high",
		tool: "read",
		toolArgs: "modes/terminal/interactive-mode.ts",
	},
	{
		id: "SecretModularityAudit",
		description: "Audit secrets subsystem modularity, wiring, and dead exports",
		model: "anthropic/claude-opus-5:medium",
	},
	{
		id: "RateLimitedWorker",
		description: "Port the vault settings domain onto the new reader",
		model: "anthropic/claude-opus-5:high",
		retry: { attempt: 2, maxAttempts: 5, delaySec: 38, errorMessage: "429 rate limit exceeded" },
	},
];

function session(agent: (typeof AGENTS)[number], index: number): ObservableSession {
	const progress = {
		index,
		agent: "task",
		agentSource: "bundled",
		id: agent.id,
		status: "running",
		task: agent.description,
		description: agent.description,
		currentTool: agent.tool,
		currentToolArgs: agent.toolArgs,
		recentTools: [],
		recentOutput: [],
		toolCount: 4,
		requests: 4,
		durationMs: 64_000,
		resolvedModel: agent.model,
		retryState: agent.retry
			? {
					attempt: agent.retry.attempt,
					maxAttempts: agent.retry.maxAttempts,
					delayMs: agent.retry.delaySec * 1000,
					errorMessage: agent.retry.errorMessage,
					startedAtMs: BASE_MS,
				}
			: undefined,
		tokens: 0,
		cost: 0,
	} as unknown as AgentProgress;
	return {
		kind: "spawn",
		id: agent.id,
		label: agent.id,
		status: "active",
		detached: true,
		lastUpdate: BASE_MS,
		description: agent.description,
		progress,
	} as ObservableSession;
}

await renderDemo(({ width, flag, hasFlag }) => {
	const frame = hasFlag("frame") ? Number.parseInt(flag("frame", "0"), 10) : undefined;
	const sessions = AGENTS.map(session);
	const lines = renderAgentHudLines(sessions, { columns: width, showModelBadge: true });
	return frame === undefined ? lines : paintRailMotion(lines, { kind: "idle", head: railIdleHeadAt(frame) }, theme);
});
