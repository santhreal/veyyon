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

/** The context files a spawned agent starts from, so the global, profile, and project scopes reach a subagent's prompt exactly as they reach its parent's. */
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
		// The parent resolved its layers and came back with nothing, which is not a normal state: the global `~/.veyyon/AGENTS.md` is seeded on startup, so an
		logger.warn("Spawning agent with no inherited context files; parent session resolved zero scopes", {
			agent: agentName,
			cwd: spawnCwd,
		});
		return undefined;
	}

	return parentContextFiles;
}
