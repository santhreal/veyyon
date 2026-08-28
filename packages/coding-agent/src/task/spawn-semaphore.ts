/** The subagent spawn semaphore, scoped to a session TREE. `subagent.maxConcurrency` is documented as a per-session ceiling, and the */
import { type SessionCpuLimit, sessionCpuLimit, sessionTreeId } from "../session/cpu-limit";
import { Semaphore } from "./parallel";

/** One semaphore per live session tree, keyed by the tree's owning session id and pinned to the limiter object that owned the group when it was created. */
const treeSemaphores = new Map<string, { limiter: SessionCpuLimit; semaphore: Semaphore }>();

/** The semaphore every spawner in this session's tree shares, resized in place so a mid-session settings change reaches work already parked in the queue as well */
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
