/**
 * The subagent spawn semaphore, scoped to a session TREE.
 *
 * `subagent.maxConcurrency` is documented as a per-session ceiling, and the
 * semaphore enforcing it used to live on the `TaskTool` instance, with a comment
 * claiming that amounted to the same thing. It does not. A subagent gets its own
 * tool set, so every agent that spawns holds a semaphore of its own, and the
 * operator's ceiling is multiplied by the number of spawners: with nested
 * spawning enabled, a cap of 32 admits 32 per spawner rather than 32 in total.
 * Stock installs set `subagent.maxNestedSpawnDepth` to 0, where a child gets no
 * task tool and the two readings agree, which is why this went unnoticed.
 *
 * The tree identity is the budget group's owner, the same answer the CPU, memory,
 * disk and process limits key on, rather than a second notion of what a session
 * tree is.
 */
import { type SessionCpuLimit, sessionCpuLimit, sessionTreeId } from "../session/cpu-limit";
import { Semaphore } from "./parallel";

/**
 * One semaphore per live session tree, keyed by the tree's owning session id and
 * pinned to the limiter object that owned the group when it was created.
 *
 * The key alone is not enough to say an entry is current. A session id can be
 * registered, disposed and registered again in one process, and an entry looked
 * up by key would then hand the new tree the finished tree's ceiling, including
 * any slot the finished tree never released. The limiter is a fresh object per
 * registration, so comparing it is what distinguishes "the same tree" from "the
 * same name".
 */
const treeSemaphores = new Map<string, { limiter: SessionCpuLimit; semaphore: Semaphore }>();

/**
 * The semaphore every spawner in this session's tree shares, resized in place so
 * a mid-session settings change reaches work already parked in the queue as well
 * as new spawns.
 *
 * `undefined` when the session has no registered budget group, which is the
 * embedded SDK case. The caller then keeps an instance-local semaphore instead:
 * sharing one process-wide semaphore across sessions that are not related would
 * be a worse answer than the per-instance one it replaces.
 */
export function treeSpawnSemaphore(sessionId: string | null | undefined, max: number): Semaphore | undefined {
	const treeId = sessionTreeId(sessionId);
	if (treeId === undefined) return undefined;
	const limiter = sessionCpuLimit(treeId);
	if (limiter === undefined) return undefined;
	// The registry is the only thing that knows a tree ended or was replaced, so a
	// stale entry can only be noticed from here. Without this, one Map entry per
	// finished session accumulates for the life of the process.
	for (const [known, entry] of treeSemaphores) {
		if (sessionCpuLimit(known) !== entry.limiter) treeSemaphores.delete(known);
	}
	const existing = treeSemaphores.get(treeId);
	if (existing) {
		existing.semaphore.resize(max);
		return existing.semaphore;
	}
	const semaphore = new Semaphore(max);
	treeSemaphores.set(treeId, { limiter, semaphore });
	return semaphore;
}

/** Forget every tree's semaphore. Test-only. */
export function resetTreeSpawnSemaphoresForTests(): void {
	treeSemaphores.clear();
}
