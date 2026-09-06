/**
 * The `autoresearch/` prompt rows: the autoresearch loop.
 *
 * WHY EACH DIRECTORY OWNS ITS OWN ROWS. `registry.ts` is still the ONE place that says which prompts exist,
 * and it aggregates every module like this one; what changed is that the 163 `import … with { type: "text" }`
 * specifiers no longer sit in a single module. They did, and the consequence was that importing one prompt
 * statically reached all 163: `tools/fs/read.ts` needs `PROMPTS["tools/read"]` to render its own description and
 * had to import the 700-line prompt registry to get it, pulling the entire prompt tree into every tool file.
 *
 * Splitting the imports by directory breaks that cycle. The types are preserved: `definePromptRows` enforces
 * the same `{ text, purpose }` shape, `registry.ts` spreads each slice into the combined `PROMPTS` map, and
 * the static keys are checked against the prompt names there so a typo in any slice still fails compilation.
 */

import { definePromptRows, type PromptEntry } from "@veyyon/utils/prompt-registry";
import autoresearchCommandResume from "./command-resume.md" with { type: "text" };
import autoresearchPrompt from "./prompt.md" with { type: "text" };
import autoresearchPromptSetup from "./prompt-setup.md" with { type: "text" };
import autoresearchResumeMessage from "./resume-message.md" with { type: "text" };
import autoresearchStallNudge from "./stall-nudge.md" with { type: "text" };

export const autoresearchPrompts = definePromptRows({
	"autoresearch/prompt": {
		text: autoresearchPrompt,
		purpose: "the autoresearch loop system prompt: iteration discipline, scope bounds, baseline tracking",
	},
	"autoresearch/prompt-setup": {
		text: autoresearchPromptSetup,
		purpose: "the autoresearch setup system prompt: harness requirements, metric parsing, first-turn focus",
	},
	"autoresearch/resume-message": {
		text: autoresearchResumeMessage,
		purpose: "the continuation turn injected on loop resume: unlogged runs, recent-runs context",
	},
	"autoresearch/command-resume": {
		text: autoresearchCommandResume,
		purpose: "the user-initiated `/autoresearch resume` turn: branch notice, optional steering text",
	},
	"autoresearch/stall-nudge": {
		text: autoresearchStallNudge,
		purpose: "the steer that names a loop which ended a turn without advancing",
	},
} satisfies Record<string, PromptEntry>);
