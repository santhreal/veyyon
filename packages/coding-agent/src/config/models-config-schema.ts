import { THINKING_EFFORTS } from "@veyyon/catalog/effort";
import { scope } from "arktype";

// Schema construction is deferred behind modelsConfigSchemas(): even with the jitless scope below (~65% cheaper than default ArkType codegen), building
function buildModelsConfigSchemas() {
	// Config schemas validate at most a handful of times per process (on config load), so the eager JIT codegen ArkType runs at definition time is pure
	const { type } = scope({}, { jitless: true });

	const OpenRouterRoutingSchema = type({
		"only?": "string[]",
		"order?": "string[]",
	});

	const VercelGatewayRoutingSchema = type({
		"only?": "string[]",
		"order?": "string[]",
	});

	// `"+": "reject"` because every key here NAMES a thinking level, and a key that names no level cannot do anything. ArkType allows undeclared keys by
	const ReasoningEffortMapSchema = type({
		"+": "reject",
		"minimal?": "string",
		"low?": "string",
		"medium?": "string",
		"high?": "string",
		"xhigh?": "string",
		"max?": "string",
	});

	const OpenAICompatFields = {
		"supportsStore?": "boolean",
		"supportsDeveloperRole?": "boolean",
		"supportsMultipleSystemMessages?": "boolean",
		"supportsReasoningEffort?": "boolean",
		"reasoningEffortMap?": ReasoningEffortMapSchema,
		"maxTokensField?": '"max_completion_tokens" | "max_tokens"',
		"supportsUsageInStreaming?": "boolean",
		"requiresToolResultName?": "boolean",
		"requiresMistralToolIds?": "boolean",
		"requiresAssistantAfterToolResult?": "boolean",
		"requiresThinkingAsText?": "boolean",
		"reasoningContentField?": '"reasoning_content" | "reasoning" | "reasoning_text"',
		"requiresReasoningContentForToolCalls?": "boolean",
		"allowsSyntheticReasoningContentForToolCalls?": "boolean",
		"requiresAssistantContentForToolCalls?": "boolean",
		"supportsToolChoice?": "boolean",
		"supportsForcedToolChoice?": "boolean",
		"disableReasoningOnForcedToolChoice?": "boolean",
		"disableReasoningOnToolChoice?": "boolean",
		"thinkingFormat?": '"openai" | "openrouter" | "zai" | "qwen" | "qwen-chat-template"',
		"openRouterRouting?": OpenRouterRoutingSchema,
		"vercelGatewayRouting?": VercelGatewayRoutingSchema,
		"extraBody?": { "[string]": "unknown" },
		"cacheControlFormat?": '"anthropic"',
		"supportsStrictMode?": "boolean",
		"toolStrictMode?": '"all_strict" | "none"',
		"streamIdleTimeoutMs?": "number >= 0",
		"supportsLongPromptCacheRetention?": "boolean",
		"supportsReasoningParams?": "boolean",
		"alwaysSendMaxTokens?": "boolean",
		"strictResponsesPairing?": "boolean",
		"supportsImageDetailOriginal?": "boolean",
		"supportsServerCompaction?": "boolean",
		// anthropic-messages compat flags (same `compat` slot, per-api interpretation)
		"requiresToolResultId?": "boolean",
		"replayUnsignedThinking?": "boolean",
	} as const;

	const OpenAICompatFieldsSchema = type(OpenAICompatFields);

	const OpenAICompatSchema = type({
		...OpenAICompatFields,
		"whenThinking?": OpenAICompatFieldsSchema,
	});

	const ApiSchema = type(
		'"openai-completions" | "openai-responses" | "openai-codex-responses" | "azure-openai-responses" | "anthropic-messages" | "google-generative-ai" | "google-gemini-cli" | "google-vertex"',
	);

	// ArkType infers a literal union only from a literal definition, so the six levels are spelled here rather than built from `THINKING_EFFORTS`: a
	const EffortSchema = type('"minimal" | "low" | "medium" | "high" | "xhigh" | "max"');

	const ThinkingControlModeSchema = type(
		'"effort" | "budget" | "google-level" | "anthropic-adaptive" | "anthropic-budget-effort"',
	);

	/** Fail closed if the schema's literals and the ladder in `@veyyon/catalog/effort` disagree. */
	for (const effort of THINKING_EFFORTS) {
		if (EffortSchema(effort) instanceof type.errors) {
			throw new Error(
				`models config schema does not accept the effort level "${effort}". ` +
					`@veyyon/catalog/effort owns the ladder (${THINKING_EFFORTS.join(", ")}); add the level to ` +
					`EffortSchema and ReasoningEffortMapSchema in packages/coding-agent/src/config/models-config-schema.ts.`,
			);
		}
	}

	// The ladder itself is not restated. `THINKING_EFFORTS` is `readonly Effort[]` and TypeScript does not consider a string-enum member assignable to its own
	const EFFORT_ORDER = THINKING_EFFORTS as readonly (typeof EffortSchema.infer)[];

	/** Accepts the canonical `efforts` vocabulary plus the legacy `minLevel`/`maxLevel`/`levels` range shape, normalizing both to */
	const ModelThinkingSchema = type({
		mode: ThinkingControlModeSchema,
		"efforts?": EffortSchema.array(),
		"defaultLevel?": EffortSchema,
		"effortMap?": ReasoningEffortMapSchema,
		"supportsDisplay?": "boolean",
		// Legacy range vocabulary (pre-efforts configs).
		"minLevel?": EffortSchema,
		"maxLevel?": EffortSchema,
		"levels?": EffortSchema.array(),
	})
		.narrow(
			(value, ctx) =>
				value.efforts !== undefined ||
				value.levels !== undefined ||
				(value.minLevel !== undefined && value.maxLevel !== undefined) ||
				ctx.mustBe("thinking with `efforts` (or legacy `levels`/`minLevel`+`maxLevel`)"),
		)
		.pipe(value => {
			let resolved = value.efforts ?? value.levels;
			if (!resolved) {
				const minIndex = EFFORT_ORDER.indexOf(value.minLevel!);
				const maxIndex = EFFORT_ORDER.indexOf(value.maxLevel!);
				resolved = EFFORT_ORDER.slice(minIndex, Math.max(minIndex, maxIndex) + 1);
			}
			return {
				mode: value.mode,
				efforts: resolved,
				...(value.defaultLevel !== undefined && { defaultLevel: value.defaultLevel }),
				...(value.effortMap !== undefined && { effortMap: value.effortMap }),
				...(value.supportsDisplay !== undefined && { supportsDisplay: value.supportsDisplay }),
			};
		});

	// `remoteCompaction` is RETIRED. Nothing has read it since per-provider compaction configuration went away, so a config that still sets it
	const RetiredRemoteCompactionSchema = type("unknown");

	const ModelDefinitionSchema = type({
		id: "string",
		"name?": "string",
		"api?": ApiSchema,
		"baseUrl?": "string",
		"reasoning?": "boolean",
		"thinking?": ModelThinkingSchema,
		"input?": '("text" | "image")[]',
		"supportsTools?": "boolean",
		"cost?": {
			input: "number",
			output: "number",
			cacheRead: "number",
			cacheWrite: "number",
		},
		"premiumMultiplier?": "number",
		"contextWindow?": "number",
		"maxTokens?": "number",
		"omitMaxOutputTokens?": "boolean",
		"headers?": { "[string]": "string" },
		"compat?": OpenAICompatSchema,
		"contextPromotionTarget?": "string",
		"compactionModel?": "string",
		"remoteCompaction?": RetiredRemoteCompactionSchema,
	}).narrow((value, ctx) => {
		// Enforce id non-empty
		if (typeof value.id === "string" && value.id.length === 0) {
			return ctx.mustBe("id a non-empty string");
		}
		if (value.name !== undefined && typeof value.name === "string" && value.name.length === 0) {
			return ctx.mustBe("name a non-empty string");
		}
		if (value.baseUrl !== undefined && typeof value.baseUrl === "string" && value.baseUrl.length === 0) {
			return ctx.mustBe("baseUrl a non-empty string");
		}
		if (
			value.contextPromotionTarget !== undefined &&
			typeof value.contextPromotionTarget === "string" &&
			value.contextPromotionTarget.length === 0
		) {
			return ctx.mustBe("contextPromotionTarget a non-empty string");
		}
		if (
			value.compactionModel !== undefined &&
			typeof value.compactionModel === "string" &&
			value.compactionModel.length === 0
		) {
			return ctx.mustBe("compactionModel a non-empty string");
		}
		return true;
	});

	const ModelOverrideSchema = type({
		"name?": "string",
		"reasoning?": "boolean",
		"thinking?": ModelThinkingSchema,
		"input?": '("text" | "image")[]',
		"supportsTools?": "boolean",
		"cost?": {
			"input?": "number",
			"output?": "number",
			"cacheRead?": "number",
			"cacheWrite?": "number",
		},
		"premiumMultiplier?": "number",
		"contextWindow?": "number",
		"maxTokens?": "number",
		"omitMaxOutputTokens?": "boolean",
		"headers?": { "[string]": "string" },
		"compat?": OpenAICompatSchema,
		"contextPromotionTarget?": "string",
		"compactionModel?": "string",
		"remoteCompaction?": RetiredRemoteCompactionSchema,
	}).narrow((value, ctx) => {
		if (value.name !== undefined && typeof value.name === "string" && value.name.length === 0) {
			return ctx.mustBe("name a non-empty string");
		}
		if (
			value.contextPromotionTarget !== undefined &&
			typeof value.contextPromotionTarget === "string" &&
			value.contextPromotionTarget.length === 0
		) {
			return ctx.mustBe("contextPromotionTarget a non-empty string");
		}
		if (
			value.compactionModel !== undefined &&
			typeof value.compactionModel === "string" &&
			value.compactionModel.length === 0
		) {
			return ctx.mustBe("compactionModel a non-empty string");
		}
		return true;
	});

	const ProviderDiscoverySchema = type({
		type: '"ollama" | "llama.cpp" | "lm-studio" | "openai-models-list" | "proxy" | "litellm"',
	});

	const ProviderAuthSchema = type('"apiKey" | "none" | "oauth"');

	const ProviderConfigSchema = type({
		"baseUrl?": "string",
		"apiKey?": "string",
		"api?": ApiSchema,
		"headers?": { "[string]": "string" },
		"compat?": OpenAICompatSchema,
		"remoteCompaction?": RetiredRemoteCompactionSchema,
		"authHeader?": "boolean",
		"auth?": ProviderAuthSchema,
		"discovery?": ProviderDiscoverySchema,
		"models?": ModelDefinitionSchema.array(),
		"modelOverrides?": { "[string]": ModelOverrideSchema },
		"disableStrictTools?": "boolean",
		/** Streaming transport override. When set to `"pi-native"`, veyyon dispatches every model under this provider via the auth-gateway's */
		"transport?": '"pi-native"',
	}).narrow((value, ctx) => {
		if (value.baseUrl !== undefined && typeof value.baseUrl === "string" && value.baseUrl.length === 0) {
			return ctx.mustBe("baseUrl a non-empty string");
		}
		if (value.apiKey !== undefined && typeof value.apiKey === "string" && value.apiKey.length === 0) {
			return ctx.mustBe("apiKey a non-empty string");
		}
		return true;
	});

	const ModelsConfigSchema = type({
		"providers?": { "[string]": ProviderConfigSchema },
	});

	return { OpenAICompatSchema, ModelOverrideSchema, ProviderDiscoverySchema, ProviderAuthSchema, ModelsConfigSchema };
}

type Schemas = ReturnType<typeof buildModelsConfigSchemas>;

let schemasCache: Schemas | undefined;

/** The models-config schema set, built lazily on first config load. */
export function modelsConfigSchemas(): Schemas {
	schemasCache ??= buildModelsConfigSchemas();
	return schemasCache;
}

export type ModelOverride = Schemas["ModelOverrideSchema"]["infer"];
export type ProviderAuthMode = Schemas["ProviderAuthSchema"]["infer"];
export type ProviderDiscovery = Schemas["ProviderDiscoverySchema"]["infer"];
export type ModelsConfig = Schemas["ModelsConfigSchema"]["infer"];
