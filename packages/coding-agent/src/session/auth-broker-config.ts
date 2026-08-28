/** Resolve auth-broker connection configuration for the local veyyon client. This is a thin coding-agent wrapper around the shared resolver in */

import {
	type AuthBrokerClientConfig,
	type DiscoverAuthStorageOptions,
	discoverAuthStorage as discoverAuthStorageShared,
	getAuthBrokerTokenFilePath,
	resolveAuthBrokerConfig as resolveAuthBrokerConfigShared,
} from "@veyyon/ai/auth-broker/discover";
import {
	getAgentDbPath,
	getAgentDir,
	getLegacyPerProfileSharedAuthDirs,
	getSharedAuthDir,
	readGlobalProfileSharingSafe,
} from "@veyyon/utils";
import { resolveConfigValue } from "../config/resolve-config-value";
import { settingsOrNull } from "../config/settings-instance";
import { getDefault } from "../config/settings-schema";
import type { AuthStorage } from "./auth-storage";

export { type AuthBrokerClientConfig, getAuthBrokerTokenFilePath };

/** Process-lifetime memo for {@link resolveAuthBrokerConfig}. Keyed on the env inputs (plus agent dir, which decides which config.yml is read) so tests */
let cachedConfigKey: string | null = null;
let cachedConfigPromise: Promise<AuthBrokerClientConfig | null> | null = null;

/** Read broker configuration. Returns null when the URL is missing (broker disabled — local store is used). Throws when URL is set but no */
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

/** Create an AuthStorage instance, using the broker when configured and falling back to the local SQLite store otherwise. Delegates to the shared resolver in */
export function discoverAuthStorage(
	agentDir: string = getAgentDir(),
	options?: Omit<DiscoverAuthStorageOptions, "agentDir" | "configValueResolver" | "loadBalancing" | "storeAgentDir">,
): Promise<AuthStorage> {
	const storeAgentDir = readGlobalProfileSharingSafe() ? getSharedAuthDir() : undefined;
	// When seeding the shared store on first run, look past the current profile's store: promote from any legacy per-profile `shared-auth` dir too (the old
	const seedSourceDbPaths = storeAgentDir
		? [getAgentDbPath(agentDir), ...getLegacyPerProfileSharedAuthDirs().map(dir => getAgentDbPath(dir))]
		: undefined;
	return discoverAuthStorageShared({
		...options,
		agentDir,
		storeAgentDir,
		seedSourceDbPaths,
		configValueResolver: resolveConfigValue,
		// A resolver, not a snapshot: this runs before `Settings.init` on the boot path, and the operator can flip the toggle mid-session from `/settings`. Reading per decision is what
		loadBalancing: () => settingsOrNull()?.get("accounts.loadBalancing") ?? getDefault("accounts.loadBalancing"),
	});
}
