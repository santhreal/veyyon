/** The `skills/` prompt rows: wrapping a skill body. and it aggregates every module like this one; what changed is that the 163 `import … with { type: "text" }` */

import { definePromptRows, type PromptEntry } from "@veyyon/utils/prompt-registry";

import skillsAutoload from "./autoload.md" with { type: "text" };
import skillsUserInvocation from "./user-invocation.md" with { type: "text" };

/** Every prompt under `src/prompts/skills/`, keyed by its id (the path under `src/prompts/`). */
export const skillsPrompts = definePromptRows({
	"skills/autoload": { text: skillsAutoload, purpose: "wraps a skill body that was loaded automatically" },
	"skills/user-invocation": { text: skillsUserInvocation, purpose: "wraps a skill body the user invoked by name" },
} satisfies Record<string, PromptEntry>);
