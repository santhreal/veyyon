/**
 * Render the Subagents HUD block the way interactive mode draws it, so the block
 * and its rail sweep can be LOOKED AT while they are being built.
 *
 * This is a debugging aid and not a proof: it draws a fixture written here, at a
 * width chosen here, through a call constructed here, so it cannot show that the
 * block is reachable, that the rows are real, or that a session positions and
 * clips them this way. The proof is a capture taken the way
 * docs/handbook/src/foundations/verification.md says. Output goes to a temporary
 * path and never into assets/, a README, or a handbook page.
 *
 * The fixtures are four running agents: one deep in a long command, one that
 * just opened a file, one waiting on the model, and one with no description at
 * all.
 *
 * Run:
 *
 *     bun scripts/demos/render-subagent-hud.ts --width 100 |
 *       bun scripts/demos/render-proof.ts --out /tmp/hud --width 100 --scale 3
 *
 * `--frame N` renders one frame of the rail sweep, so a sequence of proofs is a
 * sequence of frames; without it the block is static, which is what a terminal
 * with `display.transitions: off` draws. Flags take the space form.
 */

import { renderSubagentHudLines } from "../../packages/coding-agent/src/modes/terminal/components/dashboard/subagent-hud";
import type { ObservableSession } from "../../packages/coding-agent/src/modes/terminal/session-observer-registry";
import type { AgentProgress } from "../../packages/coding-agent/src/task";
import { theme } from "../../packages/coding-agent/src/theme/theme";
import { paintRailMotion, railIdleHeadAt } from "../../packages/coding-agent/src/tui/rail-motion";
import { flag, hasFlag, initRender, renderWidth } from "./render-args";

const columns = renderWidth();
const frame = hasFlag("frame") ? Number.parseInt(flag("frame", "0"), 10) : undefined;

/**
 * A fixed epoch, so a countdown a proof shows is the same one every time it is
 * regenerated. `Date.now()` here made the images differ run to run in the one
 * column whose whole job is to be compared against yesterday's.
 */
const BASE_MS = 1_700_000_000_000;

/** One agent per lane state, so a single image carries the whole vocabulary. */
const AGENTS: Array<{
	id: string;
	description: string;
	model: string;
	tool?: string;
	toolArgs?: string;
	/** Set for the agent asleep between provider attempts. */
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
		kind: "subagent",
		id: agent.id,
		label: agent.id,
		status: "active",
		detached: true,
		lastUpdate: BASE_MS,
		description: agent.description,
		progress,
	} as ObservableSession;
}

await initRender(flag("theme", "titanium"));
const sessions = AGENTS.map(session);
const lines = renderSubagentHudLines(sessions, { columns, showModelBadge: true });
// The same painting interactive mode does, from the same owner: one sweep down
// the whole block, the same one a tool block runs.
const painted =
	frame === undefined ? lines : paintRailMotion(lines, { kind: "idle", head: railIdleHeadAt(frame) }, theme);
process.stdout.write(`${painted.join("\n")}\n`);
