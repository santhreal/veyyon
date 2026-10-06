/**
 * A background spawn waits for its session tree's spawn slot, and a spawn cancelled around that wait
 * returns exactly the slot it held: none when it was cancelled in the queue, its own when it was
 * cancelled in the same tick it was admitted.
 *
 * THE CLASS. `SpawnScheduler` (`task/spawn-scheduler.ts`) registers every background spawn as a queued
 * job that acquires the tree semaphore before it runs. The queued-abort branch decides two things the
 * rest of the batch depends on. Releasing a slot the spawn never acquired lets a later spawn start past
 * `agent.maxConcurrency`; skipping the release of a slot it did acquire shrinks the ceiling for the rest
 * of the process. Settling neither the row nor the batch leaves the call's background state reading
 * "running" after every job has ended.
 *
 * WHAT THESE DEFEND: the scheduler reads the tree's semaphore rather than its own (a spawn queues
 * behind a slot another spawner in the tree holds), both arms of the abort-while-queued release, the
 * batch converging once a queued spawn is cancelled, and a call none of whose spawns could be
 * registered failing with every spawn's reason.
 *
 * WHAT THEY DO NOT: the inline path's admission (`runInline`), which the blocking-split and fan-out
 * cancel suites drive through `TaskTool`, and a resize of the ceiling while a spawn is queued.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { AsyncJobManager } from "@veyyon/coding-agent/async/job-manager";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { AgentLifecycleManager } from "@veyyon/coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@veyyon/coding-agent/registry/agent-registry";
import { initSessionCpuLimit, resetSessionCpuLimitsForTests } from "@veyyon/coding-agent/session/cpu-limit";
import * as discoveryModule from "@veyyon/coding-agent/task/discovery";
import * as executorModule from "@veyyon/coding-agent/task/executor";
import type { Semaphore } from "@veyyon/coding-agent/task/parallel";
import { type CallSpawn, type SpawnCall, SpawnScheduler } from "@veyyon/coding-agent/task/spawn-scheduler";
import { resetTreeSpawnSemaphoresForTests, treeSpawnSemaphore } from "@veyyon/coding-agent/task/spawn-semaphore";
import type { AgentDefinition, AgentProgress, TaskToolDetails } from "@veyyon/coding-agent/task/types";
import { makeCgroupRoot, makeDelegatedParent, makeFakeHost, removeCgroupRoots } from "../helpers/fake-cgroup";
import { useIsolatedAgentDir } from "../helpers/isolated-agent-dir";
import { makeToolSession } from "../helpers/tool-session";

// A spawn that runs writes a session under the active profile's agent dir.
useIsolatedAgentDir();

const ROOT_SESSION = "root";

const taskAgent: AgentDefinition = {
	name: "task",
	description: "General-purpose task agent",
	systemPrompt: "You are a task agent.",
	source: "bundled",
};

const managers: AsyncJobManager[] = [];

function createManager(): AsyncJobManager {
	const manager = new AsyncJobManager({ onJobComplete: () => {} });
	managers.push(manager);
	return manager;
}

/** A scheduler for the registered root session, with a ceiling of one spawn for the whole tree. */
function createScheduler(): SpawnScheduler {
	return new SpawnScheduler(
		makeToolSession({
			hasUI: false,
			settings: Settings.isolated({ "async.enabled": true, "agent.maxConcurrency": 1 }),
			getSessionSpawns: () => "*",
			getSessionId: () => ROOT_SESSION,
			getAgentId: () => null,
		}),
	);
}

/** Register the root session's budget group, which is what gives the tree a shared semaphore. */
async function treeSemaphore(): Promise<Semaphore> {
	const root = await makeCgroupRoot();
	await makeDelegatedParent(root);
	const host = makeFakeHost(root);
	await initSessionCpuLimit({ sessionId: ROOT_SESSION, cores: 1, kill: false, onNotice: () => {}, env: host.env });
	const semaphore = treeSpawnSemaphore(ROOT_SESSION, 1);
	if (!semaphore) throw new Error("the registered root session has no tree semaphore");
	return semaphore;
}

function spawnsNamed(...names: string[]): CallSpawn[] {
	return names.map(name => ({
		item: { name, agent: "task", task: `Work for ${name}.` },
		agentName: "task",
		agent: taskAgent,
	}));
}

function callFor(updates: TaskToolDetails[]): SpawnCall {
	return {
		toolCallId: "tc-scheduler",
		params: { context: "ctx" },
		defaultAgent: "task",
		onUpdate: update => {
			if (update.details) updates.push(update.details);
		},
	};
}

/**
 * Whether the tree has a free slot: a probe that is admitted at once holds one (and gives it back), a
 * probe that has to queue is withdrawn by its abort.
 */
async function slotIsFree(semaphore: Semaphore): Promise<boolean> {
	const probe = new AbortController();
	const turn = semaphore.acquire(probe.signal);
	probe.abort();
	const admitted = await turn.then(
		() => true,
		() => false,
	);
	if (admitted) semaphore.release();
	return admitted;
}

/**
 * One macrotask turn. Every microtask queued before it runs first, so a spawn whose semaphore admitted
 * it has marked its job running by the time this resolves.
 */
async function drainMicrotasks(): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	setImmediate(resolve);
	await promise;
}

function rowOf(details: TaskToolDetails | undefined, id: string): AgentProgress | undefined {
	return details?.progress?.find(row => row.id === id);
}

beforeEach(() => {
	AgentRegistry.resetGlobalForTests();
	AgentLifecycleManager.resetGlobalForTests();
	vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({ agents: [taskAgent], projectAgentsDir: null });
});

afterEach(async () => {
	vi.restoreAllMocks();
	for (const manager of managers.splice(0)) await manager.dispose({ timeoutMs: 1000 });
	AgentLifecycleManager.resetGlobalForTests();
	AgentRegistry.resetGlobalForTests();
	resetTreeSpawnSemaphoresForTests();
	resetSessionCpuLimitsForTests();
	await removeCgroupRoots();
});

/** Record every spawn that reaches its agent run; a cancelled spawn never should. */
function recordRuns(): string[] {
	const ran: string[] = [];
	vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
		ran.push(options.id ?? "?");
		throw new Error("a cancelled spawn never runs its agent");
	});
	return ran;
}

describe("a background spawn and its session tree's spawn slot", () => {
	it("queues behind a slot another spawner in the tree holds, and frees none when cancelled there", async () => {
		const semaphore = await treeSemaphore();
		await semaphore.acquire();
		const ran = recordRuns();
		const manager = createManager();

		await createScheduler().runInBackground(callFor([]), spawnsNamed("Queued"), {
			manager,
			ircEnabled: false,
			advisory: undefined,
		});
		await drainMicrotasks();
		const job = manager.getJob("Queued");
		expect(job?.queued).toBe(true);

		manager.cancel("Queued");
		await job?.promise;

		expect(job?.status).toBe("cancelled");
		expect(ran).toEqual([]);
		// The slot is still the other spawner's: the cancelled spawn returned nothing it did not hold.
		expect(await slotIsFree(semaphore)).toBe(false);
	});

	it("returns the slot it was handed when cancelled in the same tick it was admitted", async () => {
		const semaphore = await treeSemaphore();
		await semaphore.acquire();
		const manager = createManager();
		const ran = recordRuns();

		await createScheduler().runInBackground(callFor([]), spawnsNamed("Raced"), {
			manager,
			ircEnabled: false,
			advisory: undefined,
		});
		const job = manager.getJob("Raced");
		// The release hands the slot to the queued spawn synchronously; the cancel lands before the spawn
		// resumes, so it holds a slot it will never use.
		semaphore.release();
		manager.cancel("Raced");
		await job?.promise;

		expect(job?.status).toBe("cancelled");
		expect(ran).toEqual([]);
		expect(await slotIsFree(semaphore)).toBe(true);
	});

	it("settles the cancelled spawn's row so the batch converges once its sibling finishes", async () => {
		const semaphore = await treeSemaphore();
		await semaphore.acquire();
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => ({
			index: 0,
			id: options.id ?? "?",
			agent: options.agent.name,
			agentSource: "bundled",
			task: "task prompt",
			assignment: "Do the thing.",
			exitCode: 0,
			output: `${options.id} output.`,
			stderr: "",
			truncated: false,
			durationMs: 5,
			tokens: 0,
			requests: 1,
		}));
		const manager = createManager();
		const updates: TaskToolDetails[] = [];

		await createScheduler().runInBackground(callFor(updates), spawnsNamed("Cancelled", "Survivor"), {
			manager,
			ircEnabled: false,
			advisory: undefined,
		});
		manager.cancel("Cancelled");
		await manager.getJob("Cancelled")?.promise;
		semaphore.release();
		await manager.getJob("Survivor")?.promise;

		expect(manager.getJob("Survivor")?.status).toBe("completed");
		const last = updates.at(-1);
		expect(rowOf(last, "Cancelled")?.status).toBe("aborted");
		expect(rowOf(last, "Survivor")?.status).toBe("completed");
		// Both jobs have ended, so the background half no longer reads "running"; the cancelled one counts
		// as a spawn that did not complete.
		expect(last?.async?.state).toBe("failed");
	});

	it("fails a call none of whose spawns could be registered, with each spawn's reason", async () => {
		const manager = createManager();
		await manager.dispose({ timeoutMs: 1000 });

		const result = await createScheduler().runInBackground(callFor([]), spawnsNamed("One", "Two"), {
			manager,
			ircEnabled: false,
			advisory: undefined,
		});

		const text = result.content.find(part => part.type === "text")?.text ?? "";
		expect(result.isError).toBe(true);
		expect(text).toContain("Failed to start background task jobs");
		expect(text).toContain("One: Async job manager is disposed");
		expect(text).toContain("Two: Async job manager is disposed");
		expect(result.details?.results).toEqual([]);
	});
});
