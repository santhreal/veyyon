/**
 * Broker-aware auth-storage discovery used by both the coding-agent runtime and
 * the catalog model generator. Keeps the precedence logic (env → config.yml/config.yaml →
 * token file → local SQLite) in one place so build-time tooling sees the same
 * credentials as the TUI.
 */

import { existsSync } from "node:fs";
import * as path from "node:path";
import {
	getAgentDbPath,
	getAgentDir,
	getAuthBrokerSnapshotCachePath,
	getConfigRootDir,
	getGlobalConfigRootDir,
	MAIN_CONFIG_FILENAMES,
} from "@veyyon/utils/dirs";
import { $pickenv } from "@veyyon/utils/env";
import { isEnoent } from "@veyyon/utils/fs-error";
import * as logger from "@veyyon/utils/logger";
import { isRecord } from "@veyyon/utils/type-guards";
import { YAML } from "bun";
import type { AuthCredential } from "../auth-storage";
// This module constructs an `AuthStorage` from the subpath rather than through the barrel, so it
// carries the registry wiring itself; see the note on the same import in `../index.ts`.
import "../usage/defaults";
import { AuthStorage, SqliteAuthCredentialStore } from "../auth-storage";
import * as AIError from "../error";
import { AuthBrokerClient } from "./client";
import { RemoteAuthCredentialStore } from "./remote-store";
import { readAuthBrokerSnapshotCache, writeAuthBrokerSnapshotCache } from "./snapshot-cache";
import { DEFAULT_SNAPSHOT_CACHE_TTL_MS, type SnapshotResponse } from "./types";

export interface AuthBrokerClientConfig {
	url: string;
	token: string;
}

export interface ResolveAuthBrokerConfigOptions {
	agentDir?: string;
	configValueResolver?: (config: string) => Promise<string | undefined>;
}

export interface DiscoverAuthStorageOptions {
	agentDir?: string;
	/**
	 * Directory whose `agent.db` backs the LOCAL SQLite credential store, when no
	 * broker is configured. Defaults to `agentDir`. Split out so a caller can keep
	 * broker resolution keyed on the per-profile `agentDir` (a profile may define
	 * its own broker) while pointing the local credential store at a shared,
	 * cross-profile location — the mechanism behind machine-wide "shared by
	 * default" credentials. When a broker IS configured it wins regardless, so
	 * this only affects the local-store fallback.
	 */
	storeAgentDir?: string;
	/**
	 * Candidate legacy credential-store `agent.db` paths to promote from on the
	 * first run of a shared store, tried in order until one seeds the (empty)
	 * shared store. Defaults to `[getAgentDbPath(agentDir)]` — the per-profile
	 * store. A caller that knows about older store locations (e.g. a per-profile
	 * `shared-auth` dir that predates the move to a global shared store) passes
	 * them here so credentials orphaned by that move are recovered, not lost.
	 * Only consulted when `storeAgentDir` differs from `agentDir` (sharing on).
	 */
	seedSourceDbPaths?: string[];
	configValueResolver?: (config: string) => Promise<string | undefined>;
	cachePath?: string;
	sourceLabel?: string;
	/**
	 * Forwarded verbatim to {@link AuthStorage}: whether quota exhaustion may move a provider to
	 * another of its accounts. Threaded through here because the discovery entry point is the only
	 * place the app constructs its storage, and the option would otherwise be unreachable from it.
	 */
	loadBalancing?: boolean | (() => boolean);
}

/** Path to the local bearer token file. Created by `veyyon auth-broker token`. */
export function getAuthBrokerTokenFilePath(): string {
	return path.join(getConfigRootDir(), "auth-broker.token");
}

/**
 * Default resolver for config values: checks `process.env` first, then treats
 * the value as a literal. Does NOT execute `!command` syntax; such values are
 * left unresolved so the caller can fall back to the token file.
 */
async function defaultResolveConfigValue(config: string): Promise<string | undefined> {
	if (config.startsWith("!")) return undefined;
	const envValue = process.env[config];
	return envValue || config;
}

async function readTokenFile(): Promise<string | null> {
	try {
		const raw = await Bun.file(getAuthBrokerTokenFilePath()).text();
		const trimmed = raw.trim();
		return trimmed.length > 0 ? trimmed : null;
	} catch (err) {
		if (isEnoent(err)) return null;
		logger.warn("auth-broker token file unreadable", { error: String(err) });
		return null;
	}
}

interface ConfigSnapshot {
	url?: string;
	token?: string;
}

/**
 * Resolve a dotted config key (e.g. `auth.broker.url`) against a parsed YAML
 * record, accepting both nested form (`auth: { broker: { url } }`) and the
 * legacy flat literal-dot key (`"auth.broker.url": ...`). Nested wins when both
 * are present. Returns the value only when it is a string.
 */
function readDottedString(record: Record<string, unknown>, dottedKey: string): string | undefined {
	let current: unknown = record;
	for (const segment of dottedKey.split(".")) {
		if (!isRecord(current)) {
			current = undefined;
			break;
		}
		current = (current as Record<string, unknown>)[segment];
	}
	if (typeof current === "string") return current;
	const flat = record[dottedKey];
	return typeof flat === "string" ? flat : undefined;
}

async function readConfigYaml(agentDir: string): Promise<ConfigSnapshot> {
	for (const filename of MAIN_CONFIG_FILENAMES) {
		const configPath = path.join(agentDir, filename);
		try {
			const raw = await Bun.file(configPath).text();
			const parsed = YAML.parse(raw);
			if (!isRecord(parsed)) return {};
			const record = parsed as Record<string, unknown>;
			const url = readDottedString(record, "auth.broker.url");
			const token = readDottedString(record, "auth.broker.token");
			return { url, token };
		} catch (err) {
			if (isEnoent(err)) continue;
			logger.warn("auth-broker config unreadable", { path: configPath, error: String(err) });
			return {};
		}
	}
	return {};
}

function resolveSnapshotTtlMs(): number {
	const raw = $pickenv("VEYYON_AUTH_BROKER_SNAPSHOT_TTL_MS");
	if (raw === undefined) return DEFAULT_SNAPSHOT_CACHE_TTL_MS;
	const value = raw.trim();
	if (value === "") return DEFAULT_SNAPSHOT_CACHE_TTL_MS;
	const ttlMs = Number(value);
	if (Number.isFinite(ttlMs) && ttlMs >= 0) return ttlMs;
	logger.warn("Invalid VEYYON_AUTH_BROKER_SNAPSHOT_TTL_MS; using default", {
		value: raw,
	});
	return DEFAULT_SNAPSHOT_CACHE_TTL_MS;
}

/**
 * Resolve broker connection configuration using the same precedence as the TUI:
 *
 * 1. `VEYYON_AUTH_BROKER_URL` / `VEYYON_AUTH_BROKER_TOKEN` env vars.
 * 2. `auth.broker.url` / `auth.broker.token` in `<agentDir>/config.yml` or `<agentDir>/config.yaml`.
 * 3. The same keys in the machine-wide global config (`~/.veyyon/config.yml`),
 *    which is where the Settings UI's Global tab writes them — the broker is a
 *    cross-profile concern, so one machine-wide entry serves every profile
 *    while a profile's own config can still override it.
 * 4. `<config-root>/auth-broker.token` file (paired with a URL from env/config).
 *
 * Only a config value that supplies the result is passed to the resolver: a
 * value an env var overrides, and a token when no URL is configured, are not,
 * so their `!command` does not run. A config value that resolves to an empty
 * string counts as unset: a URL leaves no broker configured, and a token falls
 * through to the token file.
 *
 * Returns `null` when no broker URL is configured — callers should fall back to
 * the local SQLite store. Throws when a URL is configured but no token is
 * available, matching the TUI behavior.
 */
export async function resolveAuthBrokerConfig(
	options: ResolveAuthBrokerConfigOptions = {},
): Promise<AuthBrokerClientConfig | null> {
	const resolveConfig = options.configValueResolver ?? defaultResolveConfigValue;
	const envUrl = $pickenv("VEYYON_AUTH_BROKER_URL") || undefined;
	const envToken = $pickenv("VEYYON_AUTH_BROKER_TOKEN") || undefined;
	const configured: ConfigSnapshot =
		envUrl && envToken ? {} : await readBrokerConfigFiles(options.agentDir ?? getAgentDir());
	const url = envUrl ?? (configured.url ? (await resolveConfig(configured.url)) || undefined : undefined);
	if (!url) return null;

	const configToken = envToken || !configured.token ? undefined : (await resolveConfig(configured.token)) || undefined;
	const token = envToken ?? configToken ?? (await readTokenFile());
	if (!token) {
		throw new AIError.MissingApiKeyError(
			undefined,
			`VEYYON_AUTH_BROKER_URL is set (${url}) but no bearer token is available. ` +
				`Set VEYYON_AUTH_BROKER_TOKEN, the \`auth.broker.token\` config entry, or place one at ${getAuthBrokerTokenFilePath()}.`,
		);
	}
	return { url, token };
}

/**
 * The broker URL and token the config files set, unresolved. Per-key precedence: the profile's own
 * config wins, and the machine-wide global config fills whichever keys the profile leaves unset.
 */
async function readBrokerConfigFiles(agentDir: string): Promise<ConfigSnapshot> {
	const [fromProfile, fromGlobal] = await Promise.all([
		readConfigYaml(agentDir),
		readConfigYaml(getGlobalConfigRootDir()),
	]);
	return { url: fromProfile.url ?? fromGlobal.url, token: fromProfile.token ?? fromGlobal.token };
}

/**
 * Create an AuthStorage instance, using the broker when configured and falling
 * back to the local SQLite store otherwise. This is the single source of truth
 * for the TUI and the catalog generator.
 */
export async function discoverAuthStorage(options: DiscoverAuthStorageOptions = {}): Promise<AuthStorage> {
	const agentDir = options.agentDir ?? getAgentDir();
	const brokerConfig = await resolveAuthBrokerConfig({
		agentDir,
		configValueResolver: options.configValueResolver,
	});
	const storage = brokerConfig
		? await openBrokerStorage(brokerConfig, options)
		: await openLocalStorage(agentDir, options);
	await storage.reload();
	return storage;
}

/** An AuthStorage served by the broker at `brokerConfig`, seeded from the snapshot cache when it is fresh. */
async function openBrokerStorage(
	brokerConfig: AuthBrokerClientConfig,
	options: DiscoverAuthStorageOptions,
): Promise<AuthStorage> {
	const client = new AuthBrokerClient({ url: brokerConfig.url, token: brokerConfig.token });
	const cachePath = options.cachePath ?? getAuthBrokerSnapshotCachePath();
	const ttlMs = resolveSnapshotTtlMs();
	const persist =
		ttlMs > 0
			? (snapshot: SnapshotResponse): void => {
					void writeAuthBrokerSnapshotCache({
						path: cachePath,
						token: brokerConfig.token,
						url: brokerConfig.url,
						snapshot,
					}).catch(error => {
						logger.debug("auth-broker snapshot cache write failed", { error: String(error) });
					});
				}
			: undefined;

	let initialSnapshot = ttlMs > 0 ? await readCachedSnapshot(brokerConfig, cachePath, ttlMs) : undefined;
	if (!initialSnapshot) {
		const initialResult = await client.fetchSnapshot();
		if (initialResult.status !== 200)
			throw new AIError.AuthBrokerError("Auth broker returned no initial snapshot", {
				status: initialResult.status,
			});
		initialSnapshot = initialResult.snapshot;
		persist?.(initialSnapshot);
	}
	const store = new RemoteAuthCredentialStore({
		client,
		initialSnapshot,
		onSnapshot: persist,
	});
	return new AuthStorage(store, {
		configValueResolver: options.configValueResolver,
		sourceLabel: options.sourceLabel ?? `broker ${brokerConfig.url}`,
		loadBalancing: options.loadBalancing,
	});
}

/** The cached snapshot for this broker and token, or undefined when it is absent, stale or unreadable. */
async function readCachedSnapshot(
	brokerConfig: AuthBrokerClientConfig,
	cachePath: string,
	ttlMs: number,
): Promise<SnapshotResponse | undefined> {
	const cached = await readAuthBrokerSnapshotCache({
		path: cachePath,
		token: brokerConfig.token,
		url: brokerConfig.url,
		ttlMs,
	}).catch(error => {
		logger.debug("auth-broker snapshot cache read failed", { error: String(error) });
		return null;
	});
	return cached ?? undefined;
}

/** An AuthStorage over the local SQLite store under `options.storeAgentDir`, or `agentDir` when unset. */
async function openLocalStorage(agentDir: string, options: DiscoverAuthStorageOptions): Promise<AuthStorage> {
	const storeAgentDir = options.storeAgentDir ?? agentDir;
	const dbPath = getAgentDbPath(storeAgentDir);
	// Shared-store first run: the machine-wide store is empty, but an older
	// per-profile store may already hold a valid login. Promote the first
	// candidate that has one so enabling "shared by default" never silently logs
	// the user out. Candidates default to the current per-profile store; a caller
	// can prepend legacy locations (e.g. a per-profile `shared-auth` dir that
	// predates the global-store move). No-op when the store dir is the per-profile
	// dir (sharing off) or the shared store already has credentials.
	const store = await SqliteAuthCredentialStore.open(dbPath);
	if (options.storeAgentDir && options.storeAgentDir !== agentDir) {
		const seedSources = options.seedSourceDbPaths ?? [getAgentDbPath(agentDir)];
		try {
			await seedSharedCredentialStore(seedSources, store, dbPath);
		} catch (error) {
			store.close();
			throw error;
		}
	}
	return new AuthStorage(store, {
		configValueResolver: options.configValueResolver,
		sourceLabel: options.sourceLabel ?? `local ${dbPath}`,
		loadBalancing: options.loadBalancing,
	});
}

/**
 * One-time promotion of an older per-profile credential store into the shared,
 * machine-wide store. Copies only when the shared store has no credentials yet,
 * so it seeds on first activation of "shared by default" and never clobbers a
 * shared store the user has already populated. `sourceDbPaths` are tried in
 * order and the FIRST one holding an active login wins (later candidates are
 * ignored), so a caller can list newest-to-oldest legacy locations. Copies the
 * full credential (including refresh tokens) at the store level — never the
 * redacted snapshot — so no re-login is forced. Disabled credentials are
 * skipped: a known-bad login is not worth promoting. Idempotent under
 * concurrency because `replaceAuthCredentialsForProvider` is a per-provider
 * replace with identical data, so a racing second process writes the same rows.
 *
 * `shared` is the connection the caller goes on to serve credentials from, so
 * a launch opens and schema-checks the shared database once rather than twice.
 */
async function seedSharedCredentialStore(
	sourceDbPaths: readonly string[],
	shared: SqliteAuthCredentialStore,
	sharedDbPath: string,
): Promise<void> {
	if (shared.listAuthCredentials().length > 0) return;
	for (const sourceDbPath of sourceDbPaths) {
		if (sourceDbPath === sharedDbPath || !existsSync(sourceDbPath)) continue;
		const source = await SqliteAuthCredentialStore.open(sourceDbPath);
		try {
			const byProvider = activeCredentialsByProvider(source);
			if (byProvider.size === 0) continue;
			let count = 0;
			for (const [provider, credentials] of byProvider) {
				shared.replaceAuthCredentialsForProvider(provider, credentials);
				count += credentials.length;
			}
			logger.info("Promoted per-profile credentials to the shared store", {
				source: sourceDbPath,
				shared: sharedDbPath,
				providers: Array.from(byProvider.keys()),
				count,
			});
			// First non-empty source wins; do not merge older stores on top.
			return;
		} finally {
			source.close();
		}
	}
}

/** The active credentials in `store`, grouped by provider in listing order. */
function activeCredentialsByProvider(store: SqliteAuthCredentialStore): Map<string, AuthCredential[]> {
	const byProvider = new Map<string, AuthCredential[]>();
	for (const row of store.listAuthCredentials()) {
		// `listAuthCredentials` already returns only active rows; the explicit
		// disabled guard keeps the promotion correct even if that ever changes,
		// so a known-bad login is never carried into the shared store.
		if (row.disabledCause !== null) continue;
		const list = byProvider.get(row.provider);
		if (list) list.push(row.credential);
		else byProvider.set(row.provider, [row.credential]);
	}
	return byProvider;
}
