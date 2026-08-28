import { Effort } from "@veyyon/catalog/effort";
import { extractRetryHint } from "@veyyon/utils/fetch-retry";
import * as logger from "@veyyon/utils/logger";
import { errorMessage } from "@veyyon/utils/type-guards";
import type { ApiKeyResolver } from "../auth-retry";
import type { AuthStorage } from "../auth-storage";
import * as AIError from "../error";
import { classifyGatewayError } from "../error/gateway";
import * as anthropicMessages from "../providers/anthropic-messages-server";
import * as openaiChat from "../providers/openai-chat-server";
import * as openaiResponses from "../providers/openai-responses-server";
import * as piNative from "../providers/pi-native-server";
import { completeSimple, streamSimple } from "../stream";
import type { Api, AssistantMessageEventStream, Context, Model, SimpleStreamOptions } from "../types";
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
	AuthGatewayFormatModule as FormatModule,
	AuthGatewayParsedRequest as ParsedFormatRequest,
} from "./types";
import { DEFAULT_AUTH_GATEWAY_BIND } from "./types";

export type ModelResolver = (modelId: string) => Model<Api> | undefined;

export interface AuthGatewayBootOptions extends AuthGatewayServerOptions {
	storage: AuthStorage;
	resolveModel: ModelResolver;
	listModels?: () => Iterable<Model<Api>>;
}

const FORMAT_ROUTES: Record<string, { module: FormatModule; label: string }> = {
	"/v1/chat/completions": { module: openaiChat, label: "openai-chat" },
	"/v1/messages": { module: anthropicMessages, label: "anthropic-messages" },
	"/v1/responses": { module: openaiResponses, label: "openai-responses" },
};

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
		parts.push(JSON.stringify({ role: first.role, content: first.content }));
	}
	const seed = parts.join("\u0000");
	return deterministicUuid(seed);
}

const reportedDroppedTypedOptions = new Set<string>();

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

export function __resetDroppedTypedOptionReportsForTests(): void {
	reportedDroppedTypedOptions.clear();
}

export function buildStreamOptions(parsed: ParsedFormatRequest, api: Api, signal: AbortSignal): SimpleStreamOptions {
	const opts: SimpleStreamOptions = { signal };
	const { options } = parsed;
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
	const promptCacheKey = options.promptCacheKey ?? deriveSessionId(parsed.modelId, parsed.context);
	opts.promptCacheKey = promptCacheKey;
	opts.sessionId = promptCacheKey;
	if (options.thinkingBudgets) {
		opts.thinkingBudgets = { ...(opts.thinkingBudgets ?? {}), ...options.thinkingBudgets };
	}
	if (options.explicitThinkingBudgetTokens !== undefined) {
		const effort = options.reasoning ?? Effort.High;
		opts.thinkingBudgets = {
			...(opts.thinkingBudgets ?? {}),
			[effort]: options.explicitThinkingBudgetTokens,
		};
		opts.reasoning ??= effort;
	}
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

function clientClosedResponse(route: { module: FormatModule }): Response {
	return route.module.formatError(499, "request_aborted", "client closed request");
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

async function handleFormatEndpoint(
	route: { module: FormatModule; label: string },
	bootOpts: AuthGatewayBootOptions,
	req: Request,
	peer: string,
): Promise<Response> {
	const startedAt = performance.now();
	const requestId = crypto.randomUUID();
	const controller = mirrorRequestAbort(req);
	if (controller.signal.aborted) return clientClosedResponse(route);

	let body: unknown;
	try {
		body = await req.json();
	} catch (error) {
		if (controller.signal.aborted) return clientClosedResponse(route);
		return route.module.formatError(400, "invalid_request_error", `Invalid JSON body: ${String(error)}`);
	}
	if (controller.signal.aborted) return clientClosedResponse(route);

	const modelId =
		typeof body === "object" && body !== null && typeof (body as { model?: unknown }).model === "string"
			? (body as { model: string }).model
			: undefined;
	if (!modelId) {
		return route.module.formatError(400, "invalid_request_error", "Missing top-level `model` field");
	}

	const model = bootOpts.resolveModel(modelId);
	if (!model) {
		return route.module.formatError(404, "invalid_request_error", `Unknown model: ${modelId}`);
	}

	let parsed: ParsedFormatRequest;
	try {
		parsed = route.module.parseRequest(body, req.headers);
	} catch (error) {
		if (controller.signal.aborted) return clientClosedResponse(route);
		const message = errorMessage(error);
		return route.module.formatError(400, "invalid_request_error", message);
	}
	{
		const captured = captureRequestHeaders(req.headers);
		parsed.options.headers = { ...captured, ...(parsed.options.headers ?? {}) };
	}
	if (controller.signal.aborted) return clientClosedResponse(route);

	const sessionId = parsed.options.promptCacheKey ?? deriveSessionId(parsed.modelId, parsed.context);
	parsed.options.promptCacheKey ??= sessionId;

	let apiKey: string | undefined;
	try {
		apiKey = await bootOpts.storage.getApiKey(model.provider, sessionId, {
			modelId: model.id,
			signal: controller.signal,
		});
	} catch (error) {
		if (controller.signal.aborted) return clientClosedResponse(route);
		const classified = classifyGatewayError(error);
		logger.warn("auth-gateway getApiKey threw", { provider: model.provider, peer, error: classified.message });
		return route.module.formatError(classified.status, classified.type, classified.message);
	}
	if (controller.signal.aborted) return clientClosedResponse(route);
	if (!apiKey) {
		return route.module.formatError(
			401,
			"authentication_error",
			`No credential available for provider ${model.provider}`,
		);
	}

	const streamOpts = buildStreamOptions(parsed, model.api, controller.signal);
	streamOpts.apiKey = buildGatewayApiKeyResolver(
		bootOpts.storage,
		model,
		sessionId,
		apiKey,
		controller.signal,
		route.label,
		peer,
	);

	logger.info("auth-gateway request", {
		requestId,
		format: route.label,
		model: parsed.modelId,
		resolvedProvider: model.provider,
		resolvedModel: model.id,
		stream: parsed.stream,
		peer,
	});

	if (!parsed.stream) {
		try {
			if (controller.signal.aborted) return clientClosedResponse(route);
			const message = await completeSimple(model, parsed.context, streamOpts);
			if (message.stopReason === "aborted" || message.stopReason === "error") {
				const errorMessage =
					message.errorMessage ??
					(message.stopReason === "aborted" ? "Request was aborted" : "Upstream request failed");
				logger.warn("auth-gateway non-streaming failed", {
					format: route.label,
					reason: message.stopReason,
					error: errorMessage,
					peer,
				});
				if (message.stopReason === "aborted") {
					return route.module.formatError(499, "request_aborted", errorMessage);
				}
				const classified = classifyGatewayError(errorMessage);
				return route.module.formatError(classified.status, classified.type, errorMessage);
			}
			return json(
				200,
				route.module.encodeResponse(message, parsed.modelId),
				gatewayResponseHeaders(model, { requestId, message, startedAt }),
			);
		} catch (error) {
			if (controller.signal.aborted) return clientClosedResponse(route);
			const classified = classifyGatewayError(error);
			logger.warn("auth-gateway non-streaming aborted", {
				format: route.label,
				error: classified.message,
				peer,
			});
			return route.module.formatError(classified.status, classified.type, classified.message);
		}
	}

	let events: AssistantMessageEventStream;
	try {
		if (controller.signal.aborted) return clientClosedResponse(route);
		events = streamSimple(model, parsed.context, streamOpts);
	} catch (error) {
		const classified = classifyGatewayError(error);
		logger.warn("auth-gateway streamSimple threw", { format: route.label, error: classified.message, peer });
		return route.module.formatError(classified.status, classified.type, classified.message);
	}
	if (controller.signal.aborted) return clientClosedResponse(route);

	const sseStream = route.module.encodeStream(events, parsed.modelId, parsed.options, {
		signal: controller.signal,
		onCancel: reason => {
			if (!controller.signal.aborted) {
				controller.abort(reason instanceof Error ? reason : new Error("client closed request"));
			}
		},
	});
	return new Response(sseStream, {
		status: 200,
		headers: {
			...gatewayResponseHeaders(model, { requestId }),
			"Content-Type": "text/event-stream; charset=utf-8",
			"Cache-Control": "no-cache",
			Connection: "keep-alive",
			"X-Accel-Buffering": "no",
		},
	});
}

async function handlePiNative(bootOpts: AuthGatewayBootOptions, req: Request, peer: string): Promise<Response> {
	const startedAt = performance.now();
	const requestId = crypto.randomUUID();
	const controller = mirrorRequestAbort(req);
	const aborted = (): Response => piNative.formatError(499, "request_aborted", "client closed request");
	if (controller.signal.aborted) return aborted();

	let body: unknown;
	try {
		body = await req.json();
	} catch (error) {
		if (controller.signal.aborted) return aborted();
		return piNative.formatError(400, "invalid_request_error", `Invalid JSON body: ${String(error)}`);
	}
	if (controller.signal.aborted) return aborted();

	let parsed: piNative.PiNativeParsedRequest;
	try {
		parsed = piNative.parseRequest(body, req.headers);
	} catch (error) {
		if (controller.signal.aborted) return aborted();
		const message = errorMessage(error);
		return piNative.formatError(400, "invalid_request_error", message);
	}

	const model = bootOpts.resolveModel(parsed.modelId);
	if (!model) {
		return piNative.formatError(404, "invalid_request_error", `Unknown model: ${parsed.modelId}`);
	}
	const sessionId = parsed.options.sessionId ?? deriveSessionId(parsed.modelId, parsed.context);
	parsed.options.sessionId ??= sessionId;

	let apiKey: string | undefined;
	try {
		apiKey = await bootOpts.storage.getApiKey(model.provider, sessionId, {
			modelId: model.id,
			signal: controller.signal,
		});
	} catch (error) {
		if (controller.signal.aborted) return aborted();
		const classified = classifyGatewayError(error);
		logger.warn("auth-gateway getApiKey threw", { provider: model.provider, peer, error: classified.message });
		return piNative.formatError(classified.status, classified.type, classified.message);
	}
	if (controller.signal.aborted) return aborted();
	if (!apiKey) {
		return piNative.formatError(
			401,
			"authentication_error",
			`No credential available for provider ${model.provider}`,
		);
	}

	const streamOpts: SimpleStreamOptions = { ...parsed.options, apiKey, signal: controller.signal };
	streamOpts.apiKey = buildGatewayApiKeyResolver(
		bootOpts.storage,
		model,
		sessionId,
		apiKey,
		controller.signal,
		"pi-native",
		peer,
	);
	if (model.api === "openai-codex-responses") {
		delete streamOpts.temperature;
		delete streamOpts.topP;
		delete streamOpts.topK;
		delete streamOpts.minP;
		delete streamOpts.stopSequences;
		delete streamOpts.presencePenalty;
		delete streamOpts.frequencyPenalty;
		delete streamOpts.repetitionPenalty;
	}
	const captured = captureRequestHeaders(req.headers);
	streamOpts.headers = { ...captured, ...(streamOpts.headers ?? {}) };
	streamOpts.sessionId ??= sessionId;

	logger.info("auth-gateway request", {
		requestId,
		format: "pi-native",
		model: parsed.modelId,
		resolvedProvider: model.provider,
		resolvedModel: model.id,
		stream: parsed.stream,
		peer,
	});

	if (!parsed.stream) {
		try {
			if (controller.signal.aborted) return aborted();
			const message = await completeSimple(model, parsed.context, streamOpts);
			if (message.stopReason === "aborted" || message.stopReason === "error") {
				const errorMessage =
					message.errorMessage ??
					(message.stopReason === "aborted" ? "Request was aborted" : "Upstream request failed");
				logger.warn("auth-gateway non-streaming failed", {
					format: "pi-native",
					reason: message.stopReason,
					error: errorMessage,
					peer,
				});
				if (message.stopReason === "aborted") {
					return piNative.formatError(499, "request_aborted", errorMessage);
				}
				const classified = classifyGatewayError(errorMessage);
				return piNative.formatError(classified.status, classified.type, errorMessage);
			}
			return json(200, { message }, gatewayResponseHeaders(model, { requestId, message, startedAt }));
		} catch (error) {
			if (controller.signal.aborted) return aborted();
			const classified = classifyGatewayError(error);
			logger.warn("auth-gateway non-streaming aborted", { format: "pi-native", error: classified.message, peer });
			return piNative.formatError(classified.status, classified.type, classified.message);
		}
	}

	let events: AssistantMessageEventStream;
	try {
		if (controller.signal.aborted) return aborted();
		events = streamSimple(model, parsed.context, streamOpts);
	} catch (error) {
		const classified = classifyGatewayError(error);
		logger.warn("auth-gateway streamSimple threw", { format: "pi-native", error: classified.message, peer });
		return piNative.formatError(classified.status, classified.type, classified.message);
	}
	if (controller.signal.aborted) return aborted();

	const sseStream = piNative.encodeStream(events, parsed.modelId, parsed.options, {
		signal: controller.signal,
		onCancel: reason => {
			if (!controller.signal.aborted) {
				controller.abort(reason instanceof Error ? reason : new Error("client closed request"));
			}
		},
	});
	return new Response(sseStream, {
		status: 200,
		headers: {
			...gatewayResponseHeaders(model, { requestId }),
			"Content-Type": "text/event-stream; charset=utf-8",
			"Cache-Control": "no-cache",
			Connection: "keep-alive",
			"X-Accel-Buffering": "no",
		},
	});
}

async function handleUsage(storage: AuthStorage, signal: AbortSignal): Promise<Response> {
	const reports = (await storage.fetchUsageReports?.({ signal })) ?? [];
	const trimmed = reports.map(({ raw: _raw, ...rest }) => rest);
	return json(200, { generatedAt: Date.now(), reports: trimmed });
}

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

				if (req.method === "GET" && pathname === "/v1/usage") {
					return withCors(await handleUsage(opts.storage, req.signal), req);
				}

				if (req.method === "GET" && pathname === "/v1/credentials/check") {
					return withCors(await handleCredentialsCheck(opts.storage, req.signal), req);
				}

				const formatRoute = FORMAT_ROUTES[pathname];
				if (formatRoute && req.method === "POST") {
					return withCors(await handleFormatEndpoint(formatRoute, opts, req, peer), req);
				}

				if (req.method === "POST" && pathname === "/v1/pi/stream") {
					return withCors(await handlePiNative(opts, req, peer), req);
				}

				if (req.method === "GET" && pathname === "/v1/models") {
					return withCors(handleModelsList(opts), req);
				}

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
