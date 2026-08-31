/**
 * Extensions Capability
 *
 * Gemini-style extensions that provide MCP servers, tools, and context.
 */
import { defineCapability } from ".";
import type { MCPServer } from "./mcp";
import type { SourceMeta } from "./types";

/**
 * Extension manifest structure.
 */
export interface ExtensionManifest {
	name?: string;
	description?: string;
	mcpServers?: Record<string, Omit<MCPServer, "name" | "_source">>;
	tools?: unknown[];
	context?: unknown;
}

/**
 * An extension DIRECTORY discovered on disk: a manifest plus where it was found.
 *
 * Named for the manifest because two other things in this package are also called
 * an "extension" and mean something else. `LoadedExtension`
 * (`extensibility/extensions/types.ts`) is a veyyon extension MODULE that has been
 * executed and has registered handlers, tools, and commands; `ExtensionRow`
 * (`modes/components/extensions/types.ts`) is a dashboard row that normalizes every
 * capability kind, most of which are not extensions at all. This one is none of
 * those: it is the Gemini-style on-disk manifest, before anything is loaded from it.
 */
export interface ManifestExtension {
	/** Extension name (from manifest.name or directory name) */
	name: string;
	/** Absolute path to extension directory */
	path: string;
	/** Parsed manifest data */
	manifest: ExtensionManifest;
	/** Source level */
	level: "user" | "project";
	/** Source metadata */
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
