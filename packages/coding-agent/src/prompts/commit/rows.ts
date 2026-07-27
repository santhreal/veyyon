/**
 * The `commit/` prompt rows: the mapped and reduced commit flow.
 *
 * WHY EACH DIRECTORY OWNS ITS OWN ROWS. `registry.ts` is still the ONE place that says which prompts exist,
 * and it aggregates every module like this one; what changed is that the 163 `import … with { type: "text" }`
 * specifiers no longer sit in a single module. They did, and the consequence was that importing one prompt
 * statically reached all 163: `tools/read.ts` needs `PROMPTS["tools/read"]` to render its own description and
 * paid 167 modules for it, the largest single edge that file had. A consumer now imports the directory it
 * belongs to and pays for that directory.
 *
 * THE INVARIANT IS UNCHANGED AND IS CHECKED ONE LEVEL DEEPER. Every `.md` under `src/prompts/` is imported by
 * exactly one row module, every row module is aggregated by `registry.ts`, and nothing else in the repository
 * may import a `.md`. `packages/coding-agent/test/core/prompt-registry-coverage.test.ts` pins all three, so a
 * new prompt is still unreachable code until it is registered, and a row still cannot describe a file that is
 * not there.
 *
 * DO NOT re-declare a row that another module already holds. The id-to-file mapping exists exactly once, here
 * for these ids, and the coverage suite fails on a second importer.
 */

import type { PromptEntry } from "@veyyon/utils/prompt-registry";

import commitAnalysisSystem from "./analysis-system.md" with { type: "text" };
import commitAnalysisUser from "./analysis-user.md" with { type: "text" };
import commitChangelogSystem from "./changelog-system.md" with { type: "text" };
import commitChangelogUser from "./changelog-user.md" with { type: "text" };
import commitFileObserverSystem from "./file-observer-system.md" with { type: "text" };
import commitFileObserverUser from "./file-observer-user.md" with { type: "text" };
import commitMessageSystem from "./message-system.md" with { type: "text" };
import commitReduceSystem from "./reduce-system.md" with { type: "text" };
import commitReduceUser from "./reduce-user.md" with { type: "text" };
import commitSummaryRetry from "./summary-retry.md" with { type: "text" };
import commitSummarySystem from "./summary-system.md" with { type: "text" };
import commitSummaryUser from "./summary-user.md" with { type: "text" };
import commitTypesDescription from "./types-description.md" with { type: "text" };

/** Every prompt under `src/prompts/commit/`, keyed by its id (the path under `src/prompts/`). */
export const commitPrompts = {
	"commit/analysis-system": {
		text: commitAnalysisSystem,
		purpose: "classifies a diff into conventional-commit terms",
	},
	"commit/analysis-user": {
		text: commitAnalysisUser,
		purpose: "the analysis task, carrying the diff and project context",
	},
	"commit/changelog-system": { text: commitChangelogSystem, purpose: "writes changelog entries from commits" },
	"commit/changelog-user": {
		text: commitChangelogUser,
		purpose: "the changelog task, carrying the target file and existing entries",
	},
	"commit/file-observer-system": {
		text: commitFileObserverSystem,
		purpose: "the map phase: describes one changed file",
	},
	"commit/file-observer-user": { text: commitFileObserverUser, purpose: "the map task, carrying one file's diff" },
	"commit/message-system": { text: commitMessageSystem, purpose: "writes a commit message for the non-agentic path" },
	"commit/reduce-system": {
		text: commitReduceSystem,
		purpose: "the reduce phase: folds per-file descriptions into one message",
	},
	"commit/reduce-user": {
		text: commitReduceUser,
		purpose: "the reduce task, carrying the observations and diff statistics",
	},
	"commit/summary-retry": {
		text: commitSummaryRetry,
		purpose: "re-asks for a summary after validation rejected the last one",
	},
	"commit/summary-system": {
		text: commitSummarySystem,
		purpose: "writes the description half of a conventional commit",
	},
	"commit/summary-user": {
		text: commitSummaryUser,
		purpose: "the summary task, carrying the detail points and diff statistics",
	},
	"commit/types-description": {
		text: commitTypesDescription,
		purpose: "the conventional-commit type list shared by the commit prompts",
	},
} satisfies Record<string, PromptEntry>;
