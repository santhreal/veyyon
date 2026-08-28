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

/** The agent `analyze_files` would rather fan out to: the cheapest lane, because each spawn summarizes one file and nothing more. */
const COMMIT_ANALYSIS_PREFERRED_AGENT = "sonic";

/** The agent the commit flow fans file analysis out to, or `undefined` when this profile can spawn nothing at all. */
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
			// Withheld rather than offered-and-refused. The model cannot be told mid-run that a tool it was given does not work, so the honest move is
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
