import * as path from "node:path";
import type { ApiKeyResolver, FetchImpl } from "@veyyon/ai";
import { registerCustomApi, unregisterCustomApis } from "@veyyon/ai/api-registry";
import { registerOAuthProvider, unregisterOAuthProviders } from "@veyyon/ai/oauth";
import type { Api, Model, ModelSpec, SimpleStreamOptions } from "@veyyon/ai/types";
import { buildModel } from "@veyyon/catalog/build";
import { readModelCache } from "@veyyon/catalog/model-cache";
import { createModelManager, type ModelManagerOptions, type ModelRefreshStrategy } from "@veyyon/catalog/model-manager";
import { getBundledModels, getBundledProviders, setEnrichedRegistrySnapshotStore } from "@veyyon/catalog/models";
import { PROVIDER_DESCRIPTORS } from "@veyyon/catalog/provider-models";
import { createEnrichedRegistrySnapshotStore } from "@veyyon/catalog/registry-snapshot";
import { collapseBuiltModelVariants } from "@veyyon/catalog/variant-collapse";
import { DAY_MS, errorMessage, isBunTestRuntime, logger, wrapFetchForExtraCa } from "@veyyon/utils";
import { resolveProviderModelReference } from "../config/model-resolver";
import type { AuthStorage } from "../session/auth-storage";
import { type ApiKeyResolverModel, type ApiKeyResolverOptions, createApiKeyResolver } from "./api-key-resolver";
import { isAuthenticated, kNoAuth } from "./auth-state";
import type { ConfigError, ConfigFile } from "./config-file";
import { describeConfigEnvReference, isConfigValueCommand } from "./config-value-resolution";
import {
	DISCOVERY_DEFAULT_MAX_TOKENS,
	type DiscoveryContext,
	type DiscoveryProviderConfig,
	discoverLlamaCppModelRuntimeMetadata,
	discoverModelsByProviderType,
	getOllamaContextLengthOverride,
} from "./model-discovery";
import {
	AUTHORITATIVE_RUNTIME_CATALOG_PROVIDERS,
	BUILT_IN_DISCOVERY_CACHE_TTL_MS,
	BUILT_IN_DISCOVERY_NON_AUTHORITATIVE_RETRY_MS,
	type BuiltInDiscoveryResult,
	type CustomModelsResult,
	dropProviderModels,
	IMPLICIT_LOCAL_RUNTIME_IDS,
	IMPLICIT_LOCAL_RUNTIMES,
	isConnectionRefusalError,
	isDiscoveryBearerApiKey,
	isLoopbackUrl,
	mergeByModelKey,
	mergeDiscoveredModel,
	type ProviderDiscoveryState,
	type ProviderDiscoveryStatus,
	parseCustomModelsConfig,
	providersWithAuthoritativeProjectCatalog,
	STARTUP_MODEL_CACHE_PROVIDER_IDS,
} from "./model-registry-discovery";
import {
	applyModelOverride,
	applyModelPatch,
	applyProviderTransportOverride,
	type CustomModelOverlay,
	finalizeCustomModel,
	getDisabledProviderIdsFromSettings,
	type ModelPatch,
	normalizeSuppressedSelector,
	type ProviderOverride,
	resolveModelOverrideWithAliases,
} from "./model-registry-overrides";
import {
	buildRuntimeModelOverlays,
	collectBuiltInModelManagerOptions,
	createDynamicModelManagerOptions,
	type ProviderConfigInput,
} from "./model-registry-registration";
import {
	type CommandApiKeyResolution,
	getOAuthCredentialsForProvider,
	mergeCompat,
	resolveConfigHeaders,
	resolveConfigValue,
	toModelSpec,
} from "./model-registry-resolution";
import {
	computeStaticModelStageFingerprint,
	readStaticModelStageFile,
	writeStaticModelStageFile,
} from "./model-registry-stage";
import { ModelsConfigFile, type ProviderValidationModel, validateProviderConfiguration } from "./models-config";
import type { ModelOverride, ModelsConfig } from "./models-config-schema";

export type { ProviderConfigInput };
export { IMPLICIT_LOCAL_RUNTIME_IDS, mergeDiscoveredModel, type ProviderDiscoveryState, type ProviderDiscoveryStatus };

export class ModelRegistry {
	#models: Model<Api>[] = [];
	#customProviderApiKeys: Map<string, string> = new Map();
	#keylessProviders: Set<string> = new Set();
	#discoverableProviders: DiscoveryProviderConfig[] = [];
	#customModelOverlays: CustomModelOverlay[] = [];
	#providerOverrides: Map<string, ProviderOverride> = new Map();
	#modelOverrides: Map<string, Map<string, ModelOverride>> = new Map();
	#configError: ConfigError | undefined = undefined;
	#modelsConfigFile: ConfigFile<ModelsConfig>;
	#lastStaticLoadMtime: number | null = null;
	#registeredProviderSources: Set<string> = new Set();
	#providerDiscoveryStates: Map<string, ProviderDiscoveryState> = new Map();
	#cacheDbPath?: string;
	#snapshotIo: boolean;
	#suppressedSelectors: Map<string, number> = new Map();
	#backgroundRefresh?: Promise<void>;
	#lastDiscoveryWarnings: Map<string, string> = new Map();
	#runtimeModelOverlays: CustomModelOverlay[] = [];
	#providerReportedWindows: Map<string, number> = new Map();
	#runtimeProviderApiKeys: Map<string, string> = new Map();
	#runtimeProviderOverrides: Map<string, ProviderOverride> = new Map();
	#runtimeProvidersBySource: Map<string, Set<string>> = new Map();
	#runtimeProviderSourceByName: Map<string, string> = new Map();
	#runtimeModelManagers: Map<string, { options: ModelManagerOptions<Api>; sourceId: string }> = new Map();
	#fetch: FetchImpl;

	#resolveCommandBackedApiKey(provider: string): CommandApiKeyResolution {
		const keyConfig = this.#customProviderApiKeys.get(provider);
		if (!isConfigValueCommand(keyConfig)) return { configured: false };
		const value = resolveConfigValue(keyConfig, `API key for provider "${provider}"`);
		if (value) {
			this.authStorage.setConfigApiKey(provider, value);
			return { configured: true, value };
		}
		this.authStorage.removeConfigApiKey(provider);
		return { configured: true };
	}

	#installProviderApiKey(provider: string, keyConfig: string): void {
		this.#customProviderApiKeys.set(provider, keyConfig);
		const resolved = resolveConfigValue(keyConfig, `API key for provider "${provider}"`);
		if (resolved) {
			this.authStorage.setConfigApiKey(provider, resolved);
		} else if (isConfigValueCommand(keyConfig) || describeConfigEnvReference(keyConfig)) {
			this.authStorage.removeConfigApiKey(provider);
		}
	}

	constructor(
		readonly authStorage: AuthStorage,
		modelsPath?: string,
		options?: { fetch?: FetchImpl; snapshotIo?: boolean },
	) {
		this.#fetch =
			options?.fetch ??
			(isBunTestRuntime()
				? () => Promise.reject(new Error("network disabled in model-registry runtime test"))
				: wrapFetchForExtraCa(fetch));
		this.#snapshotIo = options?.snapshotIo ?? !isBunTestRuntime();
		this.#modelsConfigFile = ModelsConfigFile.relocate(modelsPath);
		this.#cacheDbPath = modelsPath ? path.join(path.dirname(modelsPath), "models.db") : undefined;

		setEnrichedRegistrySnapshotStore(
			this.#snapshotIo ? createEnrichedRegistrySnapshotStore(this.#cacheDbPath) : undefined,
		);
		this.authStorage.setFallbackResolver(provider => {
			const keyConfig = this.#customProviderApiKeys.get(provider);
			if (!keyConfig) return undefined;
			return resolveConfigValue(keyConfig, `API key for provider "${provider}"`);
		});
		this.#loadModels();
	}

	async refresh(strategy: ModelRefreshStrategy = "online-if-uncached"): Promise<void> {
		this.#reloadStaticModels();
		this.#suppressedSelectors.clear();
		await this.#refreshRuntimeDiscoveries(strategy);
	}

	refreshInBackground(strategy: ModelRefreshStrategy = "online-if-uncached"): void {
		if (this.#backgroundRefresh) {
			return;
		}
		const refreshPromise = this.refresh(strategy)
			.catch(error => {
				logger.warn("background model refresh failed", {
					error: errorMessage(error),
				});
			})
			.finally(() => {
				if (this.#backgroundRefresh === refreshPromise) {
					this.#backgroundRefresh = undefined;
				}
			});
		this.#backgroundRefresh = refreshPromise;
	}

	async refreshProvider(providerId: string, strategy: ModelRefreshStrategy = "online"): Promise<void> {
		this.#reloadStaticModels();
		for (const selector of this.#suppressedSelectors.keys()) {
			if (selector.startsWith(`${providerId}/`)) {
				this.#suppressedSelectors.delete(selector);
			}
		}
		await this.#refreshRuntimeDiscoveries(strategy, new Set([providerId]));
	}

	async refreshSelectedModelMetadata(model: Model<Api>): Promise<Model<Api>> {
		const isLlamaCppDiscovery = this.#discoverableProviders.some(
			providerConfig => providerConfig.provider === model.provider && providerConfig.discovery.type === "llama.cpp",
		);
		if (!isLlamaCppDiscovery) {
			return model;
		}
		const runtimeMetadata = await discoverLlamaCppModelRuntimeMetadata(model, this.#nonResolvingDiscoveryContext());
		if (runtimeMetadata === undefined) {
			return this.find(model.provider, model.id) ?? model;
		}
		const { contextWindow, maxTokens, input } = runtimeMetadata;
		const current = this.find(model.provider, model.id) ?? model;
		const override = this.#resolveLiveModelOverride(current);
		const customModel = this.#resolveLiveCustomModelOverlay(current);
		const patch: ModelPatch = {};
		if (
			contextWindow !== undefined &&
			override?.contextWindow === undefined &&
			customModel?.contextWindow === undefined &&
			current.contextWindow !== contextWindow
		) {
			patch.contextWindow = contextWindow;
		}
		const effectiveContextWindow =
			override?.contextWindow ??
			customModel?.contextWindow ??
			patch.contextWindow ??
			current.contextWindow ??
			contextWindow;
		if (maxTokens !== undefined && effectiveContextWindow !== undefined) {
			const effectiveMaxTokens = Math.min(maxTokens, effectiveContextWindow);
			if (
				override?.maxTokens === undefined &&
				customModel?.maxTokens === undefined &&
				current.maxTokens !== effectiveMaxTokens
			) {
				patch.maxTokens = effectiveMaxTokens;
			}
		}
		if (
			input !== undefined &&
			override?.input === undefined &&
			customModel?.input === undefined &&
			(current.input.length !== input.length || current.input.some((value, index) => value !== input[index]))
		) {
			patch.input = input;
		}
		if (patch.contextWindow === undefined && patch.maxTokens === undefined && patch.input === undefined) {
			return current;
		}
		const patched = applyModelPatch(current, patch, "merge");
		this.#models = this.#models.map(candidate =>
			candidate.provider === current.provider && candidate.id === current.id ? patched : candidate,
		);
		return patched;
	}

	async refreshRuntimeProviders(
		strategy: ModelRefreshStrategy = "online-if-uncached",
		providerId?: string,
	): Promise<void> {
		if (this.#runtimeModelManagers.size === 0) {
			return;
		}
		const providerIds = providerId
			? this.#runtimeModelManagers.has(providerId)
				? new Set([providerId])
				: new Set<string>()
			: new Set(this.#runtimeModelManagers.keys());
		if (providerIds.size === 0) return;
		await this.#refreshRuntimeDiscoveries(strategy, providerIds);
	}

	#reloadStaticModels(): void {
		const currentMtime = this.#modelsConfigFile.getMtimeMs();
		if (currentMtime !== null && currentMtime === this.#lastStaticLoadMtime) {
			return;
		}
		this.#modelsConfigFile.invalidate();
		this.#customProviderApiKeys.clear();
		this.#keylessProviders.clear();
		this.#discoverableProviders = [];
		this.authStorage.clearConfigApiKeys();
		for (const [k, v] of this.#runtimeProviderApiKeys) {
			this.#installProviderApiKey(k, v);
		}
		this.#providerOverrides.clear();
		this.#modelOverrides.clear();
		this.#configError = undefined;
		this.#providerDiscoveryStates.clear();
		this.#loadModels();
	}

	getError(): ConfigError | undefined {
		return this.#configError;
	}

	#loadModels() {
		const {
			models: customModels = [],
			overrides = new Map(),
			modelOverrides = new Map(),
			keylessProviders = new Set(),
			discoverableProviders = [],
			configuredProviders = new Set(),
			error: configError,
		} = this.#loadCustomModels();
		this.#configError = configError;
		this.#keylessProviders = keylessProviders;
		this.#discoverableProviders = discoverableProviders;
		this.#customModelOverlays = customModels;
		this.#providerOverrides = overrides;
		this.#modelOverrides = modelOverrides;

		this.#addImplicitDiscoverableProviders(configuredProviders);

		const staticFingerprint = computeStaticModelStageFingerprint({
			cacheDbPath: this.#cacheDbPath,
			modelsConfigFile: this.#modelsConfigFile,
			customModelOverlays: this.#customModelOverlays,
			providerOverrides: this.#providerOverrides,
			modelOverrides: this.#modelOverrides,
			keylessProviders: this.#keylessProviders,
			discoverableProviders: this.#discoverableProviders,
		});
		const restored = this.#snapshotIo ? readStaticModelStageFile(staticFingerprint, this.#cacheDbPath) : null;
		let builtInModels: Model<Api>[];
		let cachedStandardModels: Model<Api>[];
		let cachedDiscoveries: Model<Api>[];
		let authoritativeFreshProviders: Set<string>;
		if (restored) {
			builtInModels = restored.builtIn;
			cachedStandardModels = restored.cachedStandard.models;
			cachedDiscoveries = restored.cachedDiscoveries;
			authoritativeFreshProviders = restored.cachedStandard.authoritativeFreshProviders;
			for (const state of restored.discoveryStates) {
				this.#providerDiscoveryStates.set(state.provider, state);
			}
		} else {
			builtInModels = this.#applyHardcodedModelPolicies(this.#loadBuiltInModels(overrides));
			const cachedStandardResult = this.#loadCachedStandardProviderModels();
			cachedStandardModels = this.#applyHardcodedModelPolicies(cachedStandardResult.models);
			cachedDiscoveries = this.#applyHardcodedModelPolicies(this.#loadCachedDiscoverableModels());
			authoritativeFreshProviders = cachedStandardResult.authoritativeFreshProviders;
			if (this.#snapshotIo) {
				writeStaticModelStageFile(
					staticFingerprint,
					{
						createdAt: Date.now(),
						builtIn: builtInModels,
						cachedStandard: {
							models: cachedStandardModels,
							authoritativeFreshProviders: Array.from(authoritativeFreshProviders),
						},
						cachedDiscoveries,
						discoveryStates: Array.from(this.#providerDiscoveryStates.values()),
					},
					this.#cacheDbPath,
				);
			}
		}

		const cachedAuthoritativeProviders = new Set<string>();
		for (const provider of providersWithAuthoritativeProjectCatalog(cachedStandardModels)) {
			if (authoritativeFreshProviders.has(provider)) {
				cachedAuthoritativeProviders.add(provider);
			}
		}
		for (const provider of authoritativeFreshProviders) {
			if (AUTHORITATIVE_RUNTIME_CATALOG_PROVIDERS.has(provider)) {
				cachedAuthoritativeProviders.add(provider);
			}
		}
		if (cachedAuthoritativeProviders.size > 0) {
			builtInModels = dropProviderModels(builtInModels, cachedAuthoritativeProviders);
		}
		const resolvedDefaults = this.#mergeResolvedModels(
			this.#mergeResolvedModels(builtInModels, cachedStandardModels),
			cachedDiscoveries,
		);
		const withConfigModels = this.#mergeCustomModels(resolvedDefaults, this.#customModelOverlays);
		const combined = this.#mergeCustomModels(withConfigModels, this.#runtimeModelOverlays);
		const withModelOverrides = this.#applyModelOverrides(collapseBuiltModelVariants(combined), this.#modelOverrides);
		this.#models = this.#applyProviderReportedWindows(this.#applyRuntimeProviderOverrides(withModelOverrides));
		this.#lastStaticLoadMtime = this.#modelsConfigFile.getMtimeMs();
	}

	#loadBuiltInModels(overrides: Map<string, ProviderOverride>): Model<Api>[] {
		return getBundledProviders().flatMap(provider => {
			const models = getBundledModels(provider as Parameters<typeof getBundledModels>[0]) as Model<Api>[];
			const providerOverride = overrides.get(provider);

			return models.map(m => {
				if (!providerOverride) return m;
				const withTransportOverride = applyProviderTransportOverride(m, providerOverride);
				return buildModel({
					...withTransportOverride,
					compat: mergeCompat(m.compatConfig, providerOverride.compat),
				} as ModelSpec<Api>);
			});
		});
	}

	#mergeResolvedModels(baseModels: Model<Api>[], replacementModels: Model<Api>[]): Model<Api>[] {
		return mergeByModelKey(baseModels, replacementModels, (existing, replacementModel) => {
			if (!existing) return replacementModel;
			const supportsTools = replacementModel.supportsTools ?? existing.supportsTools;
			return {
				...replacementModel,
				contextWindow: replacementModel.contextWindow ?? existing.contextWindow,
				maxTokens: replacementModel.maxTokens ?? existing.maxTokens,
				omitMaxOutputTokens: replacementModel.omitMaxOutputTokens ?? existing.omitMaxOutputTokens,
				...(supportsTools !== undefined ? { supportsTools } : {}),
			};
		});
	}

	#mergeCustomModels(builtInModels: Model<Api>[], customModels: CustomModelOverlay[]): Model<Api>[] {
		return mergeByModelKey(builtInModels, customModels, (existingModel, customModel) => {
			if (!existingModel) return finalizeCustomModel(customModel, { useDefaults: true });
			return applyModelPatch(
				{
					...existingModel,
					id: customModel.id,
					provider: customModel.provider,
					api: customModel.api,
					baseUrl: customModel.baseUrl,
				},
				customModel,
				"replace",
			);
		});
	}

	#resolveStartupModelCacheProviderId(providerId: string): string {
		const descriptor = PROVIDER_DESCRIPTORS.find(candidate => candidate.providerId === providerId);
		if (!descriptor) {
			return providerId;
		}
		const baseUrl =
			this.#runtimeProviderOverrides.get(providerId)?.baseUrl ??
			this.#providerOverrides.get(providerId)?.baseUrl ??
			this.getProviderBaseUrl(providerId);
		return descriptor.createModelManagerOptions({ baseUrl, fetch: this.#fetch }).cacheProviderId ?? providerId;
	}

	#loadCachedStandardProviderModels(): {
		models: Model<Api>[];
		authoritativeFreshProviders: Set<string>;
	} {
		const configuredDiscoveryProviders = new Set(this.#discoverableProviders.map(provider => provider.provider));
		const cachedModels: Model<Api>[] = [];
		const authoritativeFreshProviders = new Set<string>();
		for (const providerId of STARTUP_MODEL_CACHE_PROVIDER_IDS) {
			if (configuredDiscoveryProviders.has(providerId)) {
				continue;
			}
			const cacheProviderId = this.#resolveStartupModelCacheProviderId(providerId);
			const cache = readModelCache<Api>(cacheProviderId, DAY_MS, Date.now, this.#cacheDbPath);
			if (!cache) {
				continue;
			}
			if (cache.fresh && cache.authoritative) {
				authoritativeFreshProviders.add(providerId);
			}
			const models = cache.models.map(model =>
				model.provider === providerId ? model : { ...model, provider: providerId },
			);
			const providerOverride = this.#providerOverrides.get(providerId);
			const withTransport = providerOverride
				? models.map(model => applyProviderTransportOverride(model, providerOverride))
				: models;
			const withCompat = providerOverride?.compat
				? withTransport.map(model =>
						buildModel({
							...model,
							compat: mergeCompat(model.compat, providerOverride.compat),
						} as ModelSpec<Api>),
					)
				: withTransport.map(model => buildModel(model));
			const overrides = this.#applyProviderModelOverrides(providerId, withCompat);
			for (let oi = 0; oi < overrides.length; oi++) cachedModels.push(overrides[oi]!);
		}
		return { models: cachedModels, authoritativeFreshProviders };
	}

	#loadCachedDiscoverableModels(): Model<Api>[] {
		const cachedModels: Model<Api>[] = [];
		for (const providerConfig of this.#discoverableProviders) {
			const cache = readModelCache<Api>(
				this.#configuredDiscoveryCacheProviderId(providerConfig),
				DAY_MS,
				Date.now,
				this.#cacheDbPath,
			);
			if (!cache) {
				this.#providerDiscoveryStates.set(providerConfig.provider, {
					provider: providerConfig.provider,
					status: "idle",
					optional: providerConfig.optional ?? false,
					stale: false,
					models: [],
				});
				continue;
			}
			const configStale = this.#isDiscoveryCacheOlderThanModelsConfig(cache.updatedAt);
			const models = this.#applyProviderModelOverrides(
				providerConfig.provider,
				this.#normalizeDiscoverableModels(
					providerConfig,
					this.#applyProviderCompat(
						providerConfig.compat,
						cache.models.map(model => buildModel(model)),
					),
				),
			);
			for (let mi = 0; mi < models.length; mi++) cachedModels.push(models[mi]!);
			const stale =
				providerConfig.discovery.type === "llama.cpp" || !cache.fresh || !cache.authoritative || configStale;
			this.#providerDiscoveryStates.set(providerConfig.provider, {
				provider: providerConfig.provider,
				status: "cached",
				optional: providerConfig.optional ?? false,
				stale,
				fetchedAt: cache.updatedAt,
				models: models.map(model => model.id),
			});
		}
		return cachedModels;
	}

	#applyProviderCompat(compat: ModelSpec<Api>["compat"] | undefined, models: Model<Api>[]): Model<Api>[] {
		if (!compat) return models;
		return models.map(model =>
			buildModel({ ...model, compat: mergeCompat(model.compatConfig, compat) } as ModelSpec<Api>),
		);
	}

	#normalizeDiscoverableModels(providerConfig: DiscoveryProviderConfig, models: Model<Api>[]): Model<Api>[] {
		const withDecoderMetadata =
			providerConfig.discovery.type === "ollama" ||
			providerConfig.discovery.type === "llama.cpp" ||
			providerConfig.discovery.type === "lm-studio"
				? models.map(model =>
						buildModel({ ...model, imageInputDecoder: "stb", compat: model.compatConfig } as ModelSpec<Api>),
					)
				: models;

		if (providerConfig.provider !== "ollama" || providerConfig.api !== "openai-responses") {
			return withDecoderMetadata;
		}

		const contextLengthOverride = getOllamaContextLengthOverride();
		return withDecoderMetadata.map(model => {
			const normalized =
				model.api === "openai-completions"
					? buildModel({
							...model,
							api: "openai-responses" as const,
							compat: model.compatConfig,
						} as ModelSpec<Api>)
					: model;
			if (contextLengthOverride === undefined) {
				return normalized;
			}
			return {
				...normalized,
				contextWindow: contextLengthOverride,
				maxTokens: Math.min(contextLengthOverride, DISCOVERY_DEFAULT_MAX_TOKENS),
			};
		});
	}

	#addImplicitDiscoverableProviders(configuredProviders: Set<string>): void {
		const disabledProviders = getDisabledProviderIdsFromSettings();
		for (const runtime of IMPLICIT_LOCAL_RUNTIMES) {
			if (configuredProviders.has(runtime.provider) || disabledProviders.has(runtime.provider)) continue;
			this.#discoverableProviders.push({
				provider: runtime.provider,
				api: runtime.api,
				baseUrl: runtime.baseUrl(),
				discovery: { type: runtime.discovery },
				optional: true,
			});
			if (runtime.keyless === "always" || !this.authStorage.hasAuth(runtime.provider)) {
				this.#keylessProviders.add(runtime.provider);
			}
		}
	}

	#loadCustomModels(): CustomModelsResult {
		const { value, error, status } = this.#modelsConfigFile.tryLoad();

		if (status === "error") {
			return {
				models: [],
				overrides: new Map(),
				modelOverrides: new Map(),
				keylessProviders: new Set(),
				discoverableProviders: [],
				configuredProviders: new Set(),
				error,
				found: true,
			};
		}
		if (status === "not-found") {
			return {
				models: [],
				overrides: new Map(),
				modelOverrides: new Map(),
				keylessProviders: new Set(),
				discoverableProviders: [],
				configuredProviders: new Set(),
				found: false,
			};
		}

		return parseCustomModelsConfig(value, (provider, key) => {
			this.#installProviderApiKey(provider, key);
		});
	}

	async #refreshRuntimeDiscoveries(
		strategy: ModelRefreshStrategy,
		providerFilter?: ReadonlySet<string>,
	): Promise<void> {
		const disabledProviders = getDisabledProviderIdsFromSettings();
		const selectedDiscoverableProviders = (
			providerFilter
				? this.#discoverableProviders.filter(provider => providerFilter.has(provider.provider))
				: this.#discoverableProviders
		).filter(provider => !disabledProviders.has(provider.provider));
		const configuredDiscoveriesPromise =
			selectedDiscoverableProviders.length === 0
				? Promise.resolve<Model<Api>[]>([])
				: Promise.all(
						selectedDiscoverableProviders.map(provider => this.#discoverProviderModels(provider, strategy)),
					).then(results => results.flat());
		const [configuredDiscovered, builtInDiscovery] = await Promise.all([
			configuredDiscoveriesPromise,
			this.#discoverBuiltInProviderModels(strategy, providerFilter),
		]);
		const discovered = configuredDiscovered.concat(builtInDiscovery.models);
		if (discovered.length === 0 && builtInDiscovery.authoritativeProviders.size === 0) {
			return;
		}
		const discoveredModels = this.#applyHardcodedModelPolicies(
			discovered.map(model =>
				mergeDiscoveredModel(
					model,
					this.find(model.provider, model.id),
					this.#providerOverrides.get(model.provider),
				),
			),
		);
		const authoritativeProviders = providersWithAuthoritativeProjectCatalog(discoveredModels);
		for (const provider of builtInDiscovery.authoritativeProviders) {
			authoritativeProviders.add(provider);
		}
		const baseModels =
			authoritativeProviders.size > 0 ? dropProviderModels(this.#models, authoritativeProviders) : this.#models;
		const resolved = this.#mergeResolvedModels(baseModels, discoveredModels);
		const withConfigModels = this.#mergeCustomModels(resolved, this.#customModelOverlays);
		const combined = this.#mergeCustomModels(withConfigModels, this.#runtimeModelOverlays);
		const withModelOverrides = this.#applyModelOverrides(collapseBuiltModelVariants(combined), this.#modelOverrides);
		this.#models = this.#applyProviderReportedWindows(this.#applyRuntimeProviderOverrides(withModelOverrides));
	}

	#configuredDiscoveryCacheProviderId(providerConfig: DiscoveryProviderConfig): string {
		if (providerConfig.discovery.type === "openai-models-list") {
			return `${providerConfig.provider}:openai-models-list-context-v2`;
		}
		if (providerConfig.discovery.type === "litellm") {
			return `${providerConfig.provider}:litellm-rich-v2`;
		}
		return providerConfig.provider;
	}

	#isDiscoveryCacheOlderThanModelsConfig(cacheUpdatedAt: number): boolean {
		const configMtime = this.#modelsConfigFile.getMtimeMs();
		return configMtime !== null && cacheUpdatedAt < Math.floor(configMtime);
	}

	async #discoverProviderModels(
		providerConfig: DiscoveryProviderConfig,
		strategy: ModelRefreshStrategy,
	): Promise<Model<Api>[]> {
		const cacheProviderId = this.#configuredDiscoveryCacheProviderId(providerConfig);
		const cached = readModelCache<Api>(cacheProviderId, DAY_MS, Date.now, this.#cacheDbPath);
		const cacheOlderThanConfig = cached !== null && this.#isDiscoveryCacheOlderThanModelsConfig(cached.updatedAt);
		const bypassFreshCache = providerConfig.discovery.type === "llama.cpp" && strategy === "online-if-uncached";
		const effectiveStrategy =
			strategy === "online-if-uncached" && (cacheOlderThanConfig || bypassFreshCache) ? "online" : strategy;
		const requiresAuth = !this.#keylessProviders.has(providerConfig.provider);
		if (requiresAuth) {
			const apiKey = await this.#peekApiKeyForProvider(providerConfig.provider);
			if (!isAuthenticated(apiKey)) {
				this.#providerDiscoveryStates.set(providerConfig.provider, {
					provider: providerConfig.provider,
					status: "unauthenticated",
					optional: providerConfig.optional ?? false,
					stale: cached !== null,
					fetchedAt: cached?.updatedAt,
					models: cached?.models.map(model => model.id) ?? [],
				});
				this.#lastDiscoveryWarnings.delete(providerConfig.provider);
				return cached
					? this.#normalizeDiscoverableModels(
							providerConfig,
							cached.models.map(model => buildModel(model)),
						)
					: [];
			}
		}

		const providerId = providerConfig.provider;
		let discoveryError: string | undefined;
		const fetchDynamicModels = async (): Promise<readonly ModelSpec<Api>[] | null> => {
			try {
				const models = this.#applyProviderModelOverrides(
					providerId,
					await discoverModelsByProviderType(providerConfig, this.#discoveryContext()),
				);
				this.#lastDiscoveryWarnings.delete(providerId);
				return models.map(toModelSpec);
			} catch (error) {
				discoveryError = errorMessage(error);
				return null;
			}
		};

		const manager = createModelManager<Api>({
			providerId,
			staticModels: [],
			cacheDbPath: this.#cacheDbPath,
			cacheProviderId,
			cacheTtlMs: DAY_MS,
			fetchDynamicModels,
		});
		const result = await manager.refresh(effectiveStrategy);
		const status = discoveryError
			? result.models.length > 0
				? "cached"
				: "unavailable"
			: effectiveStrategy === "offline"
				? cached
					? "cached"
					: "idle"
				: result.models.length > 0
					? "ok"
					: "empty";
		this.#providerDiscoveryStates.set(providerId, {
			provider: providerId,
			status,
			optional: providerConfig.optional ?? false,
			stale: result.stale || status === "cached" || ((cacheOlderThanConfig || bypassFreshCache) && status !== "ok"),
			fetchedAt: discoveryError ? cached?.updatedAt : Date.now(),
			models: result.models.map(model => model.id),
			error: discoveryError,
		});
		if (discoveryError) {
			this.#warnProviderDiscoveryFailure(providerConfig.provider, providerConfig.baseUrl, discoveryError);
		}
		return this.#applyProviderModelOverrides(
			providerId,
			this.#normalizeDiscoverableModels(
				providerConfig,
				this.#applyProviderCompat(providerConfig.compat, result.models),
			),
		);
	}

	#discoveryContext(): DiscoveryContext {
		return {
			fetch: this.#fetch,
			getBearerApiKeyResolver: async provider => {
				const apiKey = await this.getApiKeyForProvider(provider);
				if (!isDiscoveryBearerApiKey(apiKey)) {
					return undefined;
				}
				return this.resolver(provider);
			},
		};
	}

	#nonResolvingDiscoveryContext(): DiscoveryContext {
		return {
			fetch: this.#fetch,
			getBearerApiKeyResolver: async () => undefined,
		};
	}

	#hasStoredCredential(provider: string): boolean {
		return (
			this.authStorage.hasAuth(provider) ||
			this.#customProviderApiKeys.has(provider) ||
			this.#runtimeProviderApiKeys.has(provider)
		);
	}

	#hasConfiguredEndpoint(provider: string): boolean {
		return (
			this.#providerOverrides.get(provider)?.baseUrl !== undefined ||
			this.#runtimeProviderOverrides.get(provider)?.baseUrl !== undefined ||
			this.#discoverableProviders.some(row => row.provider === provider && row.optional === false) ||
			this.#customModelOverlays.some(overlay => overlay.provider === provider && overlay.baseUrl !== undefined) ||
			this.#runtimeModelOverlays.some(overlay => overlay.provider === provider && overlay.baseUrl !== undefined)
		);
	}

	#shouldWarnOnDiscoveryFailure(provider: string, url: string | undefined, error: string): boolean {
		if (this.#hasStoredCredential(provider) || this.#hasConfiguredEndpoint(provider)) {
			return true;
		}
		const effectiveUrl =
			url ??
			this.#runtimeProviderOverrides.get(provider)?.baseUrl ??
			this.#providerOverrides.get(provider)?.baseUrl ??
			this.#discoverableProviders.find(row => row.provider === provider)?.baseUrl ??
			this.getProviderBaseUrl(provider);
		if (!isLoopbackUrl(effectiveUrl)) {
			return true;
		}
		return !isConnectionRefusalError(error);
	}

	#warnProviderDiscoveryFailure(provider: string, url: string | undefined, error: string): void {
		const previous = this.#lastDiscoveryWarnings.get(provider);
		if (previous === error) {
			return;
		}
		this.#lastDiscoveryWarnings.set(provider, error);
		if (this.#shouldWarnOnDiscoveryFailure(provider, url, error)) {
			logger.warn("model discovery failed for provider", { provider, url, error });
		} else {
			logger.debug("model discovery failed for provider", { provider, url, error });
		}
	}

	async #discoverBuiltInProviderModels(
		strategy: ModelRefreshStrategy,
		providerFilter?: ReadonlySet<string>,
	): Promise<BuiltInDiscoveryResult> {
		const configuredDiscoveryProviders = new Set(this.#discoverableProviders.map(p => p.provider));
		const managerOptions = await collectBuiltInModelManagerOptions({
			strategy,
			providerFilter,
			configuredDiscoveryProviders,
			disabledProviders: getDisabledProviderIdsFromSettings(),
			runtimeProviderOverrides: this.#runtimeProviderOverrides,
			providerOverrides: this.#providerOverrides,
			keylessProviders: this.#keylessProviders,
			runtimeModelManagers: this.#runtimeModelManagers,
			fetch: this.#fetch,
			authStorage: this.authStorage,
			getProviderBaseUrl: provider => this.getProviderBaseUrl(provider),
			resolveBuiltInApiKey: (id, strat, cacheId) => this.#resolveBuiltInDiscoveryApiKey(id, strat, cacheId),
		});
		if (managerOptions.length === 0) {
			return { models: [], authoritativeProviders: new Set() };
		}
		const discoveries = await Promise.all(
			managerOptions.map(options => this.#discoverWithModelManager(options, strategy)),
		);
		const authoritativeProviders = new Set<string>();
		const models: Model<Api>[] = [];
		for (const discovery of discoveries) {
			for (let mi = 0; mi < discovery.models.length; mi++) models.push(discovery.models[mi]!);
			for (const provider of discovery.authoritativeProviders) {
				authoritativeProviders.add(provider);
			}
		}
		return { models, authoritativeProviders };
	}

	async #resolveBuiltInDiscoveryApiKey(
		providerId: string,
		strategy: ModelRefreshStrategy,
		cacheProviderId: string,
	): Promise<string | undefined> {
		const peekedKey = await this.#peekApiKeyForProvider(providerId);
		if (isAuthenticated(peekedKey) || strategy === "offline") {
			return peekedKey;
		}
		const oauthCredentials = getOAuthCredentialsForProvider(this.authStorage, providerId);
		if (oauthCredentials.length === 0) {
			return peekedKey;
		}
		if (strategy === "online-if-uncached") {
			const cache = readModelCache<Api>(
				cacheProviderId,
				BUILT_IN_DISCOVERY_CACHE_TTL_MS,
				Date.now,
				this.#cacheDbPath,
			);
			const cacheAgeMs = cache ? Date.now() - cache.updatedAt : Number.POSITIVE_INFINITY;
			if (cache?.fresh && (cache.authoritative || cacheAgeMs < BUILT_IN_DISCOVERY_NON_AUTHORITATIVE_RETRY_MS)) {
				return peekedKey;
			}
		}
		try {
			return await this.getApiKeyForProvider(providerId);
		} catch (error) {
			logger.debug("OAuth refresh failed during model discovery preflight", {
				provider: providerId,
				error: errorMessage(error),
			});
			return peekedKey;
		}
	}

	async #discoverWithModelManager(
		options: ModelManagerOptions<Api>,
		strategy: ModelRefreshStrategy,
	): Promise<BuiltInDiscoveryResult> {
		try {
			const manager = createModelManager({
				...options,
				cacheDbPath: this.#cacheDbPath,

				onDiscoveryFailure: failure =>
					this.#warnProviderDiscoveryFailure(
						options.providerId,
						failure.url || undefined,
						`${failure.stage}: ${failure.detail}`,
					),
			});
			const result = await manager.refresh(strategy);
			const models = result.models.map(model =>
				model.provider === options.providerId ? model : { ...model, provider: options.providerId },
			);
			const authoritativeProviders = new Set<string>();
			if (options.dynamicModelsAuthoritative && !result.stale) {
				authoritativeProviders.add(options.providerId);
			}
			return { models, authoritativeProviders };
		} catch (error) {
			this.#warnProviderDiscoveryFailure(options.providerId, undefined, errorMessage(error));
			return { models: [], authoritativeProviders: new Set() };
		}
	}

	#applyProviderModelOverrides(provider: string, models: Model<Api>[]): Model<Api>[] {
		const overrides = this.#modelOverrides.get(provider);
		if (!overrides || overrides.size === 0) return models;
		let liveIds: Set<string> | null = null;
		const hasLiveModel = (_provider: string, id: string) => {
			liveIds ??= new Set(models.map(m => m.id));
			return liveIds.has(id);
		};
		return models.map(model => {
			const override = resolveModelOverrideWithAliases(overrides, model, hasLiveModel);
			if (!override) return model;
			return applyModelOverride(model, override);
		});
	}

	#mergeProviderOverride(baseOverride: ProviderOverride | undefined, override: ProviderOverride): ProviderOverride {
		return {
			baseUrl: override.baseUrl ?? baseOverride?.baseUrl,
			apiKey: override.apiKey ?? baseOverride?.apiKey,
			authHeader: override.authHeader ?? baseOverride?.authHeader,
			headers: override.headers
				? resolveConfigHeaders({ ...baseOverride?.headers, ...override.headers })
				: baseOverride?.headers,
			compat: override.compat ? mergeCompat(baseOverride?.compat, override.compat) : baseOverride?.compat,
			transport: override.transport ?? baseOverride?.transport,
		};
	}

	#applyRuntimeProviderOverrides(models: Model<Api>[]): Model<Api>[] {
		if (this.#runtimeProviderOverrides.size === 0) return models;
		return models.map(model => {
			const override = this.#runtimeProviderOverrides.get(model.provider);
			if (!override) return model;
			return applyProviderTransportOverride(model, override);
		});
	}

	#resolveLiveModelOverride(model: Model<Api>): ModelOverride | undefined {
		const providerOverrides = this.#modelOverrides.get(model.provider);
		if (!providerOverrides) return undefined;
		return resolveModelOverrideWithAliases(
			providerOverrides,
			model,
			(provider, id) => this.find(provider, id) !== undefined,
		);
	}

	#resolveLiveCustomModelOverlay(model: Model<Api>): CustomModelOverlay | undefined {
		return (
			this.#customModelOverlays.find(overlay => overlay.provider === model.provider && overlay.id === model.id) ??
			this.#runtimeModelOverlays.find(overlay => overlay.provider === model.provider && overlay.id === model.id)
		);
	}

	#applyModelOverrides(models: Model<Api>[], overrides: Map<string, Map<string, ModelOverride>>): Model<Api>[] {
		if (overrides.size === 0) return models;
		let liveKeys: Set<string> | null = null;
		const hasLiveModel = (provider: string, id: string) => {
			liveKeys ??= new Set(models.map(m => `${m.provider}\u0000${m.id}`));
			return liveKeys.has(`${provider}\u0000${id}`);
		};
		return models.map(model => {
			const providerOverrides = overrides.get(model.provider);
			if (!providerOverrides) return model;
			const override = resolveModelOverrideWithAliases(providerOverrides, model, hasLiveModel);
			if (!override) return model;
			return applyModelOverride(model, override);
		});
	}

	#applyHardcodedModelPolicies(models: Model<Api>[]): Model<Api>[] {
		return models.map(model => {
			if (model.provider === "ollama-cloud" && model.omitMaxOutputTokens !== true) {
				model = applyModelOverride(model, { omitMaxOutputTokens: true });
			}
			if (model.id !== "gpt-5.4" || model.provider === "github-copilot") {
				return model;
			}
			const overrides = this.#modelOverrides.get(model.provider)?.get(model.id);
			if (!overrides) {
				return applyModelOverride(model, { contextWindow: 1_000_000 });
			}
			return applyModelOverride(model, {
				contextWindow: overrides.contextWindow ?? 1_000_000,
				...overrides,
			});
		});
	}

	recordProviderReportedContextWindow(provider: string, id: string, contextWindow: number): boolean {
		if (!Number.isFinite(contextWindow) || contextWindow <= 0) return false;
		const key = `${provider}/${id}`;
		if (this.#providerReportedWindows.get(key) === contextWindow) return false;
		this.#providerReportedWindows.set(key, contextWindow);
		this.#models = this.#applyProviderReportedWindows(this.#models);
		return true;
	}

	#applyProviderReportedWindows(models: Model<Api>[]): Model<Api>[] {
		if (this.#providerReportedWindows.size === 0) return models;
		return models.map(model => {
			const reported = this.#providerReportedWindows.get(`${model.provider}/${model.id}`);
			if (reported === undefined || model.contextWindow === reported) return model;
			return { ...model, contextWindow: reported };
		});
	}

	getAll(): Model<Api>[] {
		return this.#models;
	}

	#createAvailabilityCheck(): (model: Model<Api>) => boolean {
		const disabledProviders = getDisabledProviderIdsFromSettings();
		const byProvider = new Map<string, boolean>();
		return model => {
			let available = byProvider.get(model.provider);
			if (available === undefined) {
				available =
					!disabledProviders.has(model.provider) &&
					(this.#keylessProviders.has(model.provider) || this.authStorage.hasAuth(model.provider));
				byProvider.set(model.provider, available);
			}
			return available;
		};
	}

	getAvailable(): Model<Api>[] {
		return this.#models.filter(this.#createAvailabilityCheck());
	}

	hasConfiguredAuth(model: Model<Api>): boolean {
		const keyConfig = this.#customProviderApiKeys.get(model.provider);
		return (
			isConfigValueCommand(keyConfig) ||
			this.#keylessProviders.has(model.provider) ||
			this.authStorage.hasAuth(model.provider)
		);
	}

	isKeylessProvider(provider: string): boolean {
		return this.#keylessProviders.has(provider);
	}

	getDiscoverableProviders(): string[] {
		const disabledProviders = getDisabledProviderIdsFromSettings();
		return this.#discoverableProviders
			.filter(provider => !disabledProviders.has(provider.provider))
			.map(provider => provider.provider);
	}

	getProviderDiscoveryState(provider: string): ProviderDiscoveryState | undefined {
		return this.#providerDiscoveryStates.get(provider);
	}

	find(provider: string, modelId: string): Model<Api> | undefined {
		return resolveProviderModelReference(provider, modelId, this.#models);
	}

	getProviderBaseUrl(provider: string): string | undefined {
		return this.#models.find(m => m.provider === provider && m.baseUrl)?.baseUrl;
	}

	async getApiKey(model: Model<Api>, sessionId?: string): Promise<string | undefined> {
		const commandKey = this.#resolveCommandBackedApiKey(model.provider);
		if (commandKey.configured) return commandKey.value;
		if (this.#keylessProviders.has(model.provider) && !this.authStorage.hasAuth(model.provider)) {
			return kNoAuth;
		}
		return this.authStorage.getApiKey(model.provider, sessionId, { baseUrl: model.baseUrl, modelId: model.id });
	}

	async getApiKeyForProvider(
		provider: string,
		sessionId?: string,
		options?: { baseUrl?: string; modelId?: string; forceRefresh?: boolean; signal?: AbortSignal },
	): Promise<string | undefined> {
		const commandKey = this.#resolveCommandBackedApiKey(provider);
		if (commandKey.configured) return commandKey.value;
		if (this.#keylessProviders.has(provider) && !this.authStorage.hasAuth(provider)) {
			return kNoAuth;
		}
		return this.authStorage.getApiKey(provider, sessionId, {
			baseUrl: options?.baseUrl,
			modelId: options?.modelId,
			forceRefresh: options?.forceRefresh,
			signal: options?.signal,
		});
	}

	resolver(provider: string, options?: ApiKeyResolverOptions): ApiKeyResolver;
	resolver(model: ApiKeyResolverModel, sessionId?: string): ApiKeyResolver;
	resolver(target: string | ApiKeyResolverModel, optionsOrSessionId?: ApiKeyResolverOptions | string): ApiKeyResolver {
		const options = typeof optionsOrSessionId === "string" ? { sessionId: optionsOrSessionId } : optionsOrSessionId;
		if (typeof target === "string") {
			return createApiKeyResolver(this, target, options);
		}
		return createApiKeyResolver(this, target.provider, {
			...options,
			baseUrl: target.baseUrl,
			modelId: target.id,
		});
	}

	async #peekApiKeyForProvider(provider: string): Promise<string | undefined> {
		const commandKey = this.#resolveCommandBackedApiKey(provider);
		if (commandKey.configured) return commandKey.value;
		if (this.#keylessProviders.has(provider) && !this.authStorage.hasAuth(provider)) {
			return kNoAuth;
		}
		return this.authStorage.peekApiKey(provider);
	}

	isUsingOAuth(model: Model<Api>): boolean {
		return this.authStorage.hasOAuth(model.provider);
	}

	#clearRuntimeProviderState(providerName: string): void {
		this.#runtimeProviderApiKeys.delete(providerName);
		this.#runtimeProviderOverrides.delete(providerName);
		this.#runtimeModelOverlays = this.#runtimeModelOverlays.filter(overlay => overlay.provider !== providerName);
		this.#runtimeModelManagers.delete(providerName);
		this.authStorage.removeConfigApiKey(providerName);
	}

	clearSourceRegistrations(sourceId: string): void {
		unregisterCustomApis(sourceId);
		unregisterOAuthProviders(sourceId);
		const sourceProviders = this.#runtimeProvidersBySource.get(sourceId);
		if (!sourceProviders || sourceProviders.size === 0) {
			return;
		}
		this.#runtimeProvidersBySource.delete(sourceId);
		for (const providerName of sourceProviders) {
			if (this.#runtimeProviderSourceByName.get(providerName) !== sourceId) {
				continue;
			}
			this.#runtimeProviderSourceByName.delete(providerName);
			this.#clearRuntimeProviderState(providerName);
		}
		this.#lastStaticLoadMtime = null;
		this.#reloadStaticModels();
	}

	syncExtensionSources(activeSourceIds: string[]): void {
		const activeSources = new Set(activeSourceIds);
		for (const sourceId of this.#registeredProviderSources) {
			if (activeSources.has(sourceId)) {
				continue;
			}
			this.clearSourceRegistrations(sourceId);
			this.#registeredProviderSources.delete(sourceId);
		}
	}

	registerProvider(providerName: string, config: ProviderConfigInput, sourceId?: string): void {
		if (config.streamSimple && !config.api) {
			throw new Error(`Provider ${providerName}: "api" is required when registering streamSimple.`);
		}

		validateProviderConfiguration(
			providerName,
			{
				baseUrl: config.baseUrl,
				headers: config.headers,
				apiKey: config.apiKey,
				api: config.api,
				oauthConfigured: Boolean(config.oauth),
				models: (config.models ?? []) as ProviderValidationModel[],
			},
			"runtime-register",
		);

		if (config.streamSimple && config.api) {
			const streamSimple = config.streamSimple;
			registerCustomApi(config.api, streamSimple, sourceId, (model, context, options) =>
				streamSimple(model, context, options as SimpleStreamOptions),
			);
		}

		if (config.oauth) {
			registerOAuthProvider({
				...config.oauth,
				id: providerName,
				sourceId,
			});
		}

		let sourceHandoff = false;
		if (sourceId) {
			this.#registeredProviderSources.add(sourceId);
			const previousSourceId = this.#runtimeProviderSourceByName.get(providerName);
			if (previousSourceId && previousSourceId !== sourceId) {
				const previousProviders = this.#runtimeProvidersBySource.get(previousSourceId);
				previousProviders?.delete(providerName);
				if (previousProviders && previousProviders.size === 0) {
					this.#runtimeProvidersBySource.delete(previousSourceId);
				}
				this.#clearRuntimeProviderState(providerName);
				sourceHandoff = true;
			}
			const sourceProviders = this.#runtimeProvidersBySource.get(sourceId) ?? new Set<string>();
			sourceProviders.add(providerName);
			this.#runtimeProvidersBySource.set(sourceId, sourceProviders);
			this.#runtimeProviderSourceByName.set(providerName, sourceId);
		}
		if (sourceHandoff) {
			this.#lastStaticLoadMtime = null;
			this.#reloadStaticModels();
		}

		if (config.apiKey) {
			this.#installProviderApiKey(providerName, config.apiKey);
			this.#runtimeProviderApiKeys.set(providerName, config.apiKey);
		}

		if (config.models && config.models.length > 0) {
			const newOverlays = buildRuntimeModelOverlays(providerName, config);
			this.#runtimeModelOverlays = this.#runtimeModelOverlays.filter(m => m.provider !== providerName);
			for (let oi = 0; oi < newOverlays.length; oi++) this.#runtimeModelOverlays.push(newOverlays[oi]!);

			const nextModels = this.#models.filter(m => m.provider !== providerName);
			for (const overlay of newOverlays) {
				nextModels.push(finalizeCustomModel(overlay, { useDefaults: true }));
			}
			const runtimeTransportOverride = this.#runtimeProviderOverrides.get(providerName);
			const withRuntimeTransportOverride = runtimeTransportOverride
				? nextModels.map(model => {
						if (model.provider !== providerName) return model;
						return applyProviderTransportOverride(model, runtimeTransportOverride);
					})
				: nextModels;

			if (config.oauth?.modifyModels) {
				const credential = this.authStorage.getOAuthCredential(providerName);
				if (credential) {
					this.#models = config.oauth.modifyModels(withRuntimeTransportOverride, credential);
					return;
				}
			}

			this.#models = withRuntimeTransportOverride;
			return;
		}

		if (config.fetchDynamicModels) {
			const managerOptions = createDynamicModelManagerOptions({
				providerName,
				config,
				cacheDbPath: this.#cacheDbPath,
				peekApiKey: provider => this.#peekApiKeyForProvider(provider),
			});
			this.#runtimeModelManagers.set(providerName, { options: managerOptions, sourceId: sourceId ?? "" });
		}

		if (
			config.baseUrl ||
			config.headers ||
			config.apiKey ||
			config.authHeader !== undefined ||
			config.transport !== undefined
		) {
			const transportOverride = {
				baseUrl: config.baseUrl,
				headers: config.headers,
				apiKey: config.apiKey,
				authHeader: config.authHeader,
				transport: config.transport,
			};
			const nextRuntimeOverride = this.#mergeProviderOverride(
				this.#runtimeProviderOverrides.get(providerName),
				transportOverride,
			);
			this.#runtimeProviderOverrides.set(providerName, nextRuntimeOverride);
			this.#models = this.#models.map(m => {
				if (m.provider !== providerName) return m;
				return applyProviderTransportOverride(m, transportOverride);
			});
		}
	}

	suppressSelector(selector: string, untilMs: number): void {
		this.#suppressedSelectors.set(
			normalizeSuppressedSelector(selector, (provider, id) => this.find(provider, id) !== undefined),
			untilMs,
		);
	}

	isSelectorSuppressed(selector: string): boolean {
		const normalizedSelector = normalizeSuppressedSelector(
			selector,
			(provider, id) => this.find(provider, id) !== undefined,
		);
		const suppressedUntil = this.#suppressedSelectors.get(normalizedSelector);
		if (!suppressedUntil) return false;
		if (suppressedUntil <= Date.now()) {
			this.#suppressedSelectors.delete(normalizedSelector);
			return false;
		}
		return true;
	}

	clearSuppressedSelector(selector: string): void {
		this.#suppressedSelectors.delete(
			normalizeSuppressedSelector(selector, (provider, id) => this.find(provider, id) !== undefined),
		);
	}

	clearSuppressedSelectors(): void {
		this.#suppressedSelectors.clear();
	}
}
