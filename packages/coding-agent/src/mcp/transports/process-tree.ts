/**
 * Ending an MCP stdio server means ending everything it started.
 *
 * WHAT WAS WRONG. `StdioTransport.close()` called `Subprocess.kill()`, which
 * sends one signal to one pid: the process veyyon spawned. Almost no MCP server
 * IS that process. The published way to run one is a wrapper — `npx -y
 * @scope/server`, `uvx server`, `docker run …`, `bun x`, a shell script in a
 * repository — and the wrapper spawns the real server as a grandchild. Killing
 * the wrapper left that grandchild running, holding the environment it was
 * given, with no session able to reach it. `/mcp reload` in a long session
 * accumulated one orphan per reload; a failed handshake left one behind before
 * the operator had used the server at all.
 *
 * WHAT IS TRUE NOW. Teardown signals the tree: every live descendant first,
 * then the root, politely, and then again hard if the tree is still there when
 * the grace period ends. The descendant walk is re-taken between the two waves,
 * so a grandchild spawned during the grace period is not missed. Both waves and
 * the wait are bounded, because a reload that hangs on a server refusing to die
 * is its own defect.
 *
 * WHY THE PROCESS GROUP IS CONDITIONAL. Signalling the child's process GROUP is
 * the only way to catch a grandchild that was re-parented to init when its
 * parent died, but it is safe only when the child leads a group of its own. On
 * Linux `resolveStdioSpawnCommand` spawns detached, so the child is a session
 * leader and its group contains nothing else. On macOS it deliberately stays
 * attached so TCC can prompt, and on Windows there is no POSIX group at all —
 * there the child's group id is VEYYON'S, and signalling it would kill the
 * session that asked for the teardown. That mistake has been made in this
 * codebase before, in the shell's descendant tracker, which harvested every
 * descendant's group id and took the harness down with the target. So the group
 * is signalled only when the child is its own group leader, which
 * `leadsOwnProcessGroup` decides from the observed ids rather than from an
 * assumption about the platform.
 */
import { Process } from "@veyyon/natives";
import { errorMessage, logger } from "@veyyon/utils";

/**
 * How long the tree gets to exit after the polite signal.
 *
 * Short on purpose. A server that handles SIGTERM exits in milliseconds, and
 * the caller is usually `/mcp reload` or a session teardown, both of which the
 * operator is waiting on.
 */
export const MCP_TREE_GRACE_MS = 500;

/** Bound on the wait after the hard signal, so a teardown always returns. */
export const MCP_TREE_TIMEOUT_MS = 1_500;

/**
 * Whether the child's process group may be signalled.
 *
 * True only when the child IS the group leader. A shared group is veyyon's own,
 * and a platform without groups reports none.
 */
export function leadsOwnProcessGroup(pid: number, groupId: number | null): boolean {
	return groupId !== null && groupId === pid;
}

/**
 * Terminate an MCP server and every process it started.
 *
 * Returns true when the tree was observed gone. A false answer is reported by
 * the caller rather than thrown: teardown has no recovery, and the useful thing
 * is the pid in the log.
 */
export async function terminateMcpServerTree(pid: number): Promise<boolean> {
	let handle: Process | null = null;
	try {
		handle = Process.fromPid(pid);
	} catch (error) {
		// No native addon, or the pid is already gone. Either way there is no tree
		// to walk, and the caller still sends its own direct signal.
		logger.debug("MCP server process tree not observable", { pid, error: errorMessage(error) });
		return false;
	}
	// A pid the platform cannot open has already exited, which is the answer.
	if (!handle) return true;
	const group = leadsOwnProcessGroup(pid, handle.groupId());
	try {
		return await handle.terminate({
			group,
			gracefulMs: MCP_TREE_GRACE_MS,
			timeoutMs: MCP_TREE_TIMEOUT_MS,
		});
	} catch (error) {
		logger.debug("MCP server process tree termination failed", { pid, error: errorMessage(error) });
		return false;
	}
}
