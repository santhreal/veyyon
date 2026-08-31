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

/**
 * Resolve the HTTP base URL for an xAI tool call.
 *
 * Precedence:
 *   1. `model.baseUrl` from the registry IF the user pinned a per-model
 *      override — i.e. `merged.baseUrl` differs from the seeded/bundled
 *      default for the (provider, id) pair. Mirrors the chat path's per-model
 *      contract (`openai-responses.ts: model.baseUrl`).
 *   2. `ModelRegistry.getProviderBaseUrl(provider)` — provider-level override
 *      (e.g. `providers.xai-oauth.baseUrl` from models.yml). Reached when the
 *      modelId does not appear in the registry under this provider, which
 *      happens for tool-only ids like `grok-imagine-image` that
 *      `applyXAIOAuthCuration` filters out via `XAI_NON_CHAT_PREFIXES`.
 *      Without this leg, a registry-configured proxy is silently bypassed for
 *      image/TTS traffic.
 *   3. `XAI_BASE_URL` env var (legacy global override, preserved).
 *   4. `DEFAULT_BASE_URL = "https://api.x.ai/v1"`.
 *
 * The override gate at step 1 uses `bundled?.baseUrl ?? DEFAULT_BASE_URL` as
 * the canonical default sentinel. For xai (which has bundled entries) this
 * compares against the bundled value; for xai-oauth (no bundled entries —
 * models.json carries no xai-oauth records when the seed is absent, the
 * picker is seeded statically from `xaiOAuthModelManagerOptions` with
 * `baseUrl: DEFAULT_BASE_URL`) the sentinel falls back to DEFAULT_BASE_URL
 * so the env leg remains reachable. Without that fallback, every xai-oauth
 * model id forces `!bundled === true` and short-circuits XAI_BASE_URL
 * silently. Lookup is scoped to (provider, id); matching by id alone would
 * let xai-oauth entries hijack a xai tool call (or vice versa) when the
 * same model id ships under both descriptors.
 */
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

/**
 * Resolve xAI credentials for HTTP tool calls.
 *
 * Credential priority:
 *   1. xai-oauth — only when a *dedicated* xai-oauth source exists. Composed
 *      of two checks against the registry layer:
 *        a. `authStorage.hasNonEnvCredential("xai-oauth")` covers stored
 *           credentials (OAuth or api_key), runtime overrides (CLI
 *           `--api-key` for xai-oauth), config overrides (models.yml
 *           `providers.xai-oauth.apiKey`), and fallback resolvers.
 *        b. `$env.XAI_OAUTH_TOKEN` covers the xai-oauth-specific env var.
 *      `XAI_API_KEY` is intentionally NOT a signal here, even though the
 *      env-fallback map (`stream.ts: "xai-oauth"`) lets xai-oauth borrow it
 *      as a back-compat convenience: the borrow lets API-key-only setups
 *      satisfy the xai-oauth branch and then resolve baseUrl under
 *      xai-oauth instead of xai, silently bypassing `providers.xai.baseUrl`
 *      overrides for image/TTS traffic. The gate routes the borrow case to
 *      step 2 while preserving every dedicated xai-oauth path.
 *   2. xai (plain API key). Delegates to ModelRegistry.getApiKeyForProvider
 *      which runs AuthStorage.getApiKey's full cascade: runtime override →
 *      models.yml config override → stored api_key credential → OAuth
 *      resolution → XAI_API_KEY env var → custom fallback resolver.
 *
 * baseURL: see `resolveXAIBaseURL` above. Resolved AFTER the credential
 * decision so the scoped (provider, id) lookup is unambiguous. `modelId`
 * is optional; probes / tool-availability checks pass `undefined` and fall
 * through to env/default.
 *
 * Returns null when neither credential is available. Caller is responsible
 * for surfacing an actionable error message in that case.
 */
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

/**
 * What to do when {@link resolveXAIHttpCredentials} returns `null`.
 *
 * ONE OWNER, because there were two copies and they drifted. `tools/image-gen.ts`
 * and `tools/tts.ts` each carried the same sentence; image-gen's was corrected to
 * name a reachable command and tts's was left saying `Run /login -> xAI Grok
 * OAuth`, which is a TUI submenu path. `/login` carries no `textMode: true` in
 * `slash-commands/builtin-declarations.ts`, so it is unreachable from an ACP
 * client, a `--print` run, and the model.
 *
 * THE READER IS THE MODEL FIRST. Both call sites are tool failures, so the model
 * reads this before any person does, and it can neither sign in nor open a menu.
 * Without a stopping rule its options are to call the tool again with the same
 * arguments or to abandon the task, so the rule is stated: a missing credential
 * does not appear between two calls.
 *
 * The OAuth provider id is `xai-oauth` (`registry/oauth/xai-oauth.ts`). `xai` has
 * no login flow and `veyyon auth-broker login xai` would be refused.
 *
 * @param what The capability that could not run, e.g. `speech cannot be synthesized`.
 */
export function missingXAICredentialsMessage(what: string): string {
	return (
		`No xAI credentials, so ${what}. ` +
		"Fix: set XAI_API_KEY in the environment, or run `veyyon auth-broker login xai-oauth` to sign in with a " +
		"SuperGrok or X Premium+ account (`/login` in an interactive veyyon session). " +
		"Do not retry this tool until one of those is done; report the missing credential instead."
	);
}
