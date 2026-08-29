import type { TSchema } from "@veyyon/ai";
import { errorMessage } from "@veyyon/utils";
import type { CustomTool, CustomToolContext, CustomToolResult } from "../extensibility/custom-tools/types";
import type { MCPWrappedToolDetails } from "./mcp-client-helpers";

import {
	callExaTool,
	callWebsetsTool,
	findApiKey,
	formatGenericResponse,
	formatSearchResults,
	isSearchResponse,
} from "./mcp-client-helpers";
import type { MCPToolWrapperConfig } from "./types";

export { fetchExaTools, fetchWebsetsTools } from "./mcp-client-helpers";
export { findApiKey, isSearchResponse };

export class MCPWrappedTool implements CustomTool<TSchema, MCPWrappedToolDetails> {
	readonly name: string;
	readonly label: string;

	constructor(
		private readonly config: MCPToolWrapperConfig,
		public readonly parameters: TSchema,
		public readonly description: string,
	) {
		this.name = config.name;
		this.label = config.label;
	}

	async execute(
		_toolCallId: string,
		params: unknown,
		_onUpdate: unknown,
		ctx: CustomToolContext,
		signal?: AbortSignal,
	): Promise<CustomToolResult<MCPWrappedToolDetails>> {
		try {
			const apiKey = findApiKey();
			if (!apiKey && this.config.isWebsetsTool) {
				return {
					content: [{ type: "text" as const, text: "Error: EXA_API_KEY required for Websets tools" }],
					details: { error: "EXA_API_KEY required for Websets tools", toolName: this.config.name },
				};
			}

			const resolveTransform = () => ctx.obfuscateProviderText;
			const response = this.config.isWebsetsTool
				? await callWebsetsTool(apiKey!, this.config.mcpToolName, params as Record<string, unknown>, {
						signal,
						resolveProviderTextTransform: resolveTransform,
					})
				: await callExaTool(this.config.mcpToolName, params as Record<string, unknown>, apiKey, {
						signal,
						resolveProviderTextTransform: resolveTransform,
					});

			if (isSearchResponse(response)) {
				const formatted = formatSearchResults(response);
				return {
					content: [{ type: "text" as const, text: formatted }],
					details: { response, toolName: this.config.name },
				};
			}

			return {
				content: [{ type: "text" as const, text: formatGenericResponse(response) }],
				details: { raw: response, toolName: this.config.name },
			};
		} catch (error) {
			const message = errorMessage(error);
			return {
				content: [{ type: "text" as const, text: `Error: ${message}` }],
				details: { error: message, toolName: this.config.name },
			};
		}
	}
}
