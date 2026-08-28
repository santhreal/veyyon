import { emptyUsage } from "@veyyon/catalog/models";
import { readSseJson } from "@veyyon/utils/stream";
import { errorMessage } from "@veyyon/utils/type-guards";
import { trimTrailingSlashes } from "@veyyon/utils/url";
import * as AIError from "../error";
import { AUTH_EVIDENCE_LOCAL } from "../error/auth-classify";
import type {
	Api,
	AssistantMessage,
	AssistantMessageEvent,
	AssistantMessageEventStream as AssistantMessageEventStreamType,
	Context,
	Model,
	SimpleStreamOptions,
} from "../types";
import { createAbortSourceTracker } from "../utils/abort";
import { AssistantMessageEventStream } from "../utils/event-stream";
import { getStreamFirstEventTimeoutMs, getStreamIdleTimeoutMs, iterateWithIdleTimeout } from "../utils/idle-iterator";

const NON_WIRE_KEYS = new Set<keyof SimpleStreamOptions>([
	"signal",
	"apiKey",
	"fetch",
	"onPayload",
	"onResponse",
	"onSseEvent",
	"execHandlers",
	"cursorExecHandlers",
	"cursorOnToolResult",
	"providerSessionState",
]);
const VEYYON_NATIVE_STREAM_IDLE_TIMEOUT_ERROR = "pi-native stream stalled while waiting for the next event";
const VEYYON_NATIVE_STREAM_FIRST_EVENT_TIMEOUT_ERROR = "pi-native stream timed out while waiting for the first event";

class PiNativePayloadHookError extends Error {
	readonly rejection: unknown;
	readonly [AUTH_EVIDENCE_LOCAL] = true;

	constructor(rejection: unknown) {
		const detail = errorMessage(rejection);
		super(detail ? `pi-native onPayload hook rejected: ${detail}` : "pi-native onPayload hook rejected");
		this.name = "PiNativePayloadHookError";
		this.rejection = rejection;
	}
}

function isPiNativeProgressEvent(event: unknown): boolean {
	if (typeof event !== "object" || event === null || !("type" in event)) return true;
	return event.type !== "start";
}

function buildWireOptions(options: SimpleStreamOptions | undefined): Record<string, unknown> {
	if (!options) return {};
	const wire: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(options)) {
		if (v === undefined) continue;
		if (NON_WIRE_KEYS.has(k as keyof SimpleStreamOptions)) continue;
		wire[k] = v;
	}
	return wire;
}

async function decodeGatewayError(response: Response): Promise<AIError.AuthGatewayError> {
	const status = response.status;
	const read = await AIError.readProviderErrorBody(response);
	let body: unknown = read.text;
	try {
		body = JSON.parse(read.text);
	} catch {}
	if (typeof body === "object" && body !== null && "error" in body) {
		const err = (body as { error: unknown }).error;
		if (typeof err === "object" && err !== null) {
			const message = (err as { message?: unknown }).message;
			const type = (err as { type?: unknown }).type;
			return new AIError.AuthGatewayError(
				typeof message === "string" ? AIError.boundProviderErrorDetail(message) : `auth-gateway ${status}`,
				status,
				response.headers,
				typeof type === "string" ? type : undefined,
			);
		}
	}
	const text = typeof body === "string" ? read.detail : AIError.boundProviderErrorDetail(JSON.stringify(body));
	return new AIError.AuthGatewayError(
		`auth-gateway ${status}: ${text || response.statusText}`,
		status,
		response.headers,
	);
}

function resolveStreamUrl(model: Model<Api>): string {
	if (!model.baseUrl) {
		throw new AIError.ConfigurationError(
			`pi-native transport requires \`baseUrl\` on model ${model.id} (set it on the provider config in models.yml)`,
		);
	}
	return `${trimTrailingSlashes(model.baseUrl)}/v1/pi/stream`;
}

function buildHeaders(model: Model<Api>, apiKey: string | undefined): Record<string, string> {
	const headers: Record<string, string> = {
		"Content-Type": "application/json",
		Accept: "text/event-stream",
		...(model.headers ?? {}),
	};
	if (apiKey && !headers.Authorization) {
		headers.Authorization = `Bearer ${apiKey}`;
	}
	return headers;
}

export function streamPiNative<TApi extends Api>(
	model: Model<TApi>,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStreamType {
	const stream = new AssistantMessageEventStream();

	void (async () => {
		const callerSignal = options?.signal;
		const abortTracker = createAbortSourceTracker(callerSignal);
		let response: Response | null = null;
		const onAbort = (): void => {
			const body = response?.body;
			if (body) body.cancel("Request aborted by caller").catch(() => {});
		};
		if (callerSignal) {
			if (callerSignal.aborted) {
				stream.fail(
					callerSignal.reason instanceof Error
						? callerSignal.reason
						: new Error(String(callerSignal.reason ?? "aborted")),
				);
				return;
			}
			callerSignal.addEventListener("abort", onAbort, { once: true });
		}

		try {
			const url = resolveStreamUrl(model as Model<Api>);
			const fetchImpl = options?.fetch ?? globalThis.fetch;
			const headers = buildHeaders(
				model as Model<Api>,
				typeof options?.apiKey === "string" ? options.apiKey : undefined,
			);
			let bodyPayload: unknown = {
				modelId: `${model.provider}/${model.id}`,
				context,
				options: buildWireOptions(options),
				stream: true,
			};
			const onPayload = options?.onPayload;
			let body = JSON.stringify(bodyPayload);
			if (onPayload) {
				const wirePayload: unknown = JSON.parse(body);
				let replacementPayload: unknown;
				try {
					replacementPayload = await onPayload(wirePayload, model as Model<Api>);
				} catch (error) {
					throw new PiNativePayloadHookError(error);
				}
				if (replacementPayload !== undefined) {
					bodyPayload = replacementPayload;
					body = JSON.stringify(bodyPayload);
				}
			}

			response = await fetchImpl(url, { method: "POST", headers, body, signal: abortTracker.requestSignal });
			if (!response.ok) {
				stream.fail(await decodeGatewayError(response));
				return;
			}
			if (!response.body) {
				stream.fail(
					new AIError.AuthGatewayError("auth-gateway returned empty body", response.status, response.headers),
				);
				return;
			}

			const idleTimeoutMs = options?.streamIdleTimeoutMs ?? getStreamIdleTimeoutMs();
			const firstEventTimeoutMs = options?.streamFirstEventTimeoutMs ?? getStreamFirstEventTimeoutMs(idleTimeoutMs);
			const source = readSseJson<AssistantMessageEvent>(
				response.body as ReadableStream<Uint8Array>,
				abortTracker.requestSignal,
			);
			const watchedSource = iterateWithIdleTimeout(source, {
				idleTimeoutMs,
				firstItemTimeoutMs: firstEventTimeoutMs,
				errorMessage: VEYYON_NATIVE_STREAM_IDLE_TIMEOUT_ERROR,
				firstItemErrorMessage: VEYYON_NATIVE_STREAM_FIRST_EVENT_TIMEOUT_ERROR,
				onIdle: () =>
					abortTracker.abortLocally(new AIError.StreamTimeoutError(VEYYON_NATIVE_STREAM_IDLE_TIMEOUT_ERROR)),
				onFirstItemTimeout: () =>
					abortTracker.abortLocally(
						new AIError.StreamTimeoutError(VEYYON_NATIVE_STREAM_FIRST_EVENT_TIMEOUT_ERROR),
					),
				isProgressItem: isPiNativeProgressEvent,
			});
			let sawTerminal = false;
			for await (const event of watchedSource) {
				if (event.type === "done" || event.type === "error") sawTerminal = true;
				stream.push(event);
			}

			if (!sawTerminal) {
				const aborted = abortTracker.wasCallerAbort();
				const partial = makeSyntheticAssistant(model as Model<Api>);
				if (aborted) {
					partial.stopReason = "aborted";
					partial.errorMessage = "stream closed without terminal event";
					stream.push({ type: "error", reason: "aborted", error: partial });
				} else {
					partial.stopReason = "stop";
					stream.push({ type: "done", reason: "stop", message: partial });
				}
			}
			stream.end();
		} catch (err) {
			stream.fail(err);
		} finally {
			if (callerSignal) callerSignal.removeEventListener("abort", onAbort);
		}
	})();

	return stream;
}

function makeSyntheticAssistant(model: Model<Api>): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: emptyUsage(),
		stopReason: "stop",
		timestamp: Date.now(),
	};
}
