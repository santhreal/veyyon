/**
 * Which of a server's config values are `!command` indirections.
 *
 * An MCP server is authenticated in one of two ways: a stored OAuth credential the product
 * refreshes, or a `!command` that mints or reads one (`!op read op://vault/mcp/token`,
 * `!gcloud auth print-access-token`, `!vault kv get -field=token …`). The second kind returns a
 * value that ROTATES, and the resolution cache is keyed by the command text, which does not change
 * when the secret behind it does. So the two answers a stale credential needs — re-run the command,
 * and know that this server has a command to re-run at all — both start here.
 *
 * Only `env` and `headers` are collected, because those are the only fields
 * `MCPManager.#resolveAuthConfig` resolves. Collecting more would name values nothing re-reads.
 */
import { isConfigValueCommand } from "../config/config-value-resolution";
import type { MCPServerConfig } from "./types";

/**
 * The `!command` config values this server's credentials come from, in config order and
 * de-duplicated: one command may fill two headers, and it should be re-run once.
 */
export function mcpConfigCommandValues(config: MCPServerConfig): string[] {
	const source = config.type === "http" || config.type === "sse" ? config.headers : config.env;
	if (!source) return [];
	const commands = new Set<string>();
	for (const value of Object.values(source)) {
		if (isConfigValueCommand(value)) commands.add(value);
	}
	return [...commands];
}

/** Whether this server's credentials come from a command that can be re-run. */
export function hasMcpConfigCommands(config: MCPServerConfig): boolean {
	return mcpConfigCommandValues(config).length > 0;
}
