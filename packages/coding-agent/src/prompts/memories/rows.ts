/**
 * The `memories/` prompt rows: extracting, consolidating and reading long-term memory.
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
import memoriesConsolidation from "./consolidation.md" with { type: "text" };
import memoriesConsolidationSystem from "./consolidation_system.md" with { type: "text" };
import memoriesConsolidationShort from "./consolidation-short.md" with { type: "text" };
import memoriesExtractionLines from "./extraction-lines.md" with { type: "text" };
import memoriesReadPath from "./read-path.md" with { type: "text" };
import memoriesStageOneInput from "./stage_one_input.md" with { type: "text" };
import memoriesStageOneSystem from "./stage_one_system.md" with { type: "text" };

/** Every prompt under `src/prompts/memories/`, keyed by its id (the path under `src/prompts/`). */
export const memoriesPrompts = {
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
} satisfies Record<string, PromptEntry>;
