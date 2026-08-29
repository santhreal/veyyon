import type { Api, Model, ModelSpec } from "@veyyon/ai/types";
import { buildModel } from "@veyyon/catalog/build";
import { isVertexExpressOpenAIUrl } from "@veyyon/catalog/hosts";
import { PROVIDER_DESCRIPTORS } from "@veyyon/catalog/provider-models";
import { HOUR_MS } from "@veyyon/utils";
import { isAuthenticated } from "./auth-state";
import type { ConfigError } from "./config-file";
import {
	type DiscoveryProviderConfig,
	getImplicitOllamaBaseUrl,
	normalizeLiteLLMDiscoveryBaseUrl,
} from "./model-discovery";
import {
	buildCustomModelOverlay,
	type CustomModelDefinitionLike,
	type CustomModelOverlay,
	type ProviderOverride,
} from "./model-registry-overrides";
import { mergeCompat, resolveConfigHeaders } from "./model-registry-resolution";
import type { ModelOverride, ModelsConfig, ProviderAuthMode } from "./models-config-schema";

export const SPECIAL_MODEL_MANAGER_PROVIDER_IDS: readonly string[] = [
	"google-antigravity",
	"google-gemini-cli",
	"openai-codex",
];

export const STARTUP_MODEL_CACHE_PROVIDER_IDS: readonly string[] = [
	...PROVIDER_DESCRIPTORS.map(descriptor => descriptor.providerId),
	...SPECIAL_MODEL_MANAGER_PROVIDER_IDS,
];

export const LOCAL_PROVIDER_PLACEHOLDERS = new Set<string>(["llama-cpp-local", "lm-studio-local", "vllm-local"]);

export const RUNTIME_DYNAMIC_MODEL_FETCH_TIMEOUT_MS = 15_000;
export const BUILT_IN_DISCOVERY_CACHE_TTL_MS = 2 * HOUR_MS;
export const BUILT_IN_DISCOVERY_NON_AUTHORITATIVE_RETRY_MS = 5 * 60 * 1000;

export function isDiscoveryBearerApiKey(apiKey: string | undefined | null): apiKey is string {
	return isAuthenticated(apiKey) && !LOCAL_PROVIDER_PLACEHOLDERS.has(apiKey);
}

export interface ImplicitLocalRuntime {
	readonly provider: string;
	readonly api: Api;
	readonly baseUrl: () => string;
	readonly discovery: "ollama" | "llama.cpp" | "lm-studio";
	readonly keyless: "always" | "unless-authenticated";
}

export const IMPLICIT_LOCAL_RUNTIMES: readonly ImplicitLocalRuntime[] = [
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

export function isLoopbackUrl(url: string | undefined): boolean {
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

export function isConnectionRefusalError(error: string): boolean {
	return /unable to connect|econnrefused|connection refused|ehostunreach|enetunreach|econnreset|failed to connect/i.test(
		error,
	);
}

export async function withRuntimeDynamicModelsTimeout<T>(timeoutMs: number, run: () => Promise<T>): Promise<T> {
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

export const AUTHORITATIVE_RUNTIME_CATALOG_PROVIDERS = new Set<string>(
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

export function providersWithAuthoritativeProjectCatalog(models: readonly Model<Api>[]): Set<string> {
	const providers = new Set<string>();
	for (const model of models) {
		if (isAuthoritativeProjectCatalogModel(model)) {
			providers.add(model.provider);
		}
	}
	return providers;
}

export function dropProviderModels(models: readonly Model<Api>[], providers: ReadonlySet<string>): Model<Api>[] {
	return models.filter(model => !providers.has(model.provider));
}

export function mergeByModelKey<T extends { provider: string; id: string }>(
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

export interface BuiltInDiscoveryResult {
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

export const PROVIDER_DISCOVERY_STATUSES: ReadonlySet<string> = new Set<ProviderDiscoveryStatus>([
	"idle",
	"ok",
	"empty",
	"cached",
	"unavailable",
	"unauthenticated",
]);

export interface CustomModelsResult {
	models?: CustomModelOverlay[];
	overrides?: Map<string, ProviderOverride>;
	modelOverrides?: Map<string, Map<string, ModelOverride>>;
	keylessProviders?: Set<string>;
	discoverableProviders?: DiscoveryProviderConfig[];
	configuredProviders?: Set<string>;
	error?: ConfigError;
	found: boolean;
}

export function parseCustomModelsConfig(
	config: ModelsConfig,
	onInstallApiKey: (provider: string, apiKey: string) => void,
): CustomModelsResult {
	const overrides = new Map<string, ProviderOverride>();
	const allModelOverrides = new Map<string, Map<string, ModelOverride>>();
	const keylessProviders = new Set<string>();
	const discoverableProviders: DiscoveryProviderConfig[] = [];
	const providerEntries = Object.entries(config.providers ?? {});
	const configuredProviders = new Set(Object.keys(config.providers ?? {}));
	const models: CustomModelOverlay[] = [];

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
			onInstallApiKey(providerName, providerConfig.apiKey);
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

		const modelDefs = providerConfig.models ?? [];
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
			if (model) models.push(model);
		}
	}

	return {
		models,
		overrides,
		modelOverrides: allModelOverrides,
		keylessProviders,
		discoverableProviders,
		configuredProviders,
		found: true,
	};
}
