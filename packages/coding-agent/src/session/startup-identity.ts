/**
 * Who a session is to the agent registry and to its provider: the id, display name and kind it
 * registers under, and the prompt cache key its requests send.
 */

import { MAIN_AGENT_ID, mainAgentIdFor } from "../registry/agent-registry";
import type { CreateAgentSessionOptions } from "./factory-options";

/** The id, display name and kind an agent registers under. */
export interface AgentIdentity {
	readonly id: string;
	readonly displayName: string;
	readonly kind: "main" | "sub";
}

/**
 * A driving agent is named for the conversation it starts, so two live top-level sessions in one process
 * cannot collide on one key. It takes the bare alias only while there is no conversation id, which
 * cannot produce a second main.
 */
export function resolveAgentIdentity(
	options: Pick<CreateAgentSessionOptions, "agentId" | "parentTaskPrefix" | "agentDisplayName">,
	isSpawned: boolean,
	conversationId: string | undefined,
): AgentIdentity {
	const derivedId = !isSpawned && conversationId ? mainAgentIdFor(conversationId) : MAIN_AGENT_ID;
	const kind = isSpawned ? "sub" : "main";
	return {
		id: options.agentId ?? options.parentTaskPrefix ?? derivedId,
		displayName: options.agentDisplayName ?? kind,
		kind,
	};
}

/** The provider prompt cache key a session sends, and where it came from. */
export interface ProviderPromptCache {
	readonly key: string | undefined;
	readonly source: "explicit" | "fork" | undefined;
}

/**
 * An explicit key wins. Otherwise a session inherits `recordedKey`, the key its file records, unless the
 * caller set the model, thinking level, system prompt or tools, any of which changes the cached prefix.
 */
export function resolveProviderPromptCache(
	options: CreateAgentSessionOptions,
	recordedKey: string | undefined,
): ProviderPromptCache {
	if (options.providerPromptCacheKey !== undefined) {
		return { key: options.providerPromptCacheKey, source: options.providerPromptCacheKeySource ?? "explicit" };
	}
	const cacheShapeChanged =
		options.model !== undefined ||
		options.modelPattern !== undefined ||
		options.thinkingLevel !== undefined ||
		options.systemPrompt !== undefined ||
		options.customSystemPrompt !== undefined ||
		options.appendSystemPrompt !== undefined ||
		options.toolNames !== undefined ||
		options.customTools !== undefined;
	const key = cacheShapeChanged ? undefined : recordedKey;
	return { key, source: key !== undefined ? "fork" : undefined };
}
