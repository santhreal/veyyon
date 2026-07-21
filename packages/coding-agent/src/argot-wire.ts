// veyyon-side glue for the vendored argot codec (src/argot). Argot is a
// per-project shorthand: the model writes cheap handles, the harness expands
// them to full text before anything outside the model's history sees them. This
// is the SAME wire-codec shape as the secret obfuscator's deobfuscate direction,
// so expansion runs at the same two seams and reuses the same content/JSON
// walkers (secrets/obfuscator) — one walk, one place.

import type { AssistantMessage } from "@veyyon/ai";
import { type ArgotGate, type ArgotSession, EMPTY_GATE } from "./argot";
import {
	type JsonValue,
	mapAgentMessageStrings,
	mapAssistantContentStrings,
	mapJsonStrings,
} from "./secrets/obfuscator";
import type { SessionContext } from "./session/session-context";

/**
 * Build the argot encode gate from settings. When the feature is off the gate is
 * inert ({@link EMPTY_GATE}); otherwise it carries the model allowlist and the
 * context-token cutoff. This is the one place settings map to a gate, so the
 * runtime and its tests agree on the rule. Decoding never consults the gate.
 */
export function buildArgotGate(enabled: boolean, models: readonly string[], disableAboveTokens: number): ArgotGate {
	return enabled ? { models, disableAboveTokens } : EMPTY_GATE;
}

/** Expand handles in a tool call's arguments before the tool runs. Identity until a dict loads. */
export function expandToolArguments(argot: ArgotSession, args: Record<string, unknown>): Record<string, unknown> {
	if (!argot.loaded) return args;
	return mapJsonStrings(args as JsonValue, s => argot.expand(s)) as Record<string, unknown>;
}

/** Expand handles in assistant content before it is displayed. Identity until a dict loads. */
export function expandAssistantContent(
	argot: ArgotSession,
	content: AssistantMessage["content"],
): AssistantMessage["content"] {
	if (!argot.loaded) return content;
	return mapAssistantContentStrings(content, s => argot.expand(s));
}

/**
 * Expand handles across a whole persisted transcript for display/export/resume.
 * The persisted session keeps cheap handles (replay stays cheap — the token
 * win), so any human-facing rebuild of that history — the resumed TUI
 * transcript, a `/share` export — must expand them the same way the live
 * message seam does, or reloaded history would show raw handles. Composes on
 * top of secret deobfuscation, which runs first. Identity until a dict loads.
 */
export function expandSessionContext(argot: ArgotSession, context: SessionContext): SessionContext {
	if (!argot.loaded) return context;
	const messages = mapAgentMessageStrings(context.messages, s => argot.expand(s));
	return messages === context.messages ? context : { ...context, messages };
}
