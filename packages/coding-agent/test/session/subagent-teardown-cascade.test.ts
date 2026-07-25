/**
 * Tearing a session down must not leave a spawned agent's background work running.
 *
 * WHY THIS SUITE EXISTS: teardown cancelled the jobs whose `ownerId` matched the
 * session's own agent id and stopped there. A subagent that had itself delegated
 * therefore left a GRANDCHILD job running after the session that could receive its
 * result was disposed: it kept spending, and its delivery address no longer existed
 * (BACKLOG SUB-2, "parent abort must terminate all children"). One level of
 * cancellation looks correct in every single-depth test, which is why this suite is
 * about depth.
 *
 * The other half of the contract is just as important and is asserted in the same
 * cases: teardown reaches DOWN the spawn tree only. An unrelated agent's job, and a
 * job belonging to a sibling, must survive — a session reaching up or sideways is
 * issue #1923, where a secondary in-process session tore down the primary's work.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@veyyon/agent-core";
import { getBundledModel } from "@veyyon/catalog/models";
import { AsyncJobManager } from "@veyyon/coding-agent/async";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { AgentRegistry } from "@veyyon/coding-agent/registry/agent-registry";
import { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import { AuthStorage } from "@veyyon/coding-agent/session/auth-storage";
import { SessionManager } from "@veyyon/coding-agent/session/session-manager";
import { TempDir } from "@veyyon/utils";

describe("subagent teardown cascade", () => {
	let tempDir: TempDir;
	let session: AgentSession;
	let sessionManager: SessionManager;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let manager: AsyncJobManager;

	/**
	 * A job that runs until its own abort signal fires, so "cancelled" is observed
	 * rather than raced against a body that would have finished anyway.
	 */
	function registerHeldJob(ownerId: string): string {
		return manager.register(
			"bash",
			`held job owned by ${ownerId}`,
			async ({ signal }) =>
				await new Promise<string>(resolve => {
					signal.addEventListener("abort", () => resolve("cancelled"), { once: true });
				}),
			{ ownerId },
		);
	}

	/** Register an agent ref carrying only what the spawn-tree walk reads. */
	function registerAgent(id: string, parentId?: string): void {
		AgentRegistry.global().register({
			id,
			displayName: id,
			kind: parentId ? "sub" : "main",
			parentId,
			session: null,
		});
	}

	beforeEach(async () => {
		AgentRegistry.resetGlobalForTests();
		tempDir = TempDir.createSync("veyyon-subagent-teardown-cascade-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		modelRegistry = new ModelRegistry(authStorage);
		sessionManager = SessionManager.create(tempDir.path(), tempDir.path());
		manager = new AsyncJobManager({ onJobComplete: async () => {} });

		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected built-in anthropic model to exist");

		session = new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } }),
			sessionManager,
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry,
			agentId: "Main",
			asyncJobManager: manager,
		});
	});

	afterEach(async () => {
		manager.cancelAll();
		await manager.dispose();
		authStorage.close();
		try {
			await tempDir.remove();
		} catch {}
		AgentRegistry.resetGlobalForTests();
		vi.restoreAllMocks();
	});

	/**
	 * The defect, at the depth where it lived: the grandchild is the orphan. `worker`
	 * was reached because its job was cancelled along with the session's own; `helper`
	 * was not, and it was the one still running.
	 */
	it("cancels a grandchild subagent's job when the parent session is disposed", async () => {
		registerAgent("Main");
		registerAgent("worker", "Main");
		registerAgent("helper", "worker");

		const own = registerHeldJob("Main");
		const child = registerHeldJob("worker");
		const grandchild = registerHeldJob("helper");

		await session.dispose();

		expect(manager.getJob(own)?.status).toBe("cancelled");
		expect(manager.getJob(child)?.status).toBe("cancelled");
		expect(manager.getJob(grandchild)?.status).toBe("cancelled");
	});

	/** Depth is not capped: a fourth-generation agent is torn down too. */
	it("reaches every generation, not just two", async () => {
		registerAgent("Main");
		registerAgent("worker", "Main");
		registerAgent("helper", "worker");
		registerAgent("deep-helper", "helper");

		const deep = registerHeldJob("deep-helper");
		await session.dispose();

		expect(manager.getJob(deep)?.status).toBe("cancelled");
	});

	/**
	 * Down the tree ONLY. An agent that this session did not spawn keeps running:
	 * cancelling it would be the issue #1923 failure in a new place, where one
	 * session's teardown kills another's background work.
	 */
	it("leaves an unrelated agent's job running", async () => {
		registerAgent("Main");
		registerAgent("Other");
		registerAgent("other-worker", "Other");

		const unrelated = registerHeldJob("Other");
		const unrelatedChild = registerHeldJob("other-worker");

		await session.dispose();

		expect(manager.getJob(unrelated)?.status).toBe("running");
		expect(manager.getJob(unrelatedChild)?.status).toBe("running");
	});

	/**
	 * A subagent tearing itself down cleans up what IT spawned and nothing above it.
	 * This is the case that keeps the scoping honest: the parent's job and the
	 * sibling's job both survive.
	 */
	it("a subagent's own teardown cancels its child but not its parent or sibling", async () => {
		registerAgent("Main");
		registerAgent("worker", "Main");
		registerAgent("sibling", "Main");
		registerAgent("helper", "worker");

		const parentJob = registerHeldJob("Main");
		const siblingJob = registerHeldJob("sibling");
		const ownJob = registerHeldJob("worker");
		const childJob = registerHeldJob("helper");

		const subagent = new AgentSession({
			agent: new Agent({
				initialState: {
					model: getBundledModel("anthropic", "claude-sonnet-4-5")!,
					systemPrompt: ["Test"],
					tools: [],
					messages: [],
				},
			}),
			sessionManager,
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry,
			agentId: "worker",
			asyncJobManager: manager,
		});
		await subagent.dispose();

		expect(manager.getJob(ownJob)?.status).toBe("cancelled");
		expect(manager.getJob(childJob)?.status).toBe("cancelled");
		expect(manager.getJob(parentJob)?.status).toBe("running");
		expect(manager.getJob(siblingJob)?.status).toBe("running");
	});

	/**
	 * A spawned agent that has already been released from the registry cannot be
	 * found by the walk, and teardown must still complete rather than throw on the
	 * gap. Its job is left running, which is the honest outcome: nothing records that
	 * it belonged to this tree any more.
	 */
	it("disposes cleanly when a spawned agent has already been unregistered", async () => {
		registerAgent("Main");
		registerAgent("worker", "Main");
		registerAgent("helper", "worker");
		const orphaned = registerHeldJob("helper");
		AgentRegistry.global().unregister("worker");

		await session.dispose();

		expect(manager.getJob(orphaned)?.status).toBe("running");
	});
});
