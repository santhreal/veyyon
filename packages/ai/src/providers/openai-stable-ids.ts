/**
 * Identifiers OpenAI-family wires cap in length. A value at or under the cap is sent as is, made
 * well-formed; a longer one is sent as a prefixed hash of it. Per-session transport state is keyed by
 * the same value a request sends, so these are defined apart from the Responses encoder in
 * `./openai-shared`.
 */

function normalizeOpenAIStableId(value: string | undefined, maxLength: number, hashPrefix: string): string | undefined {
	if (!value || value.length === 0) return undefined;
	const wellFormed = value.toWellFormed();
	if (wellFormed.length <= maxLength) return wellFormed;
	return `${hashPrefix}${Bun.hash(wellFormed).toString(36)}`;
}

/** Normalize a cache identity to the wire limit accepted by OpenAI-family providers. */
export function normalizeOpenAIPromptCacheKey(sessionId: string | undefined): string | undefined {
	return normalizeOpenAIStableId(sessionId, 64, "pc_");
}

export function normalizeOpenRouterResponsesSessionId(sessionId: string | undefined): string | undefined {
	return normalizeOpenAIStableId(sessionId, 256, "session_");
}
