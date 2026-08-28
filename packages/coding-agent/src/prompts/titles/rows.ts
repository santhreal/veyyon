/** The `titles/` prompt rows: naming a session. and it aggregates every module like this one; what changed is that the 163 `import … with { type: "text" }` */

import { definePromptRows, type PromptEntry } from "@veyyon/utils/prompt-registry";

import titlesMarkerInstruction from "./marker-instruction.md" with { type: "text" };
import titlesSystem from "./system.md" with { type: "text" };

/** Every prompt under `src/prompts/titles/`, keyed by its id (the path under `src/prompts/`). */
export const titlesPrompts = definePromptRows({
	"titles/marker-instruction": {
		text: titlesMarkerInstruction,
		purpose: "the shared output contract for title generation",
	},
	"titles/system": { text: titlesSystem, purpose: "names a new session from its opening turn" },
} satisfies Record<string, PromptEntry>);
