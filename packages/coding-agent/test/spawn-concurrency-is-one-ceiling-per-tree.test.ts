/**
 * `subagent.maxConcurrency` is ONE ceiling for a session tree, not one per agent
 * that happens to spawn.
 *
 * THE DEFECT. The semaphore enforcing the ceiling lived on the `TaskTool`
 * instance, under a comment asserting that one instance meant one session. A
 * subagent gets its own tool set, so every spawning agent held a semaphore of
 * its own and the operator's ceiling was multiplied by the number of spawners: a
 * cap of 2 admitted 2 per spawner. It stayed invisible because stock installs
 * set `subagent.maxNestedSpawnDepth` to 0, where a child never receives the task
 * tool and the per-agent and per-session readings coincide. Raising that one
 * setting is what turns the latent bug live.
 *
 * WHAT THESE DEFEND, as a class rather than as the reported case: the identity a
 * tree is keyed by (the budget group's owner, resolved through the alias chain,
 * so depth is irrelevant), the ceiling itself being shared rather than merely
 * the object, unrelated sessions staying independent, and a finished tree not
 * leaving its semaphore behind for a later session to inherit.
 *
 * WHAT THEY DO NOT: that `TaskTool` calls `treeSpawnSemaphore` at all. That link
 * is one line in `#getSpawnSemaphore`, and driving it needs a real `ToolSession`
 * with agent discovery. The fallback branch it keeps for the embedded SDK case
 * is asserted here only through `treeSpawnSemaphore` returning undefined, which
 * is the signal the fallback reads.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { setTimeout as sleep } from "node:timers/promises";
import {
	initSessionCpuLimit,
	resetSessionCpuLimitsForTests,
	type SessionCpuLimit,
	withInheritedBudgetGroup,
} from "../src/session/cpu-limit";
import { disposeOwnedResources } from "../src/session/owned-resources";
import { resetTreeSpawnSemaphoresForTests, treeSpawnSemaphore } from "../src/task/spawn-semaphore";
import {
	type FakeHost,
	makeCgroupRoot,
	makeDelegatedParent,
	makeFakeHost,
	removeCgroupRoots,
} from "./helpers/fake-cgroup";

afterEach(async () => {
	resetTreeSpawnSemaphoresForTests();
	resetSessionCpuLimitsForTests();
	await removeCgroupRoots();
});

async function makeHost(): Promise<FakeHost> {
	const root = await makeCgroupRoot();
	await makeDelegatedParent(root);
	return makeFakeHost(root);
}

/** Register a root session, the way `AgentSession` does for the top conversation. */
function registerRoot(host: FakeHost, sessionId: string): Promise<SessionCpuLimit> {
	return initSessionCpuLimit({ sessionId, cores: 1, kill: false, onNotice: () => {}, env: host.env });
}

/** Register a session the way the executor does for a subagent: inside the spawner's scope. */
function registerSubagent(host: FakeHost, parentSessionId: string, sessionId: string): Promise<SessionCpuLimit> {
	return withInheritedBudgetGroup(parentSessionId, () =>
		initSessionCpuLimit({ sessionId, cores: 1, kill: false, onNotice: () => {}, env: host.env }),
	);
}

/** Whether a promise is still unsettled after the microtask queue and a timer turn. */
async function isPending(promise: Promise<unknown>): Promise<boolean> {
	let settled = false;
	void promise.then(() => {
		settled = true;
	});
	await sleep(5);
	return !settled;
}

describe("one spawn ceiling per session tree", () => {
	it("hands every spawner in the tree the same semaphore, at any depth", async () => {
		const host = await makeHost();
		await registerRoot(host, "root");
		await registerSubagent(host, "root", "child");
		await registerSubagent(host, "child", "grandchild");

		const fromRoot = treeSpawnSemaphore("root", 32);
		expect(fromRoot).toBeDefined();
		expect(treeSpawnSemaphore("child", 32)).toBe(fromRoot);
		// Depth 2 resolves through the alias chain, so a subagent of a subagent
		// shares the ROOT's ceiling rather than its parent's copy of it.
		expect(treeSpawnSemaphore("grandchild", 32)).toBe(fromRoot);
	});

	/**
	 * THE contract, and the one the old per-instance semaphore failed. Sharing the
	 * object is only interesting because it shares the COUNT: with a ceiling of
	 * one, a subagent that wants to spawn waits for the root's slot instead of
	 * being handed a second one.
	 */
	it("makes a subagent wait for the tree's slot instead of granting its own", async () => {
		const host = await makeHost();
		await registerRoot(host, "root");
		await registerSubagent(host, "root", "child");

		const rootSemaphore = treeSpawnSemaphore("root", 1);
		const childSemaphore = treeSpawnSemaphore("child", 1);
		expect(rootSemaphore).toBeDefined();
		expect(childSemaphore).toBeDefined();
		if (!rootSemaphore || !childSemaphore) throw new Error("expected a shared semaphore");

		await rootSemaphore.acquire();
		const childTurn = childSemaphore.acquire();
		expect(await isPending(childTurn)).toBe(true);

		// And the wait ends when the root's slot comes back, rather than deadlocking.
		rootSemaphore.release();
		expect(await isPending(childTurn)).toBe(false);
	});

	it("keeps unrelated sessions independent", async () => {
		const host = await makeHost();
		await registerRoot(host, "one");
		await registerRoot(host, "two");

		const first = treeSpawnSemaphore("one", 1);
		const second = treeSpawnSemaphore("two", 1);
		expect(first).toBeDefined();
		expect(second).toBeDefined();
		expect(second).not.toBe(first);
		if (!first || !second) throw new Error("expected two semaphores");

		// A slot taken in one session must not be a slot missing from the other.
		await first.acquire();
		expect(await isPending(second.acquire())).toBe(false);
	});

	it("has nothing to share for a session with no budget group", async () => {
		expect(treeSpawnSemaphore("never-registered", 4)).toBeUndefined();
		expect(treeSpawnSemaphore(null, 4)).toBeUndefined();
		expect(treeSpawnSemaphore(undefined, 4)).toBeUndefined();
	});

	it("resizes the shared ceiling in place rather than replacing it", async () => {
		const host = await makeHost();
		await registerRoot(host, "root");
		await registerSubagent(host, "root", "child");

		const atOne = treeSpawnSemaphore("root", 1);
		if (!atOne) throw new Error("expected a semaphore");
		await atOne.acquire();
		const queued = atOne.acquire();
		expect(await isPending(queued)).toBe(true);

		// The operator raises the cap mid-session. The subagent's own lookup is
		// what applies it, and work already parked in the queue is admitted.
		const raised = treeSpawnSemaphore("child", 2);
		expect(raised).toBe(atOne);
		expect(await isPending(queued)).toBe(false);
	});

	it("does not leave a finished tree's semaphore behind for a later session", async () => {
		const host = await makeHost();
		await registerRoot(host, "root");
		const before = treeSpawnSemaphore("root", 1);
		expect(before).toBeDefined();
		if (!before) throw new Error("expected a semaphore");
		// Occupy the only slot, so inheriting this object would deadlock the next
		// session rather than merely sharing state with it.
		await before.acquire();

		await disposeOwnedResources("session", "root");
		expect(treeSpawnSemaphore("root", 1)).toBeUndefined();

		// A later session that happens to reuse the id gets a fresh ceiling.
		await registerRoot(host, "root");
		const after = treeSpawnSemaphore("root", 1);
		expect(after).toBeDefined();
		expect(after).not.toBe(before);
		if (!after) throw new Error("expected a fresh semaphore");
		expect(await isPending(after.acquire())).toBe(false);
	});
});
