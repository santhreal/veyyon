/** The `memories/` prompt rows: extracting, consolidating and reading long-term memory. and it aggregates every module like this one; what changed is that the 163 `import … with { type: "text" }` */

import { definePromptRows, type PromptEntry } from "@veyyon/utils/prompt-registry";
import memoriesConsolidation from "./consolidation.md" with { type: "text" };
import memoriesConsolidationSystem from "./consolidation_system.md" with { type: "text" };
import memoriesConsolidationShort from "./consolidation-short.md" with { type: "text" };
import memoriesExtractionLines from "./extraction-lines.md" with { type: "text" };
import memoriesReadPath from "./read-path.md" with { type: "text" };
import memoriesStageOneInput from "./stage_one_input.md" with { type: "text" };
import memoriesStageOneSystem from "./stage_one_system.md" with { type: "text" };

/** Every prompt under `src/prompts/memories/`, keyed by its id (the path under `src/prompts/`). */
export const memoriesPrompts = definePromptRows({
	"memories/consolidation": {
		text: memoriesConsolidation,
		purpose: "the stage-two consolidation task, with the raw corpus inlined",
	},
	"memories/consolidation-short": {
		text: memoriesConsolidationShort,
		purpose: "condenses stored memories into a few sentences",
	},
	"memories/consolidation_system": {
		text: memoriesConsolidationSystem,
		purpose: "merges extracted memories into the stored set",
	},
	"memories/extraction-lines": {
		text: memoriesExtractionLines,
		purpose: "extracts durable memory items from one user message",
	},
	"memories/read-path": { text: memoriesReadPath, purpose: "tells the agent how to read the memory root" },
	"memories/stage_one_input": {
		text: memoriesStageOneInput,
		purpose: "the stage-one extraction task, with the rollout items inlined",
	},
	"memories/stage_one_system": { text: memoriesStageOneSystem, purpose: "extracts candidate memories from a session" },
} satisfies Record<string, PromptEntry>);
