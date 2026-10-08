/**
 * Provider sessions: the id and prompt cache key requests route under, and the per-provider transport
 * state they reuse.
 *
 * This is a session collaborator. It holds the provider session state map the agent and every side
 * request share, the provider session id the configuration or `/fresh` set, and the prompt cache key
 * the session inherited from a fork or a branch, and reaches the session only through
 * {@link ProviderSessionsHost}.
 *
 * - **Routing** ({@link ProviderSessions.activeId}, {@link ProviderSessions.sync}) selects the id a
 *   request carries and installs the metadata resolver that stamps it on Anthropic requests.
 * - **The inherited cache key** ({@link ProviderSessions.adoptInheritedCacheKey},
 *   {@link ProviderSessions.clearInheritedCacheKey}) keeps a retained prefix reading the cache its
 *   source populated, and records every discard with its reason.
 * - **Closing** ({@link ProviderSessions.closeAll}, {@link ProviderSessions.closeForModelSwitch})
 *   ends the transport sessions a model switch, a history rewrite or a new session invalidates.
 */
import type { Agent } from "@veyyon/agent-core";
import type { Model, ProviderSessionState } from "@veyyon/ai";
import type { AuthStorage } from "@veyyon/ai/auth-storage";
import { errorMessage, logger } from "@veyyon/utils";
import { buildSessionMetadata } from "../agent-session-provider-request";

/** The session log slice provider routing reads. `SessionManager` satisfies this. */
export interface ProviderSessionsStore {
	getSessionId(): string;
	getHeader(): { readonly providerPromptCacheKey?: string } | null;
}

/** What {@link ProviderSessions} needs from the session that holds it. */
export interface ProviderSessionsHost {
	readonly agent: Agent;
	readonly sessionStore: ProviderSessionsStore;
	/** Credentials the metadata resolver reads an Anthropic account id from, when loaded. */
	authStorage(): AuthStorage | undefined;
}

/** How a session starts routing: the configured id, and the cache key a fork hands over. */
export interface ProviderSessionsOptions {
	/** Provider session id the caller configured, routed under instead of the session file's id. */
	readonly configuredId?: string;
	/** Prompt cache key inherited from the session this one forked from. */
	readonly inheritedCacheKey?: string;
}

export class ProviderSessions {
	readonly #host: ProviderSessionsHost;
	readonly #configuredId: string | undefined;
	#inheritedCacheKey: string | undefined;
	readonly #cacheKeyDiscards: string[] = [];
	/**
	 * Provider-scoped transport state (websocket sessions, cached backend decisions), keyed by
	 * provider. The agent and every side request share this one map.
	 */
	readonly states = new Map<string, ProviderSessionState>();
	/** Provider session id `/fresh` minted, routed under until the transcript changes. */
	freshId: string | undefined;

	constructor(host: ProviderSessionsHost, options: ProviderSessionsOptions = {}) {
		this.#host = host;
		this.#configuredId = options.configuredId;
		this.#inheritedCacheKey = options.inheritedCacheKey;
	}

	/** The prompt cache key this session inherited, if it still holds one. */
	get inheritedCacheKey(): string | undefined {
		return this.#inheritedCacheKey;
	}

	/** The provider session id requests route under. */
	activeId(sessionId?: string): string {
		return this.freshId ?? this.#configuredId ?? sessionId ?? this.#host.sessionStore.getSessionId();
	}

	/**
	 * Set the agent's session id and install a metadata resolver, so every Anthropic request carries
	 * `metadata.user_id` shaped like Claude Code's `getAPIMetadata` output:
	 * `{ session_id, account_uuid, device_id }`. `account_uuid` is included only when an Anthropic
	 * OAuth credential with a known account UUID is loaded; `device_id` is derived from the veyyon
	 * install id and that account UUID. The resolver reads credentials on every request, so a login,
	 * a logout or a refresh that reports a new account UUID needs no resync.
	 */
	sync(sessionId?: string): void {
		const sid = this.activeId(sessionId);
		const host = this.#host;
		host.agent.sessionId = sid;
		host.agent.setMetadataResolver((provider: string) => buildSessionMetadata(sid, provider, host.authStorage()));
	}

	/** Route under the prompt cache key the session header inherited, when it names one. */
	adoptInheritedCacheKey(): void {
		const key = this.#host.sessionStore.getHeader()?.providerPromptCacheKey;
		if (!key) return;
		const agent = this.#host.agent;
		if (this.#inheritedCacheKey !== undefined || agent.promptCacheKey === undefined) {
			agent.promptCacheKey = key;
			this.#inheritedCacheKey = key;
		}
	}

	/**
	 * Drop the inherited prompt cache key, recording why.
	 *
	 * Every caller spends a full re-prefill, and a discard without a reason is a cost nobody can
	 * attribute afterwards. The record is appended only when a key was inherited, so a session that
	 * never had one accumulates no discards.
	 */
	clearInheritedCacheKey(reason: string): void {
		const key = this.#inheritedCacheKey;
		this.#inheritedCacheKey = undefined;
		if (key === undefined) return;
		this.#cacheKeyDiscards.push(reason);
		logger.warn("provider prompt cache key discarded; the next request re-reads the whole context", {
			reason,
			discardsThisSession: this.#cacheKeyDiscards.length,
		});
		const agent = this.#host.agent;
		if (agent.promptCacheKey === key) agent.promptCacheKey = undefined;
	}

	/**
	 * Put back the inherited key and the key the agent routes on, as a failed session switch found
	 * them. Restoring only the inherited key would leave the source session sending the target's
	 * `prompt_cache_key` on every later turn.
	 */
	restoreCacheKeys(inheritedCacheKey: string | undefined, agentCacheKey: string | undefined): void {
		this.#inheritedCacheKey = inheritedCacheKey;
		this.#host.agent.promptCacheKey = agentCacheKey;
	}

	/** Every cache-key discard this session paid for, in order, by reason. */
	cacheKeyDiscards(): readonly string[] {
		// A frozen copy: this is cost evidence, and a reader that trimmed the live array would
		// under-report re-prefills.
		return Object.freeze(this.#cacheKeyDiscards.slice());
	}

	/** Close every provider session. */
	closeAll(reason: string): void {
		for (const [providerKey, state] of this.states) {
			try {
				state.close();
			} catch (error) {
				logger.warn("Failed to close provider session state", { providerKey, reason, error: errorMessage(error) });
			}
		}
		this.states.clear();
	}

	/** Close the provider sessions moving from `currentModel` to `nextModel` invalidates. */
	closeForModelSwitch(currentModel: Model, nextModel: Model): void {
		if (currentModel.api === "openai-codex-responses" || nextModel.api === "openai-codex-responses") {
			this.#close("openai-codex-responses");
		}
		if (currentModel.api === "openai-responses") this.#close(`openai-responses:${currentModel.provider}`);
		if (nextModel.api === "openai-responses") this.#close(`openai-responses:${nextModel.provider}`);

		// `openai-completions` sessions are keyed `openai-completions:<provider>:<resolvedBaseUrl>:<modelId>`
		// and cache backend-specific decisions (strict-tools disable scopes, reasoning-effort
		// fallbacks). The resolved request base URL can differ from the catalog `model.baseUrl`
		// (Moonshot env override, Alibaba Coding Plan enterprise URL, Azure deployment URL), so every
		// session of the provider is closed when the switch leaves that completions backend.
		if (currentModel.api !== "openai-completions") return;
		const currentScope = `${currentModel.provider}:${currentModel.baseUrl ?? ""}`;
		const nextScope =
			nextModel.api === "openai-completions" ? `${nextModel.provider}:${nextModel.baseUrl ?? ""}` : undefined;
		if (currentScope === nextScope) return;
		const prefix = `openai-completions:${currentModel.provider}:`;
		for (const providerKey of this.states.keys()) {
			if (providerKey.startsWith(prefix)) this.#close(providerKey);
		}
	}

	/** Close the Codex Responses session after a history rewrite, since it replays the old history. */
	closeCodexForHistoryRewrite(model: Model | undefined): void {
		if (model?.api !== "openai-codex-responses") return;
		this.closeForModelSwitch(model, model);
	}

	/**
	 * Close the current Responses session after a stale replay error, and rebuild the append-only
	 * prefix. No-op when `model` does not route through a Responses API.
	 */
	resetResponses(model: Model | undefined, reason: string): void {
		if (model?.api !== "openai-responses" && model?.api !== "openai-codex-responses") return;
		this.closeForModelSwitch(model, model);
		this.#host.agent.appendOnlyContext?.invalidateForModelChange();
		logger.debug("Reset Responses provider session after stale replay error", {
			provider: model.provider,
			model: model.id,
			api: model.api,
			reason,
		});
	}

	#close(providerKey: string): void {
		const state = this.states.get(providerKey);
		if (!state) return;
		try {
			state.close();
		} catch (error) {
			logger.warn("Failed to close provider session state during model switch", {
				providerKey,
				error: errorMessage(error),
			});
		}
		this.states.delete(providerKey);
	}
}
