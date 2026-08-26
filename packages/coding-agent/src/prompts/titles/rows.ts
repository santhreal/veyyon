/**
 * The `titles/` prompt rows. Each directory owns its rows so importing one prompt doesn't reach all
 * 163 (the old single-module layout made `tools/read.ts` pay 167 modules). Invariant: every `.md` is
 * imported by exactly one row module, aggregated by `registry.ts`, nothing else imports a `.md`.
 * `test/core/prompt-registry-coverage.test.ts` pins this. DO NOT re-declare a row another module holds.
 */

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
