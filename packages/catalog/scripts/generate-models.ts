#!/usr/bin/env bun

const COPILOT_PREMIUM_MULTIPLIERS: Record<string, number> = {
	"github-copilot/claude-haiku-4.5": 0.33,
	"github-copilot/claude-opus-4.6": 3,
	"github-copilot/gpt-4o": 0,
	"github-copilot/gpt-5.4-mini": 0.33,
	"github-copilot/grok-code-fast-1": 0.25,
};

import { Database } from "bun:sqlite";
import * as path from "node:path";
import { discoverAuthStorage } from "@veyyon/ai/auth-broker/discover";
import type { OAuthAccess } from "@veyyon/ai/auth-storage";
import type { OAuthProvider } from "@veyyon/ai/oauth/types";
import { getGitLabDuoModels } from "@veyyon/ai/providers/gitlab-duo";
import { $env, getSharedAuthDir } from "@veyyon/utils";
import { ANTIGRAVITY_PRIMARY_ENDPOINT, fetchAntigravityDiscoveryModels } from "../src/discovery/antigravity";
import { fetchCodexModels } from "../src/discovery/codex";
import { buildGitLabDuoWorkflowFallbackModel } from "../src/discovery/gitlab-duo-workflow";
import { isOpenAIOSeriesModelId } from "../src/identity/family";
import { createModelManager } from "../src/model-manager";
import { hasBillableCost } from "../src/models";
import prevModelsJson from "../src/models.json" with { type: "json" };
import { toModelSpec } from "../src/provider-models/bundled-references";
import {
	allowsUnauthenticatedCatalogDiscovery,
	type CatalogDiscoveryConfig,
	type CatalogProviderDescriptor,
	isCatalogDescriptor,
} from "../src/provider-models/descriptor-types";
import { PROVIDER_DESCRIPTORS, PROVIDERS_PUBLISHING_OWN_MODEL_LIMITS } from "../src/provider-models/descriptors";
import {
	ANTHROPIC_CURATED_FALLBACK_MODELS,
	buildFireworksFastSeed,
	buildXaiOAuthStaticSeed,
	COMMAND_CODE_STATIC_MODELS,
	clampFireworksKimiMaxTokens,
	clampKimiK27CodeMaxTokens,
	isFireworksKimiK2ModelId,
	isKimiK27CodeModelId,
	MODELS_DEV_PROVIDER_DESCRIPTORS,
	mapModelsDevToModels,
	NOUS_RESEARCH_BUNDLED_MODELS,
	projectOpenAIProReasoningAliases,
	SAKANA_FUGU_STATIC_MODELS,
	stripFireworksDeepSeekThinkingToggle,
} from "../src/provider-models/openai-compat";
import type { Api, ModelSpec } from "../src/types";
import { cleanModelName } from "../src/utils";
import { collapseEffortVariantsAcrossProviders } from "../src/variant-collapse";
import { getCodexAccountId } from "../src/wire/codex";
import {
	applyCanonicalLimitFallback,
	applyGeneratedModelPolicies,
	CLOUDFLARE_FALLBACK_MODEL,
	linkOpenAIPromotionTargets,
} from "./generated-policies";

const packageRoot = path.join(import.meta.dir, "..");

const DISCOVERY_ONLY_PROVIDERS = new Set(["ollama", "vllm", "lm-studio", "litellm"]);
const RETIRED_PROVIDERS = new Set(["wafer-pass", "wandb"]);

const previousSnapshot = prevModelsJson as unknown as Record<string, Record<string, ModelSpec>>;

const providerFilterArg = process.argv.find(arg => arg.startsWith("--providers="));
const providerFilter = providerFilterArg
	? new Set(
			providerFilterArg
				.slice("--providers=".length)
				.split(",")
				.map(provider => provider.trim())
				.filter(Boolean),
		)
	: undefined;
if (providerFilter?.size === 0) {
	throw new Error("--providers requires at least one provider id");
}

async function resolveProviderApiKey(providerId: string, catalog: CatalogDiscoveryConfig): Promise<string | undefined> {
	for (const envVar of catalog.envVars ?? []) {
		const value = $env[envVar as keyof typeof $env];
		if (typeof value === "string" && value.length > 0) {
			return value;
		}
	}

	try {
		const authStorage = await discoverAuthStorage();
		try {
			const storedApiKey = await authStorage.getApiKey(providerId);
			if (storedApiKey) {
				return storedApiKey;
			}
			if (catalog.oauthProvider) {
				const oauthKey = await authStorage.getApiKey(catalog.oauthProvider);
				if (oauthKey) {
					return oauthKey;
				}
			}
		} finally {
			authStorage.close();
		}
	} catch (err) {
		console.warn(
			`Warning: Failed to retrieve credentials for ${providerId}:`,
			err instanceof Error ? err.message : String(err),
		);
	}

	return undefined;
}

async function fetchProviderModelsFromCatalog(descriptor: CatalogProviderDescriptor): Promise<ModelSpec[]> {
	const apiKey = await resolveProviderApiKey(descriptor.providerId, descriptor.catalogDiscovery);

	if (!apiKey && !allowsUnauthenticatedCatalogDiscovery(descriptor)) {
		console.log(`No ${descriptor.catalogDiscovery.label} credentials found (env or agent.db), using fallback models`);
		return [];
	}

	try {
		console.log(`Fetching models from ${descriptor.catalogDiscovery.label} model manager...`);
		const managerOptions = descriptor.createModelManagerOptions({ apiKey });
		const manager = createModelManager(managerOptions);
		const result = await manager.refresh("online");
		if (result.stale) {
			console.warn(
				`${descriptor.catalogDiscovery.label} dynamic fetch failed (stale cache merge), using fallback models`,
			);
			return [];
		}
		const models = result.models.filter(model => model.provider === descriptor.providerId);
		if (models.length === 0) {
			console.warn(`${descriptor.catalogDiscovery.label} discovery returned no models, using fallback models`);
			return [];
		}
		console.log(`Fetched ${models.length} models from ${descriptor.catalogDiscovery.label} model manager`);
		return models.map(model => toModelSpec(model));
	} catch (error) {
		console.error(`Failed to fetch ${descriptor.catalogDiscovery.label} models:`, error);
		return [];
	}
}

async function loadModelsDevData(): Promise<ModelSpec[]> {
	try {
		console.log("Fetching models from models.dev API...");
		const response = await fetch("https://models.dev/api.json");
		const data = await response.json();
		const bundleDescriptors = MODELS_DEV_PROVIDER_DESCRIPTORS.filter(descriptor => descriptor.enrichOnly !== true);
		const models = mapModelsDevToModels(data as Record<string, unknown>, bundleDescriptors);
		models.sort((a, b) => a.id.localeCompare(b.id));
		console.log(`Loaded ${models.length} tool-capable models from models.dev`);
		return models;
	} catch (error) {
		console.error("Failed to load models.dev data:", error);
		return [];
	}
}

function createGlobalModelsDevReferenceMap(modelsDevModels: readonly ModelSpec[]): Map<string, ModelSpec> {
	const references = new Map<string, ModelSpec>();
	for (const model of modelsDevModels) {
		const existing = references.get(model.id);
		if (!existing) {
			references.set(model.id, model);
			continue;
		}
		if ((model.contextWindow ?? 0) > (existing.contextWindow ?? 0)) {
			references.set(model.id, model);
			continue;
		}
		if (
			(model.contextWindow ?? 0) === (existing.contextWindow ?? 0) &&
			(model.maxTokens ?? 0) > (existing.maxTokens ?? 0)
		) {
			references.set(model.id, model);
		}
	}
	return references;
}

function applyGlobalModelsDevFallback(
	models: readonly ModelSpec[],
	modelsDevModels: readonly ModelSpec[],
): ModelSpec[] {
	const globalReferences = createGlobalModelsDevReferenceMap(modelsDevModels);
	const twinByKey = new Map(modelsDevModels.map(model => [`${model.provider}/${model.id}`, model]));
	return models.map(model => {
		if (
			model.provider === "devin" ||
			model.provider === "baseten" ||
			PROVIDERS_PUBLISHING_OWN_MODEL_LIMITS.has(model.provider)
		) {
			return model;
		}
		const twin = twinByKey.get(`${model.provider}/${model.id}`);
		if (twin) {
			return {
				...model,
				contextWindow: twin.contextWindow ?? model.contextWindow,
				maxTokens: twin.maxTokens ?? model.maxTokens,
			};
		}
		const reference = globalReferences.get(model.id);
		if (!reference) {
			return model;
		}
		return {
			...model,
			name: reference.name,
			reasoning: reference.reasoning,
			input: reference.input,
			contextWindow: model.contextWindow ?? reference.contextWindow,
			maxTokens: model.maxTokens ?? reference.maxTokens,
		};
	});
}

function overlayModelsDevReasoningOptions(
	models: readonly ModelSpec[],
	modelsDevModels: readonly ModelSpec[],
): ModelSpec[] {
	const byKey = new Map<string, ModelSpec["reasoningOptions"]>();
	for (const model of modelsDevModels) {
		if (model.reasoningOptions !== undefined) {
			byKey.set(`${model.provider}/${model.id}`, model.reasoningOptions);
		}
	}
	if (byKey.size === 0) return [...models];
	return models.map(model => {
		if (model.reasoningOptions !== undefined || model.reasoning !== true) return model;
		const reasoningOptions = byKey.get(`${model.provider}/${model.id}`);
		return reasoningOptions === undefined ? model : { ...model, reasoningOptions };
	});
}

function applyPremiumMultiplierOverrides(models: readonly ModelSpec[]): ModelSpec[] {
	return models.map(model => {
		const premiumMultiplier = COPILOT_PREMIUM_MULTIPLIERS[`${model.provider}/${model.id}`];
		if (premiumMultiplier === undefined) {
			return model;
		}
		if (model.premiumMultiplier === premiumMultiplier) {
			return model;
		}
		return {
			...model,
			premiumMultiplier,
		};
	});
}
function applyCodexPricingFallback(models: readonly ModelSpec[]): ModelSpec[] {
	const openAIModels = new Map(
		models
			.filter(model => model.provider === "openai" && hasBillableCost(model.cost))
			.map(model => [model.id, model.cost]),
	);

	return models.map(model => {
		if (model.provider !== "openai-codex" || model.api !== "openai-codex-responses") {
			return model;
		}
		if (hasBillableCost(model.cost)) {
			return model;
		}

		const openAICost = openAIModels.get(model.id);
		if (!openAICost) {
			return model;
		}

		return {
			...model,
			cost: { ...openAICost },
		};
	});
}

function applyKimiCodingAliasSurface(models: readonly ModelSpec[], modelsDevModels: readonly ModelSpec[]): ModelSpec[] {
	const k3 = modelsDevModels.find(model => model.provider === "kimi-code" && model.id === "k3");
	const surface = k3?.reasoningOptions;
	if (surface === undefined) return [...models];
	const aliasIds = new Set(["kimi-for-coding", "kimi-for-coding-highspeed"]);
	return models.map(model => {
		if (model.provider !== "kimi-code" || !aliasIds.has(model.id)) return model;
		if (model.reasoning !== true || model.reasoningOptions?.efforts !== undefined) return model;
		return { ...model, reasoningOptions: surface };
	});
}

const REASONING_SURFACE_TWINS: Readonly<Record<string, string>> = {
	"openai-codex": "openai",
	"xai-oauth": "xai",
	opencode: "opencode-zen",
	"google-gemini-cli": "google",
};

function applyTwinReasoningSurfaces(models: readonly ModelSpec[], modelsDevModels: readonly ModelSpec[]): ModelSpec[] {
	const surfacesByProvider = new Map<string, Map<string, NonNullable<ModelSpec["reasoningOptions"]>>>();
	for (const model of modelsDevModels) {
		if (model.reasoningOptions === undefined) continue;
		let surfaces = surfacesByProvider.get(model.provider);
		if (!surfaces) {
			surfaces = new Map();
			surfacesByProvider.set(model.provider, surfaces);
		}
		surfaces.set(model.id, model.reasoningOptions);
	}
	return models.map(model => {
		const sourceProvider = REASONING_SURFACE_TWINS[model.provider];
		if (sourceProvider === undefined || model.reasoning !== true) return model;
		if (model.reasoningOptions !== undefined) return model;
		const surface = surfacesByProvider.get(sourceProvider)?.get(model.id);
		return surface === undefined ? model : { ...model, reasoningOptions: surface };
	});
}

function applyKimiMaxTokensCap(models: readonly ModelSpec[]): ModelSpec[] {
	const FIREWORKS_KIMI_PROVIDERS = new Set(["fireworks", "firepass"]);
	return models.map(model => {
		if (FIREWORKS_KIMI_PROVIDERS.has(model.provider) && isFireworksKimiK2ModelId(model.id)) {
			const capped = clampFireworksKimiMaxTokens(model.id, model.maxTokens);
			return capped === model.maxTokens ? model : { ...model, maxTokens: capped };
		}
		if (model.provider === "venice" && isKimiK27CodeModelId(model.id)) {
			const capped = clampKimiK27CodeMaxTokens(model.id, model.maxTokens);
			return capped === model.maxTokens ? model : { ...model, maxTokens: capped };
		}
		return model;
	});
}

function applyFireworksDeepSeekReasoningShape(models: readonly ModelSpec[]): ModelSpec[] {
	return models.map(model => {
		if (model.provider !== "fireworks" || model.api !== "openai-completions") return model;
		return stripFireworksDeepSeekThinkingToggle(model as ModelSpec<"openai-completions">, model.id);
	});
}

function dropUnusableZaiContextTierIds(models: readonly ModelSpec[]): ModelSpec[] {
	return models.filter(model => !(model.provider === "zai" && model.id.endsWith("[1m]")));
}

function dropFireworksWireIds(models: readonly ModelSpec[]): ModelSpec[] {
	return models.filter(
		model =>
			!(
				(model.provider === "fireworks" || model.provider === "firepass") &&
				model.id.startsWith("accounts/fireworks/")
			),
	);
}

function dropXiaomiAudioOnlyIds(models: readonly ModelSpec[]): ModelSpec[] {
	return models.filter(model => {
		const isXiaomiProvider = model.provider === "xiaomi" || model.provider.startsWith("xiaomi-token-plan-");
		return !isXiaomiProvider || (!model.id.includes("-tts") && !model.id.includes("-asr"));
	});
}

function normalizeAntigravityEndpoint(models: readonly ModelSpec[]): ModelSpec[] {
	return models.map(model => {
		if (model.provider === "google-antigravity" && model.baseUrl) {
			return { ...model, baseUrl: ANTIGRAVITY_PRIMARY_ENDPOINT };
		}
		return model;
	});
}

const ANTIGRAVITY_ENDPOINT = ANTIGRAVITY_PRIMARY_ENDPOINT;

async function getOAuthAccessFromStorage(provider: OAuthProvider): Promise<OAuthAccess | null> {
	try {
		const authStorage = await discoverAuthStorage();
		try {
			let access = await authStorage.getOAuthAccess(provider);
			if (!access && provider === "google-antigravity") {
				access = await authStorage.getOAuthAccess("google-gemini-cli");
			}
			if (access) return access;
		} finally {
			authStorage.close();
		}
	} catch (err) {
		console.warn(
			`Warning: Failed to retrieve credentials for ${provider}:`,
			err instanceof Error ? err.message : String(err),
		);
	}
	const shared = readSharedStoreOAuthAccess(provider);
	if (!shared && provider === "google-antigravity") {
		return readSharedStoreOAuthAccess("google-gemini-cli");
	}
	return shared;
}

function readSharedStoreOAuthAccess(provider: OAuthProvider): OAuthAccess | null {
	try {
		const db = new Database(path.join(getSharedAuthDir(), "agent.db"), { readonly: true });
		try {
			const row = db
				.query("SELECT data FROM auth_credentials WHERE provider = ? AND credential_type = 'oauth'")
				.get(provider) as { data: string } | null;
			if (!row) return null;
			const data = JSON.parse(row.data) as {
				access?: string;
				expires?: number;
				projectId?: string;
				email?: string;
				accountId?: string;
			};
			if (!data.access) return null;
			if (typeof data.expires === "number" && data.expires <= Date.now()) return null;
			return {
				accessToken: data.access,
				accountId: data.accountId,
				email: data.email,
				projectId: data.projectId,
			};
		} finally {
			db.close();
		}
	} catch {
		return null;
	}
}

async function fetchAntigravityModels(): Promise<ModelSpec<"google-gemini-cli">[]> {
	const access = await getOAuthAccessFromStorage("google-antigravity");
	if (!access) {
		console.log("No Antigravity or Gemini CLI credentials found, will use previous models.");
		console.log("Tip: If you are logged in under a specific profile, run with VEYYON_PROFILE=<name>.");
		return [];
	}
	try {
		console.log("Fetching models from Antigravity API...");
		const discovered = await fetchAntigravityDiscoveryModels({
			token: access.accessToken,
			endpoint: ANTIGRAVITY_ENDPOINT,
		});
		if (discovered === null) {
			console.warn("Antigravity API fetch failed, will use previous models");
			return [];
		}
		if (discovered.length > 0) {
			console.log(`Fetched ${discovered.length} models from Antigravity API`);
			return discovered;
		}
		console.warn("Antigravity API returned no models, will use previous models");
		return [];
	} catch (error) {
		console.error("Failed to fetch Antigravity models:", error);
		return [];
	}
}

async function fetchCodexDiscoveryModels(): Promise<ModelSpec<"openai-codex-responses">[]> {
	const access = await getOAuthAccessFromStorage("openai-codex");
	if (!access) {
		console.log("No Codex credentials found, will use previous models.");
		console.log("Tip: If you are logged in under a specific profile, run with VEYYON_PROFILE=<name>.");
		return [];
	}
	try {
		console.log("Fetching models from Codex API...");
		const accessToken = access.accessToken;
		const accountId = access.accountId ?? getCodexAccountId(accessToken);
		const codexDiscovery = await fetchCodexModels({
			accessToken,
			accountId: accountId ?? undefined,
		});
		if (codexDiscovery === null) {
			console.warn("Codex API fetch failed");
			return [];
		}
		if (codexDiscovery.models.length > 0) {
			console.log(`Fetched ${codexDiscovery.models.length} models from Codex API`);
			return codexDiscovery.models;
		}
		return [];
	} catch (error) {
		console.error("Failed to fetch Codex models:", error);
		return [];
	}
}

async function generateModels() {
	const modelsDevModels = await loadModelsDevData();
	const catalogProviderDescriptors = PROVIDER_DESCRIPTORS.filter(
		(descriptor): descriptor is CatalogProviderDescriptor =>
			isCatalogDescriptor(descriptor) && !DISCOVERY_ONLY_PROVIDERS.has(descriptor.providerId),
	);
	const catalogProviderModelBatches = await Promise.all(
		catalogProviderDescriptors.map(async descriptor => ({
			descriptor,
			models: await fetchProviderModelsFromCatalog(descriptor),
		})),
	);
	const authoritativeCatalogProviders = new Set(
		catalogProviderModelBatches
			.filter(batch => batch.descriptor.dynamicModelsAuthoritative === true && batch.models.length > 0)
			.map(batch => batch.descriptor.providerId),
	);
	const catalogProviderModels = catalogProviderModelBatches.flatMap(batch => batch.models);
	const bundledModelsDevModels = modelsDevModels.filter(model => !authoritativeCatalogProviders.has(model.provider));
	const gitLabDuoModels = getGitLabDuoModels().map(model => toModelSpec(model));
	let allModels = applyGlobalModelsDevFallback(
		[...bundledModelsDevModels, ...catalogProviderModels, ...gitLabDuoModels],
		modelsDevModels,
	);

	allModels = allModels.map(model =>
		!model.reasoning && isOpenAIOSeriesModelId(model.id) ? { ...model, reasoning: true } : model,
	);

	if (!allModels.some(model => model.provider === "cloudflare-ai-gateway")) {
		allModels.push(CLOUDFLARE_FALLBACK_MODEL as ModelSpec<"anthropic-messages">);
	}

	allModels.push(...buildXaiOAuthStaticSeed());
	allModels.push(...ANTHROPIC_CURATED_FALLBACK_MODELS);
	if (!authoritativeCatalogProviders.has("sakana")) {
		allModels.push(...SAKANA_FUGU_STATIC_MODELS);
	}
	if (!authoritativeCatalogProviders.has("nous-research")) {
		allModels.push(...NOUS_RESEARCH_BUNDLED_MODELS);
	}
	if (!authoritativeCatalogProviders.has("command-code")) {
		allModels.push(...COMMAND_CODE_STATIC_MODELS);
	}
	if (!authoritativeCatalogProviders.has("gitlab-duo-agent")) {
		allModels.push(buildGitLabDuoWorkflowFallbackModel());
	}
	allModels.push(...buildFireworksFastSeed());

	const specialDiscoverySources = [
		{ label: "Antigravity", fetch: fetchAntigravityModels },
		{ label: "Codex", fetch: fetchCodexDiscoveryModels },
	] as const;
	const specialDiscoveries = await Promise.all(
		specialDiscoverySources.map(async source => ({
			label: source.label,
			models: await source.fetch(),
		})),
	);
	for (const discovery of specialDiscoveries) {
		if (discovery.models.length > 0) {
			console.log(`Added ${discovery.models.length} models from ${discovery.label} discovery`);
			allModels.push(...discovery.models);
		}
	}

	const modelsDevSnapshotExcludedProviders = new Set<string>();
	modelsDevSnapshotExcludedProviders.add("nous-research");
	for (const model of modelsDevModels) {
		if (model.provider === "google-vertex") {
			modelsDevSnapshotExcludedProviders.add(model.provider);
		}
	}
	for (const discovery of specialDiscoveries) {
		if (discovery.label === "Antigravity" && discovery.models.length > 0) {
			modelsDevSnapshotExcludedProviders.add("google-antigravity");
		}
	}
	const fetchedKeys = new Set(allModels.map(model => `${model.provider}/${model.id}`));

	for (const models of Object.values(previousSnapshot)) {
		for (const model of Object.values(models)) {
			if (
				!fetchedKeys.has(`${model.provider}/${model.id}`) &&
				!DISCOVERY_ONLY_PROVIDERS.has(model.provider) &&
				!RETIRED_PROVIDERS.has(model.provider) &&
				!authoritativeCatalogProviders.has(model.provider) &&
				!modelsDevSnapshotExcludedProviders.has(model.provider)
			) {
				allModels.push(model);
			}
		}
	}

	allModels = applyGlobalModelsDevFallback(allModels, modelsDevModels);
	allModels = applyPremiumMultiplierOverrides(allModels);
	allModels = applyCodexPricingFallback(allModels);
	allModels = applyKimiMaxTokensCap(allModels);
	allModels = applyFireworksDeepSeekReasoningShape(allModels);
	allModels = dropFireworksWireIds(allModels);
	allModels = dropUnusableZaiContextTierIds(allModels);
	allModels = dropXiaomiAudioOnlyIds(allModels);
	allModels = normalizeAntigravityEndpoint(allModels);
	allModels = allModels.map(model => {
		const name = cleanModelName(model.name);
		return name === model.name ? model : { ...model, name };
	});
	allModels = projectOpenAIProReasoningAliases(allModels);
	allModels = overlayModelsDevReasoningOptions(allModels, modelsDevModels);
	allModels = applyKimiCodingAliasSurface(allModels, modelsDevModels);
	allModels = applyTwinReasoningSurfaces(allModels, modelsDevModels);
	applyGeneratedModelPolicies(allModels);
	linkOpenAIPromotionTargets(allModels);
	allModels = collapseEffortVariantsAcrossProviders(allModels);
	applyCanonicalLimitFallback(allModels);

	for (const model of allModels) {
		canonicalizeModelCompat(model);
	}

	const providers: Record<string, Record<string, ModelSpec>> = {};
	for (const model of allModels) {
		if (DISCOVERY_ONLY_PROVIDERS.has(model.provider) || RETIRED_PROVIDERS.has(model.provider)) continue;
		if (!providers[model.provider]) {
			providers[model.provider] = {};
		}
		if (!providers[model.provider][model.id]) {
			providers[model.provider][model.id] = model;
		}
	}

	const sortObj = <V>(o: Record<string, V>): Record<string, V> => {
		return Object.fromEntries(
			Object.entries(o)
				.sort(([a], [b]) => a.localeCompare(b))
				.map(([id, model]) => [id, model]),
		);
	};

	const outputProviders: Record<string, Record<string, ModelSpec>> = providerFilter
		? { ...previousSnapshot }
		: providers;
	if (providerFilter) {
		for (const provider of providerFilter) {
			const generated = providers[provider];
			if (!generated) {
				throw new Error(`Cannot generate unknown or empty provider: ${provider}`);
			}
			outputProviders[provider] = generated;
		}
	}

	const MODELS: Record<string, Record<string, ModelSpec>> = sortObj(outputProviders);
	for (const key in MODELS) {
		MODELS[key] = sortObj(MODELS[key]);
	}

	await Bun.write(path.join(packageRoot, "src/models.json"), JSON.stringify(MODELS, null, "	"));
	console.log(`Generated src/models.json${providerFilter ? ` for ${[...providerFilter].join(", ")}` : ""}`);

	const totalModels = allModels.length;
	const reasoningModels = allModels.filter(m => m.reasoning).length;

	console.log(`
Model Statistics:`);
	console.log(`  Total tool-capable models: ${totalModels}`);
	console.log(`  Reasoning-capable models: ${reasoningModels}`);

	for (const [provider, models] of Object.entries(MODELS)) {
		console.log(`  ${provider}: ${Object.keys(models).length} models`);
	}
}

function canonicalizeModelCompat(model: ModelSpec<Api>): void {
	if (!model.compat) return;

	if ("disableStrictTools" in model.compat && model.compat.disableStrictTools === false) {
		delete model.compat.disableStrictTools;
	}

	let hasKeys = false;
	for (const _ in model.compat) {
		hasKeys = true;
		break;
	}
	if (!hasKeys) {
		delete model.compat;
	}
}

generateModels().catch(console.error);
