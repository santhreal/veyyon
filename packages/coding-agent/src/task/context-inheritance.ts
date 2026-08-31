import * as path from "node:path";

import { logger } from "@veyyon/utils";

import type { ContextFileEntry } from "../tools";

/** Where the spawn happens, for the warning a dropped scope now produces. */
export interface InheritContextFilesArgs {
	/** The parent session's resolved context files, in prompt order. */
	parentContextFiles: ContextFileEntry[] | undefined;
	/** The parent session's working directory. */
	parentCwd: string;
	/** The working directory the child will run in. */
	spawnCwd: string;
	/** Agent name, for the log line. */
	agentName: string;
}

/**
 * The context files a spawned agent starts from, so the global, profile, and
 * project scopes reach a subagent's prompt exactly as they reach its parent's.
 *
 * Three rules the spawn sites used to get wrong:
 *
 * 1. Nothing is filtered by file name. Every spawn site dropped entries whose
 *    basename was `AGENTS.md`, which is every scope a user actually writes:
 *    `~/.veyyon/AGENTS.md`, the active profile's `AGENTS.md`, and the project
 *    walk. Only a `CLAUDE.md` survived. The subagent was then handed the project
 *    prompt's standing claim that "every AGENTS.md ... is already inlined", so it
 *    neither had the rules nor was allowed to look for them.
 * 2. An empty result is `undefined`, never `[]`. Downstream treats any array,
 *    empty included, as "already resolved" and skips discovery, so handing a
 *    child `[]` disables its own scope loading in silence. `undefined` lets the
 *    child load its own layers.
 * 3. A child rooted somewhere else re-discovers rather than inherits. The
 *    parent's project walk describes the parent's tree; a `task(cwd: ...)` spawn
 *    or an isolated worktree needs the walk its own root produces.
 */
export function inheritContextFiles(args: InheritContextFilesArgs): ContextFileEntry[] | undefined {
	const { parentContextFiles, parentCwd, spawnCwd, agentName } = args;

	if (path.resolve(parentCwd) !== path.resolve(spawnCwd)) {
		logger.debug("Subagent re-discovers context files: spawn cwd differs from parent", {
			agent: agentName,
			parentCwd,
			spawnCwd,
		});
		return undefined;
	}

	if (parentContextFiles === undefined) return undefined;

	if (parentContextFiles.length === 0) {
		// The parent resolved its layers and came back with nothing, which is not a
		// normal state: the global `~/.veyyon/AGENTS.md` is seeded on startup, so an
		// empty set means a scope failed to load rather than that none exist. Say so,
		// and let the child try its own discovery instead of inheriting the emptiness.
		logger.warn("Spawning agent with no inherited context files; parent session resolved zero scopes", {
			agent: agentName,
			cwd: spawnCwd,
		});
		return undefined;
	}

	return parentContextFiles;
}
