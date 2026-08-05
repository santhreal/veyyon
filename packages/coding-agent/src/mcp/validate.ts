import type { MCPServerConfig } from "./types";

/**
 * Validation of a single MCP server entry, kept apart from `./config` so the
 * writer can use it without importing the loader.
 *
 * WHY THIS FILE EXISTS. `./config-writer` needs `validateServerConfig` before it
 * writes an entry, and `./config` needs `readDisabledServers` and
 * `readEnabledServers` from `./config-writer` while it loads. That is a cycle,
 * and a cycle is instantiated as one unit, so each module cost the pair wherever
 * either was imported. This function is pure: it takes a name and a config object
 * and returns error strings, touching no filesystem and no loader state, so it
 * belongs next to the types it validates rather than inside the loader.
 *
 * Nothing here may import `./config` or `./config-writer`.
 */

/**
 * Validate server config has required fields.
 */
export function validateServerConfig(name: string, config: MCPServerConfig): string[] {
	const errors: string[] = [];

	const serverType = config.type ?? "stdio";

	// Check for conflicting transport fields
	const hasCommand = "command" in config && config.command;
	const hasUrl = "url" in config && (config as { url?: string }).url;
	if (hasCommand && hasUrl) {
		errors.push(
			`Server "${name}" sets both "command" and "url", but a server is either stdio (a "command" it spawns) or http/sse (a "url" it POSTs to), never both. Fix: delete whichever one is wrong, and set "type" to "stdio" or "http" so the intent is explicit.`,
		);
	}

	if (serverType === "stdio") {
		const stdioConfig = config as { command?: string };
		if (!stdioConfig.command) {
			errors.push(
				`Server "${name}" is a stdio server with no "command" to spawn. Fix: add the executable, for example \`"command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "."]\`. If this is a remote server, set \`"type": "http"\` and give it a "url" instead.`,
			);
		}
	} else if (serverType === "http" || serverType === "sse") {
		const httpConfig = config as { url?: string };
		if (!httpConfig.url) {
			errors.push(
				`Server "${name}" is a ${serverType} server with no "url" to connect to. Fix: add \`"url": "https://…"\`. If this is a local server you want spawned, set \`"type": "stdio"\` and give it a "command" instead.`,
			);
		}
	} else {
		errors.push(
			`Server "${name}" has an unknown "type": "${serverType}". Fix: use "stdio" for a server this machine spawns, "http" for a remote Streamable HTTP server, or "sse" for a legacy 2024-11-05 HTTP+SSE server.`,
		);
	}

	return errors;
}
