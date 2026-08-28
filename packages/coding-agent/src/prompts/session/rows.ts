/** The `session/` prompt rows: what defines a session before any turn runs. and it aggregates every module like this one; what changed is that the 163 `import … with { type: "text" }` */

import { definePromptRows, type PromptEntry } from "@veyyon/utils/prompt-registry";

import sessionCodeReviewReminder from "./code-review-reminder.md" with { type: "text" };
import sessionContextFileAuthority from "./context-file-authority.md" with { type: "text" };
import sessionCustomSystemPrompt from "./custom-system-prompt.md" with { type: "text" };
import sessionPersonalitiesDefault from "./personalities/default.md" with { type: "text" };
import sessionPersonalitiesFriendly from "./personalities/friendly.md" with { type: "text" };
import sessionPersonalitiesPragmatic from "./personalities/pragmatic.md" with { type: "text" };
import sessionProjectPrompt from "./project-prompt.md" with { type: "text" };
import sessionSecretInventory from "./secret-inventory.md" with { type: "text" };
import sessionSessionState from "./session-state.md" with { type: "text" };
import sessionSystemPrompt from "./system-prompt.md" with { type: "text" };
import sessionUserInstructionAuthority from "./user-instruction-authority.md" with { type: "text" };
import sessionVerificationEvidenceReminder from "./verification-evidence-reminder.md" with { type: "text" };
import sessionVibeModeActive from "./vibe-mode-active.md" with { type: "text" };

/** Every prompt under `src/prompts/session/`, keyed by its id (the path under `src/prompts/`). */
export const sessionPrompts = definePromptRows({
	"session/code-review-reminder": {
		text: sessionCodeReviewReminder,
		purpose: "the one-turn reminder to review multi-file code changes before finalizing",
	},
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
	"session/session-state": {
		text: sessionSessionState,
		purpose:
			"the date and working directory, delivered as a turn message so a re-root does not rewrite the cached prompt prefix",
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
} satisfies Record<string, PromptEntry>);
