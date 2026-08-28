/** The `advisor/` prompt rows: the background advisor watching a live session. and it aggregates every module like this one; what changed is that the 163 `import … with { type: "text" }` */

import { definePromptRows, type PromptEntry } from "@veyyon/utils/prompt-registry";

import advisorActiveRepoWatchdog from "./active-repo-watchdog.md" with { type: "text" };
import advisorAdviseTool from "./advise-tool.md" with { type: "text" };
import advisorContextFiles from "./context-files.md" with { type: "text" };
import advisorSystem from "./system.md" with { type: "text" };

/** Every prompt under `src/prompts/advisor/`, keyed by its id (the path under `src/prompts/`). */
export const advisorPrompts = definePromptRows({
	"advisor/active-repo-watchdog": {
		text: advisorActiveRepoWatchdog,
		purpose: "extra advisor attention when the session cwd sits outside the one child git repo",
	},
	"advisor/advise-tool": { text: advisorAdviseTool, purpose: "the `advise` tool description the advisor sees" },
	"advisor/context-files": {
		text: advisorContextFiles,
		purpose: "hands the advisor the project's standing instruction files",
	},
	"advisor/system": { text: advisorSystem, purpose: "the background advisor watching a live session" },
} satisfies Record<string, PromptEntry>);
