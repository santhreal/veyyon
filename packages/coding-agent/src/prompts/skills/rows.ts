/**
 * The `skills/` prompt rows. Each directory owns its rows so importing one prompt doesn't reach all
 * 163 (the old single-module layout made `tools/read.ts` pay 167 modules). Invariant: every `.md` is
 * imported by exactly one row module, aggregated by `registry.ts`, nothing else imports a `.md`.
 * `test/core/prompt-registry-coverage.test.ts` pins this. DO NOT re-declare a row another module holds.
 */

import { definePromptRows, type PromptEntry } from "@veyyon/utils/prompt-registry";

import skillsAutoload from "./autoload.md" with { type: "text" };
import skillsUserInvocation from "./user-invocation.md" with { type: "text" };

/** Every prompt under `src/prompts/skills/`, keyed by its id (the path under `src/prompts/`). */
export const skillsPrompts = definePromptRows({
	"skills/autoload": { text: skillsAutoload, purpose: "wraps a skill body that was loaded automatically" },
	"skills/user-invocation": { text: skillsUserInvocation, purpose: "wraps a skill body the user invoked by name" },
} satisfies Record<string, PromptEntry>);
