/** The sentences an MCP transport produces when the connection, not the server's answer, is what failed. One place, because all three transports produce them. */
import { describeMCPTimeout } from "../timeout";
import type { MCPServerConfig } from "../types";

/** How a transport identifies the server it talks to. `url` for http and legacy SSE, `command` for stdio. This is not a stylistic */
export type MCPTransportTarget = { readonly url: string } | { readonly command: string };

/** `MCP server at https://…` / `MCP server "npx -y foo"`, the one phrase both spellings share. */
export function describeMCPTarget(target: MCPTransportTarget): string {
	return "url" in target ? `MCP server at ${target.url}` : `MCP server "${target.command}"`;
}

/** The same phrase, derived from a server config instead of a transport's target. For the layers above the transports (the manager, the OAuth refresh path) that */
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

/** A request or notification was attempted on a transport that is not connected. @param operation What was being attempted, e.g. `request "tools/call"`. Naming it matters because a notification lost here is not retried by anything. */
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

/** The stream ended without the response we were waiting for. Distinct from a timeout: the server closed cleanly and simply never answered */
export function mcpNoResponseForRequestMessage(target: MCPTransportTarget, requestId: string | number): string {
	return `${describeMCPTarget(target)} closed its response stream without answering request ${requestId}. Fix: this is a server-side bug; check the server's own logs. \`/mcp reconnect <name>\` clears a stale session if the server was restarted.`;
}

/** The stream carrying every in-flight response went away, so all of them are dead. */
export function mcpStreamClosedMessage(target: MCPTransportTarget, detail?: string): string {
	const cause = detail ? `: ${detail}` : "";
	return `${describeMCPTarget(target)} closed its connection${cause}, so every request in flight on it failed. ${RECONNECT_FIX}`;
}

/** Phrases this module guarantees its transport-state messages contain. `mcpFailureWarrantsReconnect` in `tool-bridge.ts` decides whether a failed MCP */
const TRANSPORT_STATE_PHRASES = ["is not connected", "closed its connection", "was disconnected by this client"];

/** The same fact in the MCP SDK's own words, for a failure raised inside the SDK before any message here wraps it. They are wording this package does not */
const SDK_TRANSPORT_STATE_PHRASES = ["transport not connected", "transport closed"];

/** True when `message` reports that the CONNECTION failed rather than the request. @param message The error message, in any case; compared case-insensitively. */
export function isMCPTransportStateMessage(message: string): boolean {
	const lowercase = message.toLowerCase();
	return (
		TRANSPORT_STATE_PHRASES.some(phrase => lowercase.includes(phrase)) ||
		SDK_TRANSPORT_STATE_PHRASES.some(phrase => lowercase.includes(phrase))
	);
}
