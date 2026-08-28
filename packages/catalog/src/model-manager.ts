import { errorMessage, HOUR_MS, MINUTE_MS } from "@veyyon/utils";
import { buildModel } from "./build";
import type { DiscoveryFailure, DiscoveryHooks } from "./discovery/failure";
import { readModelCache, writeModelCache } from "./model-cache";
import { type GeneratedProvider, getBundledModels } from "./models";
import { defaultModelsDevFallback } from "./modelsdev-overlay";
import type { Api, Model, ModelSpec, Provider } from "./types";
import { isRecord } from "./utils";
import { collapseBuiltModelVariants } from "./variant-collapse";

const DEFAULT_CACHE_TTL_MS = 2 * HOUR_MS;
const NON_AUTHORITATIVE_RETRY_MS = 5 * MINUTE_MS;

export type ModelRefreshStrategy = "online" | "offline" | "online-if-uncached";

export interface ModelsDevFallback<TApi extends Api = Api, TPayload = unknown> {
	fetch(hooks?: DiscoveryHooks): Promise<TPayload>;
	map(payload: TPayload, providerId: Provider): readonly ModelSpec<TApi>[];
	enrichOnly?: boolean;
}

export interface ModelManagerOptions<TApi extends Api = Api, TModelsDevPayload = unknown> {
	providerId: Provider;
	staticModels?: readonly ModelSpec<TApi>[];
	cacheDbPath?: string;
	cacheProviderId?: string;
	cacheTtlMs?: number;
	dynamicModelsAuthoritative?: boolean;
	dropCachedModelIdsOnStaticMismatch?: readonly string[];
	fetchDynamicModels?: (hooks?: DiscoveryHooks) => Promise<readonly ModelSpec<TApi>[] | null>;
	onDiscoveryFailure?: (failure: DiscoveryFailure) => void;
	modelsDev?: ModelsDevFallback<TApi, TModelsDevPayload>;
	now?: () => number;
}

export interface ModelResolutionResult<TApi extends Api = Api> {
	models: Model<TApi>[];
	stale: boolean;
}

export interface ModelManager<TApi extends Api = Api> {
	refresh(strategy?: ModelRefreshStrategy): Promise<ModelResolutionResult<TApi>>;
}

export function createModelManager<TApi extends Api = Api, TModelsDevPayload = unknown>(
	options: ModelManagerOptions<TApi, TModelsDevPayload>,
): ModelManager<TApi> {
	return {
		refresh(strategy: ModelRefreshStrategy = "online-if-uncached") {
			return resolveProviderModels(options, strategy);
		},
	};
}

function passModelList<TApi extends Api>(value: unknown): Model<TApi>[] {
	if (!Array.isArray(value)) {
		return [];
	}
	const out: Model<TApi>[] = [];
	for (const item of value) {
		if (item === null || typeof item !== "object" || typeof (item as { id: unknown }).id !== "string") {
			continue;
		}
		out.push(buildModel(item as ModelSpec<TApi>));
	}
	return out;
}

export async function resolveProviderModels<TApi extends Api = Api, TModelsDevPayload = unknown>(
	options: ModelManagerOptions<TApi, TModelsDevPayload>,
	strategy: ModelRefreshStrategy = "online-if-uncached",
): Promise<ModelResolutionResult<TApi>> {
	const cacheProviderId = options.cacheProviderId ?? options.providerId;
	const now = options.now ?? Date.now;
	const ttlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
	const dbPath = options.cacheDbPath;
	const staticModels = options.staticModels
		? passModelList<TApi>(options.staticModels)
		: (getBundledModels(options.providerId as GeneratedProvider) as Model<TApi>[]);
	const cache = readModelCache<TApi>(cacheProviderId, ttlMs, now, dbPath);
	const dynamicModelsAuthoritative = options.dynamicModelsAuthoritative ?? false;
	const staticFingerprint = fingerprintStatic(staticModels, dynamicModelsAuthoritative);
	const cacheFingerprintMatches = cache?.staticFingerprint === staticFingerprint && staticFingerprint.length > 0;
	const hasUsableFreshCache = (cache?.fresh ?? false) && (!dynamicModelsAuthoritative || cacheFingerprintMatches);
	const dynamicFetcher = options.fetchDynamicModels;
	const hasDynamicFetcher = typeof dynamicFetcher === "function";
	const hasAuthoritativeCache = ((cache?.authoritative ?? false) && hasUsableFreshCache) || !hasDynamicFetcher;
	const cacheAgeMs = cache ? now() - cache.updatedAt : Number.POSITIVE_INFINITY;
	const shouldFetchFromNetwork = shouldFetchRemoteSources(
		strategy,
		hasUsableFreshCache,
		hasAuthoritativeCache,
		cacheAgeMs,
	);

	if (!shouldFetchFromNetwork && cache?.fresh && hasAuthoritativeCache && cacheFingerprintMatches) {
		return { models: collapseBuiltModelVariants(passModelList<TApi>(cache.models)), stale: false };
	}

	const modelsDev = options.modelsDev ?? defaultModelsDevFallback<TApi>(options.providerId, options.cacheDbPath);
	const [fetchedModelsDevModels, fetchedDynamicModels] = shouldFetchFromNetwork
		? await Promise.all([
				fetchModelsDev(options, modelsDev),
				dynamicFetcher ? fetchDynamicModels(dynamicFetcher, options.onDiscoveryFailure) : null,
			])
		: [null, null];
	const shouldUseFreshCacheAsAuthoritative =
		strategy === "online-if-uncached" && hasUsableFreshCache && hasAuthoritativeCache;
	const dynamicFetchSucceeded = fetchedDynamicModels !== null;
	const cacheModels = dynamicFetchSucceeded
		? []
		: prepareCacheModelsForStaticMismatch(
				normalizeModelList<TApi>(cache?.models ?? []),
				staticModels,
				cacheFingerprintMatches,
				options.dropCachedModelIdsOnStaticMismatch,
			);
	const dynamicModels = fetchedDynamicModels ?? [];
	const modelsDevModelsAll = normalizeModelList<TApi>(fetchedModelsDevModels ?? []);
	const modelsDevModels = modelsDev?.enrichOnly
		? modelsDevModelsAll.filter(model => {
				return (
					staticModels.some(served => served.id === model.id) ||
					cacheModels.some(served => served.id === model.id) ||
					dynamicModels.some(served => served.id === model.id)
				);
			})
		: modelsDevModelsAll;
	const mergedWithCache = mergeDynamicModels(mergeDynamicModels(staticModels, modelsDevModels), cacheModels);
	const mergedModels = mergeDynamicModels(mergedWithCache, dynamicModels);
	const models = collapseBuiltModelVariants(
		dynamicModelsAuthoritative && dynamicFetchSucceeded ? retainModelIds(mergedModels, dynamicModels) : mergedModels,
	);
	const dynamicAuthoritative = !hasDynamicFetcher || dynamicFetchSucceeded || shouldUseFreshCacheAsAuthoritative;
	if (shouldFetchFromNetwork) {
		if (dynamicFetchSucceeded) {
			const mergedSnapshot = mergeDynamicModels(mergeDynamicModels(staticModels, modelsDevModels), dynamicModels);
			const snapshotModels = dynamicModelsAuthoritative
				? retainModelIds(mergedSnapshot, dynamicModels)
				: mergedSnapshot;
			writeModelCache(
				cacheProviderId,
				now(),
				collapseBuiltModelVariants(snapshotModels),
				true,
				staticFingerprint,
				dbPath,
			);
		} else {
			const latestCache = readModelCache<TApi>(cacheProviderId, ttlMs, now, dbPath);
			writeModelCache(
				cacheProviderId,
				now(),
				collapseBuiltModelVariants(
					mergeDynamicModels(
						mergeDynamicModels(staticModels, modelsDevModels),
						prepareCacheModelsForStaticMismatch(
							normalizeModelList<TApi>(latestCache?.models ?? cache?.models ?? []),
							staticModels,
							cacheFingerprintMatches,
							options.dropCachedModelIdsOnStaticMismatch,
						),
					),
				),
				false,
				staticFingerprint,
				dbPath,
			);
		}
	}
	return {
		models,
		stale: !dynamicAuthoritative,
	};
}

async function fetchModelsDev<TApi extends Api, TModelsDevPayload>(
	options: ModelManagerOptions<TApi, TModelsDevPayload>,
	modelsDev: ModelsDevFallback<TApi, TModelsDevPayload> | undefined,
): Promise<Model<TApi>[] | null> {
	if (!modelsDev) {
		return null;
	}

	const onFailure = options.onDiscoveryFailure;
	try {
		const payload = await modelsDev.fetch({ onFailure });
		const rejected: string[] = [];
		const models = normalizeModelList<TApi>(modelsDev.map(payload, options.providerId), rejection => {
			rejected.push(`${rejection.id} (${rejection.field})`);
		});
		if (rejected.length > 0) {
			onFailure?.({
				stage: "payload",
				url: "",
				detail: `${rejected.length} models.dev models rejected: ${rejected.slice(0, 5).join(", ")}${rejected.length > 5 ? ", ..." : ""}`,
			});
		}
		return models;
	} catch (error) {
		onFailure?.({ stage: "unhandled", url: "", detail: errorMessage(error) });
		return null;
	}
}

async function fetchDynamicModels<TApi extends Api>(
	fetcher: (hooks?: DiscoveryHooks) => Promise<readonly ModelSpec<TApi>[] | null>,
	onFailure: ((failure: DiscoveryFailure) => void) | undefined,
): Promise<Model<TApi>[] | null> {
	try {
		const models = await fetcher({ onFailure });
		if (models === null) {
			return null;
		}
		const rejected: string[] = [];
		const normalized = normalizeModelList<TApi>(models, rejection => {
			rejected.push(`${rejection.id} (${rejection.field})`);
		});
		if (rejected.length > 0) {
			onFailure?.({
				stage: "payload",
				url: "",
				detail: `${rejected.length} of ${models.length} models rejected: ${rejected.slice(0, 5).join(", ")}${rejected.length > 5 ? ", ..." : ""}`,
			});
		}
		if (models.length > 0 && normalized.length === 0) {
			return null;
		}
		return normalized;
	} catch (error) {
		onFailure?.({ stage: "unhandled", url: "", detail: errorMessage(error) });
		return null;
	}
}

function shouldFetchRemoteSources(
	strategy: ModelRefreshStrategy,
	hasFreshCache: boolean,
	hasAuthoritativeCache: boolean,
	cacheAgeMs: number,
): boolean {
	if (strategy === "offline") {
		return false;
	}
	if (strategy === "online") {
		return true;
	}
	if (!hasFreshCache) {
		return true;
	}
	if (!hasAuthoritativeCache) {
		return cacheAgeMs >= NON_AUTHORITATIVE_RETRY_MS;
	}
	return false;
}

function prepareCacheModelsForStaticMismatch<TApi extends Api>(
	models: readonly Model<TApi>[],
	staticModels: readonly Model<TApi>[],
	cacheFingerprintMatches: boolean,
	ids: readonly string[] | undefined,
): Model<TApi>[] {
	if (models.length === 0) {
		return [];
	}
	if (cacheFingerprintMatches) {
		return models.slice();
	}

	const droppedIds = ids && ids.length > 0 ? new Set(ids) : undefined;
	const staticIds = staticModels.length > 0 ? new Set(staticModels.map(model => model.id)) : undefined;
	const sanitizedModels: Model<TApi>[] = [];
	for (const model of models) {
		if (droppedIds?.has(model.id)) {
			continue;
		}
		sanitizedModels.push(staticIds?.has(model.id) ? { ...model, contextWindow: null, maxTokens: null } : model);
	}
	return sanitizedModels;
}

function mergeDynamicModels<TApi extends Api>(
	baseModels: readonly Model<TApi>[],
	dynamicModels: readonly Model<TApi>[],
): Model<TApi>[] {
	// Empty-side fast paths: `mergeDynamicModels(base, [])` is the common shape
	// after we've already merged the first pair, and `(...)` with no base
	// happens for providers without static catalogs.
	if (dynamicModels.length === 0) return baseModels.length === 0 ? [] : baseModels.slice();
	if (baseModels.length === 0) return dynamicModels.slice();
	const merged = new Map<string, Model<TApi>>(baseModels.map(model => [model.id, model]));
	for (const dynamicModel of dynamicModels) {
		if (!dynamicModel?.id) {
			continue;
		}
		const existingModel = merged.get(dynamicModel.id);
		if (!existingModel) {
			merged.set(dynamicModel.id, dynamicModel);
			continue;
		}
		merged.set(dynamicModel.id, mergeDynamicModel(existingModel, dynamicModel));
	}
	return Array.from(merged.values());
}

function retainModelIds<TApi extends Api>(
	models: readonly Model<TApi>[],
	retainedModels: readonly Model<TApi>[],
): Model<TApi>[] {
	if (retainedModels.length === 0 || models.length === 0) return [];
	const retainedIds = new Set(retainedModels.map(model => model.id));
	return models.filter(model => retainedIds.has(model.id));
}

const MODEL_CACHE_FINGERPRINT_VERSION = "merge-v3";
const kStaticFingerprint = Symbol("model-manager.staticFingerprint");
type ModelArrayWithFingerprint = readonly Model<Api>[] & { [kStaticFingerprint]?: string };
function fingerprintStatic<TApi extends Api>(
	models: readonly Model<TApi>[],
	dynamicModelsAuthoritative = false,
): string {
	if (models.length === 0) return `${MODEL_CACHE_FINGERPRINT_VERSION}:empty`;
	if (dynamicModelsAuthoritative)
		return `${MODEL_CACHE_FINGERPRINT_VERSION}:authoritative:${fingerprintStatic(models)}`;
	const tagged = models as ModelArrayWithFingerprint;
	const cached = tagged[kStaticFingerprint];
	if (cached !== undefined) return cached;
	// `Bun.hash` returns a `bigint`; base36 keeps the string short for the
	// SQLite column without sacrificing distinguishability.
	const fingerprint = `${MODEL_CACHE_FINGERPRINT_VERSION}:${Bun.hash(JSON.stringify(models)).toString(36)}`;
	tagged[kStaticFingerprint] = fingerprint;
	return fingerprint;
}

function mergeDynamicModel<TApi extends Api>(existingModel: Model<TApi>, dynamicModel: Model<TApi>): Model<TApi> {
	// When discovery resolves the same model id to a different endpoint (e.g.
	// a GitHub Copilot business/enterprise host), the bundled reference's
	// capabilities are pinned to another endpoint and no longer apply. Copilot
	// dynamic discovery also pre-applies the correct image fallback for omitted
	// `supports.vision`, so its explicit `false` must not be OR-upgraded by the
	// canonical bundled model.
	const endpointChanged = existingModel.baseUrl !== dynamicModel.baseUrl;
	const dynamicInputAuthoritative =
		endpointChanged || (existingModel.provider === "github-copilot" && dynamicModel.provider === "github-copilot");
	const supportsImage = dynamicInputAuthoritative
		? dynamicModel.input.includes("image")
		: existingModel.input.includes("image") || dynamicModel.input.includes("image");
	// Re-build from spec stage: sparse compat comes from `compatConfig` (the
	// verbatim override vocabulary), never the resolved `compat` record.
	return buildModel({
		...existingModel,
		...dynamicModel,
		// A collapsed row's effort routing is owned by its collapse table:
		// neither discovery nor the overlay may re-derive it (the same rule
		// resolveModelThinking implements). buildModel always emits the
		// `thinking` key, so an overlay row declaring no surface would
		// otherwise overwrite the routing with undefined.
		thinking:
			existingModel.thinking?.effortRouting !== undefined
				? existingModel.thinking
				: (dynamicModel.thinking ?? existingModel.thinking),
		name: preferDiscoveryName(dynamicModel.name, existingModel.name, dynamicModel.id),
		reasoning: existingModel.reasoning || dynamicModel.reasoning,
		input: supportsImage ? ["text", "image"] : ["text"],
		cost: {
			input: preferDiscoveryCost(dynamicModel.cost.input, existingModel.cost.input),
			output: preferDiscoveryCost(dynamicModel.cost.output, existingModel.cost.output),
			cacheRead: preferDiscoveryCost(dynamicModel.cost.cacheRead, existingModel.cost.cacheRead),
			cacheWrite: preferDiscoveryCost(dynamicModel.cost.cacheWrite, existingModel.cost.cacheWrite),
		},
		contextWindow: preferDiscoveryLimit(dynamicModel.contextWindow, existingModel.contextWindow),
		maxTokens: preferDiscoveryLimit(dynamicModel.maxTokens, existingModel.maxTokens),
		headers: dynamicModel.headers ? { ...existingModel.headers, ...dynamicModel.headers } : existingModel.headers,
		compat: dynamicModel.compatConfig ?? existingModel.compatConfig,
		contextPromotionTarget: dynamicModel.contextPromotionTarget ?? existingModel.contextPromotionTarget,
	} as ModelSpec<TApi>);
}

function preferDiscoveryCost(discoveryCost: number, fallbackCost: number): number {
	if (Number.isFinite(discoveryCost) && discoveryCost > 0) {
		return discoveryCost;
	}
	return fallbackCost;
}

function preferDiscoveryName(discoveryName: string, fallbackName: string, modelId: string): string {
	const normalizedDiscoveryName = discoveryName.trim();
	if (normalizedDiscoveryName.length === 0) {
		return fallbackName;
	}
	if (normalizedDiscoveryName === modelId && fallbackName !== modelId) {
		return fallbackName;
	}
	return normalizedDiscoveryName;
}

function preferDiscoveryLimit(discoveryLimit: number, fallbackLimit: number): number;
function preferDiscoveryLimit(discoveryLimit: number | null, fallbackLimit: number | null): number | null;
function preferDiscoveryLimit(discoveryLimit: number | null, fallbackLimit: number | null): number | null {
	if (discoveryLimit === null || !Number.isFinite(discoveryLimit) || discoveryLimit <= 0) {
		return fallbackLimit;
	}
	if (discoveryLimit === 4096 && fallbackLimit !== null && fallbackLimit > discoveryLimit) {
		return fallbackLimit;
	}
	return discoveryLimit;
}

function normalizeModelList<TApi extends Api>(
	value: unknown,
	onRejected?: (rejection: { id: string; field: string }) => void,
): Model<TApi>[] {
	if (!Array.isArray(value)) {
		return [];
	}
	const models: Model<TApi>[] = [];
	for (const item of value) {
		const field = modelSpecRejection(item);
		if (field === null) {
			models.push(buildModel(item as ModelSpec<TApi>));
			continue;
		}
		const id = isRecord(item) && typeof item.id === "string" && item.id.length > 0 ? item.id : "<no id>";
		onRejected?.({ id, field });
	}
	return models;
}

function modelSpecRejection(value: unknown): string | null {
	if (!isRecord(value)) {
		return "not an object";
	}
	const v = value as {
		id?: unknown;
		name?: unknown;
		api?: unknown;
		provider?: unknown;
		baseUrl?: unknown;
		reasoning?: unknown;
		input?: unknown;
		cost?: unknown;
		contextWindow?: unknown;
		maxTokens?: unknown;
	};
	if (typeof v.id !== "string" || v.id.length === 0) {
		return "id";
	}
	if (typeof v.name !== "string" || v.name.length === 0) {
		return "name";
	}
	if (typeof v.api !== "string" || v.api.length === 0) {
		return "api";
	}
	if (typeof v.provider !== "string" || v.provider.length === 0) {
		return "provider";
	}
	if (typeof v.baseUrl !== "string" || v.baseUrl.length === 0) {
		return "baseUrl";
	}
	if (typeof v.reasoning !== "boolean") {
		return "reasoning";
	}
	if (!isModelInputArray(v.input)) {
		return "input";
	}
	const costField = modelCostRejection(v.cost);
	if (costField !== null) {
		return costField;
	}
	// Finite positive: NaN > 0 is false, +Infinity < Infinity is false.
	const cw = v.contextWindow;
	if (cw !== null && (typeof cw !== "number" || !(cw > 0 && cw < Infinity))) {
		return "contextWindow";
	}
	const mt = v.maxTokens;
	if (mt !== null && (typeof mt !== "number" || !(mt > 0 && mt < Infinity))) {
		return "maxTokens";
	}
	return null;
}

function isModelInputArray(value: unknown): value is ("text" | "image")[] {
	if (!Array.isArray(value) || value.length === 0) {
		return false;
	}
	for (let i = 0; i < value.length; i++) {
		const item = value[i];
		if (item !== "text" && item !== "image") {
			return false;
		}
	}
	return true;
}

function modelCostRejection(value: unknown): string | null {
	if (!isRecord(value)) {
		return "cost";
	}
	const c = value as {
		input?: unknown;
		output?: unknown;
		cacheRead?: unknown;
		cacheWrite?: unknown;
	};
	// Finite (NaN-safe): -Infinity < x < Infinity rejects NaN and both infinities.
	// Preserves original behavior: 0 and negatives remain valid.
	const ci = c.input;
	if (typeof ci !== "number" || !(ci > -Infinity && ci < Infinity)) {
		return "cost.input";
	}
	const co = c.output;
	if (typeof co !== "number" || !(co > -Infinity && co < Infinity)) {
		return "cost.output";
	}
	const cr = c.cacheRead;
	if (typeof cr !== "number" || !(cr > -Infinity && cr < Infinity)) {
		return "cost.cacheRead";
	}
	const cw = c.cacheWrite;
	if (typeof cw !== "number" || !(cw > -Infinity && cw < Infinity)) {
		return "cost.cacheWrite";
	}
	return null;
}
