import { logger } from "@veyyon/utils";
import type { CommitAgentState } from "../../../commit/agentic/state";
import type { ModelRegistry } from "../../../config/model-registry";
import type { Settings } from "../../../config/settings";
import type { CustomTool } from "../../../extensibility/custom-tools/types";
import type { AuthStorage } from "../../../session/auth-storage";
import { loadBundledAgents } from "../../../task/agents";
import { preferredSubagentName, resolveEnabledSubagents } from "../../../task/subagent-settings";
import { createAnalyzeFileTool } from "./analyze-file";
import { createGitFileDiffTool } from "./git-file-diff";
import { createGitHunkTool } from "./git-hunk";
import { createGitOverviewTool } from "./git-overview";
import { createProposeChangelogTool } from "./propose-changelog";
import { createProposeCommitTool } from "./propose-commit";
import { createRecentCommitsTool } from "./recent-commits";
import { createSplitCommitTool } from "./split-commit";

export interface CommitToolOptions {
	cwd: string;
	authStorage: AuthStorage;
	modelRegistry: ModelRegistry;
	settings: Settings;
	state: CommitAgentState;
	changelogTargets: string[];
	enableAnalyzeFiles?: boolean;
}

/**
 * The agent `analyze_files` would rather fan out to: the cheapest lane, because
 * each spawn summarizes one file and nothing more.
 *
 * A preference, not a requirement. Nothing about reading one diff needs this
 * particular agent, so an operator who has it off should still get file
 * analysis from whatever they do have on.
 */
const COMMIT_ANALYSIS_PREFERRED_AGENT = "sonic";

/**
 * The agent the commit flow fans file analysis out to, or `undefined` when this
 * profile can spawn nothing at all.
 *
 * This used to be the literal `sonic`, in three places at once: the session's
 * `spawns` capability, the `agent` field of every spawn, and the tool
 * description. An operator who turned `sonic` off therefore got a session
 * allowed to spawn exactly one agent that the enablement check then refused,
 * once per file, and the refusals were flattened into the analysis text the
 * commit message is written from. The commit still came out; it came out
 * without the evidence it claims to be based on, and nothing said so.
 *
 * So the name is resolved against the live enabled catalog, the same source the
 * `task` tool answers from. Falling back is right HERE, unlike the eval bridge
 * which refuses rather than substitute: the bridge is honouring an agent the
 * caller named, and quietly routing that to a wider lane would spend the
 * operator's money on something they did not ask for. Nobody asks for `sonic`.
 * It is this code's own cost preference, so substituting a different enabled
 * agent gives the operator the analysis they wanted at the price they
 * configured, and refusing would break commit-message generation over a
 * preference they never expressed.
 *
 * `undefined` is the one case with no substitute, and the caller drops the tool
 * instead of offering one whose every call is refused.
 *
 * The tool DESCRIPTION still says "sonic" verbatim. It is model-facing text, so
 * changing its wording needs baseline-vs-candidate benchmarks this fix does not
 * carry, and nothing about which agent is spawned reads that sentence. Left as a
 * separate, benchmarked change rather than smuggled in here.
 */
export function commitAnalysisSpawnTarget(settings: Settings): string | undefined {
	const catalog = resolveEnabledSubagents({ settings, agents: loadBundledAgents() });
	return preferredSubagentName(
		catalog.agents.map(agent => agent.name),
		COMMIT_ANALYSIS_PREFERRED_AGENT,
	);
}

export function createCommitTools(options: CommitToolOptions): Array<CustomTool<any, any>> {
	const tools: Array<CustomTool<any, any>> = [
		createGitOverviewTool(options.cwd, options.state),
		createGitFileDiffTool(options.cwd, options.state),
		createGitHunkTool(options.cwd),
		createRecentCommitsTool(options.cwd),
	];

	if (options.enableAnalyzeFiles ?? true) {
		const analysisAgent = commitAnalysisSpawnTarget(options.settings);
		if (analysisAgent === undefined) {
			// Withheld rather than offered-and-refused. The model cannot be told
			// mid-run that a tool it was given does not work, so the honest move is
			// to not list it: the commit message is then written from the diff and
			// hunks, which is a real answer rather than an empty one. The log line
			// is the only place an operator can learn why their analysis stopped
			// happening, since a missing tool leaves no other trace.
			logger.warn("Commit agent: file analysis unavailable, no subagent is enabled", {
				preferred: COMMIT_ANALYSIS_PREFERRED_AGENT,
			});
		} else {
			tools.push(
				createAnalyzeFileTool({
					cwd: options.cwd,
					authStorage: options.authStorage,
					modelRegistry: options.modelRegistry,
					settings: options.settings,
					analysisAgent,
					state: options.state,
				}),
			);
		}
	}

	tools.push(
		createProposeChangelogTool(options.state, options.changelogTargets),
		createProposeCommitTool(options.cwd, options.state),
		createSplitCommitTool(options.cwd, options.state, options.changelogTargets),
	);

	return tools;
}
