/** The `commit-agentic/` prompt rows: the agentic commit flow. and it aggregates every module like this one; what changed is that the 163 `import … with { type: "text" }` */

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
