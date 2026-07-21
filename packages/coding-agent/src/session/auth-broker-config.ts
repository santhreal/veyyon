/**
 * Resolve auth-broker connection configuration for the local veyyon client.
 *
 * This is a thin coding-agent wrapper around the shared resolver in
 * `@veyyon/ai/auth-broker/discover` that preserves the process-lifetime
 * memoization expected by the CLI and injects the full `resolveConfigValue`
 * (including `!command` config indirection) from coding-agent's config layer.
 *
 * Precedence (highest first):
 *   1. `VEYYON_AUTH_BROKER_URL` / `VEYYON_AUTH_BROKER_TOKEN` env vars.
 *   2. `auth.broker.url` / `auth.broker.token` in `~/.veyyon/profiles/default/agent/config.yml`
 *      (hidden from the settings UI; `!command` resolution supported).
 *   3. Token file `~/.veyyon/auth-broker.token` (paired with URL from env or config).
 *
 * Returns null when no broker URL is configured — caller falls back to the
 * local SQLite store.
 *
 * Reads config.yml directly (instead of going through `Settings.init`) because
 * `discoverAuthStorage` runs before the settings singleton is initialized in
 * `runRootCommand`, and we want hand-edited config entries to be honoured at
 * boot without forcing a startup reorder.
 */

import {
	type AuthBrokerClientConfig,
	type DiscoverAuthStorageOptions,
	discoverAuthStorage as discoverAuthStorageShared,
	getAuthBrokerTokenFilePath,
	resolveAuthBrokerConfig as resolveAuthBrokerConfigShared,
} from "@veyyon/ai/auth-broker/discover";
import { getAgentDir, getSharedAuthDir, readGlobalProfileSharingSafe } from "@veyyon/utils";
import { resolveConfigValue } from "../config/resolve-config-value";
import type { AuthStorage } from "./auth-storage";

export { type AuthBrokerClientConfig, getAuthBrokerTokenFilePath };

/**
 * Process-lifetime memo for {@link resolveAuthBrokerConfig}. Keyed on the env
 * inputs (plus agent dir, which decides which config.yml is read) so tests
 * that flip `VEYYON_AUTH_BROKER_*` between cases still observe the change, while
 * repeated resolution within one CLI invocation (startup, subagent sessions)
 * skips the config.yml read and any `!command` token resolution.
 */
let cachedConfigKey: string | null = null;
let cachedConfigPromise: Promise<AuthBrokerClientConfig | null> | null = null;

/**
 * Read broker configuration. Returns null when the URL is missing
 * (broker disabled — local store is used). Throws when URL is set but no
 * token is available — the caller cannot fall back silently because the
 * user explicitly asked to use the broker.
 *
 * Successful resolutions (including "no broker configured") are memoized for
 * the process lifetime; failures are not, so a missing token can be fixed and
 * retried. Concurrent callers share one in-flight resolution.
 */
export function resolveAuthBrokerConfig(): Promise<AuthBrokerClientConfig | null> {
	const key = `${process.env.VEYYON_AUTH_BROKER_URL ?? ""}\u0000${process.env.VEYYON_AUTH_BROKER_TOKEN ?? ""}\u0000${getAgentDir()}`;
	if (cachedConfigPromise && cachedConfigKey === key) return cachedConfigPromise;
	const promise = resolveAuthBrokerConfigShared({
		agentDir: getAgentDir(),
		configValueResolver: resolveConfigValue,
	});
	cachedConfigKey = key;
	cachedConfigPromise = promise;
	promise.catch(() => {
		if (cachedConfigPromise === promise) {
			cachedConfigPromise = null;
			cachedConfigKey = null;
		}
	});
	return promise;
}

/**
 * Create an AuthStorage instance, using the broker when configured and falling
 * back to the local SQLite store otherwise. Delegates to the shared resolver in
 * pi-ai so the CLI, subagents, and the catalog generator all see the same
 * credentials.
 *
 * When the global `profileSharing` posture is on (the default), the LOCAL
 * credential store is redirected to the machine-wide shared store
 * ({@link getSharedAuthDir}) so every profile reads one set of logins; broker
 * resolution still keys on the per-profile `agentDir`. Setting `profileSharing:
 * false` in the global config isolates each profile to its own store. The first
 * shared read promotes any existing per-profile login into the shared store, so
 * turning sharing on never logs the user out.
 *
 * Default `agentDir` is the current configured agent directory.
 */
export function discoverAuthStorage(
	agentDir: string = getAgentDir(),
	options?: Omit<DiscoverAuthStorageOptions, "agentDir" | "configValueResolver" | "storeAgentDir">,
): Promise<AuthStorage> {
	const storeAgentDir = readGlobalProfileSharingSafe() ? getSharedAuthDir() : undefined;
	return discoverAuthStorageShared({
		...options,
		agentDir,
		storeAgentDir,
		configValueResolver: resolveConfigValue,
	});
}
