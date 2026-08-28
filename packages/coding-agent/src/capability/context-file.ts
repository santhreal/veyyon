import * as path from "node:path";
import { defineCapability } from ".";
import type { SourceMeta } from "./types";

export interface ContextFile {
	path: string;
	content: string;
	level: "user" | "project" | "global";
	depth?: number;
	_source: SourceMeta;
}

export const contextFileCapability = defineCapability<ContextFile>({
	id: "context-files",
	displayName: "Context Files",
	description: "Persistent instruction files (CLAUDE.md, AGENTS.md, etc.) that guide agent behavior",
	key: file =>
		file.level === "global" ? "global" : file.level === "user" ? "user" : `project:${Math.max(0, file.depth ?? 0)}`,
	toExtensionId: file => `context-file:${file.level}:${path.basename(file.path)}`,
	validate: file => {
		if (!file.path) return "Missing path";
		if (file.content === undefined) return "Missing content";
		if (file.level !== "user" && file.level !== "project" && file.level !== "global") {
			return "Invalid level: must be 'user', 'project', or 'global'";
		}
		return undefined;
	},
});
