/** Where a project's long-term memory lives on disk. One owner, and it imports almost nothing. consolidation, the model calls that summarise a session. It imports `completeSimple` from */

import * as path from "node:path";
import { getMemoriesDir } from "@veyyon/utils/dirs";

/** A project's memory root: `<agentDir>/memories/--<encoded cwd>--`. The cwd is part of the path because a worktree is a different project. Subagents running in one see a */
export function getMemoryRoot(agentDir: string, cwd: string): string {
	return path.join(getMemoriesDir(agentDir), encodeProjectPath(cwd));
}

/** One directory name per project path, flattened. The leading separator goes first so `/home/you/p` and `home/you/p` cannot produce different */
function encodeProjectPath(cwd: string): string {
	return `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}
