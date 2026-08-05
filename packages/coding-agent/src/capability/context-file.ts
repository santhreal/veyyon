/**
 * Context Files Capability
 *
 * System instruction files (CLAUDE.md, AGENTS.md, GEMINI.md, etc.) that provide
 * persistent guidance to the agent.
 */
import * as path from "node:path";
import { defineCapability } from ".";
import type { SourceMeta } from "./types";

/**
 * A context file that provides persistent instructions to the agent.
 */
export interface ContextFile {
	/** Absolute path to the file */
	path: string;
	/** File content */
	content: string;
	/**
	 * Which layer this came from. `global` is veyyon's cross-profile
	 * `~/.veyyon/AGENTS.md`; `user` is the LOADING profile's own AGENTS.md, meaning
	 * the one named by `LoadContext.agentDir` rather than whichever profile the
	 * process booted with; and `project` is the one file a directory on the
	 * repo-root-to-cwd walk contributes.
	 * Prominence runs global (least, the baseline) → project → user (most, the most
	 * specific).
	 *
	 * Which file a project directory contributes, and how `.veyyon/AGENTS.md`,
	 * `AGENTS.md` and `CLAUDE.md` rank against each other at one level, is owned by
	 * `PROJECT_RULE_FILE_NAMES` in `discovery/builtin.ts`. Do not restate it here.
	 */
	level: "user" | "project" | "global";
	/** Distance from cwd (0 = in cwd, 1 = parent, etc.) for project files */
	depth?: number;
	/** Source metadata */
	_source: SourceMeta;
}

export const contextFileCapability = defineCapability<ContextFile>({
	id: "context-files",
	displayName: "Context Files",
	description: "Persistent instruction files (CLAUDE.md, AGENTS.md, etc.) that guide agent behavior",
	// Deduplicate by scope: one global-level file, one user-level file, and one
	// project-level file per directory depth. The three scopes are distinct keys
	// so the global baseline and the per-profile file coexist (they would collide
	// if both keyed as "user"). Within each depth level, higher-priority providers
	// shadow lower-priority ones. This supports monorepo hierarchies where
	// AGENTS.md exists at multiple ancestor levels.
	//
	// This key is a CROSS-PROVIDER backstop, not the native walk's precedence rule:
	// that walk resolves one file per directory itself and never emits a loser here.
	// Clamp depth >= 0: files inside config subdirectories of an ancestor (e.g. .claude/, .github/)
	// are same-scope as the ancestor itself.
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
