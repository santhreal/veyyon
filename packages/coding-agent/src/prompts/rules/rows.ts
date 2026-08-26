/**
 * The `rules/` prompt rows. Each directory owns its rows so importing one prompt doesn't reach all
 * 163 (the old single-module layout made `tools/read.ts` pay 167 modules). Invariant: every `.md` is
 * imported by exactly one row module, aggregated by `registry.ts`, nothing else imports a `.md`.
 * `test/core/prompt-registry-coverage.test.ts` pins this. DO NOT re-declare a row another module holds.
 */

import { definePromptRows, type PromptEntry } from "@veyyon/utils/prompt-registry";

import rulesTtsrInterrupt from "./ttsr-interrupt.md" with { type: "text" };
import rulesTtsrToolReminder from "./ttsr-tool-reminder.md" with { type: "text" };

/** Every prompt under `src/prompts/rules/`, keyed by its id (the path under `src/prompts/`). */
export const rulesPrompts = definePromptRows({
	"rules/ttsr-interrupt": { text: rulesTtsrInterrupt, purpose: "interrupts output that violated a user-defined rule" },
	"rules/ttsr-tool-reminder": {
		text: rulesTtsrToolReminder,
		purpose: "reports a rule that matched a tool call without interrupting it",
	},
} satisfies Record<string, PromptEntry>);
