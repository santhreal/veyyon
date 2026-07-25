/**
 * Shared utilities for Google Generative AI and Google Cloud Code Assist providers.
 */

import { scheduler } from "node:timers/promises";
import { calculateCost, emptyCost, emptyUsage } from "@veyyon/catalog/models";
import { readSseJson } from "@veyyon/utils";
import { renderDemotedThinking } from "../dialect/demotion";
import * as AIError from "../error";
import type {
	Api,
	AssistantMessage,
	Context,
	FetchImpl,
	ImageContent,
	Message,
	Model,
	ServiceTier,
	StopReason,
	StreamOptions,
	TextContent,
	ThinkingContent,
	Tool,
	ToolCall,
} from "../types";
import { shouldSendServiceTier } from "../types";
import { normalizeSystemPrompts } from "../utils";
import { AssistantMessageEventStream } from "../utils/event-stream";
import type { RawHttpRequestDump } from "../utils/http-inspector";
import { normalizeSchemaForCCA, normalizeSchemaForGoogle, toolWireSchema } from "../utils/schema";
import type {
	Content,
	FinishReason,
	FunctionCallingConfigMode,
	GenerateContentConfig,
	GenerateContentParameters,
	GenerateContentResponse,
	Part,
	ThinkingConfig,
	ThinkingLevel,
} from "./google-types";
import { transformMessages } from "./transform-messages";
import { NON_VISION_IMAGE_PLACEHOLDER } from "./vision-guard";

export type {
	Content,
	FunctionCallingConfigMode,
	GenerateContentParameters,
	GenerateContentResponse,
	ThinkingConfig,
	ThinkingLevel,
} from "./google-types";
export { normalizeSchemaForGoogle };

type GoogleApiType = "google-generative-ai" | "google-gemini-cli" | "google-vertex";

/**
 * Thinking level for Gemini 3 models. Mirrors Google's `ThinkingLevel` enum values.
 * Defined here (not in any specific provider) so all Google providers can reference it
 * without inducing a circular dependency.
 */
export type GoogleThinkingLevel = "THINKING_LEVEL_UNSPECIFIED" | "MINIMAL" | "LOW" | "MEDIUM" | "HIGH";

/**
 * Sampling/thinking options shared by `streamGoogle` and `streamGoogleVertex`.
 * `google-gemini-cli` uses a different transport and request shape — do not extend this for it.
 */
export interface GoogleSharedStreamOptions extends StreamOptions {
	/**
	 * Tool selection mode. String forms map directly to Gemini
	 * `FunctionCallingConfigMode`. The object form forces a single named tool
	 * — `mode: "ANY"` is wire-required when `allowedFunctionNames` is set.
	 */
	toolChoice?: "auto" | "none" | "any" | { mode: "ANY"; allowedFunctionNames: [string, ...string[]] };
	thinking?: {
		enabled: boolean;
		budgetTokens?: number;
		level?: GoogleThinkingLevel;
	};
	/** Request that Google omit human-readable thought summaries while still allowing internal reasoning. */
	hideThinkingSummary?: boolean;
	/** Gemini/Vertex serving tier (`flex`/`priority`); other values are omitted. */
	serviceTier?: ServiceTier;
}

/**
 * Determines whether a streamed Gemini `Part` should be treated as "thinking".
 *
 * Protocol note (Gemini / Vertex AI thought signatures):
 * - `thought: true` is the definitive marker for thinking content (thought summaries).
 * - `thoughtSignature` is an encrypted representation of the model's internal thought process
 *   used to preserve reasoning context across multi-turn interactions.
 * - `thoughtSignature` can appear on ANY part type (text, functionCall, etc.) - it does NOT
 *   indicate the part itself is thinking content.
 * - For non-functionCall responses, the signature appears on the last part for context replay.
 * - When persisting/replaying model outputs, signature-bearing parts must be preserved as-is;
 *   do not merge/move signatures across parts.
 *
 * See: https://ai.google.dev/gemini-api/docs/thought-signatures
 */
export function isThinkingPart(part: Pick<Part, "thought" | "thoughtSignature">): boolean {
	return part.thought === true;
}

/**
 * Retain thought signatures during streaming.
 *
 * Some backends only send `thoughtSignature` on the first delta for a given part/block; later deltas may omit it.
 * This helper preserves the last non-empty signature for the current block.
 *
 * Note: this does NOT merge or move signatures across distinct response parts. It only prevents
 * a signature from being overwritten with `undefined` within the same streamed block.
 */
export function retainThoughtSignature(existing: string | undefined, incoming: string | undefined): string | undefined {
	if (typeof incoming === "string" && incoming.length > 0) return incoming;
	return existing;
}

// Thought signatures must be base64 for Google APIs (TYPE_BYTES).
const base64SignaturePattern = /^[A-Za-z0-9+/]+={0,2}$/;

const SKIP_THOUGHT_SIGNATURE = "skip_thought_signature_validator";

function isValidThoughtSignature(signature: string | undefined): signature is string {
	if (!signature) return false;
	if (signature.length % 4 !== 0) return false;
	return base64SignaturePattern.test(signature);
}

/**
 * Only keep signatures from the same provider/model and with valid base64.
 */
function resolveThoughtSignature(isSameProviderAndModel: boolean, signature: string | undefined): string | undefined {
	return isSameProviderAndModel && isValidThoughtSignature(signature) ? signature : undefined;
}

/**
 * Index of the first message whose tool-call thought signatures are sent verbatim.
 *
 * WHY THIS EXISTS. A `thoughtSignature` is an opaque blob Gemini attaches to
 * every function call, and until this was added every historical one was
 * re-uploaded on every request forever. Measured over nine live sessions they
 * were the single largest thing in the context: 40.2% of the conversation body,
 * 1,295 signatures averaging 2,239 characters, the largest one 71,636 (about
 * 18k tokens on its own). They cost more than the tool results, the tool
 * arguments, the thinking, and the model's own text combined.
 *
 * The signature exists to replay reasoning context, so the recent ones are the
 * ones worth paying for. `retention` is how many trailing assistant messages
 * keep theirs; everything older sends {@link SKIP_THOUGHT_SIGNATURE} instead,
 * which is Google's sentinel for "this part has no signature, do not fail
 * validation" and costs 33 characters.
 *
 * `undefined` means retain everything, which is the behaviour before this
 * existed. Any caller that does not opt in is unaffected.
 */
export function firstRetainedAssistantIndex(messages: readonly Message[], retention: number | undefined): number {
	if (retention === undefined || !Number.isFinite(retention) || retention < 0) return 0;
	let remaining = Math.floor(retention);
	for (let index = messages.length - 1; index >= 0; index--) {
		if (messages[index]?.role !== "assistant") continue;
		if (remaining === 0) return index + 1;
		remaining--;
	}
	// Fewer assistant messages than the retention window: every one is recent.
	return 0;
}

/**
 * Characters this request does not send because of the retention window.
 *
 * The saving has to be observable or nobody can tell the setting is doing
 * anything: the request just silently gets smaller, and "silently" is how a
 * mechanism ends up disabled for a year without anyone noticing. The session
 * accumulates this across requests and exposes it the same way it exposes the
 * bytes elided by wire path relativization.
 *
 * It counts the same thing {@link convertMessages} elides, and only that: a
 * tool-call signature that is currently sent and would not be under this
 * window, minus the {@link SKIP_THOUGHT_SIGNATURE} that replaces it. Signatures
 * already dropped for another reason, such as a foreign model's, are not
 * counted, because this window did not save them.
 *
 * The figure is per request and cumulative over a session, so it grows faster
 * than linearly: the same historical signature is elided again on every
 * subsequent turn, which is precisely the cost the window exists to avoid.
 */
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

/**
 * The two independent rules that decide whether a historical thought signature is
 * re-uploaded, resolved once so nothing can apply one without the other.
 *
 * They exist as one type because they are trivially easy to drift apart: the
 * request builder and the byte accounting both have to answer the same question,
 * and if the accounting knows about recency but not length, the context panel
 * reports a saving that does not match the request that was sent. That is the
 * quiet kind of wrong, so both callers take this and neither reimplements it.
 */
export interface SignaturePolicy {
	/**
	 * The first message index that keeps its signatures. 0 keeps everything, which
	 * is the behaviour before any of this existed.
	 */
	readonly retainFrom: number;
	/**
	 * Longest signature that is still worth re-uploading, in characters, or
	 * undefined for no limit.
	 */
	readonly maxLength: number | undefined;
}

/**
 * Resolve both signature rules from a request's context.
 *
 * A non-positive `thoughtSignatureMaxLength` means "no limit" rather than "elide
 * everything". Settings default numeric knobs to -1 to mean unset, and a literal
 * reading of that would silently strip every signature in the conversation the
 * moment the setting existed, which is the most damaging possible interpretation
 * of a default.
 */
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

/**
 * Whether one historical signature is sent, under both rules at once.
 *
 * THE SIZE RULE IS THE INTERESTING ONE, and it is not a variation on recency.
 * Signature bytes are extremely concentrated: measured over twenty DeepSWE
 * sessions, 2,297 signatures averaged 2,606 characters with a median of 660 and a
 * maximum of 91,960, and the largest tenth of them held 62.1% of all signature
 * bytes. So a length cap removes most of the mass while leaving the great
 * majority of the reasoning chain intact, whereas the recency window removes
 * nearly all of the mass and nearly all of the chain.
 *
 * That difference is the point. If replaying older reasoning turns out to matter,
 * a length cap degrades gently where a recency window does not, and the two can be
 * compared as separate arms because they are independent settings. They compose
 * when both are set: a signature is sent only if it is recent enough AND small
 * enough.
 */
export function sendsSignature(policy: SignaturePolicy, messageIndex: number, signature: string): boolean {
	if (messageIndex < policy.retainFrom) return false;
	if (policy.maxLength !== undefined && signature.length > policy.maxLength) return false;
	return true;
}

function supportsFunctionPartId<T extends GoogleApiType>(model: Model<T>): boolean {
	if (model.api === "google-vertex") return false;
	return model.id.startsWith("claude-") || (model.api === "google-generative-ai" && isGemini3Model(model.id));
}

function getGeminiMajorVersion(modelId: string): number | undefined {
	const match = modelId.toLowerCase().match(/^gemini(?:-live)?-(\d+)/);
	if (!match) return undefined;
	return Number.parseInt(match[1], 10);
}

function supportsMultimodalFunctionResponse(modelId: string): boolean {
	const geminiMajorVersion = getGeminiMajorVersion(modelId);
	if (geminiMajorVersion !== undefined) {
		return geminiMajorVersion >= 3;
	}
	return true;
}

function isGemini3Model(modelId: string): boolean {
	return modelId.includes("gemini-3");
}

/**
 * Convert internal messages to Gemini Content[] format.
 */
export function convertMessages<T extends GoogleApiType>(model: Model<T>, context: Context): Content[] {
	const contents: Content[] = [];
	const emittedToolCallNames = new Map<string, string>();

	const normalizeToolCallId = (id: string): string => {
		return id.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
	};

	const transformedMessages = transformMessages(context.messages, model, normalizeToolCallId);
	const sigPolicy = signaturePolicy(transformedMessages, context);
	const retainThinkingFrom = firstRetainedAssistantIndex(transformedMessages, context.thinkingRetention);
	let messageIndex = -1;

	// Gemini < 3 image tool results go in a separate user turn, but parallel tool results must
	// stay a single contiguous functionResponse turn ("number of function response parts is not
	// equal to number of function call parts"). Buffer image turns and flush them only after the
	// merged functionResponse turn is complete.
	let pendingToolImageParts: Part[] = [];
	const flushPendingToolImages = () => {
		if (pendingToolImageParts.length === 0) return;
		contents.push({ role: "user", parts: pendingToolImageParts });
		pendingToolImageParts = [];
	};

	for (const msg of transformedMessages) {
		messageIndex++;
		if (msg.role !== "toolResult") flushPendingToolImages();
		if (msg.role === "user" || msg.role === "developer") {
			if (typeof msg.content === "string") {
				// Skip empty user messages
				if (!msg.content || msg.content.trim() === "") continue;
				contents.push({
					role: "user",
					parts: [{ text: msg.content.toWellFormed() }],
				});
			} else {
				const supportsImages = model.input.includes("image");
				const parts: Part[] = [];
				let omittedImages = false;
				for (const item of msg.content) {
					if (item.type === "text") {
						const text = item.text.toWellFormed();
						if (text.trim().length === 0) continue;
						parts.push({ text });
					} else if (supportsImages) {
						parts.push({
							inlineData: {
								mimeType: item.mimeType,
								data: item.data,
							},
						});
					} else {
						omittedImages = true;
					}
				}
				if (omittedImages) {
					parts.push({ text: NON_VISION_IMAGE_PLACEHOLDER });
				}
				if (parts.length === 0) continue;
				contents.push({
					role: "user",
					parts,
				});
			}
		} else if (msg.role === "assistant") {
			const parts: Part[] = [];
			// Check if message is from same provider and model - only then keep thinking blocks
			const isSameProviderAndModel = msg.provider === model.provider && msg.model === model.id;

			for (const block of msg.content) {
				if (block.type === "text") {
					// Skip empty text blocks - they can cause issues with some models (e.g. Claude via Antigravity)
					if (!block.text || block.text.trim() === "") continue;
					const thoughtSignature = resolveThoughtSignature(isSameProviderAndModel, block.textSignature);
					parts.push({
						text: block.text.toWellFormed(),
						...(thoughtSignature && { thoughtSignature }),
					});
				} else if (block.type === "thinking") {
					// Skip empty thinking blocks
					if (!block.thinking || block.thinking.trim() === "") continue;
					// An UNSIGNED thinking block older than the window is dropped outright.
					// Gemini puts the signature on the function call, never on the thought
					// summary, so an unsigned summary carries no reasoning context the
					// provider can replay: it is transcript text and nothing more, and it
					// was measured at 10.8% of the conversation body. A SIGNED block is
					// never dropped here, whatever the window says, because dropping it
					// would discard replayable reasoning.
					if (
						messageIndex < retainThinkingFrom &&
						!resolveThoughtSignature(isSameProviderAndModel, block.thinkingSignature)
					) {
						continue;
					}
					const thoughtSignature = resolveThoughtSignature(isSameProviderAndModel, block.thinkingSignature);
					if (thoughtSignature) {
						parts.push({
							thought: true,
							text: block.thinking.toWellFormed(),
							thoughtSignature,
						});
					} else {
						parts.push({
							text: renderDemotedThinking(model.id, block.thinking),
						});
					}
				} else if (block.type === "toolCall") {
					emittedToolCallNames.set(block.id, block.name);
					// Elided by either signature rule means the call falls through the same
					// path as one that never had a signature: it sends Google's sentinel.
					const thoughtSignature =
						block.thoughtSignature && !sendsSignature(sigPolicy, messageIndex, block.thoughtSignature)
							? undefined
							: resolveThoughtSignature(isSameProviderAndModel, block.thoughtSignature);
					const effectiveSignature =
						thoughtSignature || (isGemini3Model(model.id) ? SKIP_THOUGHT_SIGNATURE : undefined);

					const part: Part = {
						functionCall: {
							name: block.name,
							args: block.arguments ?? {},
							...(supportsFunctionPartId(model) ? { id: block.id } : {}),
						},
					};
					if (model.provider === "google-vertex" && part?.functionCall?.id) {
						delete part.functionCall.id; // Vertex AI GenerateContent rejects 'id' in functionCall parts.
					}
					if (effectiveSignature) {
						part.thoughtSignature = effectiveSignature;
					}
					parts.push(part);
				}
			}

			if (parts.length === 0) continue;
			contents.push({
				role: "model",
				parts,
			});
		} else if (msg.role === "toolResult") {
			// Extract text and image content
			const supportsImages = model.input.includes("image");
			const textContent = msg.content.filter((c): c is TextContent => c.type === "text");
			const textResult = textContent.map(c => c.text).join("\n");
			const imageContent = supportsImages ? msg.content.filter((c): c is ImageContent => c.type === "image") : [];
			const omittedImages = !supportsImages && msg.content.some((c): c is ImageContent => c.type === "image");

			const hasText = textResult.length > 0;
			const hasImages = imageContent.length > 0;

			// Gemini 3+ models support multimodal function responses with images nested inside
			// functionResponse.parts. Claude and other non-Gemini models behind Cloud Code Assist /
			// Antigravity also accept this shape. Gemini < 3 still needs a separate user image turn.
			const modelSupportsMultimodalFunctionResponse = supportsMultimodalFunctionResponse(model.id);

			// Use "output" key for success, "error" key for errors as per SDK documentation
			const responseValue = omittedImages
				? [hasText ? textResult.toWellFormed() : "", NON_VISION_IMAGE_PLACEHOLDER].filter(Boolean).join("\n")
				: hasText
					? textResult.toWellFormed()
					: hasImages
						? "(see attached image)"
						: "";

			const imageParts: Part[] = imageContent.map(imageBlock => ({
				inlineData: {
					mimeType: imageBlock.mimeType,
					data: imageBlock.data,
				},
			}));

			const includeId = supportsFunctionPartId(model);
			const emittedName = emittedToolCallNames.get(msg.toolCallId);
			const functionResponsePart: Part = {
				functionResponse: {
					name: emittedName ?? msg.toolName,
					response: msg.isError ? { error: responseValue } : { output: responseValue },
					...(hasImages && modelSupportsMultimodalFunctionResponse && { parts: imageParts }),
					...(includeId ? { id: msg.toolCallId } : {}),
				},
			};

			if (model.provider === "google-vertex" && functionResponsePart.functionResponse?.id) {
				delete functionResponsePart.functionResponse.id; // Vertex AI GenerateContent rejects 'id' in functionResponse parts.
			}

			// Cloud Code Assist API requires all function responses to be in a single user turn.
			// Check if the last content is already a user turn with function responses and merge.
			const lastContent = contents[contents.length - 1];
			if (lastContent?.role === "user" && lastContent.parts?.some(p => p.functionResponse)) {
				lastContent.parts.push(functionResponsePart);
			} else {
				contents.push({
					role: "user",
					parts: [functionResponsePart],
				});
			}

			// For Gemini < 3, buffer images for a separate user message after the functionResponse turn
			if (hasImages && !modelSupportsMultimodalFunctionResponse) {
				pendingToolImageParts.push({ text: "Tool result image:" }, ...imageParts);
			}
		}
	}
	flushPendingToolImages();

	return contents;
}

/**
 * Convert tools to Gemini function declarations format.
 *
 * We prefer `parametersJsonSchema` (full JSON Schema: anyOf/oneOf/const/etc.).
 *
 * Claude models via Cloud Code Assist require the legacy `parameters` field; the API
 * translates it into Anthropic's `input_schema`. When using that path, we sanitize the
 * schema to remove Google-unsupported JSON Schema keywords.
 */
export function convertTools(
	tools: Tool[],
	model: Model<"google-generative-ai" | "google-gemini-cli" | "google-vertex">,
): { functionDeclarations: Record<string, unknown>[] }[] | undefined {
	if (tools.length === 0) return undefined;

	/**
	 * Claude models on Cloud Code Assist need the legacy `parameters` field;
	 * the API translates it into Anthropic's `input_schema`.
	 */
	const useParameters = model.id.startsWith("claude-");

	return [
		{
			functionDeclarations: tools.map(tool => ({
				name: tool.name,
				description: tool.description || "",
				...(useParameters
					? { parameters: normalizeSchemaForCCA(toolWireSchema(tool)) }
					: { parametersJsonSchema: normalizeSchemaForGoogle(toolWireSchema(tool)) }),
			})),
		},
	];
}

/**
 * Map tool choice string to Gemini FunctionCallingConfigMode.
 */
export function mapToolChoice(choice: string): FunctionCallingConfigMode {
	switch (choice) {
		case "auto":
			return "AUTO";
		case "none":
			return "NONE";
		case "any":
			return "ANY";
		default:
			return "AUTO";
	}
}

/**
 * Map Gemini FinishReason to our StopReason.
 */
export function mapStopReason(reason: FinishReason): StopReason {
	switch (reason) {
		case "STOP":
			return "stop";
		case "MAX_TOKENS":
			return "length";
		case "BLOCKLIST":
		case "PROHIBITED_CONTENT":
		case "SPII":
		case "SAFETY":
		case "IMAGE_SAFETY":
		case "IMAGE_PROHIBITED_CONTENT":
		case "IMAGE_RECITATION":
		case "IMAGE_OTHER":
		case "RECITATION":
		case "FINISH_REASON_UNSPECIFIED":
		case "OTHER":
		case "LANGUAGE":
		case "MALFORMED_FUNCTION_CALL":
		case "UNEXPECTED_TOOL_CALL":
		case "NO_IMAGE":
			return "error";
		default: {
			throw new AIError.ConfigurationError(`Unhandled stop reason: ${reason satisfies never}`);
		}
	}
}

/**
 * Map string finish reason to our StopReason (for raw API responses).
 */
export function mapStopReasonString(reason: string): StopReason {
	switch (reason) {
		case "STOP":
			return "stop";
		case "MAX_TOKENS":
			return "length";
		default:
			return "error";
	}
}

/**
 * Bounded retries for the well-known Gemini "empty response" failure: a benign
 * `finishReason: STOP` carrying only an empty/whitespace text part and no tool call.
 * Shared by the public/Vertex `streamGoogleGenAI` path and the Cloud Code Assist
 * (`google-gemini-cli`/`google-antigravity`) provider so both apply the same policy.
 */
export const MAX_EMPTY_STREAM_RETRIES = 2;
export const EMPTY_STREAM_BASE_DELAY_MS = 500;

/**
 * Whether a completed Google assistant message carries content worth delivering.
 *
 * A tool call or any non-whitespace text counts as meaningful. An empty/whitespace-only
 * text part — or thinking that never produced an answer — is the "empty response" failure:
 * delivered as-is the agent loop has nothing to act on and silently halts, so the request
 * must be retried instead of surfaced.
 */
export function hasMeaningfulGoogleContent(output: AssistantMessage): boolean {
	for (const block of output.content) {
		if (block.type === "toolCall") return true;
		if (block.type === "text" && block.text.trim().length > 0) return true;
	}
	return false;
}

/** Wipe a streamed message between empty-response retries so the next attempt starts clean. */
function resetGoogleStreamOutputForRetry(output: AssistantMessage): void {
	output.content = [];
	output.usage = emptyUsage();
	output.stopReason = "stop";
	output.errorMessage = undefined;
	output.timestamp = Date.now();
}

/**
 * Module-local counter for generating unique tool call IDs across Google providers.
 * Shared so that a single monotonically-increasing sequence is used regardless of which
 * Google API surface produced the stream — purely for uniqueness, not ordering semantics.
 */
let toolCallCounter = 0;

export function nextToolCallId(name: string): string {
	return `${name}_${Date.now()}_${++toolCallCounter}`;
}

/**
 * Push the appropriate `text_end` / `thinking_end` event for the given block.
 * Shared between the SDK-backed stream consumer and the gemini-cli SSE consumer so
 * the end-of-block event shape stays in lockstep.
 */
export function pushBlockEndEvent(
	block: TextContent | ThinkingContent,
	contentIndex: number,
	output: AssistantMessage,
	stream: AssistantMessageEventStream,
): void {
	if (block.type === "text") {
		stream.push({ type: "text_end", contentIndex, content: block.text, partial: output });
	} else {
		stream.push({ type: "thinking_end", contentIndex, content: block.thinking, partial: output });
	}
}

/**
 * Push the three lifecycle events (`toolcall_start` / `toolcall_delta` / `toolcall_end`) for a
 * fully-assembled `ToolCall`. Caller is responsible for appending the toolCall to `output.content`
 * before invoking — this helper does not mutate `output.content`.
 */
export function pushToolCallEvents(
	toolCall: ToolCall,
	contentIndex: number,
	output: AssistantMessage,
	stream: AssistantMessageEventStream,
): void {
	stream.push({ type: "toolcall_start", contentIndex, partial: output });
	stream.push({
		type: "toolcall_delta",
		contentIndex,
		delta: JSON.stringify(toolCall.arguments),
		partial: output,
	});
	stream.push({ type: "toolcall_end", contentIndex, toolCall, partial: output });
}

/**
 * Append a new text- or thinking-block to `output.content` and push the matching
 * `text_start` / `thinking_start` event. `onBeforeStartEvent` lets the SSE consumer
 * inject its `ensureStarted()` first-token side effect into the canonical event order.
 */
export function startTextOrThinkingBlock(
	isThinking: true,
	output: AssistantMessage,
	stream: AssistantMessageEventStream,
	onBeforeStartEvent?: () => void,
): ThinkingContent;
export function startTextOrThinkingBlock(
	isThinking: false,
	output: AssistantMessage,
	stream: AssistantMessageEventStream,
	onBeforeStartEvent?: () => void,
): TextContent;
export function startTextOrThinkingBlock(
	isThinking: boolean,
	output: AssistantMessage,
	stream: AssistantMessageEventStream,
	onBeforeStartEvent?: () => void,
): TextContent | ThinkingContent;
export function startTextOrThinkingBlock(
	isThinking: boolean,
	output: AssistantMessage,
	stream: AssistantMessageEventStream,
	onBeforeStartEvent?: () => void,
): TextContent | ThinkingContent {
	const block: TextContent | ThinkingContent = isThinking
		? { type: "thinking", thinking: "", thinkingSignature: undefined }
		: { type: "text", text: "" };
	output.content.push(block);
	onBeforeStartEvent?.();
	const contentIndex = output.content.length - 1;
	if (isThinking) {
		stream.push({ type: "thinking_start", contentIndex, partial: output });
	} else {
		stream.push({ type: "text_start", contentIndex, partial: output });
	}
	return block;
}

/**
 * Drives the chunked `generateContentStream` iterator into an `AssistantMessage` and
 * the corresponding `AssistantMessageEventStream`. Shared between `streamGoogle` and
 * `streamGoogleVertex` — every observable event order and stop-reason rule is preserved.
 *
 * The caller still owns: `output` construction, timing fields (`duration`/`ttft`),
 * `rawRequestDump`, the `client.models.generateContentStream(params)` call itself,
 * pushing `start`/`done`/`error` events, and the surrounding try/catch that translates
 * thrown errors into `output.stopReason`/`errorMessage`.
 *
 * This helper handles: the chunk loop, currentBlock flush transitions, usage metadata
 * decoding (`calculateCost` included), tool-call id collision avoidance, finish-reason
 * mapping, and the abort/stop-reason post-checks that re-throw to bubble into the
 * caller's catch.
 */
export async function consumeGoogleStream<T extends GoogleApiType>(args: {
	googleStream: AsyncIterable<GenerateContentResponse>;
	output: AssistantMessage;
	stream: AssistantMessageEventStream;
	model: Model<T>;
	options: { signal?: AbortSignal } | undefined;
	/** Vertex preserves `textSignature` on streamed text deltas; google-generative-ai does not. */
	retainTextSignature?: boolean;
	onFirstToken?: () => void;
}): Promise<void> {
	const { googleStream, output, stream, model, options, retainTextSignature, onFirstToken } = args;
	const blocks = output.content;
	const blockIndex = () => blocks.length - 1;
	let currentBlock: TextContent | ThinkingContent | null = null;
	let firstTokenSeen = false;
	let sawFinishReason = false;

	const flushCurrent = () => {
		if (!currentBlock) return;
		pushBlockEndEvent(currentBlock, blockIndex(), output, stream);
	};

	for await (const chunk of googleStream) {
		if (chunk.error) {
			const detail = chunk.error.message || chunk.error.status || "unknown error";
			const message = `Google API stream error: ${detail}`;
			throw typeof chunk.error.code === "number" && chunk.error.code >= 400
				? new AIError.GoogleApiError(message, chunk.error.code)
				: new AIError.ProviderResponseError(message, { provider: model.provider, kind: "output" });
		}
		if (!chunk.candidates?.length && chunk.promptFeedback?.blockReason) {
			const detail = chunk.promptFeedback.blockReasonMessage;
			throw new AIError.ProviderResponseError(
				`Request blocked by Google (${chunk.promptFeedback.blockReason})${detail ? `: ${detail}` : ""}`,
				{ provider: model.provider, kind: "content-blocked" },
			);
		}
		const candidate = chunk.candidates?.[0];
		if (candidate?.content?.parts) {
			for (const part of candidate.content.parts) {
				if (part.text !== undefined && part.text !== "") {
					if (!firstTokenSeen) {
						firstTokenSeen = true;
						onFirstToken?.();
					}
					const isThinking = isThinkingPart(part);
					if (
						!currentBlock ||
						(isThinking && currentBlock.type !== "thinking") ||
						(!isThinking && currentBlock.type !== "text")
					) {
						flushCurrent();
						currentBlock = startTextOrThinkingBlock(isThinking, output, stream);
					}
					if (currentBlock.type === "thinking") {
						currentBlock.thinking += part.text;
						currentBlock.thinkingSignature = retainThoughtSignature(
							currentBlock.thinkingSignature,
							part.thoughtSignature,
						);
						stream.push({
							type: "thinking_delta",
							contentIndex: blockIndex(),
							delta: part.text,
							partial: output,
						});
					} else {
						currentBlock.text += part.text;
						if (retainTextSignature) {
							currentBlock.textSignature = retainThoughtSignature(
								currentBlock.textSignature,
								part.thoughtSignature,
							);
						}
						stream.push({
							type: "text_delta",
							contentIndex: blockIndex(),
							delta: part.text,
							partial: output,
						});
					}
				} else if (part.text === "" && part.thoughtSignature && currentBlock && !part.functionCall) {
					if (currentBlock.type === "thinking") {
						currentBlock.thinkingSignature = retainThoughtSignature(
							currentBlock.thinkingSignature,
							part.thoughtSignature,
						);
					} else if (retainTextSignature) {
						currentBlock.textSignature = retainThoughtSignature(
							currentBlock.textSignature,
							part.thoughtSignature,
						);
					}
				}

				if (part.functionCall) {
					if (currentBlock) {
						flushCurrent();
						currentBlock = null;
					}

					// Generate unique ID if not provided or if it's a duplicate
					const providedId = part.functionCall.id;
					const needsNewId = !providedId || output.content.some(b => b.type === "toolCall" && b.id === providedId);
					const toolCallId = needsNewId ? nextToolCallId(part.functionCall.name || "tool") : providedId;

					const toolCall: ToolCall = {
						type: "toolCall",
						id: toolCallId,
						name: part.functionCall.name || "",
						arguments: (part.functionCall.args ?? {}) as Record<string, any>,
						...(part.thoughtSignature && { thoughtSignature: part.thoughtSignature }),
					};

					output.content.push(toolCall);
					pushToolCallEvents(toolCall, blockIndex(), output, stream);
				}
			}
		}

		if (candidate?.finishReason) {
			sawFinishReason = true;
			const mapped = mapStopReason(candidate.finishReason);
			// Only let a trailing tool call upgrade benign finishes; SAFETY/MALFORMED_FUNCTION_CALL
			// and friends must surface as errors even when earlier chunks carried valid tool calls.
			if ((mapped === "stop" || mapped === "length") && output.content.some(b => b.type === "toolCall")) {
				output.stopReason = "toolUse";
			} else {
				output.stopReason = mapped;
				if (mapped === "error") {
					output.errorMessage = `Generation failed with finish reason: ${candidate.finishReason}`;
				}
			}
		}

		if (chunk.usageMetadata) {
			// promptTokenCount includes cachedContentTokenCount when cached content is used.
			// Subtract to get non-cached input, matching the OpenAI convention where
			// input = uncached prompt tokens and cacheRead = cached tokens so that
			// input + cacheRead = total prompt tokens (no double-counting).
			// Ref: https://ai.google.dev/api/generate-content#v1beta.GenerateContentResponse.UsageMetadata
			const cachedTokens = chunk.usageMetadata.cachedContentTokenCount || 0;
			const thinkingTokens = chunk.usageMetadata.thoughtsTokenCount || 0;
			output.usage = {
				input: (chunk.usageMetadata.promptTokenCount || 0) - cachedTokens,
				output: (chunk.usageMetadata.candidatesTokenCount || 0) + thinkingTokens,
				cacheRead: cachedTokens,
				cacheWrite: 0,
				totalTokens: chunk.usageMetadata.totalTokenCount || 0,
				...(thinkingTokens > 0 ? { reasoningTokens: thinkingTokens } : {}),
				cost: emptyCost(),
			};
			calculateCost(model, output.usage);
		}
	}

	flushCurrent();

	if (options?.signal?.aborted) {
		throw new AIError.RequestAbortError();
	}

	if (!sawFinishReason) {
		throw new AIError.ProviderResponseError(
			"Google API stream ended without a finish reason (connection dropped or response truncated)",
			{ provider: model.provider, kind: "incomplete-stream" },
		);
	}

	if (output.stopReason === "aborted" || output.stopReason === "error") {
		throw new AIError.ProviderResponseError(output.errorMessage ?? "An unknown error occurred", {
			provider: model.provider,
			kind: "output",
		});
	}
}

/**
 * Generation/sampling fields that map directly onto Gemini's `GenerateContentConfig`.
 * Excludes any provider-specific extensions (`topP`/`topK`/etc are all forwarded as-is).
 */
interface GoogleGenerationConfig extends GenerateContentConfig {
	topP?: number;
	topK?: number;
	minP?: number;
	presencePenalty?: number;
	repetitionPenalty?: number;
}

/**
 * Build the `GenerateContentParameters` payload for the public Gemini API and Vertex AI.
 * Both surfaces accept the same `GenerateContentConfig` shape — every numeric/string knob,
 * tool-config, thinking-config, and system-instruction conversion is identical.
 *
 * `google-gemini-cli` is NOT routed through here: its `CloudCodeAssistRequest` body has a
 * distinct top-level shape (project/request/requestType) and a different thinking-config
 * placement on `generationConfig`.
 */
export function buildGoogleGenerateContentParams<T extends "google-generative-ai" | "google-vertex">(
	model: Model<T>,
	context: Context,
	options: GoogleSharedStreamOptions,
): GenerateContentParameters {
	const systemPrompts = normalizeSystemPrompts(context.systemPrompt);
	const contents = convertMessages(model, context);

	const generationConfig: GoogleGenerationConfig = {};
	if (options.temperature !== undefined) generationConfig.temperature = options.temperature;
	if (options.maxTokens !== undefined) generationConfig.maxOutputTokens = options.maxTokens;
	if (options.topP !== undefined) generationConfig.topP = options.topP;
	if (options.topK !== undefined) generationConfig.topK = options.topK;
	if (options.minP !== undefined) generationConfig.minP = options.minP;
	if (options.presencePenalty !== undefined) generationConfig.presencePenalty = options.presencePenalty;
	if (options.repetitionPenalty !== undefined) generationConfig.repetitionPenalty = options.repetitionPenalty;

	const config: GenerateContentConfig = {
		...(Object.keys(generationConfig).length > 0 && generationConfig),
		...(systemPrompts.length > 0 && { systemInstruction: { parts: systemPrompts.map(text => ({ text })) } }),
		...(context.tools && context.tools.length > 0 && { tools: convertTools(context.tools, model) }),
	};

	// Gemini API (google-generative-ai) reads the tier from the request body;
	// Vertex AI ignores a body field and requires the
	// `X-Vertex-AI-LLM-Shared-Request-Type` header instead (added in
	// streamGoogleVertex), so only emit the body field for the direct API.
	if (model.provider === "google" && shouldSendServiceTier(options.serviceTier, model.provider)) {
		config.serviceTier = options.serviceTier;
	}

	if (context.tools && context.tools.length > 0 && options.toolChoice) {
		const choice = options.toolChoice;
		if (typeof choice === "string") {
			const mode = mapToolChoice(choice);
			if (mode !== "AUTO") {
				config.toolConfig = {
					functionCallingConfig: { mode },
				};
			}
		} else {
			// Named-tool routing — `mode: "ANY"` plus an explicit allow-list. The
			// caller is responsible for ensuring the names exist in `context.tools`.
			config.toolConfig = {
				functionCallingConfig: {
					mode: "ANY",
					allowedFunctionNames: [...choice.allowedFunctionNames],
				},
			};
		}
	} else {
		config.toolConfig = undefined;
	}

	if (options.thinking?.enabled && model.reasoning) {
		const cfg: ThinkingConfig = { includeThoughts: !options.hideThinkingSummary };
		if (options.thinking.level !== undefined) {
			// GoogleThinkingLevel mirrors the SDK's `ThinkingLevel` string enum values 1:1.
			cfg.thinkingLevel = options.thinking.level as ThinkingLevel;
		} else if (options.thinking.budgetTokens !== undefined) {
			cfg.thinkingBudget = options.thinking.budgetTokens;
		}
		config.thinkingConfig = cfg;
	}

	if (options.signal) {
		if (options.signal.aborted) {
			throw new AIError.RequestAbortError("Request aborted");
		}
		config.abortSignal = options.signal;
	}

	return {
		model: model.id,
		contents,
		config,
	};
}

/**
 * Drive the `streamGoogle` / `streamGoogleVertex` event flow: build the assistant message,
 * push start/done/error events, run `consumeGoogleStream`, and translate thrown errors into
 * the canonical `error` event shape.
 *
 * Caller-supplied `prepare()` runs inside the try-block so any failure (missing project,
 * bad auth, etc.) is funneled through the same error path as a streaming failure.
 */
export interface GoogleGenAIRequestPlan {
	params: GenerateContentParameters;
	url: string;
	headers: Record<string, string>;
	fetch?: FetchImpl;
	/** Optional URL retried once when {@link url} returns 404 (regional Vertex endpoint missing a global-only model). */
	fallbackUrl?: string;
}

export function streamGoogleGenAI<T extends "google-generative-ai" | "google-vertex">(args: {
	model: Model<T>;
	options: GoogleSharedStreamOptions | undefined;
	api: T;
	retainTextSignature?: boolean;
	prepare: () => GoogleGenAIRequestPlan | Promise<GoogleGenAIRequestPlan>;
}): AssistantMessageEventStream {
	const { model, options, api, retainTextSignature, prepare } = args;
	const stream = new AssistantMessageEventStream();

	(async () => {
		const startTime = performance.now();
		let firstTokenTime: number | undefined;

		const output: AssistantMessage = {
			role: "assistant",
			content: [],
			api: api as Api,
			provider: model.provider,
			model: model.id,
			usage: emptyUsage(),
			stopReason: "stop",
			timestamp: Date.now(),
		};
		let rawRequestDump: RawHttpRequestDump | undefined;

		try {
			const plan = await prepare();
			let params = plan.params;
			const replacement = await options?.onPayload?.(params, model);
			if (replacement !== undefined) {
				params = replacement as GenerateContentParameters;
			}
			rawRequestDump = {
				provider: model.provider,
				api: output.api,
				model: model.id,
				method: "POST",
				url: plan.url,
				body: params,
				headers: plan.headers,
			};

			const bodyJson = JSON.stringify(paramsToWireBody(params));
			const fetchImpl = plan.fetch ?? options?.fetch ?? (globalThis.fetch.bind(globalThis) as FetchImpl);
			const openStreamAt = async (requestUrl: string): Promise<ReadableStream<Uint8Array>> => {
				const response = await fetchImpl(requestUrl, {
					method: "POST",
					headers: { ...plan.headers, "Content-Type": "application/json", Accept: "text/event-stream" },
					body: bodyJson,
					signal: options?.signal,
				});
				if (!response.ok) {
					const errorText = await response.text().catch(() => "");
					throw new AIError.GoogleApiError(
						`Google API error (${response.status}): ${extractGoogleErrorMessage(errorText)}`,
						response.status,
						{ headers: response.headers },
					);
				}
				if (!response.body) {
					throw new AIError.ProviderResponseError("Google API returned an empty response body", {
						provider: model.provider,
						kind: "empty-body",
					});
				}
				return response.body as ReadableStream<Uint8Array>;
			};
			// A regional Vertex endpoint 404s for models published only on the
			// global endpoint; retry global once so a stale/ambient region never
			// breaks a request that worked before regional routing existed.
			const openStream = async (): Promise<ReadableStream<Uint8Array>> => {
				if (!plan.fallbackUrl) return openStreamAt(plan.url);
				try {
					return await openStreamAt(plan.url);
				} catch (error) {
					if (error instanceof AIError.GoogleApiError && error.status === 404) {
						return openStreamAt(plan.fallbackUrl);
					}
					throw error;
				}
			};

			let body = await openStream();
			stream.push({ type: "start", partial: output });

			// Gemini occasionally finishes with `finishReason: STOP` while emitting only an empty
			// text part and no tool call. Delivered as-is the agent receives a blank message and
			// silently halts mid-task, so retry a bounded number of times before giving up.
			for (let emptyAttempt = 0; ; emptyAttempt++) {
				const googleStream = readSseJson<GenerateContentResponse>(body, options?.signal, event =>
					options?.onSseEvent?.({ event: event.event, data: event.data, raw: [...event.raw] }, model),
				);
				await consumeGoogleStream({
					googleStream,
					output,
					stream,
					model,
					options,
					retainTextSignature,
					onFirstToken: () => {
						firstTokenTime = performance.now();
					},
				});

				if (output.stopReason !== "stop" || hasMeaningfulGoogleContent(output)) break;
				if (emptyAttempt >= MAX_EMPTY_STREAM_RETRIES) {
					throw new AIError.ProviderResponseError(
						`Google API returned an empty response (finishReason STOP with no content) after ${MAX_EMPTY_STREAM_RETRIES + 1} attempts`,
						{ provider: model.provider, kind: "empty-body" },
					);
				}
				try {
					await scheduler.wait(EMPTY_STREAM_BASE_DELAY_MS * 2 ** emptyAttempt, { signal: options?.signal });
				} catch {
					throw new AIError.RequestAbortError();
				}
				resetGoogleStreamOutputForRetry(output);
				body = await openStream();
			}

			output.duration = performance.now() - startTime;
			if (firstTokenTime) output.ttft = firstTokenTime - startTime;
			stream.push({ type: "done", reason: output.stopReason as "length" | "stop" | "toolUse", message: output });
			stream.end();
		} catch (error) {
			const result = await AIError.finalize(error, { api: model.api, signal: options?.signal, rawRequestDump });
			output.stopReason = result.stopReason;
			output.errorStatus = result.status;
			output.errorId = result.id;
			output.errorMessage = result.message;
			output.duration = performance.now() - startTime;
			if (firstTokenTime) output.ttft = firstTokenTime - startTime;
			stream.push({ type: "error", reason: output.stopReason, error: output });
			stream.end();
		}
	})();

	return stream;
}

/**
 * Lift the SDK's `params.config` fields out of `config` and place them where the
 * Gemini / Vertex AI REST API expects them on the request body. Mirrors the
 * generateContentParametersTo{Mldev,Vertex} transformation in @google/genai
 * for the subset of fields this codebase actually sets.
 *
 * `abortSignal` is intentionally dropped — the SDK propagates it via `fetch.signal`,
 * which our caller already wires up through `options.signal`.
 */
function paramsToWireBody(params: GenerateContentParameters): Record<string, unknown> {
	const body: Record<string, unknown> = { contents: params.contents };
	const config = params.config;
	if (!config) return body;

	if (config.systemInstruction !== undefined) body.systemInstruction = config.systemInstruction;
	if (config.tools !== undefined) body.tools = config.tools;
	if (config.toolConfig !== undefined) body.toolConfig = config.toolConfig;
	if (config.safetySettings !== undefined) body.safetySettings = config.safetySettings;
	if (config.cachedContent !== undefined) body.cachedContent = config.cachedContent;
	if (config.serviceTier !== undefined) body.serviceTier = config.serviceTier;

	const gen: Record<string, unknown> = {};
	if (config.temperature !== undefined) gen.temperature = config.temperature;
	if (config.maxOutputTokens !== undefined) gen.maxOutputTokens = config.maxOutputTokens;
	if (config.topP !== undefined) gen.topP = config.topP;
	if (config.topK !== undefined) gen.topK = config.topK;
	if (config.candidateCount !== undefined) gen.candidateCount = config.candidateCount;
	if (config.stopSequences !== undefined) gen.stopSequences = config.stopSequences;
	if (config.presencePenalty !== undefined) gen.presencePenalty = config.presencePenalty;
	if (config.frequencyPenalty !== undefined) gen.frequencyPenalty = config.frequencyPenalty;
	if (config.seed !== undefined) gen.seed = config.seed;
	if (config.responseMimeType !== undefined) gen.responseMimeType = config.responseMimeType;
	if (config.responseSchema !== undefined) gen.responseSchema = config.responseSchema;
	if (config.responseJsonSchema !== undefined) gen.responseJsonSchema = config.responseJsonSchema;
	if (config.responseModalities !== undefined) gen.responseModalities = config.responseModalities;
	if (config.thinkingConfig !== undefined) gen.thinkingConfig = config.thinkingConfig;
	const generationConfig = config as unknown as { minP?: number; repetitionPenalty?: number };
	if (generationConfig.minP !== undefined) gen.minP = generationConfig.minP;
	if (generationConfig.repetitionPenalty !== undefined) gen.repetitionPenalty = generationConfig.repetitionPenalty;
	if (Object.keys(gen).length > 0) body.generationConfig = gen;
	return body;
}

function extractGoogleErrorMessage(errorText: string): string {
	if (!errorText) return "Unknown error";
	try {
		const parsed = JSON.parse(errorText) as { error?: { message?: string } };
		if (parsed.error?.message) return parsed.error.message;
	} catch {
		// fall through to raw text
	}
	return errorText;
}
