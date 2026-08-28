/** The `autoresearch/` prompt rows: the autoresearch loop. and it aggregates every module like this one; what changed is that the 163 `import … with { type: "text" }` */

import { definePromptRows, type PromptEntry } from "@veyyon/utils/prompt-registry";

import autoresearchCommandResume from "./command-resume.md" with { type: "text" };
import autoresearchPrompt from "./prompt.md" with { type: "text" };
import autoresearchPromptSetup from "./prompt-setup.md" with { type: "text" };
import autoresearchResumeMessage from "./resume-message.md" with { type: "text" };

/** Every prompt under `src/prompts/autoresearch/`, keyed by its id (the path under `src/prompts/`). */
export const autoresearchPrompts = definePromptRows({
	"autoresearch/command-resume": {
		text: autoresearchCommandResume,
		purpose: "resumes autoresearch on the active session",
	},
	"autoresearch/prompt": {
		text: autoresearchPrompt,
		purpose: "the autoresearch run prompt, wrapping the base system prompt",
	},
	"autoresearch/prompt-setup": {
		text: autoresearchPromptSetup,
		purpose: "the autoresearch setup prompt, before an experiment exists",
	},
	"autoresearch/resume-message": {
		text: autoresearchResumeMessage,
		purpose: "the steer that continues the autoresearch loop",
	},
} satisfies Record<string, PromptEntry>);
