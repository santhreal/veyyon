import type { AssistantMessage, Message, Model, ServiceTier, StreamOptions } from "../types";
import { normalizeSchemaForGoogle } from "../utils/schema";
import type { Part } from "./google-types";

export {
	buildGoogleGenerateContentParams,
	consumeGoogleStream,
	convertMessages,
	convertTools,
	EMPTY_STREAM_BASE_DELAY_MS,
	type GoogleGenAIRequestPlan,
	hasMeaningfulGoogleContent,
	MAX_EMPTY_STREAM_RETRIES,
	mapStopReason,
	mapStopReasonString,
	mapToolChoice,
	nextToolCallId,
	pushBlockEndEvent,
	pushToolCallEvents,
	resetGoogleStreamOutputForRetry,
	startTextOrThinkingBlock,
	streamGoogleGenAI,
} from "./google-shared-helpers";
export type {
	Content,
	FunctionCallingConfigMode,
	GenerateContentParameters,
	GenerateContentResponse,
	ThinkingConfig,
	ThinkingLevel,
} from "./google-types";

export { normalizeSchemaForGoogle };

export type GoogleApiType = "google-generative-ai" | "google-gemini-cli" | "google-vertex";

export type GoogleThinkingLevel = "THINKING_LEVEL_UNSPECIFIED" | "MINIMAL" | "LOW" | "MEDIUM" | "HIGH";

export interface GoogleSharedStreamOptions extends StreamOptions {
	toolChoice?: "auto" | "none" | "any" | { mode: "ANY"; allowedFunctionNames: [string, ...string[]] };
	thinking?: {
		enabled: boolean;
		budgetTokens?: number;
		level?: GoogleThinkingLevel;
	};
	hideThinkingSummary?: boolean;
	serviceTier?: ServiceTier;
}

export function isThinkingPart(part: Pick<Part, "thought" | "thoughtSignature">): boolean {
	return part.thought === true;
}

export function retainThoughtSignature(existing: string | undefined, incoming: string | undefined): string | undefined {
	if (typeof incoming === "string" && incoming.length > 0) return incoming;
	return existing;
}

const base64SignaturePattern = /^[A-Za-z0-9+/]+={0,2}$/;

export const SKIP_THOUGHT_SIGNATURE = "skip_thought_signature_validator";

function isValidThoughtSignature(signature: string | undefined): signature is string {
	if (!signature) return false;
	if (signature.length % 4 !== 0) return false;
	return base64SignaturePattern.test(signature);
}

export function resolveThoughtSignature(
	isSameProviderAndModel: boolean,
	signature: string | undefined,
): string | undefined {
	return isSameProviderAndModel && isValidThoughtSignature(signature) ? signature : undefined;
}

export function firstRetainedAssistantIndex(messages: readonly Message[], retention: number | undefined): number {
	if (retention === undefined || !Number.isFinite(retention) || retention < 0) return 0;
	let remaining = Math.floor(retention);
	for (let index = messages.length - 1; index >= 0; index--) {
		if (messages[index]?.role !== "assistant") continue;
		if (remaining === 0) return index + 1;
		remaining--;
	}
	return 0;
}

export function elidedSignatureBytes(
	messages: readonly Message[],
	policy: SignaturePolicy,
	sameProviderAndModel: (message: AssistantMessage) => boolean,
): number {
	let elided = 0;
	for (let index = 0; index < messages.length; index++) {
		const message = messages[index];
		if (message?.role !== "assistant" || !sameProviderAndModel(message)) continue;
		for (const block of message.content) {
			if (block.type !== "toolCall") continue;
			if (!isValidThoughtSignature(block.thoughtSignature)) continue;
			if (sendsSignature(policy, index, block.thoughtSignature)) continue;
			elided += block.thoughtSignature.length - SKIP_THOUGHT_SIGNATURE.length;
		}
	}
	return elided;
}

export interface SignaturePolicy {
	readonly retainFrom: number;
	readonly maxLength: number | undefined;
}

export function signaturePolicy(
	messages: readonly Message[],
	context: { thoughtSignatureRetention?: number; thoughtSignatureMaxLength?: number },
): SignaturePolicy {
	const max = context.thoughtSignatureMaxLength;
	return {
		retainFrom: firstRetainedAssistantIndex(messages, context.thoughtSignatureRetention),
		maxLength: max !== undefined && Number.isFinite(max) && max > 0 ? Math.floor(max) : undefined,
	};
}

export function sendsSignature(policy: SignaturePolicy, messageIndex: number, signature: string): boolean {
	if (messageIndex < policy.retainFrom) return false;
	if (policy.maxLength !== undefined && signature.length > policy.maxLength) return false;
	return true;
}

export function supportsFunctionPartId<T extends GoogleApiType>(model: Model<T>): boolean {
	if (model.api === "google-vertex") return false;
	return model.id.startsWith("claude-") || (model.api === "google-generative-ai" && isGemini3Model(model.id));
}

function getGeminiMajorVersion(modelId: string): number | undefined {
	const match = modelId.toLowerCase().match(/^gemini(?:-live)?-(\d+)/);
	if (!match) return undefined;
	return Number.parseInt(match[1], 10);
}

export function supportsMultimodalFunctionResponse(modelId: string): boolean {
	const geminiMajorVersion = getGeminiMajorVersion(modelId);
	if (geminiMajorVersion !== undefined) {
		return geminiMajorVersion >= 3;
	}
	return true;
}

export function isGemini3Model(modelId: string): boolean {
	return modelId.includes("gemini-3");
}
