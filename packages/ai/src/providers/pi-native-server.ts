import { errorMessage, isRecord } from "@veyyon/utils/type-guards";
import type { AuthGatewayStreamControl } from "../auth-gateway/types";
import * as AIError from "../error";
import type { AssistantMessageEventStream, Context, SimpleStreamOptions } from "../types";

export interface PiNativeParsedRequest {
	modelId: string;
	context: Context;
	options: SimpleStreamOptions;
	stream: boolean;
}
const ALLOWED_OPTION_KEYS: ReadonlySet<keyof SimpleStreamOptions> = new Set([
	"temperature",
	"topP",
	"topK",
	"minP",
	"presencePenalty",
	"frequencyPenalty",
	"repetitionPenalty",
	"stopSequences",
	"maxTokens",
	"cacheRetention",
	"headers",
	"initiatorOverride",
	"maxRetryDelayMs",
	"metadata",
	"sessionId",
	"promptCacheKey",
	"streamFirstEventTimeoutMs",
	"streamIdleTimeoutMs",
	"reasoning",
	"disableReasoning",
	"hideThinkingSummary",
	"thinkingBudgets",
	"toolChoice",
	"serviceTier",
	"kimiApiFormat",
	"syntheticApiFormat",
	"preferWebsockets",
	"openrouterVariant",
	"loopGuard",
] as const satisfies readonly (keyof SimpleStreamOptions)[]);

// parseRequest

export function parseRequest(body: unknown, _headers?: Headers): PiNativeParsedRequest {
	if (!isRecord(body)) {
		throw new AIError.ValidationError("Request body must be a JSON object");
	}
	const obj = body as Record<string, unknown>;

	let modelId: string | undefined;
	if (typeof obj.modelId === "string" && obj.modelId.length > 0) {
		modelId = obj.modelId;
	} else if (typeof obj.model === "string" && obj.model.length > 0) {
		modelId = obj.model;
	} else if (typeof obj.model === "object" && obj.model !== null) {
		const m = obj.model as Record<string, unknown>;
		if (typeof m.id === "string" && m.id.length > 0) modelId = m.id;
	}
	if (!modelId) throw new AIError.ValidationError("Missing `modelId` (or `model.id`) field");

	const context = obj.context;
	if (!isRecord(context)) {
		throw new AIError.ValidationError("Missing `context` object");
	}
	const ctxObj = context as Record<string, unknown>;
	if (!Array.isArray(ctxObj.messages)) {
		throw new AIError.ValidationError("`context.messages` must be an array");
	}
	if (ctxObj.systemPrompt !== undefined && !Array.isArray(ctxObj.systemPrompt)) {
		throw new AIError.ValidationError("`context.systemPrompt` must be an array of strings when present");
	}
	if (ctxObj.tools !== undefined && !Array.isArray(ctxObj.tools)) {
		throw new AIError.ValidationError("`context.tools` must be an array when present");
	}

	const options: SimpleStreamOptions = {};
	const rawOpts = obj.options;
	if (isRecord(rawOpts)) {
		const optsBag = options as Record<string, unknown>;
		for (const [k, v] of Object.entries(rawOpts)) {
			if (v === undefined || v === null) continue;
			if (!ALLOWED_OPTION_KEYS.has(k as keyof SimpleStreamOptions)) continue;
			optsBag[k] = v;
		}
	}

	// `stream` defaults to true — pi-native clients overwhelmingly stream, and
	// matching `streamProxy`'s implicit-stream behavior avoids a one-flag papercut.
	const stream = typeof obj.stream === "boolean" ? obj.stream : true;

	return {
		modelId,
		context: context as unknown as Context,
		options,
		stream,
	};
}
// encodeStream (SSE)

const SSE_ENCODER = new TextEncoder();
const SSE_DONE = SSE_ENCODER.encode("data: [DONE]\n\n");

export function encodeStream(
	events: AssistantMessageEventStream,
	_requestedModelId?: string,
	_options?: SimpleStreamOptions,
	control?: AuthGatewayStreamControl,
): ReadableStream<Uint8Array> {
	let cancelled = control?.signal?.aborted === true;
	const markCancelled = () => {
		cancelled = true;
	};
	control?.signal?.addEventListener("abort", markCancelled, { once: true });
	return new ReadableStream<Uint8Array>({
		async start(controller) {
			try {
				if (cancelled) {
					controller.close();
					return;
				}
				for await (const event of events) {
					if (cancelled) return;
					controller.enqueue(SSE_ENCODER.encode(`data: ${JSON.stringify(event)}\n\n`));
					if (event.type === "done" || event.type === "error") break;
				}
				if (!cancelled) {
					controller.enqueue(SSE_DONE);
					controller.close();
				}
			} catch (err) {
				if (!cancelled) {
					// Best-effort error envelope so the client iterator resolves
					// instead of hanging on the dropped connection. Shape matches the
					// canonical `error` event minus the unrecoverable `error:
					// AssistantMessage` payload (we don't have a usable one here).
					const message = errorMessage(err);
					controller.enqueue(
						SSE_ENCODER.encode(
							`data: ${JSON.stringify({ type: "error", reason: "error", errorMessage: message })}\n\n`,
						),
					);
					controller.enqueue(SSE_DONE);
					controller.close();
				}
			} finally {
				control?.signal?.removeEventListener("abort", markCancelled);
			}
		},
		cancel(reason) {
			cancelled = true;
			control?.signal?.removeEventListener("abort", markCancelled);
			control?.onCancel?.(reason);
		},
	});
}

// formatError

export function formatError(status: number, type: string, message: string): Response {
	return new Response(JSON.stringify({ error: { type, message } }), {
		status,
		headers: {
			"Content-Type": "application/json; charset=utf-8",
			"Cache-Control": "no-store",
		},
	});
}
