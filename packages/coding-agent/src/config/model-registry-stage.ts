import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Api, Model } from "@veyyon/ai/types";
import { modelCacheStamp } from "@veyyon/catalog/model-cache";
import { bundledCatalogDigest } from "@veyyon/catalog/models";
import { atomicWriteFileSync, DAY_MS, errorMessage, getModelDbPath, isRecord, logger } from "@veyyon/utils";
import type { ConfigFile } from "./config-file";
import type { DiscoveryProviderConfig } from "./model-discovery";
import { PROVIDER_DISCOVERY_STATUSES, type ProviderDiscoveryState } from "./model-registry-discovery";
import type { CustomModelOverlay, ProviderOverride } from "./model-registry-overrides";
import type { ModelOverride, ModelsConfig } from "./models-config-schema";

export const REGISTRY_SNAPSHOT_VERSION = 5;

export interface StaticModelStage {
	createdAt: number;
	builtIn: Model<Api>[];
	cachedStandard: { models: Model<Api>[]; authoritativeFreshProviders: string[] };
	cachedDiscoveries: Model<Api>[];
	discoveryStates: ProviderDiscoveryState[];
}

export interface RestoredStaticStage {
	builtIn: Model<Api>[];
	cachedStandard: { models: Model<Api>[]; authoritativeFreshProviders: Set<string> };
	cachedDiscoveries: Model<Api>[];
	discoveryStates: ProviderDiscoveryState[];
}

export function computeStaticModelStageFingerprint(params: {
	cacheDbPath?: string;
	modelsConfigFile: ConfigFile<ModelsConfig>;
	customModelOverlays: CustomModelOverlay[];
	providerOverrides: Map<string, ProviderOverride>;
	modelOverrides: Map<string, Map<string, ModelOverride>>;
	keylessProviders: Set<string>;
	discoverableProviders: DiscoveryProviderConfig[];
}): string {
	const dbPath = params.cacheDbPath ?? getModelDbPath();
	const parts: Array<string | number> = [
		REGISTRY_SNAPSHOT_VERSION,
		bundledCatalogDigest(),
		modelCacheStamp(dbPath, { ttlMs: DAY_MS }),
		params.modelsConfigFile.getMtimeMs() ?? 0,
	];
	const customConfigDigest = createHash("sha256")
		.update(
			JSON.stringify({
				overlays: params.customModelOverlays,
				overrides: Array.from(params.providerOverrides),
				modelOverrides: Array.from(params.modelOverrides, ([provider, perModel]) => [
					provider,
					Array.from(perModel),
				]),
				keyless: Array.from(params.keylessProviders),
				discoverable: params.discoverableProviders,
			}),
		)
		.digest("hex");
	parts.push(customConfigDigest);
	return parts.join(":");
}

function getStaticModelStagePath(cacheDbPath?: string): string {
	return path.join(path.dirname(cacheDbPath ?? getModelDbPath()), "resolved-models.json");
}

function snapshotModelArray(value: unknown): Model<Api>[] | null {
	if (!Array.isArray(value)) return null;
	for (const entry of value) {
		if (
			!isRecord(entry) ||
			typeof entry.id !== "string" ||
			typeof entry.provider !== "string" ||
			typeof entry.api !== "string"
		) {
			return null;
		}
	}
	return value as Model<Api>[];
}

function snapshotDiscoveryStateArray(value: unknown): ProviderDiscoveryState[] | null {
	if (!Array.isArray(value)) return null;
	const states: ProviderDiscoveryState[] = [];
	for (const entry of value) {
		if (
			!isRecord(entry) ||
			typeof entry.provider !== "string" ||
			typeof entry.status !== "string" ||
			!PROVIDER_DISCOVERY_STATUSES.has(entry.status) ||
			typeof entry.optional !== "boolean" ||
			typeof entry.stale !== "boolean" ||
			(entry.fetchedAt !== undefined &&
				(typeof entry.fetchedAt !== "number" || !Number.isFinite(entry.fetchedAt))) ||
			!Array.isArray(entry.models) ||
			!entry.models.every(model => typeof model === "string") ||
			(entry.error !== undefined && typeof entry.error !== "string")
		) {
			return null;
		}
		states.push({
			provider: entry.provider,
			status: entry.status as ProviderDiscoveryState["status"],
			optional: entry.optional,
			stale: entry.stale,
			fetchedAt: entry.fetchedAt,
			models: entry.models,
			error: entry.error,
		});
	}
	return states;
}

export function readStaticModelStageFile(fingerprint: string, cacheDbPath?: string): RestoredStaticStage | null {
	try {
		const parsed: unknown = JSON.parse(fs.readFileSync(getStaticModelStagePath(cacheDbPath), "utf8"));
		if (
			!isRecord(parsed) ||
			parsed.fingerprint !== fingerprint ||
			typeof parsed.stageDigest !== "string" ||
			!isRecord(parsed.stage)
		) {
			return null;
		}
		const stageDigest = createHash("sha256").update(JSON.stringify(parsed.stage)).digest("hex");
		if (stageDigest !== parsed.stageDigest) return null;
		const stage = parsed.stage;
		const now = Date.now();
		if (typeof stage.createdAt !== "number" || !Number.isFinite(stage.createdAt) || now < stage.createdAt) {
			return null;
		}
		if (!isRecord(stage.cachedStandard)) return null;
		const builtIn = snapshotModelArray(stage.builtIn);
		const cachedStandard = snapshotModelArray(stage.cachedStandard.models);
		const cachedDiscoveries = snapshotModelArray(stage.cachedDiscoveries);
		if (!builtIn || !cachedStandard || !cachedDiscoveries) return null;
		if (!Array.isArray(stage.cachedStandard.authoritativeFreshProviders)) return null;
		const authoritativeFreshProviders = stage.cachedStandard.authoritativeFreshProviders.filter(
			(provider): provider is string => typeof provider === "string",
		);
		if (authoritativeFreshProviders.length !== stage.cachedStandard.authoritativeFreshProviders.length) return null;
		const discoveryStates = snapshotDiscoveryStateArray(stage.discoveryStates);
		if (!discoveryStates) return null;
		return {
			builtIn,
			cachedStandard: {
				models: cachedStandard,
				authoritativeFreshProviders: new Set(authoritativeFreshProviders),
			},
			cachedDiscoveries,
			discoveryStates,
		};
	} catch {
		return null;
	}
}

export function writeStaticModelStageFile(fingerprint: string, stage: StaticModelStage, cacheDbPath?: string): void {
	try {
		const stageDigest = createHash("sha256").update(JSON.stringify(stage)).digest("hex");
		atomicWriteFileSync(getStaticModelStagePath(cacheDbPath), JSON.stringify({ fingerprint, stageDigest, stage }));
	} catch (error) {
		logger.debug("Static model stage snapshot not written", { error: errorMessage(error) });
	}
}
