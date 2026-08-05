/**
 * The sentence a failed MCP HTTP request produces, in one place.
 *
 * WHAT WAS WRONG. Five sites across `http.ts` and `sse.ts` each threw
 * `HTTP ${response.status}: ${await response.text()}`. That has three defects and
 * this module fixes all three, because a per-site fix would have fixed one
 * transport and left the other.
 *
 * 1. UNBOUNDED. The response body went into the message verbatim. A 502 from a
 *    corporate proxy or a misrouted MCP URL answers with an HTML error page, and
 *    the whole page landed in the error, in the tool result the model reads, and
 *    in the transcript it re-reads on every retry. Nothing capped it and nothing
 *    downstream could, because by then it was one string.
 *
 * 2. NO LOCATION. `HTTP 404: Not Found` named nothing. An operator with several
 *    MCP servers configured could not tell which one had failed, and neither
 *    could the model, which is the reader that decides whether to retry. The
 *    transport's config carries no server NAME (see `MCPServerConfigBase` in
 *    `mcp/types.ts`), so the URL is the identifier this layer honestly has, and
 *    for a 404 it is the more useful one anyway.
 *
 * 3. NO REMEDY. The statuses that actually happen to people each have a specific
 *    next step and the message named none of them. The auth hints
 *    (`WWW-Authenticate`, `Mcp-Auth-Server`) were already collected in `http.ts`
 *    and appended as a bracketed header dump, which tells a protocol implementer
 *    something and tells an operator nothing.
 *
 * EVERY NAMED COMMAND IS REAL AND REACHABLE. `/mcp` declares `textMode: true`, so
 * an ACP or text client can run these too, and `list`, `reauth` and `test` are all
 * declared subcommands. The first draft said `/mcp login`, which does not exist:
 * the reauthorize subcommand is `reauth`. That would have been the same defect
 * this module exists to fix, one layer up.
 */
import { truncate } from "@veyyon/utils";

/**
 * Bound on the echoed response body. Large enough to hold a JSON-RPC error
 * object or a short proxy message, small enough that an HTML error page cannot
 * displace the status, the URL and the remedy that follow it.
 */
const MAX_BODY_LENGTH = 512;

/**
 * Hard ceiling on the whole sentence. The body cap plus a URL plus a remedy is
 * expected to stay far under it; it exists because per-part caps do not compose
 * into a whole-message bound, and a configured MCP URL has no length of its own.
 */
const MAX_MESSAGE_LENGTH = 1200;

/** What the reader should do about `status`, when the status implies one thing. */
function remedyFor(status: number): string | undefined {
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
	return undefined;
}

/**
 * The message for a non-OK MCP HTTP response.
 *
 * @param url The request URL, which is what identifies the server here and what
 *   is wrong when a 404 arrives.
 * @param body The response body, echoed bounded.
 * @param authHints `WWW-Authenticate` / `Mcp-Auth-Server` values, when present.
 */
export function mcpHttpFailureMessage(url: string, status: number, body: string, authHints?: string): string {
	let message = `MCP request to ${url} failed: HTTP ${status}`;
	const trimmedBody = truncate(body.trim(), MAX_BODY_LENGTH);
	if (trimmedBody.length > 0) message += `: ${trimmedBody}`;
	if (authHints) message += ` [${authHints}]`;
	const remedy = remedyFor(status);
	if (remedy) message += `. ${remedy}`;
	return truncate(message, MAX_MESSAGE_LENGTH);
}
