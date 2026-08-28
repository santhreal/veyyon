/** Which of a server's config values are `!command` indirections. An MCP server is authenticated in one of two ways: a stored OAuth credential the product */
import { isConfigValueCommand } from "../config/config-value-resolution";
import type { MCPServerConfig } from "./types";

/** The `!command` config values this server's credentials come from, in config order and de-duplicated: one command may fill two headers, and it should be re-run once. */
export function mcpConfigCommandValues(config: MCPServerConfig): string[] {
	const source = config.type === "http" || config.type === "sse" ? config.headers : config.env;
	if (!source) return [];
	const commands = new Set<string>();
	for (const value of Object.values(source)) {
		if (isConfigValueCommand(value)) commands.add(value);
	}
	return Array.from(commands);
}

/** Whether this server's credentials come from a command that can be re-run. */
export function hasMcpConfigCommands(config: MCPServerConfig): boolean {
	return mcpConfigCommandValues(config).length > 0;
}
