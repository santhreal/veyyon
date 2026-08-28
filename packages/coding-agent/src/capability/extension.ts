import { defineCapability } from ".";
import type { MCPServer } from "./mcp";
import type { SourceMeta } from "./types";

export interface ExtensionManifest {
	name?: string;
	description?: string;
	mcpServers?: Record<string, Omit<MCPServer, "name" | "_source">>;
	tools?: unknown[];
	context?: unknown;
}

export interface ManifestExtension {
	name: string;
	path: string;
	manifest: ExtensionManifest;
	level: "user" | "project";
	_source: SourceMeta;
}

export const extensionCapability = defineCapability<ManifestExtension>({
	id: "extensions",
	displayName: "Extensions",
	description: "Gemini-style extensions providing MCP servers, tools, and context",
	key: ext => ext.name,
	validate: ext => {
		if (!ext.name) return "Missing extension name";
		if (!ext.path) return "Missing extension path";
		return undefined;
	},
});
