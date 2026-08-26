/**
 * The `side-channel/` prompt rows. Each directory owns its rows so importing one prompt doesn't reach all
 * 163 (the old single-module layout made `tools/read.ts` pay 167 modules). Invariant: every `.md` is
 * imported by exactly one row module, aggregated by `registry.ts`, nothing else imports a `.md`.
 * `test/core/prompt-registry-coverage.test.ts` pins this. DO NOT re-declare a row another module holds.
 */

import { definePromptRows, type PromptEntry } from "@veyyon/utils/prompt-registry";

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
export const sideChannelPrompts = definePromptRows({
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
} satisfies Record<string, PromptEntry>);
