import { isRecord, logger } from "@veyyon/utils";
import type { MCPToolDefinition } from "./types";

/** Validating a `tools/list` response before any of it reaches the registry. const result = await transport.request<MCPToolsListResult>("tools/list", params); */

/** Hard ceiling on pagination rounds for one `tools/list`. A server that keeps returning the same cursor otherwise loops forever. The */
export const MAX_TOOL_LIST_PAGES = 1000;

export interface ToolListPage {
	tools: MCPToolDefinition[];
	nextCursor?: string;
	/** Entries that were dropped, one message each, for reporting to the operator. */
	rejected: string[];
}

function describe(value: unknown): string {
	if (value === null) return "null";
	if (Array.isArray(value)) return "an array";
	return typeof value;
}

/** Whether `value` is usable as a tool's `inputSchema`. A missing schema is tolerated and replaced with an empty object schema, */
function normalizeInputSchema(value: unknown): { schema: MCPToolDefinition["inputSchema"]; replaced: boolean } {
	if (isRecord(value)) {
		return { replaced: false, schema: value as MCPToolDefinition["inputSchema"] };
	}
	return { replaced: value !== undefined, schema: { properties: {}, type: "object" } };
}

/** Extract the valid tool definitions from one raw `tools/list` response. Never throws for a malformed payload. A server that answers nonsense should */
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
		// Spreading a non-array is what turned a string into one tool per
		// character. Refuse the page outright rather than iterate whatever it is.
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
			// A tool with no name cannot be called. Inventing one would put a
			// phantom in front of the model that fails only when it is used.
			rejected.push(
				`tool at index ${index} had ${typeof name === "string" ? "an empty" : `a ${describe(name)}`} name`,
			);
			continue;
		}
		if (seen.has(name)) {
			// Later duplicates are dropped rather than allowed to overwrite: the
			// first definition is the one the registry already reflects, and a
			// server that sends a name twice has no defined precedence.
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

	// A non-string cursor is not a cursor. Dropping it ends pagination, which
	// loses later pages but keeps the pages already collected; continuing with a
	// value the server cannot interpret would loop.
	const rawCursor = raw.nextCursor;
	const nextCursor = typeof rawCursor === "string" && rawCursor.length > 0 ? rawCursor : undefined;
	if (rawCursor !== undefined && nextCursor === undefined) {
		rejected.push(`"nextCursor" was ${describe(rawCursor)}, not a string; stopped paginating`);
	}

	if (rejected.length > 0) {
		// Loud on purpose (Law 10). A server that quietly loses half its tools is
		// indistinguishable from a server that has fewer tools, and the operator
		// would spend the difference debugging their own prompt.
		logger.warn("Dropped invalid entries from an MCP server's tool list", {
			dropped: rejected.length,
			path: `mcp:${serverName}`,
			reasons: rejected,
			server: serverName,
		});
	}

	return { nextCursor, rejected, tools };
}
