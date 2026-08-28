import { describeMCPTimeout } from "../timeout";
import type { MCPServerConfig } from "../types";

export type MCPTransportTarget = { readonly url: string } | { readonly command: string };

export function describeMCPTarget(target: MCPTransportTarget): string {
	return "url" in target ? `MCP server at ${target.url}` : `MCP server "${target.command}"`;
}

export function describeMCPServerTarget(config: MCPServerConfig): string {
	if ("url" in config && config.url) return describeMCPTarget({ url: config.url });
	if ("command" in config && config.command) return describeMCPTarget({ command: config.command });
	return "this MCP server";
}

const TIMEOUT_FIX =
	'Fix: raise this server\'s deadline with `"timeout": <milliseconds>` on its entry in your MCP config, or set `VEYYON_MCP_TIMEOUT_MS` (`0` disables the deadline entirely). Run `/mcp test <name>` to check whether the server answers at all.';

const RECONNECT_FIX =
	"Fix: run `/mcp list` to find this server's name, then `/mcp reconnect <name>`. If reconnecting fails, `/mcp test <name>` reports why.";

export function mcpNotConnectedMessage(target: MCPTransportTarget, operation: string): string {
	return `${describeMCPTarget(target)} is not connected, so the ${operation} was not sent. ${RECONNECT_FIX}`;
}

export function mcpTimeoutMessage(target: MCPTransportTarget, phase: string, timeoutMs: number): string {
	return `${describeMCPTarget(target)} did not complete ${phase} within ${describeMCPTimeout(timeoutMs)}. ${TIMEOUT_FIX}`;
}

export function mcpEmptyResponseBodyMessage(target: MCPTransportTarget): string {
	return `${describeMCPTarget(target)} returned a response with no body, so there is nothing to parse. This is a bug in the server, not in the request. Fix: check the server's own logs, and run \`/mcp test <name>\` to confirm it is reachable at all.`;
}

export function mcpNoResponseForRequestMessage(target: MCPTransportTarget, requestId: string | number): string {
	return `${describeMCPTarget(target)} closed its response stream without answering request ${requestId}. Fix: this is a server-side bug; check the server's own logs. \`/mcp reconnect <name>\` clears a stale session if the server was restarted.`;
}

export function mcpStreamClosedMessage(target: MCPTransportTarget, detail?: string): string {
	const cause = detail ? `: ${detail}` : "";
	return `${describeMCPTarget(target)} closed its connection${cause}, so every request in flight on it failed. ${RECONNECT_FIX}`;
}

const TRANSPORT_STATE_PHRASES = ["is not connected", "closed its connection", "was disconnected by this client"];

const SDK_TRANSPORT_STATE_PHRASES = ["transport not connected", "transport closed"];

export function isMCPTransportStateMessage(message: string): boolean {
	const lowercase = message.toLowerCase();
	return (
		TRANSPORT_STATE_PHRASES.some(phrase => lowercase.includes(phrase)) ||
		SDK_TRANSPORT_STATE_PHRASES.some(phrase => lowercase.includes(phrase))
	);
}
