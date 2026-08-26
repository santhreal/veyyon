/**
 * The `steering/` prompt rows. Each directory owns its rows so importing one prompt doesn't reach all
 * 163 (the old single-module layout made `tools/read.ts` pay 167 modules). Invariant: every `.md` is
 * imported by exactly one row module, aggregated by `registry.ts`, nothing else imports a `.md`.
 * `test/core/prompt-registry-coverage.test.ts` pins this. DO NOT re-declare a row another module holds.
 */

import { definePromptRows, type PromptEntry } from "@veyyon/utils/prompt-registry";

import steeringParentIrc from "./parent-irc.md" with { type: "text" };
import steeringUserInterjection from "./user-interjection.md" with { type: "text" };

/** Every prompt under `src/prompts/steering/`, keyed by its id (the path under `src/prompts/`). */
export const steeringPrompts = definePromptRows({
	"steering/parent-irc": {
		text: steeringParentIrc,
		purpose: "delivers a parent agent's IRC message that broke an interruptible wait",
	},
	"steering/user-interjection": {
		text: steeringUserInterjection,
		purpose: "delivers a user message that arrived mid-turn and takes priority",
	},
} satisfies Record<string, PromptEntry>);
