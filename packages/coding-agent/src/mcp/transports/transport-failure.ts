/**
 * The sentences an MCP transport produces when the connection, not the server's
 * answer, is what failed. One place, because all three transports produce them.
 *
 * WHAT WAS WRONG. `stdio.ts`, `http.ts` and `sse.ts` between them threw
 * `"Transport not connected"` at six sites, `"Request timeout after ${n}ms"` at
 * three, `"Notify timeout after ${n}ms"` at two, and one each of
 * `"No response body"`, `"No response received for request ID ${id}"`,
 * `"Transport closed"` and the three legacy-SSE timeouts. Every one of them named
 * the failure and nothing else:
 *
 * 1. NO LOCATION. A session runs several MCP servers at once. "Transport not
 *    connected" told the reader which of them was dead only by luck of ordering.
 *    The transport's config carries no server NAME (see `MCPServerConfigBase` in
 *    `mcp/types.ts`), so the honest identifier is the URL for http/sse and the
 *    subprocess command for stdio, which is what `mcpHttpFailureMessage` already
 *    settled on next door and what `StdioTransport.#describeClose` already uses.
 *
 * 2. NO REMEDY. Both of these failures have a specific, different next step, and
 *    neither message named it. A timeout is a deadline the operator owns: it is
 *    `timeout` on the server entry, or `VEYYON_MCP_TIMEOUT_MS`, and `0` disables
 *    it. A dead transport is a connection the operator can re-establish with
 *    `/mcp reconnect <name>`. Nothing in either message said so, so the reader
 *    went to the source or to the logs.
 *
 * WHO READS THESE, AND WHY THEY NAME AN OPERATOR ACTION. A transport error
 * reaches two readers by two paths. It surfaces to an operator through `/mcp
 * test` and the startup report, and it is wrapped into a tool result the MODEL
 * reads by `tool-bridge.ts`. The fix for both of these failure classes is an
 * operator action, so that is what these sentences carry. The model's own action
 * — stop, do not loop, name the server to the operator — is added by the wrapper
 * in `tool-bridge.ts`, which is the layer that knows the reader. Each layer
 * states the part it actually knows.
 *
 * EVERY NAMED COMMAND IS REAL. `/mcp` declares `textMode: true` in
 * `slash-commands/builtin-declarations.ts`, so a text or ACP client can run it,
 * and `list`, `reconnect` and `test` are all declared subcommands there. There is
 * no `veyyon mcp` entry in the `commands` table in `cli-commands.ts`, so no
 * message here invents one.
 */
import { describeMCPTimeout } from "../timeout";
import type { MCPServerConfig } from "../types";

/**
 * How a transport identifies the server it talks to.
 *
 * `url` for http and legacy SSE, `command` for stdio. This is not a stylistic
 * choice: the transport layer is handed a config with no server name in it, so
 * these two are the only identifiers it can state without guessing.
 */
export type MCPTransportTarget = { readonly url: string } | { readonly command: string };

/** `MCP server at https://…` / `MCP server "npx -y foo"`, the one phrase both spellings share. */
export function describeMCPTarget(target: MCPTransportTarget): string {
	return "url" in target ? `MCP server at ${target.url}` : `MCP server "${target.command}"`;
}

/**
 * The same phrase, derived from a server config instead of a transport's target.
 *
 * For the layers above the transports (the manager, the OAuth refresh path) that
 * hold a config and still have no server name, so that one failure is named the
 * same way wherever it is reported. Falls back to "this MCP server" rather than
 * inventing an identifier: a config with neither a `url` nor a `command` is one
 * `validateServerConfig` already rejects.
 */
export function describeMCPServerTarget(config: MCPServerConfig): string {
	if ("url" in config && config.url) return describeMCPTarget({ url: config.url });
	if ("command" in config && config.command) return describeMCPTarget({ command: config.command });
	return "this MCP server";
}

/** The deadline is the operator's to move, and `/mcp test` says whether moving it would help. */
const TIMEOUT_FIX =
	'Fix: raise this server\'s deadline with `"timeout": <milliseconds>` on its entry in your MCP config, or set `VEYYON_MCP_TIMEOUT_MS` (`0` disables the deadline entirely). Run `/mcp test <name>` to check whether the server answers at all.';

/** Reconnecting is the whole remedy for a transport that is simply not up. */
const RECONNECT_FIX =
	"Fix: run `/mcp list` to find this server's name, then `/mcp reconnect <name>`. If reconnecting fails, `/mcp test <name>` reports why.";

/**
 * A request or notification was attempted on a transport that is not connected.
 *
 * @param operation What was being attempted, e.g. `request "tools/call"`. Naming it
 *   matters because a notification lost here is not retried by anything.
 */
export function mcpNotConnectedMessage(target: MCPTransportTarget, operation: string): string {
	return `${describeMCPTarget(target)} is not connected, so the ${operation} was not sent. ${RECONNECT_FIX}`;
}

/** A transport-level deadline expired. `phase` names which wait, since a server can pass one and fail the next. */
export function mcpTimeoutMessage(target: MCPTransportTarget, phase: string, timeoutMs: number): string {
	return `${describeMCPTarget(target)} did not complete ${phase} within ${describeMCPTimeout(timeoutMs)}. ${TIMEOUT_FIX}`;
}

/** A 200 with no body at all: the server accepted the POST and answered nothing. */
export function mcpEmptyResponseBodyMessage(target: MCPTransportTarget): string {
	return `${describeMCPTarget(target)} returned a response with no body, so there is nothing to parse. This is a bug in the server, not in the request. Fix: check the server's own logs, and run \`/mcp test <name>\` to confirm it is reachable at all.`;
}

/**
 * The stream ended without the response we were waiting for.
 *
 * Distinct from a timeout: the server closed cleanly and simply never answered
 * this id, so waiting longer would not have helped and raising the deadline is
 * the wrong advice.
 */
export function mcpNoResponseForRequestMessage(target: MCPTransportTarget, requestId: string | number): string {
	return `${describeMCPTarget(target)} closed its response stream without answering request ${requestId}. Fix: this is a server-side bug; check the server's own logs. \`/mcp reconnect <name>\` clears a stale session if the server was restarted.`;
}

/** The stream carrying every in-flight response went away, so all of them are dead. */
export function mcpStreamClosedMessage(target: MCPTransportTarget, detail?: string): string {
	const cause = detail ? `: ${detail}` : "";
	return `${describeMCPTarget(target)} closed its connection${cause}, so every request in flight on it failed. ${RECONNECT_FIX}`;
}

/**
 * Phrases this module guarantees its transport-state messages contain.
 *
 * `isRetriableConnectionError` in `tool-bridge.ts` decides whether a failed MCP
 * tool call is worth a reconnect-and-retry, and it decides it by reading the
 * message. That coupling is real whether or not it is written down, and it used
 * to be written down in the wrong place: `tool-bridge.ts` matched the literals
 * `"transport not connected"` and `"transport closed"`, which are the sentences
 * these builders replaced. Rewording a message would then have silently disabled
 * the reconnect, turning a recoverable stale connection into a failed tool call.
 *
 * So the phrases live next to the strings that must contain them, and the
 * predicate is exported rather than the list: a caller cannot half-implement it.
 */
const TRANSPORT_STATE_PHRASES = ["is not connected", "closed its connection", "was disconnected by this client"];

/**
 * True when `message` reports that the CONNECTION failed rather than the request.
 *
 * @param message The error message, in any case; compared case-insensitively.
 */
export function isMCPTransportStateMessage(message: string): boolean {
	const lowercase = message.toLowerCase();
	return TRANSPORT_STATE_PHRASES.some(phrase => lowercase.includes(phrase));
}
