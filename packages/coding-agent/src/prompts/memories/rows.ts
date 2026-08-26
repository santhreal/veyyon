/**
 * The `memories/` prompt rows. Each directory owns its rows so importing one prompt doesn't reach all
 * 163 (the old single-module layout made `tools/read.ts` pay 167 modules). Invariant: every `.md` is
 * imported by exactly one row module, aggregated by `registry.ts`, nothing else imports a `.md`.
 * `test/core/prompt-registry-coverage.test.ts` pins this. DO NOT re-declare a row another module holds.
 */

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
