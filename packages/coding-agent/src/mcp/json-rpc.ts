import { logger, tryParseJson } from "@veyyon/utils";
import { scopedTimeoutSignal } from "../utils/fetch-timeout";
import { mcpHttpFailureMessage } from "./transports/http-failure";
import type { JsonRpcResponse } from "./types";

const MCP_DEFAULT_TIMEOUT_MS = 60_000;

const SENSITIVE_QUERY_PARAM = /key|token|secret|auth/i;

export function redactUrlForLog(url: string): string {
	try {
		const parsed = new URL(url);
		for (const name of parsed.searchParams.keys()) {
			if (SENSITIVE_QUERY_PARAM.test(name)) parsed.searchParams.set(name, "[redacted]");
		}
		return parsed.toString();
	} catch {
		return url.split("?")[0];
	}
}

export function parseSSE(text: string): unknown {
	const lines = text.split("\n");
	for (const line of lines) {
		if (line.startsWith("data: ")) {
			const data = line.slice(6).trim();
			if (data === "[DONE]") continue;
			try {
				const result = JSON.parse(data) as unknown;
				if (result) return result;
			} catch {}
		}
	}
	return tryParseJson(text);
}

export type { JsonRpcResponse } from "./types";

export interface CallMcpOptions {
	signal?: AbortSignal;
}

export async function callMCP<T = unknown>(
	url: string,
	method: string,
	params?: Record<string, unknown>,
	options?: CallMcpOptions,
): Promise<JsonRpcResponse<T>> {
	const body = {
		jsonrpc: "2.0",
		id: Math.random().toString(36).slice(2),
		method,
		params: params ?? {},
	};

	const requestTimeout = options?.signal ? undefined : scopedTimeoutSignal(MCP_DEFAULT_TIMEOUT_MS);
	let text: string;
	try {
		const response = await fetch(url, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Accept: "application/json, text/event-stream",
			},
			body: JSON.stringify(body),
			signal: options?.signal ?? requestTimeout?.signal,
		});

		if (!response.ok) {
			const errorMsg = mcpHttpFailureMessage(redactUrlForLog(url), response.status, response.statusText);
			logger.error(errorMsg, { url: redactUrlForLog(url), method, params });
			throw new Error(errorMsg);
		}

		text = await response.text();
	} finally {
		requestTimeout?.cancel();
	}
	const result = parseSSE(text) as JsonRpcResponse<T> | null;

	if (!result) {
		logger.error("Failed to parse MCP response", {
			url: redactUrlForLog(url),
			method,
			responseText: text.slice(0, 500),
		});
		throw new Error(
			`MCP server at ${redactUrlForLog(url)} answered "${method}" with something that is neither JSON nor a JSON-RPC SSE frame, so there is nothing to read. Fix: this is a bug in the server, or a proxy rewriting its response. Check the server's own logs, and run \`/mcp test <name>\` to reproduce it.`,
		);
	}

	return result;
}
