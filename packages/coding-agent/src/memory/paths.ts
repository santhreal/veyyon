/**
 * Where a project's long-term memory lives on disk. One owner, and it imports almost nothing.
 *
 * WHY THIS IS NOT IN `memories/index.ts`. It was, and that module is the memory SUBSYSTEM: extraction,
 * consolidation, the model calls that summarise a session. It imports `completeSimple` from
 * `@veyyon/ai`, the model registry and the settings, so it reaches 558 modules. `getMemoryRoot` is a
 * two-line path join, and asking for it dragged all of that in.
 *
 * Where that landed is worth recording, because it is the shape this whole class of defect takes.
 * `internal-urls/memory-protocol.ts` needs the root to resolve a `memory://` URL, so it paid 483 modules
 * that nothing else on its path reached. `tui/hyperlink.ts` imports the memory protocol to turn a path
 * into a clickable link, so a hyperlink formatter reached the model registry. `tui/index.ts` re-exports
 * the hyperlink module, `tools/fetch.ts` takes two names from that barrel, and `tools/read.ts` imports
 * `fetch`. So reading a local file statically depended on the code that asks a model to summarise your
 * memory, through five hops, none of which looked wrong on its own.
 *
 * `memories/index.ts` re-exports both names, so no existing caller changed.
 */

import * as path from "node:path";
// Owners, not the `@veyyon/utils` barrel: 1 module against 74.
import { getMemoriesDir } from "@veyyon/utils/dirs";

/**
 * A project's memory root: `<agentDir>/memories/--<encoded cwd>--`.
 *
 * The cwd is part of the path because a worktree is a different project. Subagents running in one see a
 * different root from the main session, which is why the memory protocol takes a snapshot per registered
 * session rather than assuming one root per process.
 */
export function getMemoryRoot(agentDir: string, cwd: string): string {
	return path.join(getMemoriesDir(agentDir), encodeProjectPath(cwd));
}

/**
 * One directory name per project path, flattened.
 *
 * The leading separator goes first so `/home/you/p` and `home/you/p` cannot produce different
 * directories for the same project, and every remaining separator and the Windows drive colon become
 * `-`. The `--` fences make the encoded name unmistakable in a directory listing and keep an encoded
 * path from colliding with any other name veyyon writes beside it.
 *
 * NOT REVERSIBLE, on purpose: `-` is a legal character in a path segment, so the mapping is many-to-one
 * and nothing should try to decode it. Read the project path from the session, never from this name.
 */
function encodeProjectPath(cwd: string): string {
	return `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}
