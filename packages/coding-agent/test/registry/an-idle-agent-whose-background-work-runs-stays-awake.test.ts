/**
 * WHY: a spawned agent falls asleep once it has been idle for `agent.idleTtlMs`, and falling asleep
 * disposes its session. Disposing a spawned agent's session cancels every background job it, or an
 * agent it spawned, started (`OwnedAsyncJobs.cancelOwn`). An agent that backgrounded a long command
 * (`backgroundAfter`) or launched a process and then finished its turn was idle while that work ran,
 * so the idle timer put it to sleep and cancelled the command, or the watch on the process, before
 * its result reached the conversation waiting for it.
 *
 * The class this closes is the idle timer ending background work. For every job kind, owned by the
 * agent, its child or its grandchild, the agent stays awake and the job keeps running for as long as
 * the job runs, and the agent falls asleep once the work ends. A job owned by an agent outside the
 * subtree does not keep the agent awake and survives its sleep, and an explicit stop still cancels
 * the subtree's work.
 *
 * What it does not catch: work that is not a job on the agent's job manager, such as the turn of a
 * child woken by a message. A sleep does not cancel that work either.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Agent } from "@veyyon/agent-core";
import { AuthStorage } from "@veyyon/ai/auth-storage";
import { createMockModel } from "@veyyon/ai/providers/mock";
import { getBundledModel } from "@veyyon/catalog/models";
import { AsyncJobManager, type AsyncJobType, JOB_ENDS_ON_ITS_OWN } from "@veyyon/coding-agent/async";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { AgentLifecycleManager } from "@veyyon/coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@veyyon/coding-agent/registry/agent-registry";
import { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import { SessionManager } from "@veyyon/kernel/session/session-manager";
import { TempDir } from "@veyyon/utils";

const TTL = 50;
const WORKER = "Worker";
const JOB_KINDS = Object.keys(JOB_ENDS_ON_ITS_OWN) as AsyncJobType[];
/** Where the job's owner sits relative to the agent whose idle timer expires. */
const OWNERS = [
	{ name: "the agent", id: WORKER },
	{ name: "its child", id: "Child" },
	{ name: "its grandchild", id: "Grandchild" },
];

/** Wait for `predicate`, failing after `ms`. */
async function until(predicate: () => boolean, ms = 2_000): Promise<void> {
	const deadline = Date.now() + ms;
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error("condition not reached");
		await delay(5);
	}
}

describe("an idle agent whose background work runs stays awake", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let registry: AgentRegistry;
	let lifecycle: AgentLifecycleManager;
	let manager: AsyncJobManager;
	let session: AgentSession;
	const gates: Array<() => void> = [];

	beforeEach(async () => {
		AgentRegistry.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();
		registry = AgentRegistry.global();
		lifecycle = AgentLifecycleManager.global();
		tempDir = TempDir.createSync("@veyyon-idle-work-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		manager = new AsyncJobManager({ onJobComplete: () => {} });
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("claude-sonnet-4-5 is missing from the bundled catalog");
		const mock = createMockModel({ handler: async () => ({ content: ["ok"] }) });
		session = new AgentSession({
			agent: new Agent({
				getApiKey: () => "test-key",
				initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
				streamFn: mock.stream,
			}),
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated(),
			modelRegistry: new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml")),
			agentId: WORKER,
			asyncJobManager: manager,
		});
		registry.register({ id: WORKER, displayName: "task", kind: "sub", session, sessionFile: null, status: "idle" });
		registry.register({
			id: "Child",
			displayName: "task",
			kind: "sub",
			session: null,
			sessionFile: null,
			status: "idle",
			parentId: WORKER,
		});
		registry.register({
			id: "Grandchild",
			displayName: "task",
			kind: "sub",
			session: null,
			sessionFile: null,
			status: "idle",
			parentId: "Child",
		});
		registry.register({
			id: "Stranger",
			displayName: "task",
			kind: "sub",
			session: null,
			sessionFile: null,
			status: "idle",
		});
	});

	afterEach(async () => {
		for (const release of gates.splice(0)) release();
		if (registry.get(WORKER)?.session) await session.dispose();
		await manager.dispose({ timeoutMs: 1_000 });
		AgentLifecycleManager.resetGlobalForTests();
		AgentRegistry.resetGlobalForTests();
		authStorage.close();
		tempDir.removeSync();
	});

	/** Start a job that runs until the returned function ends it or the job is cancelled. */
	function startJob(type: AsyncJobType, ownerId: string): { id: string; finish: () => void } {
		const gate = Promise.withResolvers<void>();
		gates.push(gate.resolve);
		const id = manager.register(
			type,
			`${type} work`,
			async ({ signal }) => {
				const ended = Promise.withResolvers<void>();
				void gate.promise.then(ended.resolve);
				signal.addEventListener("abort", () => ended.resolve(), { once: true });
				await ended.promise;
				return "done";
			},
			{ ownerId },
		);
		return { id, finish: gate.resolve };
	}

	for (const kind of JOB_KINDS) {
		for (const owner of OWNERS) {
			it(`keeps the agent awake while a ${kind} job of ${owner.name} runs, then lets it sleep`, async () => {
				const job = startJob(kind, owner.id);
				lifecycle.adopt(WORKER, { idleTtlMs: TTL });

				await delay(TTL * 4);
				expect(manager.getJob(job.id)?.status).toBe("running");
				expect(registry.get(WORKER)?.status).toBe("idle");
				expect(registry.get(WORKER)?.session).toBe(session);

				job.finish();
				await until(() => manager.getJob(job.id)?.status === "completed");
				await until(() => registry.get(WORKER)?.status === "asleep");
				expect(registry.get(WORKER)?.session).toBeNull();
			});
		}
	}

	it("lets the agent sleep while a job outside its subtree runs, and leaves that job running", async () => {
		const job = startJob("task", "Stranger");
		lifecycle.adopt(WORKER, { idleTtlMs: TTL });

		await until(() => registry.get(WORKER)?.status === "asleep");
		expect(manager.getJob(job.id)?.status).toBe("running");
	});

	it("still cancels the subtree's work when the agent is stopped", async () => {
		const own = startJob("bash", WORKER);
		const child = startJob("task", "Child");
		lifecycle.adopt(WORKER, { idleTtlMs: TTL });

		await lifecycle.stop(WORKER, "stopped by the test");

		expect(registry.get(WORKER)?.status).toBe("asleep");
		expect(manager.getJob(own.id)?.status).toBe("cancelled");
		expect(manager.getJob(child.id)?.status).toBe("cancelled");
	});
});
