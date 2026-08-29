import { errorMessage } from "@veyyon/utils/type-guards";
import { mcpManagerInstance } from "../mcp/manager-instance";
import type { MCPResourceReadResult } from "../mcp/types";
import { extractResourceUri, formatAvailableResources, resolveTargetServer } from "./mcp-protocol-helpers";
import type { InternalResource, InternalUrl, ProtocolHandler } from "./types";

export class McpProtocolHandler implements ProtocolHandler {
	readonly scheme = "mcp";
	readonly immutable = true;

	async resolve(url: InternalUrl): Promise<InternalResource> {
		const mcpManager = mcpManagerInstance();
		if (!mcpManager) {
			throw new Error("No MCP manager available. MCP servers may not be configured.");
		}

		const uri = extractResourceUri(url);
		const targetServer = resolveTargetServer(mcpManager, uri);
		if (!targetServer) {
			throw new Error(
				`No MCP server has resource "${uri}".\n\nAvailable resources:\n${formatAvailableResources(mcpManager)}`,
			);
		}

		let result: MCPResourceReadResult | undefined;
		try {
			result = await mcpManager.readServerResource(targetServer, uri);
		} catch (error) {
			const message = errorMessage(error);
			throw new Error(`MCP resource read error: ${message}`);
		}

		if (!result) {
			throw new Error(`Server "${targetServer}" returned no content for "${uri}".`);
		}

		const textParts: string[] = [];
		for (const item of result.contents) {
			if (item.text !== undefined && item.text !== null) {
				textParts.push(item.text);
			} else if (item.blob) {
				textParts.push(`[Binary content: ${item.mimeType ?? "unknown"}, base64 length ${item.blob.length}]`);
			}
		}

		const content = textParts.length > 0 ? textParts.join("\n---\n") : "(empty resource)";
		return {
			url: url.href,
			content,
			contentType: "text/plain",
			size: Buffer.byteLength(content, "utf-8"),
			notes: [`MCP server: ${targetServer}`],
		};
	}
}
