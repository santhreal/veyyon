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
			`Server "${name}": both "command" and "url" are set - server should be either stdio (command) OR http/sse (url), not both`,
		);
	}

	if (serverType === "stdio") {
		const stdioConfig = config as { command?: string };
		if (!stdioConfig.command) {
			errors.push(`Server "${name}": stdio server requires "command" field`);
		}
	} else if (serverType === "http" || serverType === "sse") {
		const httpConfig = config as { url?: string };
		if (!httpConfig.url) {
			errors.push(`Server "${name}": ${serverType} server requires "url" field`);
		}
	} else {
		errors.push(`Server "${name}": unknown server type "${serverType}"`);
	}

	return errors;
}
