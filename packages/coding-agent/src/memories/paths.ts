/**
 * Where a project's long-term memory lives on disk. One owner, imports almost nothing. Was in
 `memories/index.ts` (558 modules); `getMemoryRoot` is a two-line path join. Through five hops, reading
 a local file statically depended on the model summariser. `memories/index.ts` re-exports both names.
 */

import * as path from "node:path";
// Owners, not the `@veyyon/utils` barrel: 1 module against 74.
import { getMemoriesDir } from "@veyyon/utils/dirs";

/**
 * A project's memory root: `<agentDir>/memories/--<encoded cwd>--`. The cwd is part of the path
 * because a worktree is a different project.
 */
export function getMemoryRoot(agentDir: string, cwd: string): string {
	return path.join(getMemoriesDir(agentDir), encodeProjectPath(cwd));
}

/**
 * One directory name per project path, flattened. NOT REVERSIBLE: `-` is a legal character in a path
 * segment, so the mapping is many-to-one. Read the project path from the session, never from this name.
 */
function encodeProjectPath(cwd: string): string {
	return `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}
