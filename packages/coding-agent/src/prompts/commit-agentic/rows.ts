/**
 * The `commit-agentic/` prompt rows: the agentic commit flow.
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

import commitAgenticAnalyzeFile from "./analyze-file.md" with { type: "text" };
import commitAgenticSessionUser from "./session-user.md" with { type: "text" };
import commitAgenticSplitConfirm from "./split-confirm.md" with { type: "text" };
import commitAgenticSystem from "./system.md" with { type: "text" };

/** Every prompt under `src/prompts/commit-agentic/`, keyed by its id (the path under `src/prompts/`). */
export const commitAgenticPrompts = {
	"commit-agentic/analyze-file": {
		text: commitAgenticAnalyzeFile,
		purpose: "asks the agentic commit flow's model to analyze one file",
	},
	"commit-agentic/session-user": {
		text: commitAgenticSessionUser,
		purpose: "opens the agentic commit flow over the staged changes",
	},
	"commit-agentic/split-confirm": {
		text: commitAgenticSplitConfirm,
		purpose: "asks the operator to confirm a multi-commit split",
	},
	"commit-agentic/system": { text: commitAgenticSystem, purpose: "drives the agentic commit flow" },
} satisfies Record<string, PromptEntry>;
