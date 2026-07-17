import { sanitizeText } from "@veyyon/pi-utils";
import { replaceTabs, shortenPath, TRUNCATE_LENGTHS, truncateToWidth } from "../tools/render-utils";

export const MCP_CONNECTION_STATUS_EVENT_CHANNEL = "mcp:connection-status";

export type McpConnectionStatusEvent =
	| { type: "connecting"; serverNames: string[] }
	| { type: "connected"; serverName: string }
	| { type: "failed"; serverName: string; error: string };

export type McpConnectionStatusSnapshot = {
	pendingServers: readonly string[];
	connectedServers: readonly string[];
	failedServers: readonly { serverName: string; error: string }[];
};

function sanitizeMcpStatusText(value: string, maxWidth: number): string {
	const text = shortenEmbeddedPaths(
		replaceTabs(sanitizeText(value))
			.replace(/[\r\n]+/g, " ")
			.trim(),
	);
	return truncateToWidth(text.length > 0 ? text : "(unnamed)", maxWidth);
}

function sanitizeMcpServerName(serverName: string): string {
	return sanitizeMcpStatusText(serverName, TRUNCATE_LENGTHS.SHORT);
}

function formatServerList(serverNames: readonly string[]): string {
	return serverNames.map(sanitizeMcpServerName).join(", ");
}

function formatServerCount(count: number): string {
	return count === 1 ? "server" : "servers";
}
/**
 * Collapse an MCP failure error to a single safe display line: tabs/newlines
 * stripped, embedded home paths shortened, truncated. Shared by the compact
 * startup banner and the `/mcp list` per-server detail so both sanitize identically.
 */
export function sanitizeMcpStatusError(error: string): string {
	return sanitizeMcpStatusText(error, TRUNCATE_LENGTHS.CONTENT);
}

function shortenEmbeddedPaths(text: string): string {
	return text
		.split(" ")
		.map(segment => {
			const leading = segment.match(/^[("'`[]*/)?.[0] ?? "";
			const trailing = segment.match(/[)"'`,.;:\]]*$/)?.[0] ?? "";
			const end = segment.length - trailing.length;
			if (leading.length >= end) return segment;
			return `${leading}${shortenPath(segment.slice(leading.length, end))}${trailing}`;
		})
		.join(" ");
}

export function formatMCPConnectingMessage(serverNames: readonly string[]): string {
	return `Connecting to MCP servers: ${formatServerList(serverNames)}…`;
}

/** Where the operator finds the per-server failure detail this banner omits. */
const MCP_DETAIL_HINT = "/mcp list for detail";

export function formatMCPConnectionStatusMessage(snapshot: McpConnectionStatusSnapshot): string {
	const { pendingServers, connectedServers, failedServers } = snapshot;

	// Still connecting: name what we're waiting on; summarize done/failed as counts.
	// The per-server error text is intentionally not dumped here — it lives in
	// `/mcp list`, so a slow startup stays one quiet line, not a wall of errors.
	if (pendingServers.length > 0) {
		if (connectedServers.length === 0 && failedServers.length === 0) {
			return formatMCPConnectingMessage(pendingServers);
		}
		const done: string[] = [];
		if (connectedServers.length > 0) done.push(`${connectedServers.length} connected`);
		if (failedServers.length > 0) done.push(`${failedServers.length} failed`);
		return `MCP: ${done.join(", ")}; still connecting ${formatServerList(pendingServers)}…`;
	}

	// Terminal state. Failures collapse to a count + the servers that failed
	// (names only) + a pointer to the detail view — loud enough that the operator
	// cannot miss that something failed, without the error wall (Law 10).
	if (failedServers.length > 0) {
		const failedNames = formatServerList(failedServers.map(f => f.serverName));
		if (connectedServers.length === 0) {
			return `MCP: all ${failedServers.length} ${formatServerCount(failedServers.length)} failed (${failedNames}) — ${MCP_DETAIL_HINT}`;
		}
		return `MCP: ${connectedServers.length} connected, ${failedServers.length} failed (${failedNames}) — ${MCP_DETAIL_HINT}`;
	}
	if (connectedServers.length > 0) {
		return `MCP: ${connectedServers.length} connected (${formatServerList(connectedServers)})`;
	}
	return "";
}

function isRecord(data: unknown): data is Record<string, unknown> {
	return typeof data === "object" && data !== null;
}

function isStringArray(data: unknown): data is string[] {
	return Array.isArray(data) && data.every(item => typeof item === "string");
}

/**
 * Runtime validator for the cross-module event payload. The event bus is
 * untyped at runtime, so the subscriber verifies the shape before formatting
 * rather than trusting a cast — a malformed emit is ignored instead of throwing.
 */
export function isMcpConnectionStatusEvent(data: unknown): data is McpConnectionStatusEvent {
	if (!isRecord(data) || typeof data.type !== "string") return false;
	switch (data.type) {
		case "connecting":
			return isStringArray(data.serverNames);
		case "connected":
			return typeof data.serverName === "string";
		case "failed":
			return typeof data.serverName === "string" && typeof data.error === "string";
		default:
			return false;
	}
}
