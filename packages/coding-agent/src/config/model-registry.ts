import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { registerCustomApi, unregisterCustomApis } from "@veyyon/ai/api-registry";
import type { Api, Context, Model, ModelSpec, SimpleStreamOptions, ThinkingConfig } from "@veyyon/ai/types";
import type { AssistantMessageEventStream } from "@veyyon/ai/utils/event-stream";
import { buildModel } from "@veyyon/catalog/build";
import { isVertexExpressOpenAIUrl } from "@veyyon/catalog/hosts";
import { modelCacheStamp, readModelCache } from "@veyyon/catalog/model-cache";
import { createModelManager, type ModelManagerOptions, type ModelRefreshStrategy } from "@veyyon/catalog/model-manager";
import {
	bundledCatalogDigest,
	getBundledModels,
	getBundledProviders,
	setEnrichedRegistrySnapshotStore,
} from "@veyyon/catalog/models";
import {
	googleAntigravityModelManagerOptions,
	googleGeminiCliModelManagerOptions,
	openaiCodexModelManagerOptions,
	PROVIDER_DESCRIPTORS,
} from "@veyyon/catalog/provider-models";
import { createEnrichedRegistrySnapshotStore } from "@veyyon/catalog/registry-snapshot";
import {
	collapseBuiltModelVariants,
	getVariantAliasSources,
	resolveVariantAlias,
} from "@veyyon/catalog/variant-collapse";

const SPECIAL_MODEL_MANAGER_PROVIDER_IDS: readonly string[] = [
	"google-antigravity",
	"google-gemini-cli",
	"openai-codex",
];

const STARTUP_MODEL_CACHE_PROVIDER_IDS: readonly string[] = [
	...PROVIDER_DESCRIPTORS.map(descriptor => descriptor.providerId),
	...SPECIAL_MODEL_MANAGER_PROVIDER_IDS,
];

const LOCAL_PROVIDER_PLACEHOLDERS = new Set<string>(["llama-cpp-local", "lm-studio-local", "vllm-local"]);

const RUNTIME_DYNAMIC_MODEL_FETCH_TIMEOUT_MS = 15_000;
const BUILT_IN_DISCOVERY_CACHE_TTL_MS = 2 * HOUR_MS;
const BUILT_IN_DISCOVERY_NON_AUTHORITATIVE_RETRY_MS = 5 * 60 * 1000;

import type { ApiKeyResolver, FetchImpl } from "@veyyon/ai";
import { registerOAuthProvider, unregisterOAuthProviders } from "@veyyon/ai/oauth";
import type { OAuthCredentials, OAuthLoginCallbacks } from "@veyyon/ai/oauth/types";
import { getBundledModelReferenceIndex, resolveModelReference } from "@veyyon/catalog/identity";
import {
	atomicWriteFileSync,
	DAY_MS,
	errorMessage,
	getModelDbPath,
	HOUR_MS,
	isBunTestRuntime,
	isRecord,
	logger,
	wrapFetchForExtraCa,
} from "@veyyon/utils";
import { parseModelString, resolveProviderModelReference } from "../config/model-resolver";
import type { AuthStorage, OAuthCredential } from "../session/auth-storage";
import { type ApiKeyResolverModel, type ApiKeyResolverOptions, createApiKeyResolver } from "./api-key-resolver";
import { isAuthenticated, kNoAuth } from "./auth-state";
import type { ConfigError, ConfigFile } from "./config-file";
import {
	commandFailureReason,
	configCommandPolicy,
	describeConfigEnvReference,
	isConfigValueCommand,
	parseConfigValueCommand,
	reportUnresolvedEnvReference,
	resolveConfigEnvReference,
} from "./config-value-resolution";
import {
	DISCOVERY_DEFAULT_MAX_TOKENS,
	type DiscoveryContext,
	type DiscoveryProviderConfig,
	discoverLlamaCppModelRuntimeMetadata,
	discoverModelsByProviderType,
	getImplicitOllamaBaseUrl,
	getOllamaContextLengthOverride,
	normalizeLiteLLMDiscoveryBaseUrl,
} from "./model-discovery";
import { ModelsConfigFile, type ProviderValidationModel, validateProviderConfiguration } from "./models-config";
import type { ModelOverride, ModelsConfig, ProviderAuthMode } from "./models-config-schema";
import { settings } from "./settings";

function isDiscoveryBearerApiKey(apiKey: string | undefined | null): apiKey is string {
	return isAuthenticated(apiKey) && !LOCAL_PROVIDER_PLACEHOLDERS.has(apiKey);
}

interface ImplicitLocalRuntime {
	readonly provider: string;
	readonly api: Api;
	readonly baseUrl: () => string;
	readonly discovery: "ollama" | "llama.cpp" | "lm-studio";
	readonly keyless: "always" | "unless-authenticated";
}

const IMPLICIT_LOCAL_RUNTIMES: readonly ImplicitLocalRuntime[] = [
	{
		provider: "ollama",
		api: "openai-responses",
		baseUrl: getImplicitOllamaBaseUrl,
		discovery: "ollama",
		keyless: "always",
	},
	{
		provider: "llama.cpp",
		api: "openai-responses",
		baseUrl: () => Bun.env.LLAMA_CPP_BASE_URL || "http://127.0.0.1:8080",
		discovery: "llama.cpp",
		keyless: "unless-authenticated",
	},
	{
		provider: "lm-studio",
		api: "openai-completions",
		baseUrl: () => Bun.env.LM_STUDIO_BASE_URL || "http://127.0.0.1:1234/v1",
		discovery: "lm-studio",
		keyless: "always",
	},
];

export const IMPLICIT_LOCAL_RUNTIME_IDS: readonly string[] = IMPLICIT_LOCAL_RUNTIMES.map(runtime => runtime.provider);

function isLoopbackUrl(url: string | undefined): boolean {
	if (!url) return false;
	let hostname: string;
	try {
		hostname = new URL(url).hostname.toLowerCase();
	} catch {
		return false;
	}
	if (hostname === "localhost" || hostname.endsWith(".localhost")) return true;
	if (hostname === "[::1]" || hostname === "[::]" || hostname === "::1" || hostname === "::") return true;
	if (hostname === "0.0.0.0") return true;
	return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname);
}

function isConnectionRefusalError(error: string): boolean {
	return /unable to connect|econnrefused|connection refused|ehostunreach|enetunreach|econnreset|failed to connect/i.test(
		error,
	);
}

async function withRuntimeDynamicModelsTimeout<T>(timeoutMs: number, run: () => Promise<T>): Promise<T> {
	const { promise: timeoutPromise, reject: timeoutReject } = Promise.withResolvers<never>();
	const timer = setTimeout(() => {
		timeoutReject(new Error(`fetchDynamicModels timed out after ${timeoutMs}ms`));
	}, timeoutMs);
	try {
		return await Promise.race([run(), timeoutPromise]);
	} finally {
		clearTimeout(timer);
	}
}

interface ProviderOverride {
	baseUrl?: string;
	headers?: Record<string, string>;
	apiKey?: string;
	authHeader?: boolean;
	compat?: ModelSpec<Api>["compat"];
	transport?: Model<Api>["transport"];
}

export function mergeDiscoveredModel<TApi extends Api>(
	model: Model<TApi>,
	existing: Model<Api> | undefined,
	providerOverride?: Pick<ProviderOverride, "baseUrl" | "headers" | "transport">,
): Model<TApi> {
	if (existing) {
		const supportsTools = model.supportsTools ?? existing.supportsTools;
		return buildModel({
			...model,
			baseUrl: providerOverride?.baseUrl ?? model.baseUrl ?? existing.baseUrl,
			headers: existing.headers ? { ...existing.headers, ...model.headers } : model.headers,
			transport: providerOverride?.transport ?? existing.transport ?? model.transport,
			...(supportsTools !== undefined ? { supportsTools } : {}),
			compat: model.compatConfig,
		} as ModelSpec<TApi>);
	}
	if (providerOverride) {
		return buildModel({
			...model,
			baseUrl: providerOverride.baseUrl ?? model.baseUrl,
			headers: providerOverride.headers ? { ...model.headers, ...providerOverride.headers } : model.headers,
			...(providerOverride.transport !== undefined ? { transport: providerOverride.transport } : {}),
			compat: model.compatConfig,
		} as ModelSpec<TApi>);
	}
	return model;
}

const AUTHORITATIVE_RUNTIME_CATALOG_PROVIDERS = new Set<string>(
	PROVIDER_DESCRIPTORS.filter(descriptor => descriptor.dynamicModelsAuthoritative).map(
		descriptor => descriptor.providerId,
	),
);

function isAuthoritativeProjectCatalogModel(model: Model<Api>): boolean {
	return (
		model.provider === "google-vertex" &&
		model.api === "openai-completions" &&
		isVertexExpressOpenAIUrl(model.baseUrl)
	);
}

function providersWithAuthoritativeProjectCatalog(models: readonly Model<Api>[]): Set<string> {
	const providers = new Set<string>();
	for (const model of models) {
		if (isAuthoritativeProjectCatalogModel(model)) {
			providers.add(model.provider);
		}
	}
	return providers;
}

function dropProviderModels(models: readonly Model<Api>[], providers: ReadonlySet<string>): Model<Api>[] {
	return models.filter(model => !providers.has(model.provider));
}

function mergeByModelKey<T extends { provider: string; id: string }>(
	base: readonly Model<Api>[],
	incoming: readonly T[],
	combine: (existing: Model<Api> | undefined, entry: T) => Model<Api>,
): Model<Api>[] {
	const merged = base.slice();
	const indexByKey = new Map<string, number>();
	for (let i = 0; i < merged.length; i += 1) {
		indexByKey.set(`${merged[i].provider}\u0000${merged[i].id}`, i);
	}
	for (const entry of incoming) {
		const key = `${entry.provider}\u0000${entry.id}`;
		const existingIndex = indexByKey.get(key);
		if (existingIndex !== undefined) {
			merged[existingIndex] = combine(merged[existingIndex], entry);
		} else {
			merged.push(combine(undefined, entry));
			indexByKey.set(key, merged.length - 1);
		}
	}
	return merged;
}

interface BuiltInDiscoveryResult {
	models: Model<Api>[];
	authoritativeProviders: Set<string>;
}

export type ProviderDiscoveryStatus = "idle" | "ok" | "empty" | "cached" | "unavailable" | "unauthenticated";

export interface ProviderDiscoveryState {
	provider: string;
	status: ProviderDiscoveryStatus;
	optional: boolean;
	stale: boolean;
	fetchedAt?: number;
	models: string[];
	error?: string;
}

const PROVIDER_DISCOVERY_STATUSES: ReadonlySet<string> = new Set<ProviderDiscoveryStatus>([
	"idle",
	"ok",
	"empty",
	"cached",
	"unavailable",
	"unauthenticated",
]);

interface CustomModelsResult {
	models?: CustomModelOverlay[];
	overrides?: Map<string, ProviderOverride>;
	modelOverrides?: Map<string, Map<string, ModelOverride>>;
	keylessProviders?: Set<string>;
	discoverableProviders?: DiscoveryProviderConfig[];
	configuredProviders?: Set<string>;
	error?: ConfigError;
	found: boolean;
}

const COMMAND_TIMEOUT_MS = 10_000;

function resolveCommandConfig(command: string): string | undefined {
	const cached = configCommandPolicy.getCached(command);
	if (cached !== undefined) return cached;
	if (configCommandPolicy.isBackedOff(command)) return undefined;
	try {
		const stdout = execSync(command, {
			encoding: "utf8",
			timeout: COMMAND_TIMEOUT_MS,
			windowsHide: true,
			stdio: ["ignore", "pipe", "pipe"],
		});
		const trimmed = stdout.trim();
		if (trimmed.length === 0) {
			configCommandPolicy.recordFailure(command, undefined, commandFailureReason.emptyOutput);
			return undefined;
		}
		configCommandPolicy.recordSuccess(command, trimmed);
		return trimmed;
	} catch (error) {
		const failure = error as { status?: number; signal?: string; stderr?: Buffer | string };
		const reason =
			failure.signal === "SIGTERM"
				? commandFailureReason.timedOut(COMMAND_TIMEOUT_MS)
				: typeof failure.status === "number"
					? commandFailureReason.exited(failure.status)
					: commandFailureReason.spawnFailed(errorMessage(error));
		configCommandPolicy.recordFailure(command, undefined, reason, failure.stderr?.toString());
		return undefined;
	}
}

interface CommandApiKeyResolution {
	configured: boolean;
	value?: string;
}
function resolveConfigValue(valueConfig: string, describedAs?: string): string | undefined {
	const command = parseConfigValueCommand(valueConfig);
	if (command !== null) return resolveCommandConfig(command);
	const outcome = resolveConfigEnvReference(valueConfig);
	if (outcome.ok) return outcome.value;
	reportUnresolvedEnvReference({
		variable: outcome.variable,
		explicit: outcome.explicit,
		empty: outcome.empty,
		describedAs,
	});
	return undefined;
}

type HeaderSource = Record<string, string> | undefined;

interface HeaderResolutionOptions {
	authHeader?: boolean;
	apiKeyConfig?: string;
}

function materializeConfigHeaderSources(
	sources: readonly HeaderSource[],
	options?: HeaderResolutionOptions,
): Record<string, string> | undefined {
	const resolved: Record<string, string> = {};
	for (const source of sources) {
		if (!source) continue;
		for (const [key, value] of Object.entries(source)) {
			const next = resolveConfigValue(value, `header "${key}"`);
			if (next) resolved[key] = next;
		}
	}
	if (options?.authHeader && options.apiKeyConfig) {
		const resolvedKey = resolveConfigValue(options.apiKeyConfig, "provider API key");
		if (resolvedKey) resolved.Authorization = `Bearer ${resolvedKey}`;
	}
	return Object.keys(resolved).length > 0 ? resolved : undefined;
}

function createLiveConfigHeaders(
	sources: readonly HeaderSource[],
	options?: HeaderResolutionOptions,
): Record<string, string> | undefined {
	const liveSources = sources.filter((source): source is Record<string, string> => source !== undefined);
	if (liveSources.length === 0 && (!options?.authHeader || !options.apiKeyConfig)) return undefined;

	const localHeaders: Record<string, string> = {};
	const allSources = liveSources.concat([localHeaders]);
	const current = () => materializeConfigHeaderSources(allSources, options) ?? {};
	return new Proxy(localHeaders, {
		get(target, property, receiver) {
			if (typeof property !== "string") return Reflect.get(target, property, receiver);
			return current()[property];
		},
		set(target, property, value) {
			if (typeof property !== "string" || typeof value !== "string") return false;
			target[property] = value;
			return true;
		},
		deleteProperty(target, property) {
			if (typeof property !== "string") return false;
			delete target[property];
			return true;
		},
		has(_target, property) {
			if (typeof property !== "string") return false;
			return Object.hasOwn(current(), property);
		},
		ownKeys() {
			return Reflect.ownKeys(current());
		},
		getOwnPropertyDescriptor(_target, property) {
			if (typeof property !== "string") return undefined;
			const headers = current();
			if (!Object.hasOwn(headers, property)) return undefined;
			return {
				configurable: true,
				enumerable: true,
				value: headers[property],
				writable: true,
			};
		},
	});
}

function resolveConfigHeaders(headers: Record<string, string> | undefined): Record<string, string> | undefined {
	return materializeConfigHeaderSources([headers]);
}

function extractGoogleOAuthToken(value: string | undefined): string | undefined {
	if (!isAuthenticated(value)) return undefined;
	try {
		const parsed = JSON.parse(value) as { token?: unknown };
		if (Object.hasOwn(parsed, "token")) {
			if (typeof parsed.token !== "string") {
				return undefined;
			}
			const token = parsed.token.trim();
			return token.length > 0 ? token : undefined;
		}
	} catch {}
	return value;
}

function getOAuthCredentialsForProvider(authStorage: AuthStorage, provider: string): OAuthCredential[] {
	const providerEntry = authStorage.getAll()[provider];
	if (!providerEntry) {
		return [];
	}
	const entries = Array.isArray(providerEntry) ? providerEntry : [providerEntry];
	return entries.filter((entry): entry is OAuthCredential => entry.type === "oauth");
}

function resolveOAuthAccountIdForAccessToken(
	authStorage: AuthStorage,
	provider: string,
	accessToken: string,
): string | undefined {
	const oauthCredentials = getOAuthCredentialsForProvider(authStorage, provider);
	const matchingCredential = oauthCredentials.find(credential => credential.access === accessToken);
	if (matchingCredential) {
		return matchingCredential.accountId;
	}
	if (oauthCredentials.length === 1) {
		return oauthCredentials[0].accountId;
	}
	return undefined;
}

function mergeCompat<TBase extends object, TOverride extends object>(
	baseCompat: TBase | null | undefined,
	overrideCompat: TOverride | null | undefined,
): (TBase & TOverride) | TBase | TOverride | undefined {
	if (!baseCompat) return overrideCompat ?? undefined;
	if (!overrideCompat) return baseCompat;

	const merged: Record<string, unknown> = { ...(baseCompat as Record<string, unknown>) };
	for (const [key, overrideValue] of Object.entries(overrideCompat)) {
		const baseValue = (baseCompat as Record<string, unknown>)[key];
		merged[key] =
			isRecord(baseValue) && isRecord(overrideValue) ? mergeCompat(baseValue, overrideValue) : overrideValue;
	}
	return merged as TBase & TOverride;
}

function toModelSpec<TApi extends Api>(model: Model<TApi>): ModelSpec<TApi> {
	return { ...model, compat: model.compatConfig } as ModelSpec<TApi>;
}

interface ModelPatch {
	name?: string;
	reasoning?: boolean;
	thinking?: ThinkingConfig;
	input?: ("text" | "image")[];
	supportsTools?: boolean;
	cost?: Partial<Model<Api>["cost"]>;
	contextWindow?: number;
	maxTokens?: number;
	omitMaxOutputTokens?: boolean;
	headers?: Record<string, string>;
	compat?: ModelSpec<Api>["compat"];
	contextPromotionTarget?: string;
	compactionModel?: string;
	premiumMultiplier?: number;
}

type ModelTransportPolicy = "merge" | "replace";

function applyModelPatch(base: Model<Api>, patch: ModelPatch, transport: ModelTransportPolicy): Model<Api> {
	const result = { ...base };
	if (patch.name !== undefined) result.name = patch.name;
	if (patch.reasoning !== undefined) result.reasoning = patch.reasoning;
	if (patch.thinking !== undefined) result.thinking = patch.thinking;
	if (patch.input !== undefined) result.input = patch.input;
	if (patch.supportsTools !== undefined) result.supportsTools = patch.supportsTools;
	if (patch.contextWindow !== undefined) result.contextWindow = patch.contextWindow;
	if (patch.maxTokens !== undefined) result.maxTokens = patch.maxTokens;
	if (patch.omitMaxOutputTokens !== undefined) result.omitMaxOutputTokens = patch.omitMaxOutputTokens;
	if (patch.contextPromotionTarget !== undefined) result.contextPromotionTarget = patch.contextPromotionTarget;
	if (patch.compactionModel !== undefined) result.compactionModel = patch.compactionModel;
	if (patch.premiumMultiplier !== undefined) result.premiumMultiplier = patch.premiumMultiplier;
	if (patch.cost) {
		result.cost = {
			input: patch.cost.input ?? base.cost.input,
			output: patch.cost.output ?? base.cost.output,
			cacheRead: patch.cost.cacheRead ?? base.cost.cacheRead,
			cacheWrite: patch.cost.cacheWrite ?? base.cost.cacheWrite,
		};
	}
	let compat: ModelSpec<Api>["compat"];
	if (transport === "merge") {
		if (patch.headers) {
			result.headers = { ...base.headers, ...patch.headers };
		}
		compat = mergeCompat(base.compatConfig, patch.compat);
	} else {
		result.headers = patch.headers;
		compat = patch.compat;
	}
	return buildModel({ ...result, compat } as ModelSpec<Api>);
}

function applyModelOverride(model: Model<Api>, override: ModelOverride): Model<Api> {
	return applyModelPatch(model, override as ModelPatch, "merge");
}

interface CustomModelDefinitionLike extends ModelPatch {
	id: string;
	api?: Api;
	baseUrl?: string;
	cost?: Model<Api>["cost"];
}

interface CustomModelBuildOptions {
	useDefaults: boolean;
}

interface CustomModelOverlay extends ModelPatch {
	id: string;
	provider: string;
	api: Api;
	baseUrl: string;
	cost?: Model<Api>["cost"];
	isOAuth?: boolean;
}

function mergeCustomModelHeaders(
	providerHeaders: Record<string, string> | undefined,
	modelHeaders: Record<string, string> | undefined,
	authHeader: boolean | undefined,
	apiKeyConfig: string | undefined,
): Record<string, string> | undefined {
	return createLiveConfigHeaders([providerHeaders, modelHeaders], { authHeader, apiKeyConfig });
}

function mergeAuthHeaderSources(
	sources: readonly HeaderSource[],
	authHeader: boolean | undefined,
	apiKeyConfig: string | undefined,
): Record<string, string> | undefined {
	return createLiveConfigHeaders(sources, { authHeader, apiKeyConfig });
}

function resolveCustomModelIsOAuth(api: Api, providerAuth: ProviderAuthMode | undefined): boolean | undefined {
	if (providerAuth === "oauth") return true;
	if (providerAuth !== undefined) return undefined;
	if (api === "anthropic-messages") return true;
	return undefined;
}

function buildCustomModelOverlay(
	providerName: string,
	providerBaseUrl: string,
	providerApi: Api | undefined,
	providerHeaders: Record<string, string> | undefined,
	providerApiKey: string | undefined,
	authHeader: boolean | undefined,
	providerCompat: ModelSpec<Api>["compat"] | undefined,
	providerAuth: ProviderAuthMode | undefined,
	modelDef: CustomModelDefinitionLike,
): CustomModelOverlay | undefined {
	const api = modelDef.api ?? providerApi;
	if (!api) return undefined;
	return {
		id: modelDef.id,
		provider: providerName,
		api,
		baseUrl: modelDef.baseUrl ?? providerBaseUrl,
		name: modelDef.name,
		reasoning: modelDef.reasoning,
		thinking: modelDef.thinking,
		input: modelDef.input,
		supportsTools: modelDef.supportsTools,
		cost: modelDef.cost,
		contextWindow: modelDef.contextWindow,
		maxTokens: modelDef.maxTokens,
		omitMaxOutputTokens: modelDef.omitMaxOutputTokens,
		headers: mergeCustomModelHeaders(providerHeaders, modelDef.headers, authHeader, providerApiKey),
		compat: mergeCompat(providerCompat, modelDef.compat),
		contextPromotionTarget: modelDef.contextPromotionTarget,
		compactionModel: modelDef.compactionModel,
		premiumMultiplier: modelDef.premiumMultiplier,
		isOAuth: resolveCustomModelIsOAuth(api, providerAuth),
	};
}

function applyStandaloneCustomModelPolicies(model: CustomModelOverlay): CustomModelOverlay {
	if (model.id !== "gpt-5.4" || model.provider === "github-copilot" || model.contextWindow !== undefined) {
		return model;
	}
	return { ...model, contextWindow: 1_000_000 };
}

function finalizeCustomModel(model: CustomModelOverlay, options: CustomModelBuildOptions): Model<Api> {
	const resolvedModel = options.useDefaults ? applyStandaloneCustomModelPolicies(model) : model;
	const reference = options.useDefaults
		? resolveModelReference(resolvedModel.id, getBundledModelReferenceIndex())
		: undefined;
	const cost =
		resolvedModel.cost ??
		reference?.cost ??
		(options.useDefaults ? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } : undefined);
	const input = resolvedModel.input ?? reference?.input ?? (options.useDefaults ? ["text"] : undefined);
	const supportsTools = resolvedModel.supportsTools ?? reference?.supportsTools;
	return buildModel({
		id: resolvedModel.id,
		name: resolvedModel.name ?? (options.useDefaults ? resolvedModel.id : undefined),
		api: resolvedModel.api,
		provider: resolvedModel.provider,
		baseUrl: resolvedModel.baseUrl,
		reasoning: resolvedModel.reasoning ?? reference?.reasoning ?? (options.useDefaults ? false : undefined),
		thinking: resolvedModel.thinking ?? reference?.thinking,
		input: input as ("text" | "image")[],
		...(supportsTools !== undefined ? { supportsTools } : {}),
		cost,
		contextWindow: resolvedModel.contextWindow ?? reference?.contextWindow ?? (options.useDefaults ? 128000 : null),
		maxTokens: resolvedModel.maxTokens ?? reference?.maxTokens ?? (options.useDefaults ? 16384 : null),
		headers: resolvedModel.headers,
		omitMaxOutputTokens: resolvedModel.omitMaxOutputTokens ?? reference?.omitMaxOutputTokens,
		compat: mergeCompat(reference?.compatConfig, resolvedModel.compat),
		contextPromotionTarget: resolvedModel.contextPromotionTarget,
		compactionModel: resolvedModel.compactionModel,
		premiumMultiplier: resolvedModel.premiumMultiplier,
		isOAuth: resolvedModel.isOAuth,
	} as ModelSpec<Api>);
}

function normalizeSuppressedSelector(
	selector: string,
	hasLiveModel?: (provider: string, id: string) => boolean,
): string {
	const trimmed = selector.trim();
	if (!trimmed) return trimmed;
	const parsed = parseModelString(trimmed, {
		allowMaxSuffix: true,
		allowAutoAlias: true,
		isLiteralModelId: (provider, id) => hasLiveModel?.(provider, id) === true,
	});
	if (!parsed) return trimmed;
	const aliasId = resolveVariantAlias(parsed.provider, parsed.id);
	return `${parsed.provider}/${aliasId ?? parsed.id}`;
}

function resolveModelOverrideWithAliases(
	overrides: Map<string, ModelOverride>,
	model: Model<Api>,
	hasLiveModel: (provider: string, id: string) => boolean,
): ModelOverride | undefined {
	const direct = overrides.get(model.id);
	if (direct) return direct;
	for (const rawId of getVariantAliasSources(model.provider, model.id)) {
		if (hasLiveModel(model.provider, rawId)) continue;
		const remapped = overrides.get(rawId);
		if (remapped) {
			logger.debug("model override re-keyed through variant alias", {
				provider: model.provider,
				from: rawId,
				to: model.id,
			});
			return remapped;
		}
	}
	return undefined;
}

function getDisabledProviderIdsFromSettings(): Set<string> {
	try {
		return new Set(settings.get("disabledProviders"));
	} catch {
		return new Set();
	}
}

const REGISTRY_SNAPSHOT_VERSION = 5;

interface StaticModelStage {
	createdAt: number;
	builtIn: Model<Api>[];
	cachedStandard: { models: Model<Api>[]; authoritativeFreshProviders: string[] };
	cachedDiscoveries: Model<Api>[];
	discoveryStates: ProviderDiscoveryState[];
}

interface RestoredStaticStage {
	builtIn: Model<Api>[];
	cachedStandard: { models: Model<Api>[]; authoritativeFreshProviders: Set<string> };
	cachedDiscoveries: Model<Api>[];
	discoveryStates: ProviderDiscoveryState[];
}

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

		const staticFingerprint = this.#staticModelStageFingerprint();
		const restored = this.#snapshotIo ? this.#readStaticModelStage(staticFingerprint) : null;
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
				this.#writeStaticModelStage(staticFingerprint, {
					createdAt: Date.now(),
					builtIn: builtInModels,
					cachedStandard: {
						models: cachedStandardModels,
						authoritativeFreshProviders: Array.from(authoritativeFreshProviders),
					},
					cachedDiscoveries,
					discoveryStates: Array.from(this.#providerDiscoveryStates.values()),
				});
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

	#staticModelStageFingerprint(): string {
		const dbPath = this.#cacheDbPath ?? getModelDbPath();
		const parts: Array<string | number> = [
			REGISTRY_SNAPSHOT_VERSION,
			bundledCatalogDigest(),
			modelCacheStamp(dbPath, { ttlMs: DAY_MS }),
			this.#modelsConfigFile.getMtimeMs() ?? 0,
		];
		const customConfigDigest = createHash("sha256")
			.update(
				JSON.stringify({
					overlays: this.#customModelOverlays,
					overrides: Array.from(this.#providerOverrides),
					modelOverrides: Array.from(this.#modelOverrides, ([provider, perModel]) => [
						provider,
						Array.from(perModel),
					]),
					keyless: Array.from(this.#keylessProviders),
					discoverable: this.#discoverableProviders,
				}),
			)
			.digest("hex");
		parts.push(customConfigDigest);
		return parts.join(":");
	}

	#staticModelStagePath(): string {
		return path.join(path.dirname(this.#cacheDbPath ?? getModelDbPath()), "resolved-models.json");
	}

	#readStaticModelStage(fingerprint: string): RestoredStaticStage | null {
		try {
			const parsed: unknown = JSON.parse(fs.readFileSync(this.#staticModelStagePath(), "utf8"));
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
			const builtIn = this.#snapshotModelArray(stage.builtIn);
			const cachedStandard = this.#snapshotModelArray(stage.cachedStandard.models);
			const cachedDiscoveries = this.#snapshotModelArray(stage.cachedDiscoveries);
			if (!builtIn || !cachedStandard || !cachedDiscoveries) return null;
			if (!Array.isArray(stage.cachedStandard.authoritativeFreshProviders)) return null;
			const authoritativeFreshProviders = stage.cachedStandard.authoritativeFreshProviders.filter(
				(provider): provider is string => typeof provider === "string",
			);
			if (authoritativeFreshProviders.length !== stage.cachedStandard.authoritativeFreshProviders.length)
				return null;
			const discoveryStates = this.#snapshotDiscoveryStateArray(stage.discoveryStates);
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

	#writeStaticModelStage(fingerprint: string, stage: StaticModelStage): void {
		try {
			const stageDigest = createHash("sha256").update(JSON.stringify(stage)).digest("hex");
			atomicWriteFileSync(this.#staticModelStagePath(), JSON.stringify({ fingerprint, stageDigest, stage }));
		} catch (error) {
			logger.debug("Static model stage snapshot not written", { error: errorMessage(error) });
		}
	}

	#snapshotModelArray(value: unknown): Model<Api>[] | null {
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

	#snapshotDiscoveryStateArray(value: unknown): ProviderDiscoveryState[] | null {
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
			states.push(entry as unknown as ProviderDiscoveryState);
		}
		return states;
	}

	#loadBuiltInModels(overrides: Map<string, ProviderOverride>): Model<Api>[] {
		return getBundledProviders().flatMap(provider => {
			const models = getBundledModels(provider as Parameters<typeof getBundledModels>[0]) as Model<Api>[];
			const providerOverride = overrides.get(provider);

			return models.map(m => {
				if (!providerOverride) return m;
				const withTransportOverride = this.#applyProviderTransportOverride(m, providerOverride);
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
				? models.map(model => this.#applyProviderTransportOverride(model, providerOverride))
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
		} else if (status === "not-found") {
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

		const overrides = new Map<string, ProviderOverride>();
		const allModelOverrides = new Map<string, Map<string, ModelOverride>>();
		const keylessProviders = new Set<string>();
		const discoverableProviders: DiscoveryProviderConfig[] = [];
		const providerEntries = Object.entries(value.providers ?? {});
		const configuredProviders = new Set(Object.keys(value.providers ?? {}));
		for (const [providerName, providerConfig] of providerEntries) {
			const resolvedProviderHeaders = resolveConfigHeaders(providerConfig.headers);
			if (
				providerConfig.baseUrl ||
				resolvedProviderHeaders ||
				providerConfig.apiKey ||
				providerConfig.authHeader !== undefined ||
				providerConfig.compat ||
				providerConfig.disableStrictTools ||
				providerConfig.transport
			) {
				const disableStrictCompat = providerConfig.disableStrictTools ? { disableStrictTools: true } : undefined;
				overrides.set(providerName, {
					baseUrl:
						providerConfig.discovery?.type === "litellm"
							? normalizeLiteLLMDiscoveryBaseUrl(providerConfig.baseUrl)
							: providerConfig.baseUrl,
					headers: resolvedProviderHeaders,
					apiKey: providerConfig.apiKey,
					authHeader: providerConfig.authHeader,
					compat: mergeCompat(providerConfig.compat, disableStrictCompat),
					transport: providerConfig.transport,
				});
			}

			const authMode = (providerConfig.auth ?? "apiKey") as ProviderAuthMode;
			if (authMode === "none") {
				keylessProviders.add(providerName);
			}

			if (providerConfig.discovery && (providerConfig.api || providerConfig.discovery.type === "proxy")) {
				const disableStrictCompat = providerConfig.disableStrictTools ? { disableStrictTools: true } : undefined;
				discoverableProviders.push({
					provider: providerName,
					api: (providerConfig.api ?? "openai-completions") as Api,
					baseUrl: providerConfig.baseUrl,
					headers: resolvedProviderHeaders,
					compat: mergeCompat(providerConfig.compat, disableStrictCompat),
					discovery: providerConfig.discovery,
					optional: false,
				});
			}

			if (providerConfig.apiKey) {
				this.#installProviderApiKey(providerName, providerConfig.apiKey);
			}

			if (providerConfig.modelOverrides) {
				const perModel = new Map<string, ModelOverride>();
				for (const [modelId, override] of Object.entries(providerConfig.modelOverrides)) {
					perModel.set(
						modelId,
						override.headers ? { ...override, headers: resolveConfigHeaders(override.headers) } : override,
					);
				}
				allModelOverrides.set(providerName, perModel);
			}
		}

		return {
			models: this.#parseModels(value),
			overrides,
			modelOverrides: allModelOverrides,
			keylessProviders,
			discoverableProviders,
			configuredProviders,
			found: true,
		};
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
		const managerOptions = await this.#collectBuiltInModelManagerOptions(
			strategy,
			providerFilter,
			configuredDiscoveryProviders,
		);
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

	async #collectBuiltInModelManagerOptions(
		strategy: ModelRefreshStrategy,
		providerFilter: ReadonlySet<string> | undefined,
		configuredDiscoveryProviders: ReadonlySet<string>,
	): Promise<ModelManagerOptions<Api>[]> {
		const specialProviderDescriptors: Array<{
			providerId: string;
			resolveKey: (value: string | undefined) => string | undefined;
			createOptions: (key: string) => ModelManagerOptions<Api>;
		}> = [
			{
				providerId: "google-antigravity",
				resolveKey: extractGoogleOAuthToken,
				createOptions: oauthToken =>
					googleAntigravityModelManagerOptions({
						oauthToken,
						endpoint: this.getProviderBaseUrl("google-antigravity"),
						fetch: this.#fetch,
					}),
			},
			{
				providerId: "google-gemini-cli",
				resolveKey: extractGoogleOAuthToken,
				createOptions: oauthToken =>
					googleGeminiCliModelManagerOptions({
						oauthToken,
						endpoint: this.getProviderBaseUrl("google-gemini-cli"),
						fetch: this.#fetch,
					}),
			},
			{
				providerId: "openai-codex",
				resolveKey: value => value,
				createOptions: accessToken => {
					const accountId = resolveOAuthAccountIdForAccessToken(this.authStorage, "openai-codex", accessToken);
					return openaiCodexModelManagerOptions({
						accessToken,
						accountId,
					});
				},
			},
		];
		const disabledProviders = getDisabledProviderIdsFromSettings();
		const standardProviderDescriptors = PROVIDER_DESCRIPTORS.filter(descriptor => {
			if (disabledProviders.has(descriptor.providerId)) return false;
			if (configuredDiscoveryProviders.has(descriptor.providerId)) return false;
			return providerFilter ? providerFilter.has(descriptor.providerId) : true;
		});
		const enabledSpecialProviderDescriptors = specialProviderDescriptors.filter(descriptor => {
			if (disabledProviders.has(descriptor.providerId)) return false;
			if (configuredDiscoveryProviders.has(descriptor.providerId)) return false;
			return providerFilter ? providerFilter.has(descriptor.providerId) : true;
		});
		const standardProviderKeys = await Promise.all(
			standardProviderDescriptors.map(descriptor => {
				const discoveryBaseUrl =
					this.#runtimeProviderOverrides.get(descriptor.providerId)?.baseUrl ??
					this.#providerOverrides.get(descriptor.providerId)?.baseUrl ??
					this.getProviderBaseUrl(descriptor.providerId);
				const cacheProviderId =
					descriptor.createModelManagerOptions({ baseUrl: discoveryBaseUrl, fetch: this.#fetch })
						.cacheProviderId ?? descriptor.providerId;
				return this.#resolveBuiltInDiscoveryApiKey(descriptor.providerId, strategy, cacheProviderId);
			}),
		);
		const specialKeys = await Promise.all(
			enabledSpecialProviderDescriptors.map(descriptor =>
				this.#resolveBuiltInDiscoveryApiKey(descriptor.providerId, strategy, descriptor.providerId),
			),
		);
		const options: ModelManagerOptions<Api>[] = [];
		for (let i = 0; i < standardProviderDescriptors.length; i++) {
			const descriptor = standardProviderDescriptors[i];
			const apiKey = standardProviderKeys[i];
			const hasExplicitVllmConfig =
				descriptor.providerId === "vllm" &&
				(this.#runtimeProviderOverrides.has(descriptor.providerId) ||
					this.#providerOverrides.has(descriptor.providerId) ||
					this.#keylessProviders.has(descriptor.providerId));
			if (isAuthenticated(apiKey) || descriptor.allowUnauthenticated || hasExplicitVllmConfig) {
				const discoveryBaseUrl =
					this.#runtimeProviderOverrides.get(descriptor.providerId)?.baseUrl ??
					this.#providerOverrides.get(descriptor.providerId)?.baseUrl ??
					this.getProviderBaseUrl(descriptor.providerId);
				options.push(
					descriptor.createModelManagerOptions({
						apiKey: isDiscoveryBearerApiKey(apiKey) ? apiKey : undefined,
						baseUrl: discoveryBaseUrl,
						fetch: this.#fetch,
					}),
				);
			}
		}

		for (let i = 0; i < enabledSpecialProviderDescriptors.length; i++) {
			const descriptor = enabledSpecialProviderDescriptors[i];
			const key = descriptor.resolveKey(specialKeys[i]);
			if (!isAuthenticated(key)) {
				continue;
			}
			options.push(descriptor.createOptions(key));
		}
		for (const { options: managerOpts } of this.#runtimeModelManagers.values()) {
			if (
				!configuredDiscoveryProviders.has(managerOpts.providerId) &&
				(!providerFilter || providerFilter.has(managerOpts.providerId))
			) {
				options.push(managerOpts);
			}
		}
		return options;
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
				? createLiveConfigHeaders([baseOverride?.headers, override.headers])
				: baseOverride?.headers,
			compat: override.compat ? mergeCompat(baseOverride?.compat, override.compat) : baseOverride?.compat,
			transport: override.transport ?? baseOverride?.transport,
		};
	}
	#applyProviderTransportOverride<T extends { baseUrl?: string; headers?: Record<string, string> }>(
		entry: T,
		override: Pick<ProviderOverride, "baseUrl" | "headers" | "authHeader" | "apiKey" | "transport">,
	): T {
		const headers = mergeAuthHeaderSources(
			override.headers ? [entry.headers, override.headers] : [entry.headers],
			override.authHeader,
			override.apiKey,
		);
		return {
			...entry,
			baseUrl: override.baseUrl ?? entry.baseUrl,
			headers,
			...(override.transport !== undefined ? { transport: override.transport } : {}),
		};
	}
	#applyRuntimeProviderOverrides(models: Model<Api>[]): Model<Api>[] {
		if (this.#runtimeProviderOverrides.size === 0) return models;
		return models.map(model => {
			const override = this.#runtimeProviderOverrides.get(model.provider);
			if (!override) return model;
			return this.#applyProviderTransportOverride(model, override);
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

	#parseModels(config: ModelsConfig): CustomModelOverlay[] {
		const models: CustomModelOverlay[] = [];
		for (const [providerName, providerConfig] of Object.entries(config.providers ?? {})) {
			const modelDefs = providerConfig.models ?? [];
			if (modelDefs.length === 0) continue; // Override-only, no custom models
			const resolvedProviderHeaders = resolveConfigHeaders(providerConfig.headers);
			if (providerConfig.apiKey) {
				this.#installProviderApiKey(providerName, providerConfig.apiKey);
			}
			for (const modelDef of modelDefs) {
				const providerCompat = providerConfig.disableStrictTools
					? mergeCompat(providerConfig.compat, { disableStrictTools: true })
					: providerConfig.compat;
				const model = buildCustomModelOverlay(
					providerName,
					providerConfig.baseUrl!,
					providerConfig.api as Api | undefined,
					resolvedProviderHeaders,
					providerConfig.apiKey,
					providerConfig.authHeader,
					providerCompat,
					(providerConfig.auth as ProviderAuthMode | undefined) ?? undefined,
					modelDef as CustomModelDefinitionLike,
				);
				if (!model) continue;
				models.push(model);
			}
		}
		return models;
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
			const newOverlays: CustomModelOverlay[] = [];
			for (const modelDef of config.models) {
				const overlay = buildCustomModelOverlay(
					providerName,
					config.baseUrl!,
					config.api,
					config.headers,
					config.apiKey,
					config.authHeader,
					config.compat,
					undefined,
					modelDef as CustomModelDefinitionLike,
				);
				if (!overlay) {
					throw new Error(`Provider ${providerName}, model ${modelDef.id}: no "api" specified.`);
				}
				newOverlays.push(overlay);
			}
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
						return this.#applyProviderTransportOverride(model, runtimeTransportOverride);
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
			const fetcher = config.fetchDynamicModels;
			const providerBaseUrl = config.baseUrl ?? "";
			const providerApi = config.api;
			const providerHeaders = config.headers;
			const providerApiKey = config.apiKey;
			const providerAuthHeader = config.authHeader;
			const providerCompat = config.compat;
			const managerOptions: ModelManagerOptions<Api> = {
				providerId: providerName as Parameters<typeof createModelManager>[0]["providerId"],
				staticModels: [],
				cacheDbPath: this.#cacheDbPath,
				cacheTtlMs: DAY_MS,
				dynamicModelsAuthoritative: true,
				fetchDynamicModels: async () => {
					const apiKey = await this.#peekApiKeyForProvider(providerName);
					const resolvedKey = isAuthenticated(apiKey) ? apiKey : undefined;
					const modelDefs = await withRuntimeDynamicModelsTimeout(RUNTIME_DYNAMIC_MODEL_FETCH_TIMEOUT_MS, () =>
						fetcher(resolvedKey),
					);
					const results: Model<Api>[] = [];
					for (const modelDef of modelDefs) {
						const overlay = buildCustomModelOverlay(
							providerName,
							modelDef.baseUrl ?? providerBaseUrl,
							modelDef.api ?? providerApi,
							providerHeaders,
							providerApiKey,
							providerAuthHeader,
							providerCompat,
							undefined,
							modelDef as CustomModelDefinitionLike,
						);
						if (overlay) results.push(finalizeCustomModel(overlay, { useDefaults: true }));
					}
					return results.map(toModelSpec);
				},
			};
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
				return this.#applyProviderTransportOverride(m, transportOverride);
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

export interface ProviderConfigInput {
	baseUrl?: string;
	apiKey?: string;
	api?: Api;
	streamSimple?: (model: Model<Api>, context: Context, options?: SimpleStreamOptions) => AssistantMessageEventStream;
	headers?: Record<string, string>;
	compat?: ModelSpec<Api>["compat"];
	authHeader?: boolean;
	transport?: Model<Api>["transport"];
	oauth?: {
		name: string;
		login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials | string>;
		refreshToken?(credentials: OAuthCredentials): Promise<OAuthCredentials>;
		getApiKey?(credentials: OAuthCredentials): string;
		modifyModels?(models: Model<Api>[], credentials: OAuthCredentials): Model<Api>[];
	};
	fetchDynamicModels?: (
		apiKey: string | undefined,
	) => Promise<readonly NonNullable<ProviderConfigInput["models"]>[number][]>;
	models?: Array<{
		id: string;
		name: string;
		api?: Api;
		baseUrl?: string;
		reasoning: boolean;
		thinking?: ThinkingConfig;
		input: ("text" | "image")[];
		supportsTools?: boolean;
		cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
		contextWindow: number;
		maxTokens: number;
		headers?: Record<string, string>;
		compat?: ModelSpec<Api>["compat"];
		contextPromotionTarget?: string;
		compactionModel?: string;
		premiumMultiplier?: number;
	}>;
}
