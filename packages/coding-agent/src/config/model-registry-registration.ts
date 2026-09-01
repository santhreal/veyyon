import type { FetchImpl } from "@veyyon/ai";
import type { OAuthCredentials, OAuthLoginCallbacks } from "@veyyon/ai/oauth/types";
import type { Api, Context, Model, ModelSpec, SimpleStreamOptions, ThinkingConfig } from "@veyyon/ai/types";
import type { AssistantMessageEventStream } from "@veyyon/ai/utils/event-stream";
import type { createModelManager, ModelManagerOptions, ModelRefreshStrategy } from "@veyyon/catalog/model-manager";
import {
	googleAntigravityModelManagerOptions,
	googleGeminiCliModelManagerOptions,
	openaiCodexModelManagerOptions,
	PROVIDER_DESCRIPTORS,
} from "@veyyon/catalog/provider-models";
import { DAY_MS } from "@veyyon/utils";
import type { AuthStorage } from "../session/auth-storage";
import { isAuthenticated } from "./auth-state";
import {
	isDiscoveryBearerApiKey,
	RUNTIME_DYNAMIC_MODEL_FETCH_TIMEOUT_MS,
	withRuntimeDynamicModelsTimeout,
} from "./model-registry-discovery";
import {
	buildCustomModelOverlay,
	type CustomModelDefinitionLike,
	type CustomModelOverlay,
	finalizeCustomModel,
	type ProviderOverride,
} from "./model-registry-overrides";
import { extractGoogleOAuthToken, resolveOAuthAccountIdForAccessToken, toModelSpec } from "./model-registry-resolution";

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

export function buildRuntimeModelOverlays(providerName: string, config: ProviderConfigInput): CustomModelOverlay[] {
	if (!config.models || config.models.length === 0) return [];
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
	return newOverlays;
}

export function createDynamicModelManagerOptions(params: {
	providerName: string;
	config: ProviderConfigInput;
	cacheDbPath?: string;
	peekApiKey: (provider: string) => Promise<string | undefined>;
}): ModelManagerOptions<Api> {
	const { providerName, config, cacheDbPath, peekApiKey } = params;
	const fetcher = config.fetchDynamicModels!;
	const providerBaseUrl = config.baseUrl ?? "";
	const providerApi = config.api;
	const providerHeaders = config.headers;
	const providerApiKey = config.apiKey;
	const providerAuthHeader = config.authHeader;
	const providerCompat = config.compat;

	return {
		providerId: providerName as Parameters<typeof createModelManager>[0]["providerId"],
		staticModels: [],
		cacheDbPath,
		cacheTtlMs: DAY_MS,
		dynamicModelsAuthoritative: true,
		fetchDynamicModels: async () => {
			const apiKey = await peekApiKey(providerName);
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
}

export async function collectBuiltInModelManagerOptions(params: {
	strategy: ModelRefreshStrategy;
	providerFilter: ReadonlySet<string> | undefined;
	configuredDiscoveryProviders: ReadonlySet<string>;
	disabledProviders: ReadonlySet<string>;
	runtimeProviderOverrides: Map<string, ProviderOverride>;
	providerOverrides: Map<string, ProviderOverride>;
	keylessProviders: Set<string>;
	runtimeModelManagers: Map<string, { options: ModelManagerOptions<Api>; sourceId: string }>;
	fetch: FetchImpl;
	authStorage: AuthStorage;
	getProviderBaseUrl: (provider: string) => string | undefined;
	resolveBuiltInApiKey: (
		providerId: string,
		strategy: ModelRefreshStrategy,
		cacheProviderId: string,
	) => Promise<string | undefined>;
}): Promise<ModelManagerOptions<Api>[]> {
	const {
		strategy,
		providerFilter,
		configuredDiscoveryProviders,
		disabledProviders,
		runtimeProviderOverrides,
		providerOverrides,
		keylessProviders,
		runtimeModelManagers,
		fetch,
		authStorage,
		getProviderBaseUrl,
		resolveBuiltInApiKey,
	} = params;

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
					endpoint: getProviderBaseUrl("google-antigravity"),
					fetch,
				}),
		},
		{
			providerId: "google-gemini-cli",
			resolveKey: extractGoogleOAuthToken,
			createOptions: oauthToken =>
				googleGeminiCliModelManagerOptions({
					oauthToken,
					endpoint: getProviderBaseUrl("google-gemini-cli"),
					fetch,
				}),
		},
		{
			providerId: "openai-codex",
			resolveKey: value => value,
			createOptions: accessToken => {
				const accountId = resolveOAuthAccountIdForAccessToken(authStorage, "openai-codex", accessToken);
				return openaiCodexModelManagerOptions({
					accessToken,
					accountId,
				});
			},
		},
	];

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
				runtimeProviderOverrides.get(descriptor.providerId)?.baseUrl ??
				providerOverrides.get(descriptor.providerId)?.baseUrl ??
				getProviderBaseUrl(descriptor.providerId);
			const cacheProviderId =
				descriptor.createModelManagerOptions({ baseUrl: discoveryBaseUrl, fetch }).cacheProviderId ??
				descriptor.providerId;
			return resolveBuiltInApiKey(descriptor.providerId, strategy, cacheProviderId);
		}),
	);
	const specialKeys = await Promise.all(
		enabledSpecialProviderDescriptors.map(descriptor =>
			resolveBuiltInApiKey(descriptor.providerId, strategy, descriptor.providerId),
		),
	);
	const options: ModelManagerOptions<Api>[] = [];
	for (let i = 0; i < standardProviderDescriptors.length; i++) {
		const descriptor = standardProviderDescriptors[i];
		const apiKey = standardProviderKeys[i];
		const hasExplicitVllmConfig =
			descriptor.providerId === "vllm" &&
			(runtimeProviderOverrides.has(descriptor.providerId) ||
				providerOverrides.has(descriptor.providerId) ||
				keylessProviders.has(descriptor.providerId));
		if (isAuthenticated(apiKey) || descriptor.allowUnauthenticated || hasExplicitVllmConfig) {
			const discoveryBaseUrl =
				runtimeProviderOverrides.get(descriptor.providerId)?.baseUrl ??
				providerOverrides.get(descriptor.providerId)?.baseUrl ??
				getProviderBaseUrl(descriptor.providerId);
			options.push(
				descriptor.createModelManagerOptions({
					apiKey: isDiscoveryBearerApiKey(apiKey) ? apiKey : undefined,
					baseUrl: discoveryBaseUrl,
					fetch,
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
	for (const { options: managerOpts } of runtimeModelManagers.values()) {
		if (
			!configuredDiscoveryProviders.has(managerOpts.providerId) &&
			(!providerFilter || providerFilter.has(managerOpts.providerId))
		) {
			options.push(managerOpts);
		}
	}
	return options;
}
