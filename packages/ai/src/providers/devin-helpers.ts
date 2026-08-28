import { gunzipSync } from "node:zlib";
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import {
	DEVIN_EXTENSION_NAME,
	DEVIN_EXTENSION_VERSION,
	DEVIN_IDE_NAME,
	DEVIN_IDE_VERSION,
} from "@veyyon/catalog/discovery/devin";
import {
	ChatMessageRequestType,
	GetChatMessageRequestSchema,
} from "@veyyon/catalog/discovery/devin-gen/exa/api_server_pb/api_server_pb";
import {
	GetUserJwtRequestSchema,
	GetUserJwtResponseSchema,
} from "@veyyon/catalog/discovery/devin-gen/exa/auth_pb/auth_pb";
import {
	CacheControlType,
	type ChatMessagePrompt,
	ChatMessagePromptSchema,
	ChatToolChoiceSchema,
	ChatToolDefinitionSchema,
	PromptCacheOptionsSchema,
} from "@veyyon/catalog/discovery/devin-gen/exa/chat_pb/chat_pb";
import {
	ChatMessageSource,
	type ChatToolCall,
	ChatToolCallSchema,
	CompletionConfigurationSchema,
	ConversationalPlannerMode,
	ImageDataSchema,
	MetadataSchema,
} from "@veyyon/catalog/discovery/devin-gen/exa/codeium_common_pb/codeium_common_pb";
import { isAbortError } from "@veyyon/utils/abortable";
import { tryParseJson } from "@veyyon/utils/json";
import { errorMessage } from "@veyyon/utils/type-guards";
import { trimTrailingSlashes } from "@veyyon/utils/url";
import * as AIError from "../error";
import type { Context, Message, Model, StreamOptions, Tool } from "../types";
import { deterministicUuid } from "../utils/deterministic-id";
import { toolWireSchema } from "../utils/schema/wire";

export { DEVIN_CASCADE_ENDPOINT } from "@veyyon/catalog/provider-endpoints";

import {
	DEVIN_AUTH_PATH,
	DEVIN_DEFAULT_STOP_PATTERNS,
	DEVIN_MAX_PROVIDER_RETRIES,
	DEVIN_RETRY_BASE_DELAY_MS,
	DEVIN_RETRY_MAX_DELAY_MS,
	type DevinOptions,
} from "./devin";

export async function fetchDevinAuthMetadata(
	apiKey: string,
	baseUrl: string,
	fetchImpl: NonNullable<StreamOptions["fetch"]>,
	signal: AbortSignal | undefined,
): Promise<{ userJwt: string; baseUrl?: string }> {
	const request = create(GetUserJwtRequestSchema, {
		metadata: create(MetadataSchema, {
			apiKey,
			ideName: DEVIN_IDE_NAME,
			ideVersion: DEVIN_IDE_VERSION,
			extensionName: DEVIN_EXTENSION_NAME,
			extensionVersion: DEVIN_EXTENSION_VERSION,
			locale: "en",
		}),
	});
	const response = await fetchImpl(`${baseUrl}${DEVIN_AUTH_PATH}`, {
		method: "POST",
		headers: {
			"content-type": "application/proto",
			"connect-protocol-version": "1",
			accept: "*/*",
		},
		body: toBinary(GetUserJwtRequestSchema, request),
		signal,
	});
	const payload = new Uint8Array(await response.arrayBuffer());
	if (!response.ok) {
		// Through the shared cap like every other interpolated body: an auth endpoint
		// behind a corporate proxy answers with an HTML page, and this was the one site
		// still putting a whole decoded payload into `Error.message`.
		throw new AIError.DevinApiError(
			`Devin auth error ${response.status} ${response.statusText}: ${AIError.boundProviderErrorDetail(new TextDecoder().decode(payload))}`,
			response.status,
		);
	}
	const decoded = decodeDevinUserJwtResponse(payload);
	if (!decoded.userJwt) {
		throw new AIError.ProviderResponseError("Devin auth error: GetUserJwt returned an empty user JWT", {
			provider: "devin",
			kind: "runtime",
		});
	}
	const customBaseUrl = decoded.customApiServerUrl.trim();
	return {
		userJwt: decoded.userJwt,
		...(customBaseUrl ? { baseUrl: trimTrailingSlashes(customBaseUrl) } : undefined),
	};
}

export function decodeDevinUserJwtResponse(payload: Uint8Array) {
	try {
		return fromBinary(GetUserJwtResponseSchema, payload);
	} catch {
		try {
			return fromBinary(GetUserJwtResponseSchema, gunzipSync(payload));
		} catch {
			throw new AIError.ProviderResponseError(
				`Devin auth error: GetUserJwt answered with ${payload.byteLength} byte(s) that are neither a protobuf response nor gzip: ${AIError.boundProviderErrorDetail(new TextDecoder().decode(payload))}`,
				{ provider: "devin", kind: "envelope" },
			);
		}
	}
}

export function buildDevinChatRequest(
	model: Model<"devin-agent">,
	context: Context,
	options: DevinOptions | undefined,
	apiKey: string,
	userJwt: string,
) {
	const cascadeId = options?.conversationId ?? options?.sessionId ?? crypto.randomUUID();
	const stopPatterns =
		options?.stopSequences && options.stopSequences.length > 0
			? DEVIN_DEFAULT_STOP_PATTERNS.concat(options.stopSequences)
			: DEVIN_DEFAULT_STOP_PATTERNS;
	return create(GetChatMessageRequestSchema, {
		metadata: create(MetadataSchema, {
			apiKey,
			userJwt,
			ideName: DEVIN_IDE_NAME,
			ideVersion: DEVIN_IDE_VERSION,
			extensionName: DEVIN_EXTENSION_NAME,
			extensionVersion: DEVIN_EXTENSION_VERSION,
			locale: "en",
		}),
		prompt: (context.systemPrompt ?? []).join("\n\n"),
		chatMessagePrompts: buildChatMessagePrompts(context.messages, cascadeId),
		chatModelUid: options?.chatModelUid ?? model.requestModelId ?? model.id,
		requestType: ChatMessageRequestType.CASCADE,
		plannerMode: ConversationalPlannerMode.DEFAULT,
		toolChoice: create(ChatToolChoiceSchema, { choice: { case: "optionName", value: "auto" } }),
		systemPromptCacheOptions: create(PromptCacheOptionsSchema, { type: CacheControlType.EPHEMERAL }),
		disableParallelToolCalls: true,
		cascadeId,
		executionId: crypto.randomUUID(),
		configuration: create(CompletionConfigurationSchema, {
			numCompletions: 1n,
			maxTokens: BigInt(options?.maxTokens ?? model.maxTokens ?? 64000),
			maxNewlines: 200n,
			temperature: options?.temperature ?? 0.4,
			firstTemperature: options?.temperature ?? 0.4,
			topK: 50n,
			topP: options?.topP ?? 1,
			stopPatterns,
			fimEotProbThreshold: 1,
		}),
		tools: (context.tools ?? []).map((tool: Tool) =>
			create(ChatToolDefinitionSchema, {
				name: tool.name,
				description: tool.description,
				jsonSchemaString: JSON.stringify(toolWireSchema(tool)),
				strict: tool.strict ?? false,
			}),
		),
	});
}

export function buildChatMessagePrompts(messages: Message[], cascadeId: string): ChatMessagePrompt[] {
	const prompts: ChatMessagePrompt[] = [];
	for (const [index, msg] of messages.entries()) {
		if (msg.role === "user" || msg.role === "developer") {
			let promptText = "";
			const images = [];
			if (typeof msg.content === "string") {
				promptText = msg.content;
			} else {
				for (const part of msg.content) {
					if (part.type === "text") {
						promptText += part.text;
					} else if (part.type === "image") {
						images.push(create(ImageDataSchema, { base64Data: part.data, mimeType: part.mimeType }));
					}
				}
			}
			prompts.push(
				create(ChatMessagePromptSchema, {
					messageId: deterministicUuid(`${cascadeId}\0${index}\0${msg.role}`),
					source: ChatMessageSource.USER,
					prompt: promptText,
					images,
				}),
			);
		} else if (msg.role === "assistant") {
			let promptText = "";
			let thinkingText = "";
			let signature = "";
			const toolCalls: ChatToolCall[] = [];
			for (const part of msg.content) {
				if (part.type === "text") {
					promptText += part.text;
				} else if (part.type === "thinking") {
					thinkingText += part.thinking;
					if (!signature && part.thinkingSignature) signature = part.thinkingSignature;
				} else if (part.type === "toolCall") {
					toolCalls.push(
						create(ChatToolCallSchema, {
							id: part.id,
							name: part.name,
							argumentsJson: JSON.stringify(part.arguments),
						}),
					);
				}
			}
			prompts.push(
				create(ChatMessagePromptSchema, {
					messageId: msg.responseId ?? `bot-${deterministicUuid(`${cascadeId}\0${index}\0assistant`)}`,
					source: ChatMessageSource.SYSTEM,
					prompt: promptText,
					thinking: thinkingText,
					signature,
					signatureType: "",
					toolCalls,
				}),
			);
		} else {
			let resultText = "";
			const images = [];
			for (const part of msg.content) {
				if (part.type === "text") {
					resultText += part.text;
				} else if (part.type === "image") {
					images.push(create(ImageDataSchema, { base64Data: part.data, mimeType: part.mimeType }));
				}
			}
			prompts.push(
				create(ChatMessagePromptSchema, {
					messageId: deterministicUuid(`${cascadeId}\0${index}\0tool\0${msg.toolCallId}`),
					source: ChatMessageSource.TOOL,
					toolCallId: msg.toolCallId,
					toolResultIsError: msg.isError,
					prompt: resultText,
					images,
				}),
			);
		}
	}
	return prompts;
}

export interface DevinTrailerError {
	readonly code: string;
	readonly message: string;
	readonly text: string;
}

export function readConnectTrailerError(text: string): DevinTrailerError | null {
	if (text.length === 0) return null;
	const parsed = tryParseJson(text);
	if (!parsed || typeof parsed !== "object" || !("error" in parsed)) return null;
	const err = parsed.error;
	if (!err || typeof err !== "object") return null;
	const code = "code" in err && typeof err.code === "string" ? err.code : "";
	const message = "message" in err && typeof err.message === "string" ? err.message : "";
	if (!code && !message) return null;
	return { code, message, text: `Devin stream error${code ? ` ${code}` : ""}: ${message}` };
}

export function parseDevinRateLimitResetMs(message: string): number | undefined {
	const match =
		/\breset(?:s)?\s+(?:in|after)\s+(?:about\s+|approximately\s+|~)?(\d+)\s*(second|minute|hour)s?\b/i.exec(message);
	if (!match?.[1] || !match[2]) return undefined;
	const amount = Number(match[1]);
	if (!Number.isFinite(amount) || amount < 0) return undefined;
	const unit = match[2].toLowerCase();
	const scale = unit === "second" ? 1_000 : unit === "minute" ? 60_000 : 3_600_000;
	return amount * scale;
}

export function devinRetryDelayMs(
	error: unknown,
	state: { attempt: number; emittedToken: boolean; aborted: boolean },
): number | undefined {
	if (state.aborted || state.emittedToken) return undefined;
	if (state.attempt >= DEVIN_MAX_PROVIDER_RETRIES) return undefined;
	if (isAbortError(error)) return undefined;
	if (!AIError.isProviderRetryableError(error)) return undefined;

	const message = errorMessage(error);
	const statedResetMs = parseDevinRateLimitResetMs(message);
	if (statedResetMs !== undefined) {
		// One second of slack, because waiting until the exact stated instant races the server's own
		// clock and a retry that lands a moment early just burns an attempt.
		const waitMs = statedResetMs + 1_000;
		return waitMs > DEVIN_RETRY_MAX_DELAY_MS ? undefined : waitMs;
	}
	return Math.min(DEVIN_RETRY_BASE_DELAY_MS * 2 ** state.attempt, DEVIN_RETRY_MAX_DELAY_MS);
}

export function devinTrailerFailure(trailer: DevinTrailerError): Error {
	const status = AIError.connectFailureStatus(trailer);
	if (status === undefined) return new AIError.ValidationError(trailer.text);
	return new AIError.DevinApiError(trailer.text, status);
}
