/**
 * Exa MCP tool registration.
 *
 * `exa.enableResearcher` and `exa.enableWebsets` are the two settings that turn
 * Exa's hosted MCP servers into agent tools. This module is the one place that
 * reads them and the one place that turns a discovered MCP tool into a
 * {@link MCPWrappedTool}; `sdk.ts` calls {@link getExaMcpTools} once per session
 * and pushes the result onto the custom-tool list.
 *
 * Discovery is dynamic on purpose. The webset surface changes as Exa ships
 * tools, so the list comes from the server's own `tools/list` rather than from a
 * hardcoded table here. The researcher half still has to name what it wants,
 * because `mcp.exa.ai` requires a `toolNames` filter on the request; those names
 * live in {@link RESEARCHER_MCP_TOOL_NAMES} and nowhere else.
 *
 * Nothing here fails quietly. Both settings default to off, so reaching this
 * code at all means the user asked for the tools. If they cannot be provided,
 * the reason and the fix go to the log at error level rather than the session
 * starting with the tools silently absent.
 */
import { $env, errorMessage, logger } from "@veyyon/utils";
import type { CustomTool } from "../extensibility/custom-tools/types";
import { fetchExaTools, fetchWebsetsTools, MCPWrappedTool } from "./mcp-client";
import type { MCPTool } from "./types";

/**
 * The researcher tools requested from `mcp.exa.ai`.
 *
 * `deep_researcher_start` kicks off a research run and returns a task id;
 * `deep_researcher_check` polls it. Both are needed for the tool to be usable,
 * so they are requested together.
 */
export const RESEARCHER_MCP_TOOL_NAMES = ["deep_researcher_start", "deep_researcher_check"] as const;

/** Prefix applied to every Exa MCP tool name so it cannot collide with a built-in. */
const TOOL_NAME_PREFIX = "exa_";

/** Turn a discovered MCP tool into an agent tool. */
function wrap(tool: MCPTool, isWebsetsTool: boolean): MCPWrappedTool {
	return new MCPWrappedTool(
		{
			name: `${TOOL_NAME_PREFIX}${tool.name}`,
			label: `Exa ${tool.name.replace(/_/g, " ")}`,
			mcpToolName: tool.name,
			isWebsetsTool,
		},
		tool.inputSchema,
		tool.description,
	);
}

/** Which halves of the Exa MCP surface a session wants. */
export interface ExaMcpToolRequest {
	researcher: boolean;
	websets: boolean;
}

/**
 * Discover the enabled Exa MCP tools.
 *
 * Returns an empty list when neither half is requested, which is the default.
 * A discovery failure is reported and drops only the half that failed: an
 * unreachable websets endpoint must not cost the user their researcher tools.
 */
export async function getExaMcpTools(request: ExaMcpToolRequest): Promise<CustomTool<any, any>[]> {
	if (!request.researcher && !request.websets) return [];

	const apiKey = $env.EXA_API_KEY ?? null;
	if (request.websets && !apiKey) {
		logger.error("Exa websets tools are enabled but EXA_API_KEY is not set; they were not registered", {
			fix: "Set EXA_API_KEY in your environment, or turn off exa.enableWebsets in /settings → Providers → Services.",
		});
	}

	const halves: Array<Promise<CustomTool<any, any>[]>> = [];
	if (request.researcher) halves.push(discoverResearcherTools(apiKey));
	if (request.websets && apiKey) halves.push(discoverWebsetsTools(apiKey));

	return (await Promise.all(halves)).flat();
}

async function discoverResearcherTools(apiKey: string | null): Promise<CustomTool<any, any>[]> {
	try {
		const tools = await fetchExaTools(apiKey, [...RESEARCHER_MCP_TOOL_NAMES]);
		if (tools.length === 0) {
			logger.error("Exa researcher is enabled but mcp.exa.ai returned no matching tools", {
				requested: RESEARCHER_MCP_TOOL_NAMES,
				fix: "Check that your Exa plan includes the deep researcher, or turn off exa.enableResearcher.",
			});
			return [];
		}
		return tools.map(tool => wrap(tool, false));
	} catch (error) {
		logger.error("Exa researcher tools could not be discovered; they were not registered", {
			error: errorMessage(error),
			fix: "Check network access to mcp.exa.ai and your EXA_API_KEY, or turn off exa.enableResearcher.",
		});
		return [];
	}
}

async function discoverWebsetsTools(apiKey: string): Promise<CustomTool<any, any>[]> {
	try {
		const tools = await fetchWebsetsTools(apiKey);
		if (tools.length === 0) {
			logger.error("Exa websets is enabled but websetsmcp.exa.ai returned no tools", {
				fix: "Check that your Exa plan includes websets, or turn off exa.enableWebsets.",
			});
			return [];
		}
		return tools.map(tool => wrap(tool, true));
	} catch (error) {
		logger.error("Exa websets tools could not be discovered; they were not registered", {
			error: errorMessage(error),
			fix: "Check network access to websetsmcp.exa.ai and your EXA_API_KEY, or turn off exa.enableWebsets.",
		});
		return [];
	}
}
