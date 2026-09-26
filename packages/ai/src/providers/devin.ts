import { scheduler } from "node:timers/promises";
import { gunzipSync, gzipSync } from "node:zlib";
import { create, fromBinary, fromJson, type JsonValue, toBinary, toJson } from "@bufbuild/protobuf";
import {
	DEVIN_EXTENSION_NAME,
	DEVIN_EXTENSION_VERSION,
	DEVIN_IDE_NAME,
	DEVIN_IDE_VERSION,
	normalizeDevinSessionToken,
} from "@veyyon/catalog/discovery/devin";
import {
	ChatMessageRequestType,
	GetChatMessageRequestSchema,
	type GetChatMessageResponse,
	GetChatMessageResponseSchema,
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
	type ModelUsageStats,
	StopReason,
} from "@veyyon/catalog/discovery/devin-gen/exa/codeium_common_pb/codeium_common_pb";
import { calculateCost, discardAttemptUsage } from "@veyyon/catalog/models";
import { DEVIN_CASCADE_ENDPOINT } from "@veyyon/catalog/provider-endpoints";
import { isAbortError } from "@veyyon/utils/abortable";
import { tryParseJson } from "@veyyon/utils/json";
import { parseStreamingJson, parseStreamingJsonThrottled } from "@veyyon/utils/json-parse";
import * as logger from "@veyyon/utils/logger";
import { errorMessage } from "@veyyon/utils/type-guards";
import { trimTrailingSlashes } from "@veyyon/utils/url";
import * as AIError from "../error";
import type {
	Api,
	AssistantMessage,
	Context,
	Message,
	Model,
	StreamFunction,
	StreamOptions,
	TextContent,
	ThinkingContent,
	Tool,
	ToolCall,
	Usage,
} from "../types";
import { clearStreamingPartialJson, setStreamingPartialJson } from "../utils/block-symbols";
import { deterministicUuid } from "../utils/deterministic-id";
import { AssistantMessageEventStream } from "../utils/event-stream";
import { toolWireSchema } from "../utils/schema/wire";
import { createInitialResponsesAssistantMessage } from "./initial-message";

/**
 * Base host for Codeium/Windsurf's Cascade chat API (Connect protocol over HTTP/1.1).
 *
 * Re-exported from `@veyyon/catalog/provider-endpoints`, not declared here. It used to be `DEVIN_CASCADE_ENDPOINT`, which
 * was the same name the OAuth flow in `../registry/oauth/devin.ts` used for `https://api.devin.ai`: two hosts,
 * one name, one package, and this one exported.
 */
export { DEVIN_CASCADE_ENDPOINT } from "@veyyon/catalog/provider-endpoints";

export interface DevinOptions extends StreamOptions {
	/** Wire model uid selected after thinking-effort routing. */
	chatModelUid?: string;
	/**
	 * Which provider-level retry this is, counted from 0. Internal.
	 *
	 * Set only by {@link streamDevin} when it re-runs itself after a transient failure. It does two
	 * things: it bounds the retries, and it suppresses the second `start` event, because the first
	 * attempt already emitted one to the consumer and a stream that starts twice is a protocol error
	 * rather than a retry.
	 */
	devinRetryAttempt?: number;
}

/**
 * How many times a Devin turn may be re-run before the failure reaches the operator.
 *
 * Three, matching the other providers' provider-level budget. The retries are only ever attempted
 * before the first token, so this costs latency on a failing turn and nothing on a working one.
 */
const DEVIN_MAX_PROVIDER_RETRIES = 3;
const DEVIN_RETRY_BASE_DELAY_MS = 1_000;
/**
 * The longest this will sit waiting before giving the failure to the operator.
 *
 * Cascade's rate-limit windows are stated in its message and range from one minute to forty. A
 * minute is worth waiting through, since the alternative is losing the turn. Forty is not: nothing
 * useful happens for the operator in that time and the correct answer is to fail now and let them
 * decide, which is what a window over this cap does.
 */
const DEVIN_RETRY_MAX_DELAY_MS = 90_000;

const CHAT_MESSAGE_PATH = "/exa.api_server_pb.ApiServerService/GetChatMessage";
const DEVIN_AUTH_PATH = "/exa.auth_pb.AuthService/GetUserJwt";
const DEVIN_DEFAULT_STOP_PATTERNS = ["<|user|>", "<|bot|>", "<|context_request|>", "<|endoftext|>", "<|end_of_turn|>"];

/** Connect streaming framing: flag byte bit 0x01 = gzip payload, 0x02 = end-of-stream JSON trailers. */
const CONNECT_COMPRESSED_FLAG = 0x01;
const CONNECT_END_STREAM_FLAG = 0x02;
/**
 * Hard upper bound on a single Connect frame payload. The 4-byte length prefix
 * is otherwise attacker-controlled (up to `2**32 - 1`), so a malicious or buggy
 * peer could force {@link streamDevin}'s reader to buffer gigabytes via
 * `Buffer.concat` before the idle-timeout wrapper aborts. Well above any
 * legitimate Cascade response but tight enough that a corrupt length prefix
 * fails fast instead of consuming memory.
 */
const MAX_CONNECT_FRAME_PAYLOAD = 16 * 1024 * 1024;

export const streamDevin: StreamFunction<"devin-agent"> = (
	model: Model<"devin-agent">,
	context: Context,
	options?: DevinOptions,
): AssistantMessageEventStream => {
	const stream = new AssistantMessageEventStream();

	const retryAttempt = options?.devinRetryAttempt ?? 0;

	(async () => {
		const startTime = performance.now();
		const decoder = new DevinStreamDecoder(
			stream,
			createInitialResponsesAssistantMessage("devin-agent" as Api, model.provider, model.id),
		);
		const output = decoder.output;

		try {
			const body = await postDevinChatRequest(model, context, options);

			// Only the first attempt announces the stream. A retry is a continuation of the same turn
			// from the consumer's point of view, and it is only ever reached when nothing but `start`
			// has escaped, so re-announcing would be the one observable difference between a retried
			// turn and a clean one.
			if (retryAttempt === 0) stream.push({ type: "start", partial: output });

			await readConnectMessages(body, model, payload => {
				decoder.apply(fromBinary(GetChatMessageResponseSchema, payload));
			});
			const doneReason = decoder.finish();

			calculateCost(model, output.usage);
			output.duration = performance.now() - startTime;
			if (decoder.firstTokenTime) output.ttft = decoder.firstTokenTime - startTime;

			stream.push({ type: "done", reason: doneReason, message: output });
			stream.end();
		} catch (error) {
			const retryDelayMs = devinRetryDelayMs(error, {
				attempt: retryAttempt,
				emittedToken: decoder.firstTokenTime !== undefined,
				aborted: options?.signal?.aborted === true,
			});
			if (retryDelayMs !== undefined) {
				await forwardDevinRetry(stream, model, context, options, {
					attempt: retryAttempt,
					delayMs: retryDelayMs,
					error,
					abandonedUsage: output.usage,
				});
				return;
			}
			// Finalized BEFORE the record is written, because the outcome is what decides how loud
			// it should be: a caller abort is the operator pressing stop, not a provider failure.
			const result = await AIError.finalize(error, { api: model.api, signal: options?.signal });
			// Chosen at call time from a static access, not from a table built at module load: a
			// captured function detaches any spy a test installs on the logger namespace.
			const record = result.logLevel === "debug" ? logger.debug : logger.error;
			record("devin: stream failed", {
				model: model.id,
				stopReason: result.stopReason,
				status: result.status,
				errorId: result.id,
				rules: result.rules,
				error: String(error),
			});
			AIError.applyFinalizeResult(output, result);
			output.duration = performance.now() - startTime;
			if (decoder.firstTokenTime) output.ttft = decoder.firstTokenTime - startTime;
			stream.push({ type: "error", reason: result.stopReason, error: output });
			stream.end();
		}
	})();

	return stream;
};

/**
 * Authenticate, send one framed, gzipped `GetChatMessage` request, and return the streaming
 * response body. A non-2xx answer or an empty body throws before any event reaches the caller.
 */
async function postDevinChatRequest(
	model: Model<"devin-agent">,
	context: Context,
	options: DevinOptions | undefined,
): Promise<ReadableStream<Uint8Array>> {
	const fetchImpl = options?.fetch ?? fetch;
	const baseUrl = trimTrailingSlashes(model.baseUrl || DEVIN_CASCADE_ENDPOINT);
	const apiKey = normalizeDevinSessionToken(options?.apiKey);
	const auth = await fetchDevinAuthMetadata(apiKey, baseUrl, fetchImpl, options?.signal);
	const chatBaseUrl = auth.baseUrl ?? baseUrl;
	let request = buildDevinChatRequest(model, context, options, apiKey, auth.userJwt);
	logger.debug("devin: sending chat request", { model: model.id, tools: context.tools?.length ?? 0 });
	const resolvedApiKey = request.metadata?.apiKey ?? apiKey;
	const resolvedUserJwt = request.metadata?.userJwt ?? auth.userJwt;

	// `onPayload` is a JSON seam: the secret-redaction walker behind it
	// (`transformProviderPayload`) rewrites every string and refuses any
	// value JSON cannot express. A protobuf message is not that shape --
	// `metadata.requestId` is a uint64 and therefore a bigint, and bytes
	// fields are Uint8Array -- so handing the message straight over made
	// EVERY Devin request fail with "the provider request contains a
	// non-JSON value/object; confidentiality transform failed." for any
	// operator with secrets configured. Canonical proto3 JSON carries the
	// 64-bit fields as strings, so the hook sees, and can redact, the
	// whole payload. Only paid when a hook is installed.
	const payloadHook = options?.onPayload;
	if (payloadHook) {
		const replacementPayload = await payloadHook(toJson(GetChatMessageRequestSchema, request), model);
		if (replacementPayload !== undefined) {
			request = fromJson(GetChatMessageRequestSchema, replacementPayload as JsonValue);
		}
	}
	const wireMetadata = create(MetadataSchema, request.metadata);
	wireMetadata.apiKey = resolvedApiKey;
	wireMetadata.userJwt = resolvedUserJwt;
	request.metadata = wireMetadata;
	const gz = gzipSync(toBinary(GetChatMessageRequestSchema, request));
	const frame = Buffer.alloc(5 + gz.length);
	frame[0] = CONNECT_COMPRESSED_FLAG;
	frame.writeUInt32BE(gz.length, 1);
	frame.set(gz, 5);

	const response = await fetchImpl(chatBaseUrl + CHAT_MESSAGE_PATH, {
		method: "POST",
		headers: {
			"content-type": "application/connect+proto",
			"connect-protocol-version": "1",
			"connect-content-encoding": "gzip",
			"accept-encoding": "identity",
			"user-agent": "connect-go/1.18.1 (go1.26.3)",
			"connect-accept-encoding": "gzip",
			...(options?.headers ?? {}),
		},
		body: frame,
		signal: options?.signal,
	});

	if (!response.ok) {
		const detail = await AIError.readProviderErrorDetail(response);
		throw new AIError.DevinApiError(
			`Devin API error ${response.status} ${response.statusText}: ${detail}`,
			response.status,
		);
	}
	if (!response.body) {
		throw new AIError.ProviderResponseError("Devin API error: response body is empty", {
			provider: model.provider,
			kind: "empty-body",
		});
	}
	return response.body;
}

/**
 * Split a Connect streaming body into its message payloads, gunzipping compressed frames, and hand
 * each to `onMessage` synchronously, so a read holding many frames costs no promise per frame.
 *
 * The end-of-stream frame is not a message: its JSON trailers either carry an error, which is
 * thrown, or nothing. A read is appended to the unconsumed tail only when a frame straddles two
 * reads, so a read holding whole frames is sliced in place rather than copied.
 */
async function readConnectMessages(
	body: ReadableStream<Uint8Array>,
	model: Model<"devin-agent">,
	onMessage: (payload: Uint8Array) => void,
): Promise<void> {
	const reader = body.getReader();
	let pending: Buffer = Buffer.alloc(0);
	for (;;) {
		const { done, value } = await reader.read();
		if (value && value.length > 0) {
			pending =
				pending.length === 0
					? Buffer.from(value.buffer, value.byteOffset, value.byteLength)
					: Buffer.concat([pending, value]);
		}

		while (pending.length >= 5) {
			const flag = pending[0];
			const len = pending.readUInt32BE(1);
			if (len > MAX_CONNECT_FRAME_PAYLOAD) {
				throw new AIError.ProviderResponseError(
					`Devin Connect frame length ${len} exceeds ${MAX_CONNECT_FRAME_PAYLOAD}-byte cap`,
					{ provider: model.provider, kind: "envelope" },
				);
			}
			if (pending.length < 5 + len) break;
			const payload = pending.subarray(5, 5 + len);
			pending = pending.subarray(5 + len);
			const raw = flag & CONNECT_COMPRESSED_FLAG ? gunzipSync(payload) : payload;

			if (flag & CONNECT_END_STREAM_FLAG) {
				const trailerError = readConnectTrailerError(raw.toString("utf8").trim());
				if (trailerError) throw devinTrailerFailure(trailerError);
				continue;
			}
			onMessage(raw);
		}

		if (done) return;
	}
}

/** A tool call being streamed: its content block, where it sits, and the argument text so far. */
interface DevinStreamingToolCall {
	block: ToolCall;
	contentIndex: number;
	json: string;
	/**
	 * Argument-buffer length at the last mid-stream parse, which bounds that work to O(N) via
	 * `parseStreamingJsonThrottled`; the authoritative parse still runs at `toolcall_end`.
	 */
	parsedLen: number;
}

/**
 * Fold decoded Cascade messages into the assistant message and push the matching events.
 *
 * Content blocks are only ever appended, so each open block keeps the index it was pushed at.
 */
class DevinStreamDecoder {
	readonly output: AssistantMessage;
	firstTokenTime: number | undefined;
	#stream: AssistantMessageEventStream;
	#text: { block: TextContent; contentIndex: number } | undefined;
	#thinking: { block: ThinkingContent; contentIndex: number } | undefined;
	// Keyed by streamed tool-call id. The accumulated argument text is kept here rather than on
	// the content object so a finalized tool call stays clean.
	#toolCalls = new Map<string, DevinStreamingToolCall>();
	#activeToolCallId: string | undefined;
	#stopReason = StopReason.UNSPECIFIED;

	constructor(stream: AssistantMessageEventStream, output: AssistantMessage) {
		this.#stream = stream;
		this.output = output;
	}

	apply(msg: GetChatMessageResponse): void {
		if (msg.messageId && !this.output.responseId) this.output.responseId = msg.messageId;
		if (msg.deltaThinking) this.#applyThinking(msg.deltaThinking, msg.deltaSignature);
		if (msg.deltaText) this.#applyText(msg.deltaText);
		if (msg.deltaToolCalls.length > 0) this.#applyToolCalls(msg.deltaToolCalls);
		if (msg.stopReason !== StopReason.UNSPECIFIED) this.#stopReason = msg.stopReason;
		if (msg.usage) this.#applyUsage(msg.usage);
	}

	/** Close every open block, settle each tool call's arguments, and set the stop reason. */
	finish(): "stop" | "length" | "toolUse" {
		this.#endText();
		this.#endThinking();
		for (const call of this.#toolCalls.values()) {
			call.block.arguments = parseStreamingJson(call.json);
			clearStreamingPartialJson(call.block);
			this.#stream.push({
				type: "toolcall_end",
				contentIndex: call.contentIndex,
				toolCall: call.block,
				partial: this.output,
			});
		}
		const reason =
			this.#toolCalls.size > 0 ? "toolUse" : this.#stopReason === StopReason.MAX_TOKENS ? "length" : "stop";
		this.output.stopReason = reason;
		return reason;
	}

	#markFirstToken(): void {
		if (this.firstTokenTime === undefined) this.firstTokenTime = performance.now();
	}

	#applyThinking(delta: string, signature: string): void {
		this.#markFirstToken();
		let open = this.#thinking;
		if (!open) {
			open = { block: { type: "thinking", thinking: "" }, contentIndex: this.output.content.length };
			this.output.content.push(open.block);
			this.#thinking = open;
			this.#stream.push({ type: "thinking_start", contentIndex: open.contentIndex, partial: this.output });
		}
		open.block.thinking += delta;
		if (signature) open.block.thinkingSignature = signature;
		this.#stream.push({ type: "thinking_delta", contentIndex: open.contentIndex, delta, partial: this.output });
	}

	#applyText(delta: string): void {
		this.#markFirstToken();
		this.#endThinking();
		let open = this.#text;
		if (!open) {
			open = { block: { type: "text", text: "" }, contentIndex: this.output.content.length };
			this.output.content.push(open.block);
			this.#text = open;
			this.#stream.push({ type: "text_start", contentIndex: open.contentIndex, partial: this.output });
		}
		open.block.text += delta;
		this.#stream.push({ type: "text_delta", contentIndex: open.contentIndex, delta, partial: this.output });
	}

	#applyToolCalls(deltas: ChatToolCall[]): void {
		this.#markFirstToken();
		this.#endText();
		this.#endThinking();
		for (const tc of deltas) {
			const toolCallId = tc.id || this.#activeToolCallId;
			if (!toolCallId) continue;
			let call = this.#toolCalls.get(toolCallId);
			if (!call) {
				const block: ToolCall = { type: "toolCall", id: toolCallId, name: tc.name, arguments: {} };
				call = { block, contentIndex: this.output.content.length, json: "", parsedLen: 0 };
				this.output.content.push(block);
				this.#toolCalls.set(toolCallId, call);
				this.#stream.push({ type: "toolcall_start", contentIndex: call.contentIndex, partial: this.output });
			}
			if (tc.name) call.block.name = tc.name;
			this.#activeToolCallId = toolCallId;
			if (tc.argumentsJson) this.#appendArguments(call, tc.argumentsJson);
		}
	}

	/** Cascade resends the whole argument text on some deltas and only the new tail on others. */
	#appendArguments(call: DevinStreamingToolCall, argumentsJson: string): void {
		const previous = call.json;
		const accumulated = argumentsJson.startsWith(previous) ? argumentsJson : previous + argumentsJson;
		call.json = accumulated;
		// Publish the raw accumulation on the block itself. `arguments` only
		// re-parses every STREAMING_JSON_PARSE_MIN_GROWTH bytes, so a preview
		// reading it alone shows nothing until the call closes; the renderer
		// path (event-controller → ToolArgsRevealController) decodes this
		// buffer every frame instead. Cleared at `toolcall_end` in `finish`,
		// because a marker left holding text is how `agent-loop.ts` detects
		// a call whose arguments never finished.
		setStreamingPartialJson(call.block, accumulated);
		const throttled = parseStreamingJsonThrottled(accumulated, call.parsedLen);
		if (throttled) {
			call.block.arguments = throttled.value;
			call.parsedLen = throttled.parsedLen;
		}
		this.#stream.push({
			type: "toolcall_delta",
			contentIndex: call.contentIndex,
			delta: accumulated.slice(previous.length),
			partial: this.output,
		});
	}

	#applyUsage(usage: ModelUsageStats): void {
		const out = this.output.usage;
		out.input = Number(usage.inputTokens);
		out.output = Number(usage.outputTokens);
		out.cacheRead = Number(usage.cacheReadTokens);
		out.cacheWrite = Number(usage.cacheWriteTokens);
		out.totalTokens = out.input + out.output;
	}

	#endText(): void {
		const open = this.#text;
		if (!open) return;
		this.#text = undefined;
		this.#stream.push({
			type: "text_end",
			contentIndex: open.contentIndex,
			content: open.block.text,
			partial: this.output,
		});
	}

	#endThinking(): void {
		const open = this.#thinking;
		if (!open) return;
		this.#thinking = undefined;
		this.#stream.push({
			type: "thinking_end",
			contentIndex: open.contentIndex,
			content: open.block.thinking,
			partial: this.output,
		});
	}
}

interface DevinRetry {
	attempt: number;
	delayMs: number;
	error: unknown;
	/** What the abandoned attempt reported before it died, which Devin still billed. */
	abandonedUsage: Usage;
}

/**
 * Wait out a transient failure, then re-run the whole turn and forward it into the stream the
 * caller is already reading.
 *
 * Delegating rather than looping in place is what keeps the partial output of the failed attempt
 * from reaching anyone: the retry builds its own, and the only event the caller has seen so far is
 * the `start` the first attempt emitted, which the retry does not repeat.
 */
async function forwardDevinRetry(
	stream: AssistantMessageEventStream,
	model: Model<"devin-agent">,
	context: Context,
	options: DevinOptions | undefined,
	retry: DevinRetry,
): Promise<void> {
	logger.warn("devin: transient stream failure, retrying", {
		model: model.id,
		attempt: retry.attempt + 1,
		delayMs: retry.delayMs,
		error: String(retry.error),
	});
	if (options?.providerRetryWait) await options.providerRetryWait(retry.delayMs, options.signal);
	else await scheduler.wait(retry.delayMs, { signal: options?.signal });

	const retried = streamDevin(model, context, { ...options, devinRetryAttempt: retry.attempt + 1 });
	// The abandoned attempt's text reaches nobody, but Devin billed whatever it reported before
	// dying: carry that spend onto the message the retry delivers, once, whichever terminal shape
	// arrives first.
	let carried = false;
	const carrySpend = (message: AssistantMessage): AssistantMessage => {
		if (!carried) {
			carried = true;
			discardAttemptUsage(model, retry.abandonedUsage, message.usage);
		}
		return message;
	};
	for await (const event of retried) {
		if (event.type === "done") carrySpend(event.message);
		else if (event.type === "error") carrySpend(event.error);
		stream.push(event);
		if (stream.done) return;
	}
	if (!stream.done) stream.end(carrySpend(await retried.result()));
}

async function fetchDevinAuthMetadata(
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

/**
 * Decode a `GetUserJwt` response, which arrives as bare protobuf or gzipped
 * protobuf depending on what the server negotiated.
 *
 * The third case is neither, and it has to name itself: a proxy's error page, a
 * truncated body, or an SSE keepalive from something that is not Devin all fail
 * the protobuf parse and then fail `gunzipSync`, whose own message is
 * "incorrect header check" — a zlib internal that names no provider, no step
 * and no remedy, and that was reaching the operator as the whole explanation of
 * a failed turn.
 */
function decodeDevinUserJwtResponse(payload: Uint8Array) {
	try {
		return fromBinary(GetUserJwtResponseSchema, payload);
	} catch {
		try {
			return fromBinary(GetUserJwtResponseSchema, gunzipSync(payload));
		} catch {
			throw new AIError.ProviderResponseError(
				`Devin auth error: GetUserJwt answered with ${payload.byteLength} byte(s) that are neither a protobuf response nor gzip: ${AIError.boundProviderErrorDetail(new TextDecoder().decode(payload))}`,
				// `envelope`, not `incomplete-stream`: a body that is neither
				// protobuf nor gzip is structurally wrong rather than cut short, so
				// the three-rung auth ladder cannot improve on it — and retrying
				// spent the caller's whole first-event budget, which turned an
				// actionable message into a deadline.
				{ provider: "devin", kind: "envelope" },
			);
		}
	}
}

/**
 * Build a {@link GetChatMessageRequest} for one Cascade turn. Auth rides inside
 * `Metadata.apiKey`; the system prompt is the flattened `prompt` string and the
 * conversation history maps to `chatMessagePrompts`.
 */
function buildDevinChatRequest(
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

/** Map veyyon `Message` history onto Cascade `ChatMessagePrompt`s (USER / SYSTEM / TOOL channels). */
function buildChatMessagePrompts(messages: Message[], cascadeId: string): ChatMessagePrompt[] {
	const prompts: ChatMessagePrompt[] = [];
	// messageId seeds are `cascadeId\0index\0role[...]` — prompt text is excluded
	// so ids stay stable across content edits / history rebuilds.
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

/**
 * Parse a Connect end-of-stream JSON trailer and return a human-readable error
 * string when it carries `{ error: { code, message } }`, else `null`. The trailer
 * is untrusted server output, so the shape is checked with guards rather than asserted.
 */
/**
 * A stream-level failure Cascade reports in its Connect end-stream trailer.
 *
 * THE CODE IS KEPT, and it used to be thrown away. This parser flattened the whole structured error
 * into one string and the single caller wrapped that string in a `ValidationError`, so EVERY
 * server-side stream failure was reported as a permanent, non-retryable, client-side mistake. A
 * validation error is exactly the class that must never be retried, which made every transient
 * Cascade failure fatal to the turn: measured across recorded sessions, 564 of 2690 Devin turns
 * (21%) ended in error, and 561 of those were one message, `permission_denied: Reached overall
 * message rate limit. Please try again later. Your limit will reset in 1 minute.` The server states
 * the wait and 563 of the 564 had not emitted a single token, so nearly every one of them was
 * safely retryable and none was retried.
 */
interface DevinTrailerError {
	/** Connect error code, e.g. `resource_exhausted`, `unavailable`, `invalid_argument`. */
	readonly code: string;
	/** The server's human-readable message, which is what carries the rate-limit reset window. */
	readonly message: string;
	/** The operator-facing rendering, unchanged from what this function used to return. */
	readonly text: string;
}

function readConnectTrailerError(text: string): DevinTrailerError | null {
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

/**
 * How long Cascade says to wait, read out of the sentence it says it in.
 *
 * There is no `retry-after` header on a Connect trailer, so the only machine-usable signal is the
 * server's own English: "Your limit will reset in 1 minute", "in 40 minutes". Honoring it matters
 * in both directions. Retrying sooner than the server asked is a guaranteed failure that burns the
 * retry budget, and a window far longer than any backoff (the 40-minute case is real) means the
 * turn must fail now rather than sit in a doomed sleep.
 *
 * Exported for tests: the parse is the part that decides whether a retry is even attempted.
 */
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

/**
 * How long to wait before re-running a failed turn, or `undefined` when it must not be re-run.
 *
 * WHY EVERY CONDITION IS HERE. Each one is a way a retry does harm rather than good:
 *
 *   - `emittedToken`: the replay-safety rule, and the same one Anthropic's provider loop uses. Once
 *     a delta has escaped to the consumer there is no way to un-say it, so a second attempt would
 *     duplicate or contradict text already on screen. This is why the fix cannot help the socket
 *     drops that happen mid-answer, only the failures that arrive before any output, which is what
 *     nearly all of them are: 563 of 564 recorded Devin errors had emitted no token.
 *   - `aborted`: the caller asked to stop. Retrying would fire a fresh request on the way out.
 *   - `attempt`: bounded budget, so a persistently failing endpoint fails in seconds not forever.
 *   - `isProviderRetryableError`: the shared classification, so Devin agrees with every other
 *     provider about what transient means instead of keeping a second opinion here.
 *   - the delay cap: a rate-limit window longer than the cap is a signal to stop, not to sleep.
 *
 * The delay prefers the server's own stated reset window over backoff, because retrying before the
 * window closes is a guaranteed second failure that spends the budget for nothing.
 */
function devinRetryDelayMs(
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

/**
 * Turn a trailer error into the throwable that classifies correctly.
 *
 * The status codes are how the shared machinery reads these: `isProviderRetryableError` keys off
 * `status(error)` plus the message, so a rate limit has to arrive as 429 and a server fault as 503
 * to be treated the way every other provider's equivalent already is. Anything the shared table
 * cannot place stays a `ValidationError`, so genuine `invalid_argument` failures are reported
 * exactly as before. The table itself lives in {@link AIError.connectFailureStatus} because Cursor
 * speaks the same protocol and has to agree about every code.
 *
 * Exported for tests: this and Cursor's equivalent have to be assertable side by side,
 * because one table with two readers is what keeps them from drifting apart again.
 */
export function devinTrailerFailure(trailer: DevinTrailerError): Error {
	const status = AIError.connectFailureStatus(trailer);
	if (status === undefined) return new AIError.ValidationError(trailer.text);
	return new AIError.DevinApiError(trailer.text, status);
}
