import { createHash, randomBytes, randomUUID } from "node:crypto";
import { ANTIGRAVITY_SYSTEM_INSTRUCTION, getAntigravityModelWireProfile } from "@veyyon/catalog/wire/gemini-headers";
import type { Context, Model, TextContent } from "../types";
import { normalizeSystemPrompts } from "../utils";
import { normalizeSchemaForCCA } from "../utils/schema";
import type { FunctionCallingConfigMode, ThinkingLevel } from "./google-shared";
import { convertMessages, convertTools, type GoogleThinkingLevel, mapToolChoice } from "./google-shared";

export type { GoogleThinkingLevel };

import {
	type AntigravityProviderSessionState,
	type CloudCodeAssistRequest,
	type GoogleGeminiCliOptions,
	getAntigravityProviderSessionState,
	isClaudeModel,
	shouldInjectAntigravitySystemInstruction,
} from "./google-gemini-cli";

export const INT63_MASK = (1n << 63n) - 1n;
export const ANTIGRAVITY_RANDOM_BOUND = 9_000_000_000_000_000_000n;

function formatSignedDecimalSessionId(value: bigint): string {
	return `-${value.toString()}`;
}

function deriveSignedDecimalFromHash(text: string): string {
	const digest = createHash("sha256").update(text).digest();
	let value = 0n;
	for (let index = 0; index < 8; index += 1) {
		value = (value << 8n) | BigInt(digest[index] ?? 0);
	}
	return formatSignedDecimalSessionId(value & INT63_MASK);
}

function randomBoundedInt63(maxExclusive: bigint): bigint {
	while (true) {
		const bytes = randomBytes(8);
		let value = 0n;
		for (const byte of bytes) {
			value = (value << 8n) | BigInt(byte);
		}
		value &= INT63_MASK;
		if (value < maxExclusive) {
			return value;
		}
	}
}

function randomSignedDecimalSessionId(): string {
	return formatSignedDecimalSessionId(randomBoundedInt63(ANTIGRAVITY_RANDOM_BOUND));
}

function getFirstUserTextForAntigravitySession(context: Context): string | undefined {
	for (const message of context.messages) {
		if (message.role !== "user") {
			continue;
		}

		if (typeof message.content === "string") {
			return message.content;
		}

		if (Array.isArray(message.content)) {
			const firstTextPart = message.content.find((item): item is TextContent => item.type === "text");
			return firstTextPart?.text;
		}

		return undefined;
	}

	return undefined;
}

function deriveAntigravitySessionId(context: Context): string {
	const text = getFirstUserTextForAntigravitySession(context);
	if (text && text.trim().length > 0) {
		return deriveSignedDecimalFromHash(text);
	}

	return randomSignedDecimalSessionId();
}

function normalizeAntigravityTools(
	tools: CloudCodeAssistRequest["request"]["tools"],
): CloudCodeAssistRequest["request"]["tools"] {
	return tools?.map(tool => ({
		...tool,
		functionDeclarations: tool.functionDeclarations.map(declaration => {
			if ("parameters" in declaration) {
				return declaration;
			}

			const { parametersJsonSchema, ...rest } = declaration;
			return {
				...rest,
				parameters: normalizeSchemaForCCA(parametersJsonSchema),
			};
		}),
	}));
}

export interface AntigravityRequestEnvelope {
	sessionId: string;
	requestId: string;
	labels: Record<string, string>;
}

function buildAntigravityRequestEnvelope(
	model: Model<"google-gemini-cli">,
	context: Context,
	wireModelId: string,
	state: AntigravityProviderSessionState | undefined,
): AntigravityRequestEnvelope {
	if (state) {
		state.agentId ??= randomUUID();
		state.trajectoryId ??= randomUUID();
		state.sessionId ??= randomSignedDecimalSessionId();
		state.stepIndex = (state.stepIndex ?? 1) + 1;
	}
	const agentId = state?.agentId ?? randomUUID();
	const trajectoryId = state?.trajectoryId ?? randomUUID();
	const sessionId = state?.sessionId ?? deriveAntigravitySessionId(context);
	const step = state?.stepIndex ?? 2;
	const requestId = `agent/${agentId}/${Date.now()}/${trajectoryId}/${step}`;
	const isClaude = isClaudeModel(model.id);
	const profile = getAntigravityModelWireProfile(wireModelId);
	const labels: Record<string, string> = {};
	if (state?.lastExecutionId) labels.last_execution_id = state.lastExecutionId;
	labels.last_step_index = String(step - 1);
	if (profile?.modelEnum !== undefined) labels.model_enum = profile.modelEnum;
	labels.trajectory_id = trajectoryId;
	labels.used_claude = String(isClaude);
	labels.used_claude_conservative = String(isClaude);
	return { sessionId, requestId, labels };
}

export function buildRequest(
	model: Model<"google-gemini-cli">,
	context: Context,
	projectId: string,
	options: GoogleGeminiCliOptions = {},
	isAntigravity = false,
): CloudCodeAssistRequest {
	const systemPrompts = normalizeSystemPrompts(context.systemPrompt);
	const contents = convertMessages(model, context);
	const generationConfig: CloudCodeAssistRequest["request"]["generationConfig"] = {};
	if (options.temperature !== undefined) {
		generationConfig.temperature = options.temperature;
	}
	if (options.maxTokens !== undefined) {
		generationConfig.maxOutputTokens = options.maxTokens;
	}
	if (options.topP !== undefined) {
		generationConfig.topP = options.topP;
	}
	if (options.topK !== undefined) {
		generationConfig.topK = options.topK;
	}
	if (options.minP !== undefined) {
		generationConfig.minP = options.minP;
	}
	if (options.presencePenalty !== undefined) {
		generationConfig.presencePenalty = options.presencePenalty;
	}
	if (options.repetitionPenalty !== undefined) {
		generationConfig.repetitionPenalty = options.repetitionPenalty;
	}

	if (options.thinking?.enabled && model.reasoning) {
		generationConfig.thinkingConfig = {
			includeThoughts: !options.hideThinkingSummary,
		};
		if (options.thinking.level !== undefined) {
			generationConfig.thinkingConfig.thinkingLevel = options.thinking.level as ThinkingLevel;
		} else if (options.thinking.budgetTokens !== undefined) {
			generationConfig.thinkingConfig.thinkingBudget = options.thinking.budgetTokens;
		}
	} else if (options.thinking?.suppress && model.reasoning) {
		const suppress = options.thinking.suppress;
		generationConfig.thinkingConfig = { includeThoughts: false };
		if ("level" in suppress) {
			generationConfig.thinkingConfig.thinkingLevel = suppress.level as ThinkingLevel;
		} else {
			generationConfig.thinkingConfig.thinkingBudget = suppress.budget;
		}
	}

	const request: CloudCodeAssistRequest["request"] = {
		contents,
	};

	// System instruction is an object with parts, not a plain string. Antigravity
	if (systemPrompts.length > 0) {
		request.systemInstruction = {
			...(isAntigravity ? { role: "user" } : {}),
			parts: systemPrompts.map(text => ({ text })),
		};
	}

	if (isAntigravity && shouldInjectAntigravitySystemInstruction(model.id)) {
		const existingParts = request.systemInstruction?.parts ?? [];
		request.systemInstruction = {
			role: "user",
			parts: [{ text: ANTIGRAVITY_SYSTEM_INSTRUCTION }, ...existingParts],
		};
	}

	if (context.tools && context.tools.length > 0) {
		const convertedTools = convertTools(context.tools, model);
		request.tools = isAntigravity ? normalizeAntigravityTools(convertedTools) : convertedTools;
		if (options.toolChoice) {
			const choice = options.toolChoice;
			if (typeof choice === "string") {
				const mode = mapToolChoice(choice);
				if (mode !== "AUTO") {
					request.toolConfig = {
						functionCallingConfig: { mode },
					};
				}
			} else {
				request.toolConfig = {
					functionCallingConfig: {
						mode: "ANY",
						allowedFunctionNames: choice.allowedFunctionNames.slice(),
					},
				};
			}
		}
		// Antigravity's default tool mode is VALIDATED (verified for Gemini and
		if (isAntigravity && !request.toolConfig) {
			request.toolConfig = {
				functionCallingConfig: { mode: "VALIDATED" as FunctionCallingConfigMode },
			};
		}
	}

	// Claude on Antigravity always forces VALIDATED, even with no tools declared.
	if (isAntigravity && isClaudeModel(model.id)) {
		request.toolConfig = {
			functionCallingConfig: {
				mode: "VALIDATED" as FunctionCallingConfigMode,
			},
		};
	}

	const wireModelId = options.requestModelId ?? model.requestModelId ?? model.id;

	if (isAntigravity) {
		const profile = getAntigravityModelWireProfile(wireModelId);
		if (profile) {
			generationConfig.maxOutputTokens = profile.maxOutputTokens;
		}
		const state = getAntigravityProviderSessionState(options.providerSessionState);
		const envelope = buildAntigravityRequestEnvelope(model, context, wireModelId, state);
		request.labels = envelope.labels;
		if (Object.keys(generationConfig).length > 0) {
			request.generationConfig = generationConfig;
		}
		request.sessionId = envelope.sessionId;
		return {
			project: projectId,
			requestId: envelope.requestId,
			request,
			model: wireModelId,
			userAgent: "antigravity",
			requestType: "agent",
		};
	}

	if (Object.keys(generationConfig).length > 0) {
		request.generationConfig = generationConfig;
	}

	return {
		project: projectId,
		model: wireModelId,
		request,
	};
}
