/**
 * Custom Tools Capability
 *
 * User-defined tools that extend agent capabilities.
 */
import { defineCapability } from ".";
import type { SourceMeta } from "./types";

/**
 * A custom-tool definition FILE found on disk, before anything is loaded from it.
 *
 * DISCOVERED is the distinguishing word. `CustomTool`
 * (`extensibility/custom-tools/types.ts`) is the runtime interface an extension
 * registers with `pi.registerTool`: it is generic over its parameter schema and
 * carries an `execute`, an approval tier, and MCP metadata. This one carries none
 * of that -- it is a path, a description, and where it came from, which is all a
 * discovery provider knows before the file is read. Both were called `CustomTool`,
 * so an editor auto-import picked whichever it offered. (A third `CustomTool` in
 * `packages/ai/src/providers/openai-responses-wire.ts` is generated vendor wire for
 * OpenAI's own custom-tool type and is not ours to rename.)
 */
export interface DiscoveredCustomTool {
	/** Tool name (unique key) */
	name: string;
	/** Absolute path to tool definition file */
	path: string;
	/** Tool description */
	description: string;
	/** Tool implementation (script path or inline) */
	implementation?: string;
	/** Source level */
	level: "user" | "project";
	/** Source metadata */
	_source: SourceMeta;
}

export const toolCapability = defineCapability<DiscoveredCustomTool>({
	id: "tools",
	displayName: "Custom Tools",
	description: "User-defined tools that extend agent capabilities",
	key: tool => tool.name,
	toExtensionId: tool => `tool:${tool.name}`,
	validate: tool => {
		if (!tool.name) return "Missing name";
		if (!tool.path) return "Missing path";
		return undefined;
	},
});
