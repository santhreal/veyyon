/**
 * The transcript output of the mutating `/mcp` subcommands: the help text,
 * the outcome messages of `add`, `test`, `enable`, `disable` and `reauth`,
 * the hints appended to their failures, and the animated connection-check
 * block.
 */
import { Spacer, Text } from "@veyyon/tui";
import type { MCPServerConnection } from "../../../mcp/types";
import { MCP_ADD_USAGE, MCP_SEARCH_USAGE } from "../../../slash-commands/helpers/mcp-args";
import { theme } from "../../../theme/theme";
import { shortenPath } from "../../../tools/core/render-utils";
import { ChatBlock } from "../components/transcript/chat-block";

export type McpConnectionState = "connected" | "connecting" | "disconnected";

/**
 * Animated "Connecting to …" transcript block. Owns its spinner interval: it
 * starts on mount and is cleared on {@link ChatBlock.finish}/dispose, so callers
 * never juggle `setInterval`/`clearInterval` or `requestRender` by hand.
 */
export class McpConnectingBlock extends ChatBlock {
	readonly #text: Text;

	constructor(private readonly serverName: string) {
		super();
		this.addChild(new Spacer(1));
		const frame = theme.spinnerFrames[0] ?? "|";
		this.#text = new Text(theme.fg("muted", `${frame} Connecting to "${serverName}"...`), 1, 0);
		this.addChild(this.#text);
	}

	override onMount(): void {
		const frames = theme.spinnerFrames;
		let frame = 0;
		const interval = setInterval(() => {
			frame++;
			this.#text.setText(
				theme.fg("muted", `${frames[frame % frames.length] ?? "|"} Connecting to "${this.serverName}"...`),
			);
			this.requestRender();
		}, 80);
		this.onCleanup(() => clearInterval(interval));
	}

	/**
	 * Replace the spinner line with the outcome of the check; pair with
	 * {@link finish}. `quietWhenDisconnected` reports a disconnected server as
	 * a finished check rather than a warning.
	 */
	settle(state: McpConnectionState, quietWhenDisconnected: boolean | undefined): void {
		const name = this.serverName;
		this.#text.setText(
			state === "connected"
				? theme.fg("success", `${theme.status.enabled} Connected to "${name}"`)
				: state === "connecting"
					? theme.fg("muted", `${theme.status.connecting} "${name}" is still connecting...`)
					: quietWhenDisconnected
						? theme.fg("muted", `${theme.status.connecting} Connection check complete for "${name}"`)
						: theme.fg("warning", `warn Could not connect to "${name}" yet`),
		);
		this.requestRender();
	}
}

/** The `/mcp help` text. */
export function mcpHelpText(): string {
	return [
		"",
		theme.bold("MCP Server Management"),
		"",
		"Manage Model Context Protocol (MCP) servers for external tool integrations.",
		"",
		theme.fg("accent", "Commands:"),
		"  /mcp add              Add a new MCP server (interactive wizard)",
		`  ${MCP_ADD_USAGE.replace("Usage: ", "")}`,
		"  /mcp list             List all configured MCP servers",
		"  /mcp remove <name>    Remove an MCP server",
		"  /mcp test <name>      Test connection to an MCP server",
		"  /mcp reauth <name>    Reauthorize OAuth for an MCP server",
		"  /mcp unauth <name>    Remove OAuth auth from an MCP server",
		"  /mcp enable <name>    Enable an MCP server",
		"  /mcp disable <name>   Disable an MCP server",
		`  ${MCP_SEARCH_USAGE.replace("Usage: ", "")}`,
		"                        Search Smithery registry and deploy from picker",
		"  /mcp smithery-login   Login to Smithery and cache API key",
		"  /mcp smithery-logout  Remove cached Smithery API key",
		"  /mcp reconnect <name> Reconnect to a specific MCP server",
		"  /mcp reload           Force reload and rediscover MCP runtime tools",
		"  /mcp resources        List available resources from connected servers",
		"  /mcp prompts          List available prompts from connected servers",
		"  /mcp notifications    Show notification capabilities and subscription state",
		"  /mcp help             Show this help message",
		"",
	].join("\n");
}

/** The message a closed `/mcp add` wizard prints. */
export function addCancelledMessage(): string {
	return [
		"",
		theme.fg("muted", "Server creation cancelled."),
		"",
		theme.fg("dim", "Tip: Press Ctrl+C or Esc anytime to cancel"),
		"",
	].join("\n");
}

/** The servers a reload or reconnect failed to connect, one per row. */
export function connectionErrorsMessage(errors: ReadonlyMap<string, string>): string {
	const lines = ["", theme.fg("warning", "Some servers failed to connect:"), ""];
	for (const [serverName, error] of errors) lines.push(`  ${serverName}: ${error}`);
	lines.push("");
	return lines.join("\n");
}

export function addedServerMessage(name: string, filePath: string, state: McpConnectionState): string {
	return [
		"",
		theme.fg("success", `+ Added server "${name}" to ${shortenPath(filePath)}`),
		"",
		...addedServerStatusRows(name, state),
		"",
		theme.fg("muted", `Run ${theme.fg("accent", "/mcp list")} to see all configured servers.`),
		"",
	].join("\n");
}

function addedServerStatusRows(name: string, state: McpConnectionState): string[] {
	if (state === "connected") return [theme.fg("success", `${theme.status.enabled} Successfully connected to server`)];
	const test = theme.fg("accent", `/mcp test ${name}`);
	if (state === "connecting") {
		return [
			theme.fg("muted", `${theme.status.connecting} Server is connecting in background...`),
			theme.fg("muted", `  Run ${test} in a few seconds.`),
		];
	}
	return [
		theme.fg("warning", "warn Server added but not yet connected"),
		theme.fg("muted", `  Run ${test} to test the connection.`),
	];
}

/** A hint for a failed `/mcp add`, chosen by the error text; empty when none applies. */
export function addFailureTip(message: string): string {
	if (message.includes("EACCES") || message.includes("permission denied")) {
		return "\n\nTip: Check file permissions for the config directory.";
	}
	if (message.includes("ENOSPC")) return "\n\nTip: Insufficient disk space.";
	if (message.includes("already exists")) {
		return `\n\nTip: Use ${theme.fg("accent", "/mcp list")} to see existing servers.`;
	}
	return "";
}

/** A hint for a failed `/mcp test`, chosen by the error text; empty when none applies. */
export function testFailureTip(message: string): string {
	if (message.includes("ENOENT") || message.includes("not found")) {
		return "\n\nTip: Check that the command or URL is correct.";
	}
	if (message.includes("EACCES")) return "\n\nTip: Check file/command permissions.";
	if (message.includes("ECONNREFUSED")) {
		return "\n\nTip: Check that the server is running and the URL/port is correct.";
	}
	if (message.includes("timeout")) {
		return "\n\nTip: The server may be slow or unresponsive. Try increasing the timeout.";
	}
	if (message.includes("401") || message.includes("403")) return "\n\nTip: Check your authentication credentials.";
	return "";
}

export function testedServerMessage(
	name: string,
	connection: MCPServerConnection,
	tools: readonly { name: string }[],
): string {
	const lines = [
		"",
		theme.fg("success", `${theme.status.enabled} Successfully connected to "${name}"`),
		"",
		`  Server: ${connection.serverInfo.name} v${connection.serverInfo.version}`,
		`  Tools: ${tools.length}`,
	];
	if (tools.length > 0 && tools.length <= 10) {
		lines.push("", "  Available tools:");
		for (const tool of tools) lines.push(`    • ${tool.name}`);
	}
	lines.push("");
	return lines.join("\n");
}

export function alreadySetMessage(name: string, enabled: boolean): string {
	return ["", theme.fg("muted", `Server "${name}" is already ${enabled ? "enabled" : "disabled"}.`), ""].join("\n");
}

export function enabledMessage(label: string, state: McpConnectionState): string {
	const status =
		state === "connected"
			? theme.fg("success", "Connected")
			: state === "connecting"
				? theme.fg("muted", "Connecting")
				: theme.fg("warning", "Not connected yet");
	return ["", theme.fg("success", `${theme.status.enabled} Enabled ${label}`), "", `  Status: ${status}`, ""].join(
		"\n",
	);
}

export function reauthorizedMessage(name: string, scope: string, state: McpConnectionState): string {
	const status =
		state === "connected"
			? theme.fg("success", "connected")
			: state === "connecting"
				? theme.fg("muted", "connecting")
				: theme.fg("warning", "not connected");
	return ["", theme.fg("success", `ok Reauthorized "${name}" (${scope} config)`), "", `  Status: ${status}`, ""].join(
		"\n",
	);
}
