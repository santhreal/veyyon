/**
 * Single-source provider auth model. Every provider — model providers,
 * gateways, search/tool credentials, and login-only flows — is described by
 * one {@link ProviderDefinition}. The legacy scattered structures (the
 * `OAuthProvider` union, `serviceProviderMap`, `builtInOAuthProviders`, the
 * refresh/login switches, and the CLI callback maps) are all *derived* from
 * the registry of these definitions. Adding a provider is one new file in
 * `./providers/` plus one line in `./registry.ts`. Model-catalog metadata
 * (default model, model-manager factory, catalog discovery) lives in
 * `@veyyon/catalog`'s descriptor table.
 */
import type { OAuthCredentials, OAuthLoginCallbacks } from "./oauth/types";

/**
 * API-key environment fallback, re-exported from its owner so the name stays where callers expect it.
 *
 * It was declared here AND in `env-api-key.ts`, identically, which is the same-name duplicate that drifts.
 * `../provider-env-keys.ts` owns both the type and the table it describes.
 */
export type { KeyResolver } from "../provider-env-keys";

/**
 * Declarative description of a single provider's auth/login wiring. All
 * fields are optional except `id`/`name`; presence of a field opts the
 * provider into a derived structure:
 *
 * - `login` present ⇒ member of `OAuthProvider`, shown in the `/login` list
 *   (unless `showInLoginList === false`) and dispatchable via `AuthStorage.login`.
 * - `callbackPort` present ⇒ entry in the auth-broker `CALLBACK_PORTS` map.
 * - `pasteCodeFlow` ⇒ member of `PASTE_CODE_LOGIN_PROVIDERS`.
 *
 * Heavy OAuth flow modules MUST be reached through dynamic-import thunks in
 * `login`/`refreshToken` so they stay out of the eager startup graph.
 */
export interface ProviderDefinition {
	readonly id: string;
	readonly name: string;
	/** Login-list availability flag. Defaults to true when shown. */
	readonly available?: boolean;
	/** Whether to surface in the interactive login list. Defaults to true when `login` is present. */
	readonly showInLoginList?: boolean;
	// --- env-var fallback (the catalog table's `envVars` supplies plain names; set this only for computed resolvers) ---
	// --- interactive login (OAuthProviderInterface-compatible) ---
	readonly login?: (callbacks: OAuthLoginCallbacks) => Promise<OAuthCredentials | string>;
	readonly refreshToken?: (credentials: OAuthCredentials) => Promise<OAuthCredentials>;
	readonly getApiKey?: (credentials: OAuthCredentials) => string;
	/** Store OAuth credentials under a different provider id (e.g. `openai-codex-device` ⇒ `openai-codex`). */
	readonly storeCredentialsAs?: string;
	// --- coding-agent login UX ---
	/** Auth-broker local callback-server port. Presence ⇒ entry in `CALLBACK_PORTS`. */
	readonly callbackPort?: number;
	/** OAuth flow needs a pasted code/redirect URL rather than a callback server. */
	readonly pasteCodeFlow?: boolean;
}
