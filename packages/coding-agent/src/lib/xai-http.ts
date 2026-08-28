// Ported from NousResearch/hermes-agent (MIT) — tools/xai_http.py.

import { getBundledModels } from "@veyyon/catalog/models";
import { $env, trimTrailingSlashes } from "@veyyon/utils";
import type { ModelRegistry } from "../config/model-registry";

const DEFAULT_BASE_URL = "https://api.x.ai/v1";

interface XAICredentials {
	provider: "xai-oauth" | "xai";
	apiKey: string;
	baseURL: string;
}

export function veyyonXAIUserAgent(): string {
	return "veyyon/xai";
}

/** @deprecated Use {@link veyyonXAIUserAgent} */
export const ohMyPiXAIUserAgent = veyyonXAIUserAgent;

type XAIProvider = "xai-oauth" | "xai";

/** Resolve the HTTP base URL for an xAI tool call. Precedence: */
function resolveXAIBaseURL(modelRegistry: ModelRegistry, provider: XAIProvider, modelId: string | undefined): string {
	if (modelId) {
		const merged = modelRegistry.getAll().find(m => m.id === modelId && m.provider === provider);
		if (merged?.baseUrl) {
			const bundled = getBundledModels(provider as Parameters<typeof getBundledModels>[0]).find(
				m => m.id === modelId,
			);
			const providerDefault = bundled?.baseUrl ?? DEFAULT_BASE_URL;
			if (merged.baseUrl !== providerDefault) {
				return trimTrailingSlashes(merged.baseUrl);
			}
		}
	}
	const providerBaseUrl = modelRegistry.getProviderBaseUrl(provider);
	if (providerBaseUrl) {
		const normalized = trimTrailingSlashes(providerBaseUrl);
		if (normalized !== DEFAULT_BASE_URL) return normalized;
	}
	return trimTrailingSlashes($env.XAI_BASE_URL || DEFAULT_BASE_URL);
}

/** Resolve xAI credentials for HTTP tool calls. Credential priority: */
export async function resolveXAIHttpCredentials(
	modelRegistry: ModelRegistry,
	modelId?: string,
): Promise<XAICredentials | null> {
	const hasDedicatedXaiOAuth =
		modelRegistry.authStorage.hasNonEnvCredential("xai-oauth") || Boolean($env.XAI_OAUTH_TOKEN);
	if (hasDedicatedXaiOAuth) {
		const oauthKey = await modelRegistry.getApiKeyForProvider("xai-oauth");
		if (oauthKey) {
			const baseURL = resolveXAIBaseURL(modelRegistry, "xai-oauth", modelId);
			return { provider: "xai-oauth", apiKey: oauthKey, baseURL };
		}
	}

	const apiKey = await modelRegistry.getApiKeyForProvider("xai");
	if (apiKey) {
		const baseURL = resolveXAIBaseURL(modelRegistry, "xai", modelId);
		return { provider: "xai", apiKey, baseURL };
	}

	return null;
}

/** What to do when {@link resolveXAIHttpCredentials} returns `null`. ONE OWNER, because there were two copies and they drifted. `tools/image-gen.ts` */
export function missingXAICredentialsMessage(what: string): string {
	return (
		`No xAI credentials, so ${what}. ` +
		"Fix: set XAI_API_KEY in the environment, or run `veyyon auth-broker login xai-oauth` to sign in with a " +
		"SuperGrok or X Premium+ account (`/login` in an interactive veyyon session). " +
		"Do not retry this tool until one of those is done; report the missing credential instead."
	);
}
