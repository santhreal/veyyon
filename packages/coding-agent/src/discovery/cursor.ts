/** Cursor Provider Loads configuration from Cursor's config directories. */

import { tryParseJson } from "@veyyon/utils";
import { registerProvider } from "../capability";
import { readFile } from "../capability/fs";
import { type MCPServer, mcpCapability } from "../capability/mcp";
import type { Rule } from "../capability/rule";
import { ruleCapability } from "../capability/rule";
import type { LoadContext, LoadResult, SourceMeta } from "../capability/types";
import { expandEnvVarsDeep, warnUnresolved } from "./env-expansion";
import { buildRuleFromMarkdown, createSourceMeta, getUserPath, loadFilesFromDir } from "./helpers";

const PROVIDER_ID = "cursor";
const DISPLAY_NAME = "Cursor";
const PRIORITY = 50;

function parseMCPServers(content: string, path: string): LoadResult<MCPServer> {
	const items: MCPServer[] = [];
	const warnings: string[] = [];

	const parsed = tryParseJson<{ mcpServers?: Record<string, unknown> }>(content);
	if (!parsed?.mcpServers) {
		warnings.push(`${path}: missing or invalid 'mcpServers' key`);
		return { items, warnings };
	}

	const servers = expandEnvVarsDeep(parsed.mcpServers, warnUnresolved(warnings, path));
	for (const [name, config] of Object.entries(servers)) {
		const serverConfig = config as Record<string, unknown>;
		items.push({
			name,
			command: serverConfig.command as string | undefined,
			args: serverConfig.args as string[] | undefined,
			env: serverConfig.env as Record<string, string> | undefined,
			url: serverConfig.url as string | undefined,
			headers: serverConfig.headers as Record<string, string> | undefined,
			transport: ["stdio", "sse", "http"].includes(serverConfig.type as string)
				? (serverConfig.type as "stdio" | "sse" | "http")
				: undefined,
			timeout: typeof serverConfig.timeout === "number" ? serverConfig.timeout : undefined,
			_source: createSourceMeta(PROVIDER_ID, path, "user"),
		});
	}

	return { items, warnings };
}

async function loadMCPServers(ctx: LoadContext): Promise<LoadResult<MCPServer>> {
	const userPath = getUserPath(ctx, "cursor", "mcp.json");
	const userContent = userPath ? await readFile(userPath) : null;
	if (!userContent || !userPath) return { items: [], warnings: [] };

	return parseMCPServers(userContent, userPath);
}

async function loadRules(ctx: LoadContext): Promise<LoadResult<Rule>> {
	const userRulesPath = getUserPath(ctx, "cursor", "rules");
	if (!userRulesPath) return { items: [], warnings: [] };

	return await loadFilesFromDir<Rule>(userRulesPath, PROVIDER_ID, "user", {
		extensions: ["mdc", "md"],
		transform: transformMDCRule,
	});
}

function transformMDCRule(name: string, content: string, path: string, source: SourceMeta): Rule {
	return buildRuleFromMarkdown(name, content, path, source, { stripNamePattern: /\.(mdc|md)$/ });
}

registerProvider(mcpCapability.id, {
	id: PROVIDER_ID,
	displayName: DISPLAY_NAME,
	description: "Load MCP servers from ~/.cursor/mcp.json and .cursor/mcp.json",
	priority: PRIORITY,
	load: loadMCPServers,
});

registerProvider(ruleCapability.id, {
	id: PROVIDER_ID,
	displayName: DISPLAY_NAME,
	description: "Load rules from .cursor/rules/*.mdc and legacy .cursorrules",
	priority: PRIORITY,
	load: loadRules,
});
