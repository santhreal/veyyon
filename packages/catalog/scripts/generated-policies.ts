import { buildCompat } from "../src/build";
import {
	type AnthropicModel,
	bareModelId,
	isFableOrMythos,
	type OpenAIModel,
	type OpenAIVariant,
	type ParsedModel,
	parseKnownModel,
	semverEqual,
} from "../src/identity/classify";
import { isMimoModelIdOrName } from "../src/identity/family";
import { getLongestModelLikeIdSegment } from "../src/identity/id";
import { buildModelReferenceIndex, resolveModelReference } from "../src/identity/reference";
import { resolveModelThinking } from "../src/model-thinking";
import { PROVIDERS_PUBLISHING_OWN_MODEL_LIMITS } from "../src/provider-models/descriptors";
import { resolveWaferServerlessThinkingFormat } from "../src/provider-models/openai-compat";
import type { Api, Model, ModelSpec } from "../src/types";
import { isVariantCollapsedSpec } from "../src/variant-collapse";
import { buildCanonicalModelIndex, buildCanonicalReferenceData } from "./equivalence";

const CLOUDFLARE_AI_GATEWAY_BASE_URL = "https://gateway.ai.cloudflare.com/v1/<account>/<gateway>/anthropic";

export const CLOUDFLARE_FALLBACK_MODEL: ModelSpec<"anthropic-messages"> = {
	id: "claude-sonnet-4-5",
	name: "Claude Sonnet 4.5",
	api: "anthropic-messages",
	provider: "cloudflare-ai-gateway",
	baseUrl: CLOUDFLARE_AI_GATEWAY_BASE_URL,
	reasoning: true,
	input: ["text", "image"],
	cost: {
		input: 3,
		output: 15,
		cacheRead: 0.3,
		cacheWrite: 3.75,
	},
	contextWindow: 200000,
	maxTokens: 64000,
};

const CODEX_GPT_5_4_PRIORITY_BY_VARIANT: Partial<Record<OpenAIVariant, number>> = {
	base: 0,
	mini: 1,
	nano: 2,
};

const COPILOT_GENERATED_LIMITS: Record<string, { contextWindow: number; maxTokens: number }> = {
	"claude-opus-4.6": { contextWindow: 168000, maxTokens: 32000 },
	"gpt-5.2": { contextWindow: 272000, maxTokens: 128000 },
	"gpt-5.4": { contextWindow: 272000, maxTokens: 128000 },
	"gpt-5.4-mini": { contextWindow: 272000, maxTokens: 128000 },
	"grok-code-fast-1": { contextWindow: 192000, maxTokens: 64000 },
};

export function applyGeneratedModelPolicies(models: ModelSpec<Api>[]): void {
	for (const model of models) {
		applyGeneratedModelPolicy(model);
		rebakeModelThinking(model);
	}
}

export function rebakeModelThinking(model: ModelSpec<Api>): void {
	if (isVariantCollapsedSpec(model)) return;
	const requiresProviderAuthoredEffort =
		model.provider === "umans" && (model.thinking?.requiresEffort === true || model.id === "umans-kimi-k2.7");
	const thinking = resolveModelThinking({ ...model, thinking: undefined }, buildCompat(model));
	if (thinking) {
		model.thinking = requiresProviderAuthoredEffort ? { ...thinking, requiresEffort: true } : thinking;
	} else {
		delete model.thinking;
	}
}

export function linkOpenAIPromotionTargets(models: ModelSpec<Api>[]): void {
	for (const candidate of models) {
		const parsedCandidate = parseKnownModel(candidate.id);
		if (parsedCandidate.family !== "openai") continue;
		let targetVersion: string | undefined;
		if (parsedCandidate.variant === "codex-spark") {
			targetVersion = "5.5";
		} else if (semverEqual(parsedCandidate.version, "5.5")) {
			targetVersion = "5.4";
		} else {
			continue;
		}
		let fallback: ModelSpec<Api> | undefined;
		let fallbackBareLength = Number.POSITIVE_INFINITY;
		for (const model of models) {
			if (model === candidate) continue;
			if (model.provider !== candidate.provider || model.api !== candidate.api) continue;
			const parsed = parseKnownModel(model.id);
			if (parsed.family !== "openai" || !semverEqual(parsed.version, targetVersion)) continue;
			const bareLength = bareModelId(model.id).length;
			if (bareLength < fallbackBareLength) {
				fallback = model;
				fallbackBareLength = bareLength;
			}
		}
		if (!fallback) continue;
		candidate.contextPromotionTarget = `${fallback.provider}/${fallback.id}`;
	}
}

export function applyCanonicalLimitFallback(models: ModelSpec<Api>[]): void {
	if (!models.some(model => model.contextWindow === null || model.maxTokens === null)) {
		return;
	}
	const catalog = models as unknown as readonly Model<Api>[];
	const referenceData = buildCanonicalReferenceData(catalog);
	const canonicalIndex = buildCanonicalModelIndex(catalog, referenceData);
	const referenceIndex = buildModelReferenceIndex(catalog);

	for (const model of models) {
		if (PROVIDERS_PUBLISHING_OWN_MODEL_LIMITS.has(model.provider)) {
			continue;
		}
		if (model.contextWindow !== null && model.maxTokens !== null) {
			continue;
		}
		const canonicalId = canonicalIndex.bySelector.get(`${model.provider}/${model.id}`.toLowerCase());
		const segment = getLongestModelLikeIdSegment(model.id);
		const references = [
			canonicalId ? resolveModelReference(canonicalId, referenceIndex) : undefined,
			segment ? referenceIndex.suffixAlias.get(segment) : undefined,
		];
		for (const reference of references) {
			if (!reference || (reference.provider === model.provider && reference.id === model.id)) {
				continue;
			}
			if (model.contextWindow === null && reference.contextWindow !== null) {
				model.contextWindow = reference.contextWindow;
			}
			if (model.maxTokens === null && reference.maxTokens !== null) {
				model.maxTokens = reference.maxTokens;
			}
			if (model.contextWindow !== null && model.maxTokens !== null) {
				break;
			}
		}
	}
}

function applyGeneratedModelPolicy(model: ModelSpec<Api>): void {
	const copilotLimits = model.provider === "github-copilot" ? COPILOT_GENERATED_LIMITS[model.id] : undefined;
	if (copilotLimits) {
		model.contextWindow = copilotLimits.contextWindow;
		model.maxTokens = copilotLimits.maxTokens;
	}
	if (model.provider === "command-code") {
		model.maxTokens = null;
	}

	if (model.provider === "ollama-cloud") {
		model.omitMaxOutputTokens = true;
	}

	if ((model.provider === "zai" || model.provider === "zhipu-coding-plan") && model.id === "glm-5.2") {
		model.contextWindow = 1_000_000;
		model.maxTokens = 131_072;
	}
	if (
		model.id === "MiniMax-M3" &&
		(model.provider === "minimax" ||
			model.provider === "minimax-cn" ||
			model.provider === "minimax-code" ||
			model.provider === "minimax-code-cn")
	) {
		model.contextWindow = 1_000_000;
	}

	if (
		model.api === "openai-completions" &&
		(model.provider === "minimax-code" || model.provider === "minimax-code-cn")
	) {
		model.compat = {
			...(model.compat ?? {}),
			supportsStore: false,
			supportsDeveloperRole: false,
			supportsReasoningEffort: false,
			reasoningContentField: "reasoning_content",
		};
		delete model.compat.thinkingFormat;
	}
	if (model.api === "openai-completions" && model.provider === "wafer-serverless" && model.reasoning) {
		const thinkingFormat = resolveWaferServerlessThinkingFormat(model.id, undefined);
		if (thinkingFormat === "zai") {
			model.compat = {
				...(model.compat ?? {}),
				thinkingFormat,
				reasoningContentField: "reasoning_content",
				supportsDeveloperRole: false,
			};
		}
	}
	if (model.api === "openai-completions" && model.provider === "opencode-go" && isMimoModelIdOrName(model.id)) {
		model.compat = {
			...(model.compat ?? {}),
			supportsToolChoice: false,
		};
	}
	if (model.api === "openai-completions" && model.provider === "opencode-go" && model.id === "kimi-k2.7-code") {
		model.compat = {
			...(model.compat ?? {}),
			supportsForcedToolChoice: false,
		};
	}
	if (
		model.api === "openai-completions" &&
		model.provider === "opencode-go" &&
		(model.id === "deepseek-v4-flash" || model.id === "deepseek-v4-pro")
	) {
		model.compat = {
			...(model.compat ?? {}),
			supportsToolChoice: false,
			maxTokensField: "max_tokens",
			reasoningContentField: "reasoning_content",
			requiresReasoningContentForToolCalls: true,
		};
	}
	const parsedModel = parseKnownModel(model.id);
	const applyPatchToolType = inferGeneratedApplyPatchToolType(model, parsedModel);
	if (applyPatchToolType) {
		model.applyPatchToolType = applyPatchToolType;
	} else {
		delete model.applyPatchToolType;
	}
	if (parsedModel.family === "anthropic") {
		applyAnthropicCatalogPolicy(model, parsedModel);
	}
	if (parsedModel.family === "openai") {
		applyOpenAICatalogPolicy(model, parsedModel);
	}
}

function applyAnthropicCatalogPolicy(model: ModelSpec<Api>, parsedModel: AnthropicModel): void {
	if (model.provider === "anthropic" && parsedModel.kind === "opus" && semverEqual(parsedModel.version, "4.5")) {
		model.cost.cacheRead = 0.5;
		model.cost.cacheWrite = 6.25;
	}

	if (model.provider === "amazon-bedrock" && parsedModel.kind === "opus" && semverEqual(parsedModel.version, "4.6")) {
		model.cost.cacheRead = 0.5;
		model.cost.cacheWrite = 6.25;
		model.contextWindow = 1000000;
		model.maxTokens = 128000;
	}

	if (model.provider === "anthropic" && isFableOrMythos(parsedModel.kind)) {
		model.contextWindow = 1_000_000;
		model.maxTokens = 128_000;
		model.cost.input = 10;
		model.cost.output = 50;
		model.cost.cacheRead = 1;
		model.cost.cacheWrite = 12.5;
	}
}

function inferGeneratedApplyPatchToolType(
	model: ModelSpec<Api>,
	parsedModel: ParsedModel,
): ModelSpec<Api>["applyPatchToolType"] {
	if (parsedModel.family !== "openai" || parsedModel.version.major !== 5) {
		return undefined;
	}
	if (model.provider === "openai" && model.api === "openai-responses") {
		return "freeform";
	}
	if (model.provider === "openai-codex" && model.api === "openai-codex-responses") {
		return "freeform";
	}
	return undefined;
}

function applyOpenAICatalogPolicy(model: ModelSpec<Api>, parsedModel: OpenAIModel): void {
	if (parsedModel.variant.startsWith("codex") && parsedModel.variant !== "codex-spark") {
		model.contextWindow = 272000;
		return;
	}
	if (model.api === "openai-codex-responses" && semverEqual(parsedModel.version, "5.4")) {
		const normalizedPriority = CODEX_GPT_5_4_PRIORITY_BY_VARIANT[parsedModel.variant];
		if (normalizedPriority !== undefined) {
			model.priority = normalizedPriority;
		}
		if (parsedModel.variant === "mini" || parsedModel.variant === "nano") {
			model.contextWindow = 272000;
		}
	}
	if (model.api === "openai-codex-responses" && semverEqual(parsedModel.version, "5.6")) {
		model.contextWindow = 372000;
	}
}
