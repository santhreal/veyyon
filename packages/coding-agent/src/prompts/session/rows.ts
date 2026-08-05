/**
 * The `session/` prompt rows: what defines a session before any turn runs.
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

import sessionContextFileAuthority from "./context-file-authority.md" with { type: "text" };
import sessionCustomSystemPrompt from "./custom-system-prompt.md" with { type: "text" };
import sessionPersonalitiesDefault from "./personalities/default.md" with { type: "text" };
import sessionPersonalitiesFriendly from "./personalities/friendly.md" with { type: "text" };
import sessionPersonalitiesPragmatic from "./personalities/pragmatic.md" with { type: "text" };
import sessionProjectPrompt from "./project-prompt.md" with { type: "text" };
import sessionSecretInventory from "./secret-inventory.md" with { type: "text" };
import sessionSystemPrompt from "./system-prompt.md" with { type: "text" };
import sessionUserInstructionAuthority from "./user-instruction-authority.md" with { type: "text" };
import sessionVerificationEvidenceReminder from "./verification-evidence-reminder.md" with { type: "text" };
import sessionVibeModeActive from "./vibe-mode-active.md" with { type: "text" };

/** Every prompt under `src/prompts/session/`, keyed by its id (the path under `src/prompts/`). */
export const sessionPrompts = {
	"session/context-file-authority": {
		text: sessionContextFileAuthority,
		purpose:
			"ranks the three context-file scopes, broadest first, and states that a narrower file never overrides a broader one",
	},
	"session/custom-system-prompt": {
		text: sessionCustomSystemPrompt,
		purpose: "assembles an operator-supplied system prompt with its context files",
	},
	"session/personalities/default": {
		text: sessionPersonalitiesDefault,
		purpose: "the terse evidence-first personality",
	},
	"session/personalities/friendly": {
		text: sessionPersonalitiesFriendly,
		purpose: "the warm collaborative personality",
	},
	"session/personalities/pragmatic": {
		text: sessionPersonalitiesPragmatic,
		purpose: "the pragmatic senior-engineer personality",
	},
	"session/project-prompt": { text: sessionProjectPrompt, purpose: "the workstation and project context block" },
	"session/secret-inventory": {
		text: sessionSecretInventory,
		purpose: "the AVAILABLE SECRETS runtime section: the credential placeholders this session can actually spend",
	},
	"session/system-prompt": { text: sessionSystemPrompt, purpose: "the main system prompt" },
	"session/user-instruction-authority": {
		text: sessionUserInstructionAuthority,
		purpose:
			"states unconditionally that the user's live instruction outranks every file, rule, and standing configuration",
	},
	"session/verification-evidence-reminder": {
		text: sessionVerificationEvidenceReminder,
		purpose: "the one-turn reminder to verify a successful mutation before finalizing",
	},
	"session/vibe-mode-active": { text: sessionVibeModeActive, purpose: "the director contract while vibe mode is on" },
} satisfies Record<string, PromptEntry>;
