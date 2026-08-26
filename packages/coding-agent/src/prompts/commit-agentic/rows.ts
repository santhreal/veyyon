/**
 * The `commit-agentic/` prompt rows. Each directory owns its rows so importing one prompt doesn't reach all
 * 163 (the old single-module layout made `tools/read.ts` pay 167 modules). Invariant: every `.md` is
 * imported by exactly one row module, aggregated by `registry.ts`, nothing else imports a `.md`.
 * `test/core/prompt-registry-coverage.test.ts` pins this. DO NOT re-declare a row another module holds.
 */

import { definePromptRows, type PromptEntry } from "@veyyon/utils/prompt-registry";

import commitAgenticAnalyzeFile from "./analyze-file.md" with { type: "text" };
import commitAgenticSessionUser from "./session-user.md" with { type: "text" };
import commitAgenticSplitConfirm from "./split-confirm.md" with { type: "text" };
import commitAgenticSystem from "./system.md" with { type: "text" };

/** Every prompt under `src/prompts/commit-agentic/`, keyed by its id (the path under `src/prompts/`). */
export const commitAgenticPrompts = definePromptRows({
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
} satisfies Record<string, PromptEntry>);
