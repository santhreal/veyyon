/** The sentence a failed MCP HTTP request produces, in one place. `HTTP ${response.status}: ${await response.text()}`. That has three defects and */
import { truncate } from "@veyyon/utils";

/** Bound on the echoed response body. Large enough to hold a JSON-RPC error object or a short proxy message, small enough that an HTML error page cannot */
const MAX_BODY_LENGTH = 512;

/** Hard ceiling on the whole sentence. The body cap plus a URL plus a remedy is expected to stay far under it; it exists because per-part caps do not compose */
const MAX_MESSAGE_LENGTH = 1200;

/** What the reader should do about `status`. Total, not partial. It used to return `undefined` for anything outside */
function remedyFor(status: number): string {
	if (status === 401 || status === 403) {
		return "Fix: run `/mcp list` to find this server's name, then `/mcp reauth <name>`, or check its token in your MCP configuration.";
	}
	if (status === 404) {
		return "Fix: check the server URL. A 404 here usually means the path is wrong rather than the host.";
	}
	if (status === 429) {
		return "Fix: the server is rate limiting. Retry after a pause rather than immediately.";
	}
	if (status >= 500) {
		return "Fix: the server failed, not the request. Retry, and check the server's own logs if it persists.";
	}
	return "Fix: check this server's `url`, `type` and `headers` in your MCP configuration, then run `/mcp test <name>` to reproduce it. A 4xx here means the server understood the request and refused it, so retrying it unchanged will not help.";
}

/** The message for a non-OK MCP HTTP response. @param url The request URL, which is what identifies the server here and what is wrong when a 404 arrives. */
export function mcpHttpFailureMessage(url: string, status: number, body: string, authHints?: string): string {
	let message = `MCP request to ${url} failed: HTTP ${status}`;
	const trimmedBody = truncate(body.trim(), MAX_BODY_LENGTH);
	if (trimmedBody.length > 0) message += `: ${trimmedBody}`;
	if (authHints) message += ` [${authHints}]`;
	message += `. ${remedyFor(status)}`;
	return truncate(message, MAX_MESSAGE_LENGTH);
}
