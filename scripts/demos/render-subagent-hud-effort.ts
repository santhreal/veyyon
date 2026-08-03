/**
 * Render the Subagents HUD block the way the interactive mode draws it, so the effort badge can be
 * proved as an image rather than through a tmux capture.
 *
 * `--effort` appends the resolved effort to each agent's selector, which is what the executor now
 * does for an agent that inherits its effort instead of carrying an explicit `:level` suffix.
 * Without the flag it renders the previous behaviour, so the pair is a differential. Width comes
 * from `--width=N` in that joined form, not `--width N`, and defaults to 100.
 *
 * Run:
 *     bun scripts/demos/render-subagent-hud-effort.ts --effort --width=100 |
 *       bun scripts/demos/render-proof.ts --out /tmp/hud-after --width 100 --scale 3
 *
 * Drop `--effort` and change the `--out` prefix for the before half of the pair.
 */

import { renderSubagentHudLines } from "../../packages/coding-agent/src/modes/interactive-mode";
import type { ObservableSession } from "../../packages/coding-agent/src/modes/session-observer-registry";
import { initTheme } from "../../packages/coding-agent/src/modes/theme/theme";
import type { AgentProgress } from "../../packages/coding-agent/src/task";

const args = new Set(process.argv.slice(2));
const withEffort = args.has("--effort");
const columns = Number(process.argv.find(a => a.startsWith("--width="))?.slice(8) ?? 100);

/** The three agents from the reported screenshot, with the efforts they actually run at. */
const AGENTS: { id: string; description: string; effort: string }[] = [
	{ id: "DockerSecretHarness", description: "Build containerized harness for /secret flow", effort: "high" },
	{ id: "SecretModeFlowUX", description: "Surface secret-use signals in yolo mode transcripts", effort: "high" },
	{
		id: "SecretModularityAudit",
		description: "Audit secrets subsystem modularity, wiring, and dead exports",
		effort: "medium",
	},
];

function session(agent: (typeof AGENTS)[number], index: number): ObservableSession {
	const selector = withEffort ? `anthropic/claude-opus-5:${agent.effort}` : "anthropic/claude-opus-5";
	const progress = {
		index,
		agent: "task",
		agentSource: "bundled",
		id: agent.id,
		status: "running",
		task: agent.description,
		description: agent.description,
		recentTools: [],
		recentOutput: [],
		resolvedModel: selector,
		tokens: 0,
		cost: 0,
	} as unknown as AgentProgress;
	return {
		kind: "subagent",
		id: agent.id,
		label: agent.id,
		status: "active",
		detached: true,
		lastUpdate: Date.now(),
		description: agent.description,
		progress,
	} as ObservableSession;
}

await initTheme();
const lines = renderSubagentHudLines(AGENTS.map(session), columns, true);
process.stdout.write(`${lines.join("\n")}\n`);
