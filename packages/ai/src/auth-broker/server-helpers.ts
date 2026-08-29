import { clampLow } from "@veyyon/utils/math";
import { type Type, type } from "arktype";
import type { AuthStorage } from "../auth-storage";
import { formatGenerationTag } from "./generation-tag";

export interface AuthBrokerServerOptions {
	storage: AuthStorage;
	bind?: string;
	bearerTokens: string[];
	version?: string;
	refreshSkewMs?: number;
	refreshIntervalMs?: number;
	disableRefresher?: boolean;
	streamKeepaliveMs?: number;
}

export interface AuthBrokerServerHandle {
	url: string;
	port: number;
	hostname: string;
	close(): Promise<void>;
}

export function json(status: number, body: unknown, headers?: Record<string, string>): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json", ...(headers ?? {}) },
	});
}

export function empty(status: number, headers?: Record<string, string>): Response {
	return new Response(null, { status, headers });
}

export function isAuthorized(req: Request, tokens: ReadonlySet<string>): boolean {
	if (tokens.size === 0) return true;
	const header = req.headers.get("authorization");
	if (!header) return false;
	const match = header.match(/^Bearer\s+(.+)$/i);
	if (!match) return false;
	return tokens.has(match[1].trim());
}

export async function parseBody<t>(
	req: Request,
	schema: Type<t>,
	options: { allowEmpty?: boolean } = {},
): Promise<{ ok: true; data: typeof schema.infer } | { ok: false; response: Response }> {
	let raw: string;
	try {
		raw = await req.text();
	} catch (error) {
		return { ok: false, response: json(400, { error: `Invalid request body: ${String(error)}` }) };
	}
	if (raw.length === 0 && !options.allowEmpty) {
		return { ok: false, response: json(400, { error: "Request body required" }) };
	}
	let parsed: unknown;
	try {
		parsed = raw.length === 0 ? {} : JSON.parse(raw);
	} catch (error) {
		return { ok: false, response: json(400, { error: `Invalid JSON body: ${String(error)}` }) };
	}
	const result = schema(parsed);
	if (result instanceof type.errors) {
		return { ok: false, response: json(400, { error: result.summary }) };
	}
	return { ok: true, data: result };
}

export const REFRESH_ROUTE = /^\/v1\/credential\/(\d+)\/refresh$/;
export const DISABLE_ROUTE = /^\/v1\/credential\/(\d+)\/disable$/;
export const BLOCK_ROUTE = /^\/v1\/credential\/(\d+)\/block$/;
export const BLOCKS_ROUTE = /^\/v1\/credential\/(\d+)\/blocks$/;

export const MAX_SNAPSHOT_WAIT_MS = 30_000;
export const DISABLED_NEXT_SWEEP_IN_MS = Number.MAX_SAFE_INTEGER;

export function snapshotHeaders(generation: number): Record<string, string> {
	return {
		ETag: formatGenerationTag(generation),
		"Cache-Control": "no-store",
	};
}

export function parseWaitMs(url: URL): number {
	const raw = url.searchParams.get("wait");
	if (raw === null) return 0;
	const parsed = Number(raw);
	if (!Number.isFinite(parsed)) return 0;
	return clampLow(Math.trunc(parsed), 0, MAX_SNAPSHOT_WAIT_MS);
}

export function delayResult(ms: number): { promise: Promise<"timeout">; cancel: () => void } {
	const done = Promise.withResolvers<"timeout">();
	const timer = setTimeout(() => done.resolve("timeout"), ms);
	timer.unref?.();
	return {
		promise: done.promise,
		cancel: () => clearTimeout(timer),
	};
}
