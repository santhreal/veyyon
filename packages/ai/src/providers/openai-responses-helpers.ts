import * as logger from "@veyyon/utils/logger";
import type { Context, Model, Tool, ToolChoice } from "../types";
import { normalizeSystemPrompts, resolveCacheRetention } from "../utils";
import {
	adaptSchemaForStrict,
	findStrictToolSchemaViolation,
	NO_STRICT,
	sanitizeSchemaForOpenAIResponses,
	toolWireSchema,
} from "../utils/schema";
import {
	isForcedToolChoice,
	mapToOpenAIResponsesToolChoice,
	type OpenAIResponsesToolChoice,
} from "../utils/tool-choice";
import { compactGrammarDefinition } from "./grammar";
import { isOfficialOpenAIResponsesEndpoint, resolveOpenAIPromptCachePolicy } from "./openai-prompt-cache";
import {
	buildDeveloperSystemInput,
	maybeAddOpenRouterAnthropicCacheControl,
	type OpenAIResponsesOptions,
	type OpenAIResponsesProviderSessionState,
	type OpenAIResponsesSamplingParams,
} from "./openai-responses";
import type { Tool as OpenAITool } from "./openai-responses-wire";
import {
	applyCommonResponsesSamplingParams,
	applyOpenAIExtraBody,
	applyOpenAIGatewayRouting,
	applyResponsesCompatPolicy,
	applyWireModelIdTransform,
	buildResponsesInput,
	getOpenAIPromptCacheKey,
	getOpenRouterResponsesSessionId,
	isStrictToolsDisabledForScope,
	type OpenAIStrictToolsScope,
	resolveOpenAICompatPolicy,
	resolveOpenAIOutputTokenParam,
} from "./openai-shared";

export function buildParams(
	model: Model<"openai-responses">,
	context: Context,
	options: OpenAIResponsesOptions | undefined,
	providerSessionState: OpenAIResponsesProviderSessionState | undefined,
	strictToolsScope?: OpenAIStrictToolsScope,
	disableStrictToolsOverride = false,
): { params: OpenAIResponsesSamplingParams; strictToolsApplied: boolean } {
	const policy = resolveOpenAICompatPolicy(model, {
		endpoint: "responses",
		reasoning: options?.reasoning,
		disableReasoning: options?.disableReasoning,
		toolChoice: options?.toolChoice,
		strictResponsesPairing: options?.strictResponsesPairing,
		includeEncryptedReasoning: options?.includeEncryptedReasoning,
		filterReasoningHistory: options?.filterReasoningHistory,
		omitReasoningEffort: options?.omitReasoningEffort,
	});
	const strictResponsesPairing = policy.tools.strictResponsesPairing;
	const shouldReplayNativeHistory = providerSessionState?.nativeHistoryReplayWarmed ?? true;
	const messages = buildResponsesInput({
		model,
		context,
		strictResponsesPairing,
		supportsImageDetailOriginal: model.compat.supportsImageDetailOriginal,
		supportsDeveloperRole: policy.messages.supportsDeveloperRole,
		nativeHistory: {
			replay: shouldReplayNativeHistory,
			filterReasoning: policy.reasoning.filterReasoningHistory,
		},
		includeThinkingSignatures: shouldReplayNativeHistory && !policy.reasoning.filterReasoningHistory,
		repairOrphanOutputs: true,
	});

	const cacheRetention = resolveCacheRetention(options?.cacheRetention);
	const promptCacheKey = getOpenAIPromptCacheKey(options);
	const cachePolicy = resolveOpenAIPromptCachePolicy({
		model,
		promptCacheKey,
		cacheRetention,
	});
	const systemPrompts = normalizeSystemPrompts(context.systemPrompt);
	let systemInstructions: string | undefined;
	if (systemPrompts.length > 0) {
		const needsDeveloperRole = policy.messages.systemRole === "developer";
		if (needsDeveloperRole) {
			messages.unshift(...buildDeveloperSystemInput(systemPrompts, cachePolicy));
		} else {
			systemInstructions = systemPrompts.join("\n\n");
		}
	}

	const modelId = applyWireModelIdTransform(
		model.requestModelId ?? model.id,
		model.compat.wireModelIdMode,
		options?.openrouterVariant,
	);
	const params: OpenAIResponsesSamplingParams = {
		model: modelId,
		input: messages,
		instructions: systemInstructions,
		stream: true,
		prompt_cache_key: promptCacheKey,
		prompt_cache_retention: cachePolicy.promptCacheRetention,
		session_id: model.compat.isOpenRouterHost ? getOpenRouterResponsesSessionId(options) : undefined,
		store: false,
		stream_options: model.compat.supportsObfuscationOptOut ? { include_obfuscation: false } : undefined,
	};
	maybeAddOpenRouterAnthropicCacheControl(params, model, cacheRetention);
	const outputToken = resolveOpenAIOutputTokenParam({
		field: "max_output_tokens",
		maxTokens: options?.maxTokens,
		maxTokensExplicit: options?.maxTokensExplicit ?? options?.maxTokens !== undefined,
		modelMaxTokens: model.maxTokens,
		omitMaxOutputTokens: model.omitMaxOutputTokens ?? false,
		routedUpstreamSelfCaps: model.compat.routedUpstreamSelfCaps,
		alwaysSendMaxTokens: model.compat.alwaysSendMaxTokens,
	});

	applyCommonResponsesSamplingParams(params, { ...options, maxTokens: outputToken?.value }, model);
	if (options?.textVerbosity && isOfficialOpenAIResponsesEndpoint(model)) {
		params.text = { ...params.text, verbosity: options.textVerbosity };
	}

	let strictToolsApplied = false;
	if (context.tools) {
		const disableStrictTools =
			disableStrictToolsOverride || isStrictToolsDisabledForScope(providerSessionState, strictToolsScope);
		const strictMode = !disableStrictTools && model.compat.supportsStrictMode !== false;
		params.tools = convertTools(context.tools, strictMode, model);
		strictToolsApplied = params.tools.some(t => (t as { strict?: boolean }).strict === true);
		if (options?.toolChoice) {
			const emittedNames = new Set(
				params.tools.map(t => (t as { name?: string }).name).filter((n): n is string => n !== undefined),
			);
			const survivingTools =
				params.tools.length === context.tools.length
					? context.tools
					: context.tools.filter(t => emittedNames.has(t.customWireName ?? t.name));
			const toolChoice = mapOpenAIResponsesToolChoiceForTools(options.toolChoice, survivingTools, model);
			if (toolChoice !== undefined && params.tools.length > 0) {
				params.tool_choice = toolChoice;
			}
		}
	}

	const reasoningPolicy = resolveOpenAICompatPolicy(model, {
		endpoint: "responses",
		reasoning: options?.reasoning,
		disableReasoning: options?.disableReasoning,
		toolChoice: params.tool_choice,
		strictResponsesPairing: options?.strictResponsesPairing,
		includeEncryptedReasoning: options?.includeEncryptedReasoning,
		filterReasoningHistory: options?.filterReasoningHistory,
		omitReasoningEffort: options?.omitReasoningEffort,
	});
	const reasoningSummary =
		model.provider === "xai-oauth"
			? options?.reasoning === undefined
				? undefined
				: null
			: options?.reasoningSummary;
	applyResponsesCompatPolicy(params, reasoningPolicy, {
		reasoningSummary,
		mapEffort: effort =>
			model.compat.reasoningEffortMap?.[effort as NonNullable<OpenAIResponsesOptions["reasoning"]>] ??
			model.thinking?.effortMap?.[effort as NonNullable<OpenAIResponsesOptions["reasoning"]>] ??
			effort,
	});
	if (model.reasoningMode) {
		params.reasoning = { ...params.reasoning, mode: model.reasoningMode };
	}

	applyOpenAIGatewayRouting(params, model.compat);

	applyOpenAIExtraBody(params, options?.extraBody);

	return { params, strictToolsApplied };
}

export function supportsFreeformApplyPatch(
	model: Model<"openai-responses" | "azure-openai-responses" | "openai-codex-responses">,
): boolean {
	return model.applyPatchToolType === "freeform";
}

export function mapOpenAIResponsesToolChoiceForTools(
	choice: ToolChoice | undefined,
	tools: Tool[],
	model: Model<"openai-responses">,
): OpenAIResponsesToolChoice {
	if (!model.compat.supportsToolChoice) return undefined;
	if (isForcedToolChoice(choice) && !model.compat.supportsForcedToolChoice) {
		return "auto";
	}
	const mapped = mapToOpenAIResponsesToolChoice(choice);
	if (!mapped || typeof mapped === "string" || mapped.type !== "function") {
		return mapped;
	}

	const directTool = tools.find(tool => tool.name === mapped.name);
	const customTool = supportsFreeformApplyPatch(model)
		? tools.find(tool => tool.customFormat && (tool.name === mapped.name || tool.customWireName === mapped.name))
		: undefined;
	const offeredTool = customTool ?? directTool;
	if (!offeredTool) {
		return undefined;
	}
	return customTool ? { type: "custom", name: customTool.customWireName ?? customTool.name } : mapped;
}

export function convertTools(
	tools: Tool[],
	strictMode: boolean,
	model: Model<"openai-responses" | "azure-openai-responses" | "openai-codex-responses">,
	onQuarantine: (toolName: string, schemaPath: string) => void = (toolName, schemaPath) =>
		logger.warn(
			`Tool "${toolName}" omitted from the openai-responses request: its parameter schema is invalid for this provider at ${schemaPath} (an enum/const value cannot match its declared type). Other tools are unaffected.`,
		),
): OpenAITool[] {
	const allowFreeform = supportsFreeformApplyPatch(model);
	const out: OpenAITool[] = [];
	for (const tool of tools) {
		if (allowFreeform && tool.customFormat) {
			out.push({
				type: "custom",
				name: tool.customWireName ?? tool.name,
				description: tool.description || "",
				format: {
					type: "grammar",
					syntax: tool.customFormat.syntax,
					definition: compactGrammarDefinition(tool.customFormat.syntax, tool.customFormat.definition),
				},
			} as unknown as OpenAITool);
			continue;
		}
		const strict = !NO_STRICT && strictMode && tool.strict !== false;
		const baseParameters = toolWireSchema(tool);
		const responseParameters = sanitizeSchemaForOpenAIResponses(baseParameters);
		const { schema: parameters, strict: effectiveStrict } = adaptSchemaForStrict(responseParameters, strict);
		const violation = findStrictToolSchemaViolation(parameters);
		if (violation) {
			onQuarantine(tool.name, violation);
			continue;
		}
		out.push({
			type: "function",
			name: tool.name,
			description: tool.description || "",
			parameters,
			...(effectiveStrict
				? { strict: true }
				: !NO_STRICT && strictMode && tool.strict === false
					? { strict: false }
					: {}),
		} as OpenAITool);
	}
	return out;
}
