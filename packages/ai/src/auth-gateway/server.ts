/**
 * veyyon auth-gateway HTTP server.
 *
 * Accepts any provider-format request (OpenAI chat-completions, Anthropic
 * messages, OpenAI Responses) and dispatches through pi-ai's `streamSimple()`
 * — which handles credential injection, anthropic-beta headers, codex
 * websocket transport, and all the per-provider intricacies. The gateway is
 * pure protocol translation: foreign wire → veyyon Context → pi-ai stream() →
 * veyyon events → foreign wire.
 *
 * Endpoints:
 *   GET  /healthz                          → unauth; ok + version
 *   GET  /v1/usage                         → aggregated provider usage (5-min per-credential cache via AuthStorage)
 *   GET  /v1/credentials/check             → per-credential auth probe (diagnose 401s in a multi-account pool)
 *   GET  /v1/models                        → list known models from the registry
 *   POST /v1/chat/completions              → OpenAI chat-completions in/out
 *   POST /v1/messages                      → Anthropic messages in/out
 *   POST /v1/responses                     → OpenAI Responses in/out
 */

import { Effort } from "@veyyon/catalog/effort";
import { extractRetryHint } from "@veyyon/utils/fetch-retry";
import * as logger from "@veyyon/utils/logger";
import { errorMessage, isRecord } from "@veyyon/utils/type-guards";
import type { ApiKeyResolver } from "../auth-retry";
import type { AuthStorage } from "../auth-storage";
import * as AIError from "../error";
import { classifyGatewayError } from "../error/gateway";
import * as anthropicMessages from "../providers/anthropic-messages-server";
import * as openaiChat from "../providers/openai-chat-server";
import * as openaiResponses from "../providers/openai-responses-server";
import * as piNative from "../providers/pi-native-server";
import { completeSimple, streamSimple } from "../stream";
import type { Api, AssistantMessage, AssistantMessageEventStream, Context, Model, SimpleStreamOptions } from "../types";
import { deterministicUuid } from "../utils/deterministic-id";
import { parseBind } from "../utils/parse-bind";
import {
	captureRequestHeaders,
	corsHeaders,
	gatewayResponseHeaders,
	isAuthorized,
	json,
	resolvePeer,
	withCors,
} from "./http";
import type {
	AuthGatewayServerHandle,
	AuthGatewayServerOptions,
	AuthGatewayStreamControl,
	AuthGatewayFormatModule as FormatModule,
	AuthGatewayParsedRequest as ParsedFormatRequest,
} from "./types";
import { DEFAULT_AUTH_GATEWAY_BIND } from "./types";

// ParsedFormatRequest / ParsedFormatOptions / FormatModule come from ./types.

export type ModelResolver = (modelId: string) => Model<Api> | undefined;

export interface AuthGatewayBootOptions extends AuthGatewayServerOptions {
	/** Source of credentials. Caller wires this to a broker-backed AuthStorage. */
	storage: AuthStorage;
	/**
	 * Resolve a client-requested model id to a pi-ai Model. Caller supplies
	 * this from a ModelRegistry (lives in `coding-agent` to avoid an inverse
	 * dependency in `pi-ai`).
	 */
	resolveModel: ModelResolver;
	/** Optional supplier for `/v1/models` listing. Returns the full model array. */
	listModels?: () => Iterable<Model<Api>>;
}

// `parseBind` lives in ../utils/parse-bind so the gateway and broker can't
// drift on accepted inputs (e.g. empty hostname, IPv6 brackets).

/** A completion route: serves one `POST` path from request body to answer. */
type CompletionHandler = (bootOpts: AuthGatewayBootOptions, req: Request, peer: string) => Promise<Response>;

const COMPLETION_ROUTES: Record<string, CompletionHandler> = {
	"/v1/chat/completions": (bootOpts, req, peer) => serveFormatRequest(openaiChat, "openai-chat", bootOpts, req, peer),
	"/v1/messages": (bootOpts, req, peer) =>
		serveFormatRequest(anthropicMessages, "anthropic-messages", bootOpts, req, peer),
	"/v1/responses": (bootOpts, req, peer) =>
		serveFormatRequest(openaiResponses, "openai-responses", bootOpts, req, peer),
	"/v1/pi/stream": servePiNativeRequest,
};

/** Every path a completion route answers `POST` on. */
export const AUTH_GATEWAY_COMPLETION_PATHS: readonly string[] = Object.keys(COMPLETION_ROUTES);

// (passthrough fast-path removed — it bypassed pi-ai provider logic, in
// particular the Anthropic Claude-Code OAuth system-prompt prefix injection.
// Every request now takes the translate path so credential-specific request
// shaping always applies.)

// Options the caller's wire format may carry but the resolved provider can't
// honour are stripped in `buildStreamOptions`. We used to 400 here
// (`Unsupported option: temperature for openai-codex-responses`), but every
// realistic client (llm-git, openai SDK, anthropic SDK) bakes some of these
// defaults in without knowing which model they'll resolve to. Rejecting the
// request just turned that into per-call config hell, so the request goes
// through with the option stripped, which is what the upstream provider would
// do anyway when it ignores extra fields. The strip is reported once per api
// and option set rather than passing unrecorded; see
// `reportDroppedTypedOptions`.

/**
 * Derive a stable cache identity from the parts of the request that don't
 * change turn-to-turn within a logical conversation: model id, system prompt,
 * tool definitions, and the first message (the conversation seed). Codex-class
 * backends only cache prefixes when an explicit `prompt_cache_key` is set;
 * without one, two requests with the same prefix but different trailing
 * messages don't coalesce. This bridges Anthropic-style clients (which signal
 * caching via `cache_control` markers rather than an opaque key) to Codex's
 * keyed model so cross-protocol caching "just works".
 *
 * Including the first message scopes the key to one logical conversation:
 * two different chats with the same system prompt no longer share a cache
 * bucket and can't trample each other's prefix-tree entries.
 *
 * Anthropic-backed requests ignore `sessionId`; the key is harmless there.
 */
function deriveSessionId(modelId: string, context: Context): string {
	const parts: string[] = [modelId];
	if (context.systemPrompt && context.systemPrompt.length > 0) {
		parts.push(context.systemPrompt.join("\n\n"));
	}
	if (context.tools && context.tools.length > 0) {
		parts.push(JSON.stringify(context.tools));
	}
	const first = context.messages?.[0];
	if (first) {
		// Strip timestamp / provider metadata so the hash is stable across turns
		// of the same conversation (veyyon re-stamps every parsed Message). role +
		// content is what's actually on the wire.
		parts.push(JSON.stringify({ role: first.role, content: first.content }));
	}
	const seed = parts.join("\u0000");
	// The 36-char UUID flows through unchanged:
	// `normalizeOpenAIPromptCacheKey` accepts ≤64 chars verbatim.
	return deterministicUuid(seed);
}

/** `api:options` combinations already reported, so each is announced once. */
const reportedDroppedTypedOptions = new Set<string>();

/**
 * Announce request options the gateway is unable to forward.
 *
 * Warned once per API and option set rather than per request: a client that
 * sends `seed` sends it on every request, and a per-request warning would bury
 * the one line that matters. The names are logged, never the values, since
 * `user` and `logitBias` carry caller data.
 */
function reportDroppedTypedOptions(api: Api, names: string[]): void {
	const signature = `${api}:${Array.from(names).sort().join(",")}`;
	const detail = { api, dropped: names };
	if (reportedDroppedTypedOptions.has(signature)) {
		logger.debug("auth-gateway still dropping unsupported typed options", detail);
		return;
	}
	reportedDroppedTypedOptions.add(signature);
	logger.warn("auth-gateway cannot forward some request options, so they had no effect on this request", detail);
}

/** Test-only reset for {@link reportDroppedTypedOptions}'s once-per-signature bound. */
export function __resetDroppedTypedOptionReportsForTests(): void {
	reportedDroppedTypedOptions.clear();
}

/**
 * Translate a parsed gateway request into the stream options pi-ai understands.
 *
 * Exported because this is where request options are silently lost when they
 * have no pi-ai equivalent, and that behaviour needs asserting directly rather
 * than through a whole gateway round trip.
 */
export function buildStreamOptions(parsed: ParsedFormatRequest, api: Api, signal: AbortSignal): SimpleStreamOptions {
	const opts: SimpleStreamOptions = { signal };
	const { options } = parsed;
	// Codex backend rejects every sampling control with
	// `Unsupported parameter: …` (#3117). Strip the full set for that one
	// provider; everything else is harmless to forward — `streamSimple` ignores
	// what the underlying provider doesn't honour.
	const isCodex = api === "openai-codex-responses";
	if (options.maxOutputTokens !== undefined) opts.maxTokens = options.maxOutputTokens;
	if (options.temperature !== undefined && !isCodex) opts.temperature = options.temperature;
	if (options.topP !== undefined && !isCodex) opts.topP = options.topP;
	if (options.topK !== undefined && !isCodex) opts.topK = options.topK;
	if (options.minP !== undefined && !isCodex) opts.minP = options.minP;
	if (options.stopSequences !== undefined && !isCodex) opts.stopSequences = options.stopSequences;
	if (options.presencePenalty !== undefined && !isCodex) opts.presencePenalty = options.presencePenalty;
	if (options.frequencyPenalty !== undefined && !isCodex) opts.frequencyPenalty = options.frequencyPenalty;
	if (options.repetitionPenalty !== undefined && !isCodex) opts.repetitionPenalty = options.repetitionPenalty;
	if (options.metadata !== undefined) opts.metadata = options.metadata;
	if (options.headers !== undefined) opts.headers = { ...(opts.headers ?? {}), ...options.headers };
	if (options.toolChoice !== undefined) {
		opts.toolChoice =
			typeof options.toolChoice === "object" ? { type: "tool", name: options.toolChoice.name } : options.toolChoice;
	}
	if (options.reasoning !== undefined) opts.reasoning = options.reasoning;
	if (options.disableReasoning !== undefined) opts.disableReasoning = options.disableReasoning;
	if (options.hideThinkingSummary !== undefined) opts.hideThinkingSummary = options.hideThinkingSummary;
	if (options.taskBudget !== undefined) opts.taskBudget = options.taskBudget;
	if (options.serviceTier !== undefined) opts.serviceTier = options.serviceTier;
	if (options.cacheRetention !== undefined) opts.cacheRetention = options.cacheRetention;
	// Client-supplied `prompt_cache_key` wins; otherwise derive a stable
	// key from the model + system + tools so prefix caching engages on
	// Codex-class backends across turns of the same logical conversation.
	const promptCacheKey = options.promptCacheKey ?? deriveSessionId(parsed.modelId, parsed.context);
	opts.promptCacheKey = promptCacheKey;
	opts.sessionId = promptCacheKey;
	if (options.thinkingBudgets) {
		opts.thinkingBudgets = { ...(opts.thinkingBudgets ?? {}), ...options.thinkingBudgets };
	}
	if (options.explicitThinkingBudgetTokens !== undefined) {
		// Mirror Rust's `resolve_thinking_budget`: explicit budget pins onto
		// whichever effort the client requested (or High when unspecified) and
		// ALSO sets the effort so providers that gate on `reasoning` actually
		// surface the budget.
		const effort = options.reasoning ?? Effort.High;
		opts.thinkingBudgets = {
			...(opts.thinkingBudgets ?? {}),
			[effort]: options.explicitThinkingBudgetTokens,
		};
		opts.reasoning ??= effort;
	}
	// Fields that don't yet have a matching pi-ai `SimpleStreamOptions` slot, so
	// the gateway cannot forward them. They are NEVER widened into
	// `options.extra` — every consumer would have to re-implement the typed parse
	// to read them back out. Landing first-class fields for these upstream is
	// what removes this block.
	//
	// Dropping them has to be loud. A caller that set `responseFormat` and got
	// prose back, or set `seed` and got different answers to identical requests,
	// sees a request that succeeded and an option that did nothing, with no error
	// anywhere to connect the two.
	const droppedTypedOptions = Object.entries({
		parallelToolCalls: options.parallelToolCalls,
		previousResponseId: options.previousResponseId,
		seed: options.seed,
		logitBias: options.logitBias,
		user: options.user,
		responseFormat: options.responseFormat,
	})
		.filter(([, value]) => value !== undefined)
		.map(([name]) => name);
	if (droppedTypedOptions.length > 0) {
		reportDroppedTypedOptions(api, droppedTypedOptions);
	}
	return opts;
}

/**
 * Hook fired by {@link streamSimple} when the upstream request fails in a
 * way that's rotatable — today that's HTTP 401 (credential is bad) and
 * usage-limit phrasing matched by {@link isUsageLimitError} (Codex's
 * `usage_limit_reached`, Anthropic's `usage_limit_reached`, Google's
 * `resource_exhausted`, …). The two cases need different storage actions:
 *
 * - **usage-limit** → {@link AuthStorage.markUsageLimitReached}. Marks just
 *   the current session's credential as temporarily blocked (honouring
 *   `retry-after` / `resets_at` hints when present) and returns `true` only
 *   when a sibling credential is still available. Burning the credential
 *   with `invalidateCredentialMatching` here would orphan accounts whose
 *   reset window is several hours away — exactly the bug this helper exists
 *   to avoid.
 * - **auth-failure** → {@link AuthStorage.invalidateCredentialMatching}.
 *   Suspect/delete the row so it doesn't get re-picked next request.
 *
 * In both branches we return the next `getApiKey` result (sticky on the
 * same `sessionId`) so streamSimple can transparently retry the pre-emit
 * failure with a fresh credential. Returning `undefined` aborts the retry
 * and surfaces the original error to the caller.
 */
async function refreshGatewayApiKeyAfterAuthError(
	storage: AuthStorage,
	model: Model<Api>,
	sessionId: string,
	provider: string,
	oldKey: string,
	error: unknown,
	signal: AbortSignal,
	format: string,
	peer: string,
): Promise<string | undefined> {
	const message = errorMessage(error);
	if (AIError.isUsageLimit(error)) {
		const retryAfterMs = extractRetryHint(undefined, message);
		const { switched, retryAtMs } = await storage.markUsageLimitReached(provider, sessionId, {
			retryAfterMs,
			baseUrl: model.baseUrl,
			modelId: model.id,
			apiKey: oldKey,
			signal,
		});
		logger.debug("auth-gateway retrying provider request after usage-limit block", {
			format,
			provider,
			peer,
			switched,
			retryAfterMs,
			retryAtMs,
			error: message,
		});
		if (!switched) return undefined;
		return storage.getApiKey(provider, sessionId, { modelId: model.id, signal });
	}
	await storage.invalidateCredentialMatching(provider, oldKey, { sessionId, signal });
	logger.debug("auth-gateway retrying provider request after credential invalidation", {
		format,
		provider,
		peer,
		error: message,
	});
	return storage.getApiKey(provider, sessionId, { modelId: model.id, signal });
}

/**
 * Build the {@link ApiKeyResolver} handed to `streamSimple` for a gateway
 * request. Drives the central a/b/c auth-retry policy server-side:
 *
 * - initial resolve → the credential already resolved for this request.
 * - step (b) `!lastChance` → force-refresh the SAME session-sticky credential
 *   (a peer/broker may have rotated its token out from under our cached copy).
 * - step (c) `lastChance` → {@link refreshGatewayApiKeyAfterAuthError} switches
 *   to a sibling (usage-limit block vs credential invalidation by error class).
 *
 * `lastKey` tracks the most recent bearer so the switch step invalidates the
 * credential that actually failed.
 */
function buildGatewayApiKeyResolver(
	storage: AuthStorage,
	model: Model<Api>,
	sessionId: string,
	initialKey: string,
	requestSignal: AbortSignal,
	format: string,
	peer: string,
): ApiKeyResolver {
	let lastKey = initialKey;
	return async ({ lastChance, error, signal }) => {
		const sig = signal ?? requestSignal;
		if (error === undefined) {
			lastKey = initialKey;
			return initialKey;
		}
		if (!lastChance) {
			const refreshed = await storage.getApiKey(model.provider, sessionId, {
				modelId: model.id,
				signal: sig,
				forceRefresh: true,
			});
			lastKey = refreshed ?? lastKey;
			return refreshed;
		}
		const next = await refreshGatewayApiKeyAfterAuthError(
			storage,
			model,
			sessionId,
			model.provider,
			lastKey,
			error,
			sig,
			format,
			peer,
		);
		lastKey = next ?? lastKey;
		return next;
	};
}

function mirrorRequestAbort(req: Request): AbortController {
	const controller = new AbortController();
	if (req.signal.aborted) {
		controller.abort(req.signal.reason);
	} else {
		req.signal.addEventListener("abort", () => controller.abort(req.signal.reason), { once: true });
	}
	return controller;
}

/** The SSE encoder's cancel hook: a client that closes the response aborts the upstream call once. */
function abortOnClientClose(controller: AbortController): (reason?: unknown) => void {
	return reason => {
		if (!controller.signal.aborted) {
			controller.abort(reason instanceof Error ? reason : new Error("client closed request"));
		}
	};
}

/**
 * The wire a completion route answers in: its error envelope, and how it encodes a finished turn
 * and a streamed one. Every foreign format module is one; {@link PI_NATIVE_WIRE} is pi-native's.
 */
interface GatewayWire<O> {
	formatError(status: number, type: string, message: string): Response;
	encodeResponse(message: AssistantMessage, requestedModelId: string): unknown;
	encodeStream(
		events: AssistantMessageEventStream,
		requestedModelId: string,
		options: O,
		control: AuthGatewayStreamControl,
	): ReadableStream<Uint8Array>;
}

/** A parsed completion request: the fields the shared path reads and the options its wire encodes with. */
interface CompletionRequest<O> {
	modelId: string;
	context: Context;
	stream: boolean;
	options: O;
}

/** Pi-native's wire: the canonical message is the body, the canonical events are the stream. */
const PI_NATIVE_WIRE: GatewayWire<SimpleStreamOptions> = {
	formatError: piNative.formatError,
	encodeResponse: message => ({ message }),
	encodeStream: piNative.encodeStream,
};

/** Headers of every streamed answer, after the identity headers. */
const EVENT_STREAM_HEADERS = {
	"Content-Type": "text/event-stream; charset=utf-8",
	"Cache-Control": "no-cache",
	Connection: "keep-alive",
	// Disable proxy buffering (nginx and ingress controllers honor this).
	// Without it the SSE stream gets held until the buffer flushes, which
	// stalls the long-thinking-budget calls we exist to support.
	"X-Accel-Buffering": "no",
} as const;

/**
 * One completion request in flight: its id and start time, the abort mirrored from the client
 * connection, and the wire every answer is written in. A step that ends the request returns its
 * `Response`; once the client has closed its connection, that answer is a 499.
 */
class GatewayExchange<O> {
	readonly requestId = crypto.randomUUID();
	readonly startedAt = performance.now();
	readonly #controller: AbortController;
	readonly #wire: GatewayWire<O>;
	readonly #label: string;
	readonly #peer: string;

	constructor(wire: GatewayWire<O>, label: string, peer: string, req: Request) {
		this.#wire = wire;
		this.#label = label;
		this.#peer = peer;
		this.#controller = mirrorRequestAbort(req);
	}

	get signal(): AbortSignal {
		return this.#controller.signal;
	}

	/** An error in this wire's envelope. */
	reject(status: number, type: string, message: string): Response {
		return this.#wire.formatError(status, type, message);
	}

	/** The answer to a client that closed its connection. */
	closed(): Response {
		return this.reject(499, "request_aborted", "client closed request");
	}

	/** The answer to a request its wire's parser rejected with `error`. */
	malformed(error: unknown): Response {
		return this.signal.aborted ? this.closed() : this.reject(400, "invalid_request_error", errorMessage(error));
	}

	/** The request body parsed as JSON, or the answer that ends the request. */
	async readBody(req: Request): Promise<{ body: unknown } | Response> {
		if (this.signal.aborted) return this.closed();
		let body: unknown;
		try {
			body = await req.json();
		} catch (error) {
			if (this.signal.aborted) return this.closed();
			return this.reject(400, "invalid_request_error", `Invalid JSON body: ${String(error)}`);
		}
		return this.signal.aborted ? this.closed() : { body };
	}

	/**
	 * The session's credential, wrapped in the resolver `streamSimple` retries auth failures through,
	 * or the answer that ends the request. pi-ai's `stream()` does not consult `AuthStorage`, so the
	 * gateway resolves the credential itself; for an OAuth provider it is the access token, refreshed
	 * through the broker override on `AuthStorage` when needed.
	 */
	async apiKey(storage: AuthStorage, model: Model<Api>, sessionId: string): Promise<ApiKeyResolver | Response> {
		const { signal } = this;
		let apiKey: string | undefined;
		try {
			apiKey = await storage.getApiKey(model.provider, sessionId, { modelId: model.id, signal });
		} catch (error) {
			if (signal.aborted) return this.closed();
			const classified = classifyGatewayError(error);
			logger.warn("auth-gateway getApiKey threw", {
				provider: model.provider,
				peer: this.#peer,
				error: classified.message,
			});
			return this.reject(classified.status, classified.type, classified.message);
		}
		if (signal.aborted) return this.closed();
		if (!apiKey) {
			return this.reject(401, "authentication_error", `No credential available for provider ${model.provider}`);
		}
		return buildGatewayApiKeyResolver(storage, model, sessionId, apiKey, signal, this.#label, this.#peer);
	}

	/** Run the turn and answer with the finished message or, when the client asked for one, an event stream. */
	async complete(model: Model<Api>, request: CompletionRequest<O>, options: SimpleStreamOptions): Promise<Response> {
		logger.info("auth-gateway request", {
			requestId: this.requestId,
			format: this.#label,
			model: request.modelId,
			resolvedProvider: model.provider,
			resolvedModel: model.id,
			stream: request.stream,
			peer: this.#peer,
		});
		return request.stream ? this.#stream(model, request, options) : this.#finish(model, request, options);
	}

	async #finish(model: Model<Api>, request: CompletionRequest<O>, options: SimpleStreamOptions): Promise<Response> {
		const { signal } = this;
		try {
			if (signal.aborted) return this.closed();
			const message = await completeSimple(model, request.context, options);
			if (message.stopReason === "aborted" || message.stopReason === "error") {
				return this.#failedTurn(message.stopReason, message.errorMessage);
			}
			return json(
				200,
				this.#wire.encodeResponse(message, request.modelId),
				gatewayResponseHeaders(model, { requestId: this.requestId, message, startedAt: this.startedAt }),
			);
		} catch (error) {
			if (signal.aborted) return this.closed();
			const classified = classifyGatewayError(error);
			logger.warn("auth-gateway non-streaming aborted", {
				format: this.#label,
				error: classified.message,
				peer: this.#peer,
			});
			return this.reject(classified.status, classified.type, classified.message);
		}
	}

	/** A turn the provider ended as failed: 499 when it was aborted, the classifier's verdict otherwise. */
	#failedTurn(reason: "aborted" | "error", providerMessage: string | undefined): Response {
		const message = providerMessage ?? (reason === "aborted" ? "Request was aborted" : "Upstream request failed");
		logger.warn("auth-gateway non-streaming failed", {
			format: this.#label,
			reason,
			error: message,
			peer: this.#peer,
		});
		if (reason === "aborted") return this.reject(499, "request_aborted", message);
		const classified = classifyGatewayError(message);
		return this.reject(classified.status, classified.type, message);
	}

	#stream(model: Model<Api>, request: CompletionRequest<O>, options: SimpleStreamOptions): Response {
		const { signal } = this;
		let events: AssistantMessageEventStream;
		try {
			if (signal.aborted) return this.closed();
			events = streamSimple(model, request.context, options);
		} catch (error) {
			const classified = classifyGatewayError(error);
			logger.warn("auth-gateway streamSimple threw", {
				format: this.#label,
				error: classified.message,
				peer: this.#peer,
			});
			return this.reject(classified.status, classified.type, classified.message);
		}
		if (signal.aborted) return this.closed();
		const body = this.#wire.encodeStream(events, request.modelId, request.options, {
			signal,
			onCancel: abortOnClientClose(this.#controller),
		});
		return new Response(body, {
			status: 200,
			headers: { ...gatewayResponseHeaders(model, { requestId: this.requestId }), ...EVENT_STREAM_HEADERS },
		});
	}
}

/**
 * A foreign wire format (OpenAI chat-completions, Anthropic messages, OpenAI Responses): the
 * request is translated into a pi-ai `Context` and the turn back into the same wire.
 */
async function serveFormatRequest(
	module: FormatModule,
	label: string,
	bootOpts: AuthGatewayBootOptions,
	req: Request,
	peer: string,
): Promise<Response> {
	const exchange = new GatewayExchange(module, label, peer, req);
	const read = await exchange.readBody(req);
	if (read instanceof Response) return read;

	// All three supported wire formats put the model id on a top-level `model`
	// field. Read it without running the full strict schema so the route can
	// produce a coherent error envelope when the model id is missing.
	const modelId = isRecord(read.body) && typeof read.body.model === "string" ? read.body.model : undefined;
	if (!modelId) {
		return exchange.reject(400, "invalid_request_error", "Missing top-level `model` field");
	}
	const model = bootOpts.resolveModel(modelId);
	if (!model) {
		return exchange.reject(404, "invalid_request_error", `Unknown model: ${modelId}`);
	}

	// Parse the wire-format request BEFORE resolving the credential so we
	// have a stable per-conversation `sessionId` to thread into AuthStorage.
	// Sticky-credential tracking and `markUsageLimitReached` both key off
	// this id; without it `getApiKey` would re-roundrobin every request
	// and `markUsageLimitReached` would no-op (it can only mark the
	// credential it last handed out to that session).
	let parsed: ParsedFormatRequest;
	try {
		parsed = module.parseRequest(read.body, req.headers);
	} catch (error) {
		return exchange.malformed(error);
	}
	// Merge gateway-captured passthrough headers under the parser's own
	// captures. Parsers that set `options.headers` themselves win (they may
	// have stripped or normalized values); the gateway's allow-list fills in
	// anything they didn't touch.
	parsed.options.headers = { ...captureRequestHeaders(req.headers), ...(parsed.options.headers ?? {}) };
	if (exchange.signal.aborted) return exchange.closed();

	// Sticky credential id: honour the client's `prompt_cache_key` when
	// supplied (so external session ids align), otherwise derive from
	// modelId + system + tools + first message. Mirrored into
	// streamOpts.sessionId / promptCacheKey by `buildStreamOptions`.
	const sessionId = parsed.options.promptCacheKey ?? deriveSessionId(parsed.modelId, parsed.context);
	parsed.options.promptCacheKey ??= sessionId;

	const apiKey = await exchange.apiKey(bootOpts.storage, model, sessionId);
	if (apiKey instanceof Response) return apiKey;
	const options = buildStreamOptions(parsed, model.api, exchange.signal);
	options.apiKey = apiKey;
	return exchange.complete(model, parsed, options);
}

/**
 * Pi-native fast path: `POST /v1/pi/stream`. Accepts the canonical pi-ai
 * `Context` directly (no wire-format round-trip) and emits a bandwidth-shrunk
 * event stream matching `pi-agent`'s `streamProxy`. Skips the OpenAI /
 * Anthropic / Responses translation layers — those exist to bridge foreign
 * SDKs (llm-git, anthropic-sdk, openai-sdk), and bridging back to pi-native
 * just to bridge forward again is wasted work.
 *
 * Every other gateway concern (bearer auth, model resolve, credential fetch,
 * abort mirroring, codex temperature/topP strip, prefix-cache key derivation,
 * Claude-Code OAuth shaping inside `streamSimple`) still applies — only
 * `parseRequest`/`encodeResponse`/`encodeStream` differ from the format-endpoint
 * path.
 */
async function servePiNativeRequest(bootOpts: AuthGatewayBootOptions, req: Request, peer: string): Promise<Response> {
	const exchange = new GatewayExchange(PI_NATIVE_WIRE, "pi-native", peer, req);
	const read = await exchange.readBody(req);
	if (read instanceof Response) return read;

	let parsed: piNative.PiNativeParsedRequest;
	try {
		parsed = piNative.parseRequest(read.body, req.headers);
	} catch (error) {
		return exchange.malformed(error);
	}
	const model = bootOpts.resolveModel(parsed.modelId);
	if (!model) {
		return exchange.reject(404, "invalid_request_error", `Unknown model: ${parsed.modelId}`);
	}
	// Pi-native already parsed `streamOpts.sessionId` (when set by the
	// client); fall back to the derived key so credential-stickiness lines
	// up with cache-prefix stickiness — same identity used for both means
	// the next turn of this conversation reuses the same credential until
	// it hits a usage cap, then markUsageLimitReached can hand off.
	const sessionId = parsed.options.sessionId ?? deriveSessionId(parsed.modelId, parsed.context);
	parsed.options.sessionId ??= sessionId;

	const apiKey = await exchange.apiKey(bootOpts.storage, model, sessionId);
	if (apiKey instanceof Response) return apiKey;
	const options = piNativeStreamOptions(parsed.options, model.api, req.headers, exchange.signal);
	options.apiKey = apiKey;
	return exchange.complete(model, parsed, options);
}

/**
 * The options a pi-native request hands to `streamSimple`. The client's options are trusted
 * (`parseRequest` already allow-listed them) and only server-controlled fields are injected. The
 * codex sampling strip mirrors `buildStreamOptions`: Codex rejects every one with a 400 (#3117).
 */
function piNativeStreamOptions(
	client: SimpleStreamOptions,
	api: Api,
	headers: Headers,
	signal: AbortSignal,
): SimpleStreamOptions {
	const options: SimpleStreamOptions = { ...client, signal };
	if (api === "openai-codex-responses") {
		delete options.temperature;
		delete options.topP;
		delete options.topK;
		delete options.minP;
		delete options.stopSequences;
		delete options.presencePenalty;
		delete options.frequencyPenalty;
		delete options.repetitionPenalty;
	}
	// Merge gateway-captured passthrough headers under the client's own
	// headers — the client's values win when they collide.
	options.headers = { ...captureRequestHeaders(headers), ...(options.headers ?? {}) };
	return options;
}

/**
 * Snapshot of `GET /v1/usage` — `fetchUsageReports` already caches reports at
 * a 5-minute per-credential TTL (with jitter, plus last-good fallback on
 * failure) inside `AuthStorage`, so this handler is a thin wrapper that
 * surfaces the same data to HTTP callers (notably the macOS usage widget).
 */
async function handleUsage(storage: AuthStorage, signal: AbortSignal): Promise<Response> {
	const reports = (await storage.fetchUsageReports?.({ signal })) ?? [];
	// Drop the heavy provider-specific `raw` payload — UI consumers only need
	// `limits` + `metadata`. Match the broker's `/v1/usage` shape so a single
	// client struct (Swift widget, llm-git, ...) works against either endpoint.
	const trimmed = reports.map(({ raw: _raw, ...rest }) => rest);
	return json(200, { generatedAt: Date.now(), reports: trimmed });
}

/**
 * Per-credential health probe surfaced on `GET /v1/credentials/check`. Tells
 * the caller exactly which row in their broker is producing 401s — the
 * aggregate `/v1/usage` endpoint silently drops failed credentials, which is
 * the wrong shape when you're diagnosing auth.
 *
 * The probe is sequential (one credential at a time) to avoid synchronized
 * N-account fan-out tripping per-IP rate limits on provider `/usage`
 * endpoints. For multi-account pools that's the difference between getting
 * a clean diagnosis and getting a 429 storm.
 */
async function handleCredentialsCheck(storage: AuthStorage, signal: AbortSignal): Promise<Response> {
	const credentials = await storage.checkCredentials({ signal });
	return json(200, { generatedAt: Date.now(), credentials });
}

function handleModelsList(opts: AuthGatewayBootOptions): Response {
	const list = opts.listModels ? Array.from(opts.listModels()) : [];
	const seen = new Set<string>();
	const data = [];
	for (const model of list) {
		const id = `${model.provider}/${model.id}`;
		if (seen.has(id)) continue;
		seen.add(id);
		data.push({
			id,
			object: "model" as const,
			owned_by: model.provider,
			api: model.api,
		});
	}
	return json(200, { object: "list", data });
}

export function startAuthGateway(opts: AuthGatewayBootOptions): AuthGatewayServerHandle {
	const bind = parseBind(opts.bind ?? DEFAULT_AUTH_GATEWAY_BIND);
	const tokens = new Set<string>(opts.bearerTokens);
	const version = opts.version;

	const server = Bun.serve({
		hostname: bind.hostname,
		port: bind.port,
		fetch: async (req): Promise<Response> => {
			const url = new URL(req.url);
			const pathname = url.pathname;
			const peer = resolvePeer(req);
			// CORS preflight is always answered without auth — browsers send
			// preflights pre-authentication and a 401 here breaks the actual
			// request before the bearer is ever attached.
			if (req.method === "OPTIONS") {
				return new Response(null, { status: 204, headers: corsHeaders(req) });
			}
			try {
				if (req.method === "GET" && pathname === "/healthz") {
					return withCors(json(200, { ok: true, version }), req);
				}
				if (!isAuthorized(req, tokens)) {
					logger.info("auth-gateway request unauthorized", { method: req.method, path: pathname, peer });
					return withCors(json(401, { error: "unauthorized" }), req);
				}

				// Aggregated usage — backed by AuthStorage's 5-min per-credential cache.
				// Same shape as the broker's `/v1/usage`, so widget/llm-git speak to either with the
				// same client struct.
				if (req.method === "GET" && pathname === "/v1/usage") {
					return withCors(await handleUsage(opts.storage, req.signal), req);
				}

				// Per-credential auth probe — diagnoses which row in a multi-account
				// pool is producing 401s. Aggregated `/v1/usage` silently drops failed
				// credentials, so we need a separate endpoint that captures errors.
				if (req.method === "GET" && pathname === "/v1/credentials/check") {
					return withCors(await handleCredentialsCheck(opts.storage, req.signal), req);
				}

				// Completion routes: the foreign wire formats and the pi-native fast path.
				const completion = COMPLETION_ROUTES[pathname];
				if (completion && req.method === "POST") {
					return withCors(await completion(opts, req, peer), req);
				}

				// Model catalog.
				if (req.method === "GET" && pathname === "/v1/models") {
					return withCors(handleModelsList(opts), req);
				}

				// Route-table miss: no format module to defer to, so we emit a
				// plain JSON 404 rather than guessing at a protocol-specific envelope.
				return withCors(json(404, { error: `No route: ${req.method} ${pathname}` }), req);
			} catch (error) {
				logger.error("auth-gateway handler crashed", {
					method: req.method,
					path: pathname,
					peer,
					error: String(error),
				});
				return withCors(json(500, { error: "internal error" }), req);
			}
		},
		// Max-out Bun's idle timeout. Long thinking-budget calls can sit idle
		// for minutes before the first token arrives; the default kills them.
		idleTimeout: 255,
	});

	const boundHost = server.hostname ?? bind.hostname;
	const boundPort = server.port ?? bind.port;
	return {
		url: `http://${boundHost}:${boundPort}`,
		port: boundPort,
		hostname: boundHost,
		close: async () => {
			server.stop(true);
		},
	};
}
