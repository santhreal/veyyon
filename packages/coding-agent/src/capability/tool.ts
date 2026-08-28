/** Custom Tools Capability User-defined tools that extend agent capabilities. */
import { defineCapability } from ".";
import type { SourceMeta } from "./types";

/** A custom-tool definition FILE found on disk, before anything is loaded from it. DISCOVERED is the distinguishing word. `CustomTool` */
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
