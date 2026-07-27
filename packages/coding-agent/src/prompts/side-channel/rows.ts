/**
 * The `side-channel/` prompt rows: turns that reuse the session's context but are not the task.
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

import sideChannelBackgroundTanDispatch from "./background-tan-dispatch.md" with { type: "text" };
import sideChannelBtwUser from "./btw-user.md" with { type: "text" };
import sideChannelIrcAutoreply from "./irc-autoreply.md" with { type: "text" };
import sideChannelIrcIncoming from "./irc-incoming.md" with { type: "text" };
import sideChannelOmfgUser from "./omfg-user.md" with { type: "text" };
import sideChannelRecapUser from "./recap-user.md" with { type: "text" };
import sideChannelSideChannelNoTools from "./side-channel-no-tools.md" with { type: "text" };
import sideChannelSpeechRewrite from "./speech-rewrite.md" with { type: "text" };
import sideChannelTanContextSwitch from "./tan-context-switch.md" with { type: "text" };

/** Every prompt under `src/prompts/side-channel/`, keyed by its id (the path under `src/prompts/`). */
export const sideChannelPrompts = {
	"side-channel/background-tan-dispatch": {
		text: sideChannelBackgroundTanDispatch,
		purpose: "notifies the agent that a tangential task moved to a background agent",
	},
	"side-channel/btw-user": {
		text: sideChannelBtwUser,
		purpose: "an ephemeral side question answered from context with no tools",
	},
	"side-channel/irc-autoreply": {
		text: sideChannelIrcAutoreply,
		purpose: "a side-channel turn replying to an IRC message mid-task",
	},
	"side-channel/irc-incoming": {
		text: sideChannelIrcIncoming,
		purpose: "delivers an incoming IRC message from another agent",
	},
	"side-channel/omfg-user": {
		text: sideChannelOmfgUser,
		purpose: "authors a Time Traveling Stream Rule from a frustrating behavior",
	},
	"side-channel/recap-user": { text: sideChannelRecapUser, purpose: "recaps the session for a user who stepped away" },
	"side-channel/side-channel-no-tools": {
		text: sideChannelSideChannelNoTools,
		purpose: "an ephemeral turn that reuses context but forbids tool calls",
	},
	"side-channel/speech-rewrite": {
		text: sideChannelSpeechRewrite,
		purpose: "rewrites assistant text for speech synthesis",
	},
	"side-channel/tan-context-switch": {
		text: sideChannelTanContextSwitch,
		purpose: "tells a forked session it owns only the new request",
	},
} satisfies Record<string, PromptEntry>;
