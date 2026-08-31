import { type } from "arktype";
import type { CommitAgentState, GitOverviewSnapshot } from "../../../commit/agentic/state";
import { extractScopeCandidates } from "../../../commit/analysis/scope";
// Use the canonical machine-generated-file predicate so git_overview hides exactly the
// files the rest of commit analysis (scope, map-reduce) hides. A private copy here once
// keyed on the narrower manifest-only EXCLUDED_LOCK_FILES set with a case-sensitive
// match, so it leaked generated lock files (deno.lock, npm-shrinkwrap.json, uppercase
// CARGO.LOCK, ...) into the model's overview.
import { isExcludedFile } from "../../../commit/utils/exclusions";
import type { CustomTool } from "../../../extensibility/custom-tools/types";
import * as git from "../../../utils/git";

function filterExcludedFiles(files: string[]): { filtered: string[]; excluded: string[] } {
	const filtered: string[] = [];
	const excluded: string[] = [];
	for (const file of files) {
		if (isExcludedFile(file)) {
			excluded.push(file);
		} else {
			filtered.push(file);
		}
	}
	return { filtered, excluded };
}

const gitOverviewSchema = type({
	"staged?": type("boolean").describe("use staged changes (default true)"),
	"include_untracked?": type("boolean").describe("include untracked when unstaged"),
});

export function createGitOverviewTool(cwd: string, state: CommitAgentState): CustomTool<typeof gitOverviewSchema> {
	return {
		name: "git_overview",
		label: "Git Overview",
		description: "Return staged files, diff stat summary, and numstat entries.",
		parameters: gitOverviewSchema,
		async execute(_toolCallId, params) {
			const staged = params.staged ?? true;
			const allFiles = await git.diff.changedFiles(cwd, { cached: staged });
			const { filtered: files, excluded } = filterExcludedFiles(allFiles);
			const stat = await git.diff(cwd, { stat: true, cached: staged });
			const allNumstat = await git.diff.numstat(cwd, { cached: staged });
			const numstat = allNumstat.filter(entry => !isExcludedFile(entry.path));
			const scopeResult = extractScopeCandidates(numstat);
			const untrackedFiles = !staged && params.include_untracked ? await git.ls.untracked(cwd) : undefined;
			const snapshot: GitOverviewSnapshot = {
				files,
				stat,
				numstat,
				scopeCandidates: scopeResult.scopeCandidates,
				isWideScope: scopeResult.isWide,
				untrackedFiles,
				excludedFiles: excluded.length > 0 ? excluded : undefined,
			};
			state.overview = snapshot;
			return {
				content: [{ type: "text", text: JSON.stringify(snapshot, null, 2) }],
				details: snapshot,
			};
		},
	};
}
