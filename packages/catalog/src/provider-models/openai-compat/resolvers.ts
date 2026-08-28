import { Effort } from "../../effort";
import { FIREPASS_WIRE_PREFIX, toFirepassPublicModelId, toFireworksPublicModelId } from "../../fireworks-model-id";
import {
	ANTHROPIC_API_ENDPOINT,
	CLOUD_CODE_ENDPOINT,
	GEMINI_DEVELOPER_API_ENDPOINT,
	OPENROUTER_API_ENDPOINT,
} from "../../provider-endpoints";
import type { Api, FetchImpl, ModelSpec } from "../../types";
import { isRecord, toNumber, toPositiveNumber } from "../../utils";
import { CODEX_BASE_URL } from "../../wire/codex";
import { COPILOT_API_HEADERS, PERSONAL_GITHUB_COPILOT_BASE_URL } from "../../wire/github-copilot";
import {
	fetchModelsDevPayload,
	type ModelsDevModel,
	mapModelsDevReasoningOptions,
	toInputCapabilities,
	toModelName,
} from "./helpers";
import {
	COPILOT_ANTHROPIC_MODEL_PATTERN,
	clampKimiK27CodeMaxTokens,
	isCopilotResponsesModelId,
	UMANS_BASE_URL,
	UMANS_VIA_HANDOFF_MODEL_IDS,
	ZENMUX_ANTHROPIC_BASE_URL,
	ZENMUX_OPENAI_BASE_URL,
} from "./overrides";

export interface ModelsDevProviderDescriptor {
	modelsDevKey: string;
	providerId: string;
	api: Api;
	baseUrl: string;
	defaultContextWindow?: number;
	defaultMaxTokens?: number;
	compat?: ModelSpec<Api>["compat"];
	headers?: Record<string, string>;
	filterModel?: (modelId: string, model: ModelsDevModel) => boolean;
	transformModel?: (
		model: ModelSpec<Api>,
		modelId: string,
		raw: ModelsDevModel,
	) => ModelSpec<Api> | ModelSpec<Api>[] | null;
	resolveApi?: (modelId: string, raw: ModelsDevModel) => { api: Api; baseUrl: string } | null;
	enrichOnly?: boolean;
}

export function mapModelsDevToModels(
	data: Record<string, unknown>,
	descriptors: readonly ModelsDevProviderDescriptor[],
): ModelSpec<Api>[] {
	const models: ModelSpec<Api>[] = [];
	for (const desc of descriptors) {
		const providerData = (data as Record<string, Record<string, unknown>>)[desc.modelsDevKey];
		if (!isRecord(providerData) || !isRecord(providerData.models)) continue;

		for (const [modelId, rawModel] of Object.entries(providerData.models)) {
			if (!isRecord(rawModel)) continue;
			const m = rawModel as ModelsDevModel;

			if (desc.filterModel) {
				if (!desc.filterModel(modelId, m)) continue;
			} else {
				if (m.tool_call !== true) continue;
			}

			const resolved = desc.resolveApi?.(modelId, m) ?? { api: desc.api, baseUrl: desc.baseUrl };
			if (!resolved) continue;

			const reasoningOptions =
				m.reasoning === true ? mapModelsDevReasoningOptions(m.reasoning_options, modelId) : undefined;

			const mapped: ModelSpec<Api> = {
				id: modelId,
				name: toModelName(m.name, modelId),
				api: resolved.api,
				provider: desc.providerId as ModelSpec<Api>["provider"],
				baseUrl: resolved.baseUrl,
				reasoning: m.reasoning === true,
				...(reasoningOptions !== undefined ? { reasoningOptions } : {}),
				input: toInputCapabilities(m.modalities?.input),
				cost: {
					input: toNumber(m.cost?.input) ?? 0,
					output: toNumber(m.cost?.output) ?? 0,
					cacheRead: toNumber(m.cost?.cache_read) ?? 0,
					cacheWrite: toNumber(m.cost?.cache_write) ?? 0,
				},
				contextWindow: toPositiveNumber(m.limit?.context, desc.defaultContextWindow ?? null),
				maxTokens: toPositiveNumber(m.limit?.output, desc.defaultMaxTokens ?? null),
				...(m.tool_call === false ? { supportsTools: false } : {}),
				...(desc.compat && { compat: desc.compat }),
				...(desc.headers && { headers: { ...desc.headers } }),
			};

			if (desc.transformModel) {
				const result = desc.transformModel(mapped, modelId, m);
				if (result === null) continue;
				if (Array.isArray(result)) {
					for (let ri = 0; ri < result.length; ri++) models.push(result[ri]!);
				} else {
					models.push(result);
				}
			} else {
				models.push(mapped);
			}
		}
	}
	return models;
}

export function createModelsDevReferenceMap<TApi extends Api>(
	models: readonly ModelSpec<Api>[],
): Map<string, ModelSpec<TApi>> {
	const references = new Map<string, ModelSpec<TApi>>();
	for (const model of models) {
		const candidate = model as ModelSpec<TApi>;
		const existing = references.get(candidate.id);
		if (!existing) {
			references.set(candidate.id, candidate);
			continue;
		}
		if ((candidate.contextWindow ?? 0) > (existing.contextWindow ?? 0)) {
			references.set(candidate.id, candidate);
			continue;
		}
		if (
			candidate.contextWindow === existing.contextWindow &&
			(candidate.maxTokens ?? 0) > (existing.maxTokens ?? 0)
		) {
			references.set(candidate.id, candidate);
		}
	}
	return references;
}

export async function loadModelsDevReferences<TApi extends Api>(
	fetchImpl?: FetchImpl,
): Promise<Map<string, ModelSpec<TApi>>> {
	try {
		const payload = await fetchModelsDevPayload(fetchImpl);
		return createModelsDevReferenceMap<TApi>(
			mapModelsDevToModels(payload as Record<string, unknown>, MODELS_DEV_PROVIDER_DESCRIPTORS),
		);
	} catch {
		return new Map<string, ModelSpec<TApi>>();
	}
}

export const BEDROCK_GLOBAL_PREFIXES = [
	"anthropic.claude-fable-5",
	"anthropic.claude-mythos-5",
	"anthropic.claude-haiku-4-5",
	"anthropic.claude-sonnet-4",
	"anthropic.claude-opus-4-5",
	"amazon.nova-2-lite",
	"cohere.embed-v4",
	"twelvelabs.pegasus-1-2",
];

export const BEDROCK_US_PREFIXES = [
	"amazon.nova-lite",
	"amazon.nova-micro",
	"amazon.nova-premier",
	"amazon.nova-pro",
	"anthropic.claude-3-7-sonnet",
	"anthropic.claude-opus-4-1",
	"anthropic.claude-opus-4-20250514",
	"deepseek.r1",
	"meta.llama3-2",
	"meta.llama3-3",
	"meta.llama4",
];

export function bedrockCrossRegionId(id: string): string {
	if (BEDROCK_GLOBAL_PREFIXES.some(p => id.startsWith(p))) return `global.${id}`;
	if (BEDROCK_US_PREFIXES.some(p => id.startsWith(p))) return `us.${id}`;
	return id;
}

export interface ApiResolutionRule {
	matches: (modelId: string, raw: ModelsDevModel) => boolean;
	resolved: { api: Api; baseUrl: string };
}

export function resolveApiByRules(
	modelId: string,
	raw: ModelsDevModel,
	rules: readonly ApiResolutionRule[],
	fallback: { api: Api; baseUrl: string },
): { api: Api; baseUrl: string } {
	for (const rule of rules) {
		if (rule.matches(modelId, raw)) return rule.resolved;
	}
	return fallback;
}

export function createOpenCodeApiResolution(
	basePath: string,
	idOverrides: Readonly<Record<string, Api>> = {},
): {
	defaultResolution: { api: Api; baseUrl: string };
	rules: ApiResolutionRule[];
} {
	const completionsBaseUrl = `${basePath}/v1`;
	const baseUrlForApi = (api: Api): string => (api === "anthropic-messages" ? basePath : completionsBaseUrl);
	const overrideRules: ApiResolutionRule[] = Object.entries(idOverrides).map(([id, api]) => ({
		matches: modelId => modelId === id,
		resolved: { api, baseUrl: baseUrlForApi(api) },
	}));
	return {
		defaultResolution: { api: "openai-completions", baseUrl: completionsBaseUrl },
		rules: [
			...overrideRules,
			{
				matches: (_modelId, raw) => raw.provider?.npm === "@ai-sdk/openai",
				resolved: { api: "openai-responses", baseUrl: completionsBaseUrl },
			},
			{
				matches: (_modelId, raw) => raw.provider?.npm === "@ai-sdk/anthropic",
				resolved: { api: "anthropic-messages", baseUrl: basePath },
			},
			{
				matches: (_modelId, raw) => raw.provider?.npm === "@ai-sdk/google",
				resolved: { api: "google-generative-ai", baseUrl: completionsBaseUrl },
			},
		],
	};
}

export const OPENCODE_ZEN_API_RESOLUTION = createOpenCodeApiResolution("https://opencode.ai/zen", {
	"minimax-m3": "openai-completions",
	"minimax-m3-free": "openai-completions",
});

export const OPENCODE_GO_API_RESOLUTION = createOpenCodeApiResolution("https://opencode.ai/zen/go", {
	"minimax-m2.7": "openai-completions",
	"minimax-m3": "openai-completions",
	"minimax-m3-free": "openai-completions",
	"qwen3.5-plus": "openai-completions",
	"qwen3.6-plus": "openai-completions",
});

export const COPILOT_DEFAULT_RESOLUTION = {
	api: "openai-completions",
	baseUrl: PERSONAL_GITHUB_COPILOT_BASE_URL,
} as const satisfies { api: Api; baseUrl: string };

export const COPILOT_API_RESOLUTION_RULES: readonly ApiResolutionRule[] = [
	{
		matches: modelId => COPILOT_ANTHROPIC_MODEL_PATTERN.test(modelId),
		resolved: { api: "anthropic-messages", baseUrl: PERSONAL_GITHUB_COPILOT_BASE_URL },
	},
	{
		matches: isCopilotResponsesModelId,
		resolved: { api: "openai-responses", baseUrl: PERSONAL_GITHUB_COPILOT_BASE_URL },
	},
];

export function simpleModelsDevDescriptor(
	modelsDevKey: string,
	providerId: string,
	api: Api,
	baseUrl: string,
	options: Omit<ModelsDevProviderDescriptor, "modelsDevKey" | "providerId" | "api" | "baseUrl"> = {},
): ModelsDevProviderDescriptor {
	return {
		modelsDevKey,
		providerId,
		api,
		baseUrl,
		...options,
	};
}

export function openAiCompletionsDescriptor(
	modelsDevKey: string,
	providerId: string,
	baseUrl: string,
	options: Omit<ModelsDevProviderDescriptor, "modelsDevKey" | "providerId" | "api" | "baseUrl"> = {},
): ModelsDevProviderDescriptor {
	return simpleModelsDevDescriptor(modelsDevKey, providerId, "openai-completions", baseUrl, options);
}

export function anthropicMessagesDescriptor(
	modelsDevKey: string,
	providerId: string,
	baseUrl: string,
	options: Omit<ModelsDevProviderDescriptor, "modelsDevKey" | "providerId" | "api" | "baseUrl"> = {},
): ModelsDevProviderDescriptor {
	return simpleModelsDevDescriptor(modelsDevKey, providerId, "anthropic-messages", baseUrl, options);
}

export const GOOGLE_VERTEX_BASE_URL = "https://{location}-aiplatform.googleapis.com";
export const GOOGLE_VERTEX_OPENAI_BASE_URL =
	"https://{location}-aiplatform.googleapis.com/v1/projects/{project}/locations/{location}/endpoints/openapi";
export const GOOGLE_VERTEX_ANTHROPIC_BASE_URL =
	"https://{location}-aiplatform.googleapis.com/v1/projects/{project}/locations/{location}/publishers/anthropic/models/{model}:streamRawPredict";

export function resolveGoogleVertexApi(modelId: string, raw: ModelsDevModel): { api: Api; baseUrl: string } {
	if (raw.provider?.npm === "@ai-sdk/google-vertex/anthropic") {
		return {
			api: "anthropic-messages",
			baseUrl: GOOGLE_VERTEX_ANTHROPIC_BASE_URL.replace("{model}", modelId),
		};
	}
	if (modelId.includes("/") || raw.provider?.npm === "@ai-sdk/openai-compatible") {
		return { api: "openai-completions", baseUrl: GOOGLE_VERTEX_OPENAI_BASE_URL };
	}
	return { api: "google-vertex", baseUrl: GOOGLE_VERTEX_BASE_URL };
}

export const MODELS_DEV_PROVIDER_DESCRIPTORS_BEDROCK: readonly ModelsDevProviderDescriptor[] = [
	{
		modelsDevKey: "amazon-bedrock",
		providerId: "amazon-bedrock",
		api: "bedrock-converse-stream",
		baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
		filterModel: (id, m) => {
			if (m.tool_call !== true) return false;
			if (id.startsWith("ai21.jamba")) return false;
			if (id.startsWith("amazon.titan-text-express") || id.startsWith("mistral.mistral-7b-instruct-v0"))
				return false;
			return true;
		},
		transformModel: (model, modelId, m) => {
			const crossRegionId = bedrockCrossRegionId(modelId);
			const bedrockModel: ModelSpec<Api> = {
				...model,
				id: crossRegionId,
				name: toModelName(m.name, crossRegionId),
			};
			if (modelId.startsWith("anthropic.claude-")) {
				return [
					bedrockModel,
					{
						...bedrockModel,
						id: `eu.${modelId}`,
						name: `${toModelName(m.name, modelId)} (EU)`,
					},
				];
			}
			return bedrockModel;
		},
	},
];

export const MODELS_DEV_PROVIDER_DESCRIPTORS_CORE: readonly ModelsDevProviderDescriptor[] = [
	anthropicMessagesDescriptor("anthropic", "anthropic", ANTHROPIC_API_ENDPOINT, {
		filterModel: (id, m) => {
			if (m.tool_call !== true) return false;
			if (
				id.startsWith("claude-3-5-haiku") ||
				id.startsWith("claude-3-7-sonnet") ||
				id === "claude-3-opus-20240229" ||
				id === "claude-3-sonnet-20240229"
			)
				return false;
			return true;
		},
	}),
	simpleModelsDevDescriptor("google", "google", "google-generative-ai", GEMINI_DEVELOPER_API_ENDPOINT),
	simpleModelsDevDescriptor("openai", "openai", "openai-responses", "https://api.openai.com/v1"),
	openAiCompletionsDescriptor("groq", "groq", "https://api.groq.com/openai/v1"),
	openAiCompletionsDescriptor("cerebras", "cerebras", "https://api.cerebras.ai/v1"),
	openAiCompletionsDescriptor("togetherai", "together", "https://api.together.xyz/v1"),
	openAiCompletionsDescriptor("wandb", "coreweave", "https://api.inference.wandb.ai/v1", {
		transformModel: model => {
			if (!model.id.startsWith("openai/gpt-oss-")) {
				return model;
			}
			return {
				...model,
				reasoning: true,
				thinking: { mode: "effort", efforts: [Effort.Low, Effort.Medium, Effort.High] },
			};
		},
	}),
	openAiCompletionsDescriptor("nvidia", "nvidia", "https://integrate.api.nvidia.com/v1", {
		defaultContextWindow: 131072,
	}),
	openAiCompletionsDescriptor("xai", "xai", "https://api.x.ai/v1"),
	simpleModelsDevDescriptor("xai", "xai-oauth", "openai-responses", "https://api.x.ai/v1", { enrichOnly: true }),
	simpleModelsDevDescriptor("openai", "openai-codex", "openai-codex-responses", CODEX_BASE_URL, {
		enrichOnly: true,
	}),
	simpleModelsDevDescriptor("google", "google-gemini-cli", "google-gemini-cli", CLOUD_CODE_ENDPOINT, {
		enrichOnly: true,
	}),
	openAiCompletionsDescriptor("deepseek", "deepseek", "https://api.deepseek.com", {
		filterModel: (id, m) => m.tool_call === true && id.startsWith("deepseek-v4"),
		compat: {
			supportsDeveloperRole: false,
			supportsReasoningEffort: true,
			maxTokensField: "max_tokens",
			supportsToolChoice: false,
			extraBody: { thinking: { type: "enabled" } },
			reasoningContentField: "reasoning_content",
			requiresReasoningContentForToolCalls: true,
			requiresAssistantContentForToolCalls: true,
		},
	}),
];

export const MODELS_DEV_PROVIDER_DESCRIPTORS_CODING_PLANS: readonly ModelsDevProviderDescriptor[] = [
	anthropicMessagesDescriptor("zai-coding-plan", "zai", "https://api.z.ai/api/anthropic"),
	anthropicMessagesDescriptor("umans-ai-coding-plan", "umans", UMANS_BASE_URL, {
		transformModel: model => ({
			...model,
			input: (UMANS_VIA_HANDOFF_MODEL_IDS as readonly string[]).includes(model.id) ? ["text"] : model.input,
			maxTokens: model.id === "umans-coder" ? 32_768 : model.maxTokens,
		}),
	}),
	openAiCompletionsDescriptor("xiaomi", "xiaomi", "https://api.xiaomimimo.com/v1", {
		defaultContextWindow: 262144,
		defaultMaxTokens: 8192,
		compat: {
			supportsStore: false,
			thinkingFormat: "zai",
			reasoningContentField: "reasoning_content",
			requiresReasoningContentForToolCalls: true,
			allowsSyntheticReasoningContentForToolCalls: false,
		},
	}),
	openAiCompletionsDescriptor("fireworks-ai", "fireworks", "https://api.fireworks.ai/inference/v1", {
		compat: { supportsToolChoice: false, requiresAssistantContentForToolCalls: true },
		transformModel: model => ({
			...model,
			id: model.id.startsWith(FIREPASS_WIRE_PREFIX)
				? toFirepassPublicModelId(model.id)
				: toFireworksPublicModelId(model.id),
		}),
	}),
	openAiCompletionsDescriptor("baseten", "baseten", "https://inference.baseten.co/v1"),
	openAiCompletionsDescriptor("novita-ai", "novita", "https://api.novita.ai/openai/v1"),
	openAiCompletionsDescriptor("vercel", "vercel-ai-gateway", "https://ai-gateway.vercel.sh"),
	openAiCompletionsDescriptor("wafer.ai", "wafer-serverless", "https://pass.wafer.ai/v1"),
	simpleModelsDevDescriptor("sakana", "sakana", "openai-responses", "https://api.sakana.ai/v1", {
		compat: { includeEncryptedReasoning: false, streamIdleTimeoutMs: 0 },
	}),
	openAiCompletionsDescriptor("kimi-for-coding", "kimi-code", "https://api.kimi.com/coding/v1", {
		headers: { "User-Agent": "KimiCLI/1.0", "X-Msh-Platform": "kimi_cli" },
	}),
	openAiCompletionsDescriptor("minimax-coding-plan", "minimax-code", "https://api.minimax.io/v1", {
		compat: {
			supportsStore: false,
			supportsDeveloperRole: false,
			supportsReasoningEffort: false,
			reasoningContentField: "reasoning_content",
		},
	}),
	openAiCompletionsDescriptor("minimax-cn-coding-plan", "minimax-code-cn", "https://api.minimaxi.com/v1", {
		compat: {
			supportsStore: false,
			supportsDeveloperRole: false,
			supportsReasoningEffort: false,
			reasoningContentField: "reasoning_content",
		},
	}),
	openAiCompletionsDescriptor(
		"alibaba-coding-plan",
		"alibaba-coding-plan",
		"https://coding-intl.dashscope.aliyuncs.com/v1",
		{
			compat: {
				supportsDeveloperRole: false,
			},
		},
	),
	openAiCompletionsDescriptor(
		"zhipuai-coding-plan",
		"zhipu-coding-plan",
		"https://open.bigmodel.cn/api/coding/paas/v4",
		{
			compat: {
				thinkingFormat: "zai",
				reasoningContentField: "reasoning_content",
				supportsDeveloperRole: false,
			},
		},
	),
];

export const filterActiveToolCallModels = (_id: string, m: ModelsDevModel): boolean => {
	if (m.tool_call !== true) return false;
	if (m.status === "deprecated") return false;
	return true;
};

export const MODELS_DEV_PROVIDER_DESCRIPTORS_GOOGLE_VERTEX: readonly ModelsDevProviderDescriptor[] = [
	simpleModelsDevDescriptor("google-vertex", "google-vertex", "google-vertex", GOOGLE_VERTEX_BASE_URL, {
		filterModel: filterActiveToolCallModels,
		resolveApi: resolveGoogleVertexApi,
	}),
];

export const MODELS_DEV_PROVIDER_DESCRIPTORS_SPECIALIZED: readonly ModelsDevProviderDescriptor[] = [
	simpleModelsDevDescriptor("azure", "azure", "azure-openai-responses", "", {
		filterModel: (modelId, m) => {
			if (m.tool_call !== true) return false;
			return /^(gpt-|o1|o3|o4|codex|chatgpt)/.test(modelId);
		},
	}),
	anthropicMessagesDescriptor(
		"cloudflare-ai-gateway",
		"cloudflare-ai-gateway",
		"https://gateway.ai.cloudflare.com/v1/<account>/<gateway>/anthropic",
	),
	openAiCompletionsDescriptor("mistral", "mistral", "https://api.mistral.ai/v1"),
	openAiCompletionsDescriptor("opencode", "opencode-zen", "https://opencode.ai/zen/v1", {
		filterModel: filterActiveToolCallModels,
		resolveApi: (modelId, raw) =>
			resolveApiByRules(
				modelId,
				raw,
				OPENCODE_ZEN_API_RESOLUTION.rules,
				OPENCODE_ZEN_API_RESOLUTION.defaultResolution,
			),
	}),
	openAiCompletionsDescriptor("opencode-go", "opencode-go", "https://opencode.ai/zen/go/v1", {
		filterModel: filterActiveToolCallModels,
		resolveApi: (modelId, raw) =>
			resolveApiByRules(
				modelId,
				raw,
				OPENCODE_GO_API_RESOLUTION.rules,
				OPENCODE_GO_API_RESOLUTION.defaultResolution,
			),
	}),
	openAiCompletionsDescriptor("github-copilot", "github-copilot", PERSONAL_GITHUB_COPILOT_BASE_URL, {
		defaultContextWindow: 128000,
		defaultMaxTokens: 8192,
		headers: { ...COPILOT_API_HEADERS },
		filterModel: filterActiveToolCallModels,
		resolveApi: (modelId, raw) =>
			resolveApiByRules(modelId, raw, COPILOT_API_RESOLUTION_RULES, COPILOT_DEFAULT_RESOLUTION),
		transformModel: model => {
			if (model.api === "openai-completions") {
				return {
					...model,
					compat: {
						supportsStore: false,
						supportsDeveloperRole: false,
						supportsReasoningEffort: false,
					},
				};
			}
			return model;
		},
	}),
	anthropicMessagesDescriptor("minimax", "minimax", "https://api.minimax.io/anthropic"),
	anthropicMessagesDescriptor("minimax-cn", "minimax-cn", "https://api.minimaxi.com/anthropic"),
	openAiCompletionsDescriptor("huggingface", "huggingface", "https://router.huggingface.co/v1"),
	openAiCompletionsDescriptor("kilo", "kilo", "https://api.kilo.ai/api/gateway"),
	openAiCompletionsDescriptor("moonshotai", "moonshot", "https://api.moonshot.ai/v1"),
	openAiCompletionsDescriptor("nano-gpt", "nanogpt", "https://nano-gpt.com/api/v1"),
	simpleModelsDevDescriptor("openrouter", "openrouter", "openrouter", OPENROUTER_API_ENDPOINT),
	openAiCompletionsDescriptor("synthetic", "synthetic", "https://api.synthetic.new/openai/v1"),
	openAiCompletionsDescriptor("venice", "venice", "https://api.venice.ai/api/v1", {
		transformModel: model => {
			const maxTokens = clampKimiK27CodeMaxTokens(model.id, model.maxTokens);
			return maxTokens === model.maxTokens ? model : { ...model, maxTokens };
		},
	}),
	simpleModelsDevDescriptor("ollama-cloud", "ollama-cloud", "ollama-chat", "https://ollama.com"),
	openAiCompletionsDescriptor(
		"xiaomi-token-plan-ams",
		"xiaomi-token-plan-ams",
		"https://token-plan-ams.xiaomimimo.com/v1",
	),
	openAiCompletionsDescriptor(
		"xiaomi-token-plan-cn",
		"xiaomi-token-plan-cn",
		"https://token-plan-cn.xiaomimimo.com/v1",
	),
	openAiCompletionsDescriptor(
		"xiaomi-token-plan-sgp",
		"xiaomi-token-plan-sgp",
		"https://token-plan-sgp.xiaomimimo.com/v1",
	),
	openAiCompletionsDescriptor("qwen-portal", "qwen-portal", "https://portal.qwen.ai/v1", {
		defaultContextWindow: 128000,
		defaultMaxTokens: 8192,
	}),
	openAiCompletionsDescriptor("zenmux", "zenmux", ZENMUX_OPENAI_BASE_URL, {
		filterModel: filterActiveToolCallModels,
		resolveApi: modelId => {
			if (modelId.startsWith("anthropic/")) {
				return { api: "anthropic-messages" as const, baseUrl: ZENMUX_ANTHROPIC_BASE_URL };
			}
			return { api: "openai-completions" as const, baseUrl: ZENMUX_OPENAI_BASE_URL };
		},
	}),
];

export const MODELS_DEV_PROVIDER_DESCRIPTORS: readonly ModelsDevProviderDescriptor[] = [
	...MODELS_DEV_PROVIDER_DESCRIPTORS_BEDROCK,
	...MODELS_DEV_PROVIDER_DESCRIPTORS_GOOGLE_VERTEX,
	...MODELS_DEV_PROVIDER_DESCRIPTORS_CORE,
	...MODELS_DEV_PROVIDER_DESCRIPTORS_CODING_PLANS,
	...MODELS_DEV_PROVIDER_DESCRIPTORS_SPECIALIZED,
];
