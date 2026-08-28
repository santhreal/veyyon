import { timingSafeEqual as nodeTimingSafeEqual } from "node:crypto";
import type { Api, AssistantMessage, Model } from "../types";

const JSON_HEADERS = {
	"Content-Type": "application/json",
	"X-Content-Type-Options": "nosniff",
} as const;

export function json(status: number, body: unknown, headers?: Record<string, string>): Response {
	return new Response(JSON.stringify(body) ?? "null", {
		status,
		headers: headers ? { ...JSON_HEADERS, ...headers } : JSON_HEADERS,
	});
}

export function gatewayResponseHeaders(
	model: Model<Api>,
	info: { requestId: string; message?: AssistantMessage; startedAt?: number },
): Record<string, string> {
	const headers: Record<string, string> = {
		"x-request-id": info.requestId,
		"request-id": info.requestId,
		"x-litellm-model-id": model.id,
	};
	if (model.baseUrl) headers["x-litellm-model-api-base"] = model.baseUrl;
	if (info.message) headers["x-litellm-response-cost"] = info.message.usage.cost.total.toString();
	if (info.startedAt !== undefined) {
		const elapsed = (performance.now() - info.startedAt).toFixed(0);
		headers["x-litellm-response-duration-ms"] = elapsed;
		headers["openai-processing-ms"] = elapsed;
	}
	return headers;
}

export function resolvePeer(req: Request): string {
	const fwd = req.headers.get("x-forwarded-for");
	if (fwd) return fwd.split(",")[0].trim();
	return req.headers.get("x-real-ip") ?? "unknown";
}

export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
	if (a.length === b.length && typeof nodeTimingSafeEqual === "function") {
		return nodeTimingSafeEqual(a, b);
	}
	const len = Math.max(a.length, b.length);
	let diff = a.length ^ b.length;
	for (let i = 0; i < len; i++) {
		const av = (i < a.length ? a[i] : 0) | 0;
		const bv = (i < b.length ? b[i] : 0) | 0;
		diff |= av ^ bv;
	}
	return diff === 0;
}

const TOKEN_ENCODER = new TextEncoder();

export function isAuthorized(req: Request, tokens: ReadonlySet<string>): boolean {
	if (tokens.size === 0) return true;
	const header = req.headers.get("authorization");
	if (!header) return false;
	const match = header.match(/^Bearer\s+(.+)$/i);
	if (!match) return false;
	const presented = TOKEN_ENCODER.encode(match[1].trim());
	let ok = false;
	for (const tok of tokens) {
		const expected = TOKEN_ENCODER.encode(tok);
		if (timingSafeEqual(presented, expected)) ok = true;
	}
	return ok;
}

const PASSTHROUGH_HEADER_NAMES: Record<string, true> = {
	"anthropic-beta": true,
	"anthropic-version": true,
	"openai-organization": true,
	"openai-project": true,
	"openai-beta": true,
	"chatgpt-account-id": true,
	originator: true,
	session_id: true,
	conversation_id: true,
	"x-prompt-cache-key": true,
	"x-session-id": true,
	"x-conversation-id": true,
};

export function captureRequestHeaders(headers: Headers): Record<string, string> {
	const out: Record<string, string> = {};
	headers.forEach((value, key) => {
		if (!value) return;
		const lower = key.toLowerCase();
		if (PASSTHROUGH_HEADER_NAMES[lower] || lower.startsWith("x-stainless-")) {
			out[lower] = value;
		}
	});
	return out;
}

const CACHE_KEY_HEADERS: readonly string[] = [
	"x-prompt-cache-key",
	"session_id",
	"conversation_id",
	"x-session-id",
	"x-conversation-id",
];

function readBodyCacheKey(body: unknown): string | undefined {
	if (body === null || typeof body !== "object") return undefined;
	const root = body as Record<string, unknown>;
	const direct = root.prompt_cache_key;
	if (typeof direct === "string" && direct.length > 0) return direct;
	const metadata = root.metadata;
	if (metadata === null || typeof metadata !== "object") return undefined;
	const meta = metadata as Record<string, unknown>;
	for (const field of ["prompt_cache_key", "session_id", "conversation_id"] as const) {
		const v = meta[field];
		if (typeof v === "string" && v.length > 0) return v;
	}
	return undefined;
}

export function resolvePromptCacheKey(body: unknown, headers?: Headers): string | undefined {
	const fromBody = readBodyCacheKey(body);
	if (fromBody) return fromBody;
	if (!headers) return undefined;
	for (const name of CACHE_KEY_HEADERS) {
		const v = headers.get(name);
		if (v && v.length > 0) return v;
	}
	return undefined;
}

const CORS_HEADERS: Record<string, string> = {
	"Access-Control-Allow-Origin": "*",
	"Access-Control-Allow-Methods": "GET, POST, OPTIONS",
	"Access-Control-Allow-Headers":
		"authorization, content-type, anthropic-version, anthropic-beta, openai-organization, openai-project, x-stainless-*, x-api-key",
	"Access-Control-Expose-Headers":
		"x-request-id, request-id, x-litellm-model-id, x-litellm-model-api-base, x-litellm-response-cost, x-litellm-response-duration-ms, openai-processing-ms",
	"Access-Control-Max-Age": "86400",
};

export function corsHeaders(_req: Request): Record<string, string> {
	return { ...CORS_HEADERS };
}

export function withCors(response: Response, req: Request): Response {
	const headers = new Headers(response.headers);
	const cors = corsHeaders(req);
	for (const k in cors) headers.set(k, cors[k]);
	return new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers,
	});
}
