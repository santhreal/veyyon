/**
 * Broker-aware auth-storage discovery used by both the coding-agent runtime and
 * the catalog model generator. Keeps the precedence logic (env → config.yml/config.yaml →
 * token file → local SQLite) in one place so build-time tooling sees the same
 * credentials as the TUI.
 */

import { existsSync } from "node:fs";
import * as path from "node:path";
import {
	$pickenv,
	getAgentDbPath,
	getAgentDir,
	getAuthBrokerSnapshotCachePath,
	getConfigRootDir,
	isEnoent,
	isRecord,
	logger,
	MAIN_CONFIG_FILENAMES,
} from "@veyyon/utils";
import { YAML } from "bun";
import type { AuthCredential } from "../auth-storage";
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
	configValueResolver?: (config: string) => Promise<string | undefined>;
	cachePath?: string;
	sourceLabel?: string;
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
 * 3. `<config-root>/auth-broker.token` file (paired with a URL from env/config).
 *
 * Returns `null` when no broker URL is configured — callers should fall back to
 * the local SQLite store. Throws when a URL is configured but no token is
 * available, matching the TUI behavior.
 */
export async function resolveAuthBrokerConfig(
	options: ResolveAuthBrokerConfigOptions = {},
): Promise<AuthBrokerClientConfig | null> {
	const agentDir = options.agentDir ?? getAgentDir();
	const resolveConfig = options.configValueResolver ?? defaultResolveConfigValue;

	const envUrl = $pickenv("VEYYON_AUTH_BROKER_URL");
	const envToken = $pickenv("VEYYON_AUTH_BROKER_TOKEN");

	let url = envUrl && envUrl.length > 0 ? envUrl : undefined;
	let configToken: string | undefined;
	if (!url || !envToken) {
		const fromConfig = await readConfigYaml(agentDir);
		if (!url && fromConfig.url) {
			const resolved = await resolveConfig(fromConfig.url);
			if (resolved && resolved.length > 0) url = resolved;
		}
		if (fromConfig.token) {
			const resolved = await resolveConfig(fromConfig.token);
			if (resolved && resolved.length > 0) configToken = resolved;
		}
	}
	if (!url) return null;

	const token =
		(envToken && envToken.length > 0 ? envToken : undefined) ?? configToken ?? (await readTokenFile()) ?? undefined;
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

	if (brokerConfig) {
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

		let initialSnapshot: SnapshotResponse | undefined;
		if (ttlMs > 0) {
			initialSnapshot =
				(await readAuthBrokerSnapshotCache({
					path: cachePath,
					token: brokerConfig.token,
					url: brokerConfig.url,
					ttlMs,
				}).catch(error => {
					logger.debug("auth-broker snapshot cache read failed", { error: String(error) });
					return null;
				})) ?? undefined;
		}
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
		const storage = new AuthStorage(store, {
			configValueResolver: options.configValueResolver,
			sourceLabel: options.sourceLabel ?? `broker ${brokerConfig.url}`,
		});
		await storage.reload();
		return storage;
	}

	const storeAgentDir = options.storeAgentDir ?? agentDir;
	const dbPath = getAgentDbPath(storeAgentDir);
	// Shared-store first run: the machine-wide store is empty, but the per-profile
	// store may already hold a valid login. Promote it once so enabling "shared by
	// default" never silently logs the user out. No-op when the store dir is the
	// per-profile dir (sharing off) or the shared store already has credentials.
	if (options.storeAgentDir && options.storeAgentDir !== agentDir) {
		await seedSharedCredentialStore(getAgentDbPath(agentDir), dbPath);
	}
	const storage = await AuthStorage.create(dbPath, {
		configValueResolver: options.configValueResolver,
		sourceLabel: options.sourceLabel ?? `local ${dbPath}`,
	});
	await storage.reload();
	return storage;
}

/**
 * One-time promotion of a per-profile credential store into the shared,
 * machine-wide store. Copies only when the shared store has no credentials yet,
 * so it seeds on first activation of "shared by default" and never clobbers a
 * shared store the user has already populated. Copies the full credential
 * (including refresh tokens) at the store level — never the redacted snapshot —
 * so no re-login is forced. Disabled credentials are skipped: a known-bad login
 * is not worth promoting. Idempotent under concurrency because
 * `replaceAuthCredentialsForProvider` is a per-provider replace with identical
 * data, so a racing second process writes the same rows.
 */
async function seedSharedCredentialStore(sourceDbPath: string, sharedDbPath: string): Promise<void> {
	if (sourceDbPath === sharedDbPath) return;
	if (!existsSync(sourceDbPath)) return;
	const shared = await SqliteAuthCredentialStore.open(sharedDbPath);
	try {
		if (shared.listAuthCredentials().length > 0) return;
		const source = await SqliteAuthCredentialStore.open(sourceDbPath);
		try {
			// `listAuthCredentials` already returns only active rows; the explicit
			// disabled guard keeps the promotion correct even if that ever changes,
			// so a known-bad login is never carried into the shared store.
			const rows = source.listAuthCredentials().filter(row => row.disabledCause === null);
			if (rows.length === 0) return;
			const byProvider = new Map<string, AuthCredential[]>();
			for (const row of rows) {
				const list = byProvider.get(row.provider);
				if (list) list.push(row.credential);
				else byProvider.set(row.provider, [row.credential]);
			}
			for (const [provider, credentials] of byProvider) {
				shared.replaceAuthCredentialsForProvider(provider, credentials);
			}
			logger.info("Promoted per-profile credentials to the shared store", {
				source: sourceDbPath,
				shared: sharedDbPath,
				providers: [...byProvider.keys()],
				count: rows.length,
			});
		} finally {
			source.close();
		}
	} finally {
		shared.close();
	}
}
