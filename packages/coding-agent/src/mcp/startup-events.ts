import { isRecord, sanitizeText } from "@veyyon/utils";
import { replaceTabs, shortenEmbeddedPaths, TRUNCATE_LENGTHS, truncateToWidth } from "../tools/render-utils";

export const MCP_CONNECTION_STATUS_EVENT_CHANNEL = "mcp:connection-status";

/** The `serverName` a config-level MCP failure is reported under. An `mcp.json` that cannot be parsed, or an entry the capability layer refused, */
export const MCP_CONFIG_STATUS_LABEL = "mcp config";

export type McpConnectionStatusEvent =
	| { type: "connecting"; serverNames: string[] }
	| { type: "connected"; serverName: string }
	// `foreign` marks servers imported from another tool's config (Claude Code,
	// Codex, …) — the boot health zone downgrades their failures from alarm to
	// dim, since veyyon merely borrowed them.
	| { type: "failed"; serverName: string; error: string; foreign?: boolean };

function sanitizeMcpStatusText(value: string, maxWidth: number): string {
	const text = shortenEmbeddedPaths(
		replaceTabs(sanitizeText(value))
			.replace(/[\r\n]+/g, " ")
			.trim(),
	);
	return truncateToWidth(text.length > 0 ? text : "(unnamed)", maxWidth);
}

/** Collapse an MCP failure error to a single safe display line: tabs/newlines stripped, embedded home paths shortened, truncated. Shared by the compact */
export function sanitizeMcpStatusError(error: string): string {
	return sanitizeMcpStatusText(error, TRUNCATE_LENGTHS.CONTENT);
}

function isStringArray(data: unknown): data is string[] {
	return Array.isArray(data) && data.every(item => typeof item === "string");
}

/** Runtime validator for the cross-module event payload. The event bus is untyped at runtime, so the subscriber verifies the shape before formatting */
export function isMcpConnectionStatusEvent(data: unknown): data is McpConnectionStatusEvent {
	if (!isRecord(data) || typeof data.type !== "string") return false;
	switch (data.type) {
		case "connecting":
			return isStringArray(data.serverNames);
		case "connected":
			return typeof data.serverName === "string";
		case "failed":
			return (
				typeof data.serverName === "string" &&
				typeof data.error === "string" &&
				(data.foreign === undefined || typeof data.foreign === "boolean")
			);
		default:
			return false;
	}
}
