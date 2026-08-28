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
	storeAgentDir?: string;
	seedSourceDbPaths?: string[];
	configValueResolver?: (config: string) => Promise<string | undefined>;
	cachePath?: string;
	sourceLabel?: string;
	loadBalancing?: boolean | (() => boolean);
}

export function getAuthBrokerTokenFilePath(): string {
	return path.join(getConfigRootDir(), "auth-broker.token");
}

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
		const fromProfile = await readConfigYaml(agentDir);
		const fromGlobal = await readConfigYaml(getGlobalConfigRootDir());
		const fromConfig = { url: fromProfile.url ?? fromGlobal.url, token: fromProfile.token ?? fromGlobal.token };
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
			loadBalancing: options.loadBalancing,
		});
		await storage.reload();
		return storage;
	}

	const storeAgentDir = options.storeAgentDir ?? agentDir;
	const dbPath = getAgentDbPath(storeAgentDir);
	if (options.storeAgentDir && options.storeAgentDir !== agentDir) {
		const seedSources = options.seedSourceDbPaths ?? [getAgentDbPath(agentDir)];
		await seedSharedCredentialStore(seedSources, dbPath);
	}
	const storage = await AuthStorage.create(dbPath, {
		configValueResolver: options.configValueResolver,
		sourceLabel: options.sourceLabel ?? `local ${dbPath}`,
		loadBalancing: options.loadBalancing,
	});
	await storage.reload();
	return storage;
}

async function seedSharedCredentialStore(sourceDbPaths: readonly string[], sharedDbPath: string): Promise<void> {
	const shared = await SqliteAuthCredentialStore.open(sharedDbPath);
	try {
		if (shared.listAuthCredentials().length > 0) return;
		for (const sourceDbPath of sourceDbPaths) {
			if (sourceDbPath === sharedDbPath) continue;
			if (!existsSync(sourceDbPath)) continue;
			const source = await SqliteAuthCredentialStore.open(sourceDbPath);
			let seeded = false;
			try {
				const rows = source.listAuthCredentials().filter(row => row.disabledCause === null);
				if (rows.length === 0) continue;
				const byProvider = new Map<string, AuthCredential[]>();
				for (const row of rows) {
					const list = byProvider.get(row.provider);
					if (list) list.push(row.credential);
					else byProvider.set(row.provider, [row.credential]);
				}
				for (const [provider, credentials] of byProvider) {
					shared.replaceAuthCredentialsForProvider(provider, credentials);
				}
				seeded = true;
				logger.info("Promoted per-profile credentials to the shared store", {
					source: sourceDbPath,
					shared: sharedDbPath,
					providers: Array.from(byProvider.keys()),
					count: rows.length,
				});
			} finally {
				source.close();
			}
			if (seeded) return;
		}
	} finally {
		shared.close();
	}
}
