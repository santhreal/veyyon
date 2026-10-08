/**
 * The ChatGPT Codex provider's entry in a session's provider state map, read and reset without the Codex
 * client: the entry's key and shape, the transport a session reports for `/session` and the background
 * prewarm, the request context a compaction pass sends, and the history reset after a compaction rewrites
 * the conversation. The client in `../openai-codex-responses` creates and writes the entry, and a session
 * loads it on its first Codex turn.
 */
import { CODEX_BASE_URL } from "@veyyon/catalog/wire/codex";
import { $env, $flag } from "@veyyon/utils/env";
import type { CodexCompactionContext, CodexCompactionRequestContext, Model, ProviderSessionState } from "../../types";
import type {
	CodexProviderSessionState,
	CodexTransport,
	CodexWebSocketSessionState,
	OpenAICodexWebSocketDebugStats,
} from "../openai-codex-responses";
import { normalizeOpenAIPromptCacheKey } from "../openai-stable-ids";

export const CODEX_PROVIDER_SESSION_STATE_KEY = "openai-codex-responses";

/** Live Codex session state to preserve after a successful history rewrite. */
export interface OpenAICodexCompactionResetOptions {
	providerSessionState?: Map<string, ProviderSessionState>;
	sessionId?: string;
	compaction: CodexCompactionContext;
}

export interface OpenAICodexTransportDetails {
	websocketPreferred: boolean;
	lastTransport?: CodexTransport;
	websocketDisabled: boolean;
	websocketConnected: boolean;
	fallbackCount: number;
	canAppend: boolean;
	prewarmed: boolean;
	hasSessionState: boolean;
	hasTurnState: boolean;
	lastFallbackAt?: number;
}

/** Which session's transport to read: the session id, the host, and the session's provider state map. */
export interface OpenAICodexSessionLookup {
	sessionId?: string;
	baseUrl?: string;
	providerSessionState?: Map<string, ProviderSessionState>;
}

/** Add the selected wire implementation to one logical compaction context. */
export function createOpenAICodexCompactionRequestContext(options: {
	context: CodexCompactionContext | undefined;
	implementation: "responses" | "responses_compaction_v2" | "responses_compact";
}): CodexCompactionRequestContext | undefined {
	const context = options.context;
	if (!context) return undefined;
	return {
		operationId: context.operationId,
		trigger: context.trigger,
		reason: context.reason,
		implementation: options.implementation,
		phase: context.phase,
		strategy: context.strategy,
	};
}

export function isCodexProviderSessionState(
	state: ProviderSessionState | undefined,
): state is CodexProviderSessionState {
	return (
		state !== undefined &&
		"webSocketSessions" in state &&
		state.webSocketSessions instanceof Map &&
		"webSocketPublicToPrivate" in state &&
		state.webSocketPublicToPrivate instanceof Map &&
		"metadataSessions" in state &&
		state.metadataSessions instanceof Map
	);
}

export function resetCodexWebSocketAppendState(state: CodexWebSocketSessionState): void {
	state.canAppend = false;
	state.lastRequest = undefined;
	state.lastResponseId = undefined;
	state.lastResponseItems = undefined;
}

/**
 * Invalidate Codex history-dependent transport state after compaction while
 * retaining the session identity and live connection.
 */
export function resetOpenAICodexHistoryAfterCompaction(options: OpenAICodexCompactionResetOptions): void {
	const providerState = options.providerSessionState?.get(CODEX_PROVIDER_SESSION_STATE_KEY);
	if (!isCodexProviderSessionState(providerState)) return;
	for (const websocketState of providerState.webSocketSessions.values()) {
		resetCodexWebSocketAppendState(websocketState);
		if (options.compaction.phase !== "mid_turn") websocketState.turnState = undefined;
	}
	const sessionId = normalizeOpenAIPromptCacheKey(options.sessionId);
	if (!sessionId) return;
	const metadataSession = providerState.metadataSessions.get(sessionId);
	if (!metadataSession) return;
	metadataSession.windowId = crypto.randomUUID();
	metadataSession.compactionOperationId = undefined;
	metadataSession.reuseTurnForNextRequest = options.compaction.phase !== "standalone_turn";
}

/** `VEYYON_CODEX_WEBSOCKET` as a boolean, or undefined when it is unset. */
export function getCodexWebSocketEnvValue(): boolean | undefined {
	const envVal = $env.VEYYON_CODEX_WEBSOCKET;
	if (envVal !== undefined) {
		return $flag("VEYYON_CODEX_WEBSOCKET");
	}
	return undefined;
}

/** The websocket session state a public session id maps to, or undefined when the session has none. */
function findCodexWebSocketSessionState(
	model: Model<"openai-codex-responses">,
	options: OpenAICodexSessionLookup | undefined,
): CodexWebSocketSessionState | undefined {
	const providerState = options?.providerSessionState?.get(CODEX_PROVIDER_SESSION_STATE_KEY);
	if (!isCodexProviderSessionState(providerState)) return undefined;
	const normalizedSessionId = normalizeOpenAIPromptCacheKey(options?.sessionId);
	if (!normalizedSessionId) return undefined;
	const baseUrl = options?.baseUrl || model.baseUrl || CODEX_BASE_URL;
	const privateSessionKey = providerState.webSocketPublicToPrivate.get(
		`${baseUrl}:${model.id}:${normalizedSessionId}`,
	);
	return privateSessionKey ? providerState.webSocketSessions.get(privateSessionKey) : undefined;
}

export function getOpenAICodexWebSocketDebugStats(
	model: Model<"openai-codex-responses">,
	options?: OpenAICodexSessionLookup,
): OpenAICodexWebSocketDebugStats | undefined {
	const stats = findCodexWebSocketSessionState(model, options)?.stats;
	return stats ? { ...stats } : undefined;
}

export function getOpenAICodexTransportDetails(
	model: Model<"openai-codex-responses">,
	options?: OpenAICodexSessionLookup & { preferWebsockets?: boolean },
): OpenAICodexTransportDetails {
	const envVal = getCodexWebSocketEnvValue();
	const websocketPreferred =
		envVal !== undefined
			? envVal
			: options?.preferWebsockets === false
				? false
				: options?.preferWebsockets === true || model.preferWebsockets === true;
	const state = findCodexWebSocketSessionState(model, options);

	return {
		websocketPreferred,
		lastTransport: state?.lastTransport,
		websocketDisabled: state?.disableWebsocket ?? false,
		websocketConnected: state?.connection?.isOpen() ?? false,
		fallbackCount: state?.fallbackCount ?? 0,
		canAppend: state?.canAppend ?? false,
		prewarmed: state?.prewarmed ?? false,
		hasSessionState: state !== undefined,
		hasTurnState: state?.turnState !== undefined,
		lastFallbackAt: state?.lastFallbackAt,
	};
}
