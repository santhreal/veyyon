/**
 * The Anthropic Messages provider's per-session state: its key in a session's provider state map, its
 * shape, and the fast-mode re-arm a session runs on `/fast on`. A session reads these before any
 * Anthropic turn streams, so they are defined apart from the Messages client in `./anthropic`.
 */
import type { CacheTrackerState } from "../cache";
import type { ProviderSessionState } from "../types";

export const ANTHROPIC_PROVIDER_SESSION_STATE_KEY = "anthropic-messages";

export type AnthropicProviderSessionState = ProviderSessionState & {
	strictToolsDisabled: boolean;
	fastModeDisabled: boolean;
	/**
	 * Runtime-learned: this endpoint returned `400 Invalid signature in
	 * thinking block` for a replayed unsigned thinking block, so it must be
	 * treated as a signing proxy from now on. All subsequent requests demote
	 * unsigned thinking to text for this (baseUrl, modelId), same behavior as
	 * an explicit `compat.replayUnsignedThinking: false`. Cleared on session
	 * close.
	 */
	replayUnsignedThinkingDisabled: boolean;
	/**
	 * Runtime-learned: this endpoint answered `stop_reason: "refusal"` with
	 * category `reasoning_extraction` for a request carrying prior-turn
	 * reasoning demoted to text, so that prose must be dropped rather than
	 * replayed from now on. All subsequent requests to this (baseUrl, modelId)
	 * omit demoted prior reasoning, same behavior as an explicit
	 * `compat.replayDemotedPriorReasoning: false`. Cleared on session close.
	 */
	priorReasoningReplayDisabled: boolean;
	/**
	 * Prompt-cache observations for this endpoint+model, so a miss can be judged
	 * against the previous turn rather than guessed at. Kept here because the
	 * cache identity is the conversation prefix, which is exactly what this key
	 * already scopes. Reset on close with everything else.
	 */
	cacheTracker: CacheTrackerState;
};

/**
 * Clears the in-session "server rejected fast mode" sticky flag. Call when the
 * caller is explicitly re-arming `serviceTier: "priority"` (e.g. user toggled
 * `/fast on` after a previous turn auto-disabled it) so the next request
 * actually carries `speed: "fast"` again. No-op when the map or state entry
 * hasn't been materialized yet.
 */
export function clearAnthropicFastModeFallback(
	providerSessionState: Map<string, ProviderSessionState> | undefined,
): void {
	if (!providerSessionState) return;
	// Fast mode is re-armed session-wide (user toggled `/fast on`), so clear the
	// sticky flag on every per-endpoint/model Anthropic entry — plus the legacy
	// unscoped key — rather than a single shared object.
	const prefix = `${ANTHROPIC_PROVIDER_SESSION_STATE_KEY}:`;
	for (const [key, value] of providerSessionState) {
		if (key !== ANTHROPIC_PROVIDER_SESSION_STATE_KEY && !key.startsWith(prefix)) continue;
		(value as AnthropicProviderSessionState).fastModeDisabled = false;
	}
}
