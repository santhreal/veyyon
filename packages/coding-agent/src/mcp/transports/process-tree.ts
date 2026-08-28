/** Ending an MCP stdio server means ending everything it started. sends one signal to one pid: the process veyyon spawned. Almost no MCP server */
import { Process } from "@veyyon/natives";
import { errorMessage, logger } from "@veyyon/utils";

/** How long the tree gets to exit after the polite signal. Short on purpose. A server that handles SIGTERM exits in milliseconds, and */
export const MCP_TREE_GRACE_MS = 500;

/** Bound on the wait after the hard signal, so a teardown always returns. */
export const MCP_TREE_TIMEOUT_MS = 1_500;

/** Whether the child's process group may be signalled. True only when the child IS the group leader. A shared group is veyyon's own, */
export function leadsOwnProcessGroup(pid: number, groupId: number | null): boolean {
	return groupId !== null && groupId === pid;
}

/** Terminate an MCP server and every process it started. Returns true when the tree was observed gone. A false answer is reported by */
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
