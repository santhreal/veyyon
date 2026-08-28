import { isRecord, logger } from "@veyyon/utils";
import type { MCPToolDefinition } from "./types";

export const MAX_TOOL_LIST_PAGES = 1000;

export interface ToolListPage {
	tools: MCPToolDefinition[];
	nextCursor?: string;
	rejected: string[];
}

function describe(value: unknown): string {
	if (value === null) return "null";
	if (Array.isArray(value)) return "an array";
	return typeof value;
}

function normalizeInputSchema(value: unknown): { schema: MCPToolDefinition["inputSchema"]; replaced: boolean } {
	if (isRecord(value)) {
		return { replaced: false, schema: value as MCPToolDefinition["inputSchema"] };
	}
	return { replaced: value !== undefined, schema: { properties: {}, type: "object" } };
}

export function validateToolListPage(raw: unknown, serverName: string): ToolListPage {
	const rejected: string[] = [];

	if (!isRecord(raw)) {
		return {
			rejected: [`the response was ${describe(raw)}, not an object`],
			tools: [],
		};
	}

	const rawTools = raw.tools;
	if (!Array.isArray(rawTools)) {
		return {
			rejected: [`"tools" was ${describe(rawTools)}, not an array`],
			tools: [],
		};
	}

	const tools: MCPToolDefinition[] = [];
	const seen = new Set<string>();
	for (const [index, entry] of rawTools.entries()) {
		if (!isRecord(entry)) {
			rejected.push(`tool at index ${index} was ${describe(entry)}, not an object`);
			continue;
		}
		const name = entry.name;
		if (typeof name !== "string" || name.trim().length === 0) {
			rejected.push(
				`tool at index ${index} had ${typeof name === "string" ? "an empty" : `a ${describe(name)}`} name`,
			);
			continue;
		}
		if (seen.has(name)) {
			rejected.push(`tool "${name}" appeared more than once; kept the first definition`);
			continue;
		}
		const { schema, replaced } = normalizeInputSchema(entry.inputSchema);
		if (replaced) {
			rejected.push(
				`tool "${name}" had an inputSchema that was ${describe(entry.inputSchema)}; treated it as taking no arguments`,
			);
		}
		seen.add(name);
		tools.push({
			inputSchema: schema,
			name,
			...(typeof entry.description === "string" ? { description: entry.description } : {}),
		});
	}

	const rawCursor = raw.nextCursor;
	const nextCursor = typeof rawCursor === "string" && rawCursor.length > 0 ? rawCursor : undefined;
	if (rawCursor !== undefined && nextCursor === undefined) {
		rejected.push(`"nextCursor" was ${describe(rawCursor)}, not a string; stopped paginating`);
	}

	if (rejected.length > 0) {
		logger.warn("Dropped invalid entries from an MCP server's tool list", {
			dropped: rejected.length,
			path: `mcp:${serverName}`,
			reasons: rejected,
			server: serverName,
		});
	}

	return { nextCursor, rejected, tools };
}
