/**
 * Leaving a conversation stops the agents it spawned, not only unregisters them.
 *
 * WHY THIS SUITE EXISTS: `/new`, `/resume` and a handoff re-root the session in the agent registry
 * and let go of the previous conversation's spawn tree. That let-go was `release`, which disposes
 * the agent's session. Dispose stops the agent loop but leaves the agent's bash, eval, handoff and
 * advisor work running and its scheduled continuations armed, so a subagent in the middle of a turn
 * kept working for a conversation nobody could see any more. The let-go is now `terminate`: abort a
 * running agent, then release it, deepest generation first.
 *
 * The class is "a status whose agent is not stopped when its conversation ends". The status sweep
 * reads `AGENT_STATUSES`, so a new status fails here until it states whether it is aborted.
 *
 * Not caught: an agent whose own abort ignores its signal (the rescope waits as long as that abort,
 * the same wait the session's own abort imposes at the start of `/new`), and a spawned agent that
 * a subagent registered under a parent id this session does not own.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@veyyon/agent-core";
import { AuthStorage } from "@veyyon/ai/auth-storage";
import { getBundledModel } from "@veyyon/catalog/models";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { AgentLifecycleManager } from "@veyyon/coding-agent/registry/agent-lifecycle";
import { AGENT_STATUSES, AgentRegistry, type AgentStatus } from "@veyyon/coding-agent/registry/agent-registry";
import { AgentSession, RESCOPE_TERMINATE_REASON } from "@veyyon/coding-agent/session/agent-session";
import { SessionManager } from "@veyyon/kernel/session/session-manager";
import { TempDir } from "@veyyon/utils";

/** What each spawned agent was asked to do, in the order it was asked. */
type Call = `abort:${string}:${string}` | `dispose:${string}`;

/** A spawned agent's session, reduced to the two calls the lifecycle makes on it. */
function spawnedSession(id: string, calls: Call[], abortError?: Error): AgentSession {
	return {
		abort: async (options?: { reason?: string }) => {
			calls.push(`abort:${id}:${options?.reason ?? ""}`);
			if (abortError) throw abortError;
		},
		dispose: async () => {
			calls.push(`dispose:${id}`);
		},
	} as unknown as AgentSession;
}

describe("leaving a conversation", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession;
	let calls: Call[];

	function registerSpawned(id: string, parentId: string, status: AgentStatus, abortError?: Error): void {
		AgentRegistry.global().register({
			id,
			displayName: id,
			kind: "sub",
			parentId,
			status,
			session: spawnedSession(id, calls, abortError),
		});
	}

	beforeEach(async () => {
		AgentRegistry.resetGlobalForTests();
		// The lifecycle manager binds the registry it was built with, so it is reset after it.
		AgentLifecycleManager.resetGlobalForTests();
		calls = [];
		tempDir = TempDir.createSync("veyyon-leaving-a-conversation-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected built-in anthropic model to exist");
		session = new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } }),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry: new ModelRegistry(authStorage),
			agentId: "Main",
		});
		AgentRegistry.global().register({ id: "Main", displayName: "main", kind: "main", session });
	});

	afterEach(async () => {
		await session.dispose();
		authStorage.close();
		try {
			await tempDir.remove();
		} catch {}
		AgentLifecycleManager.resetGlobalForTests();
		AgentRegistry.resetGlobalForTests();
		vi.restoreAllMocks();
	});

	/**
	 * One case per status, enumerated from the registry's own list. Only a running agent has a turn
	 * to abort; every status is released and leaves the registry.
	 */
	for (const status of AGENT_STATUSES) {
		it(`stops a spawned agent whose status is ${status} and removes it from the registry`, async () => {
			registerSpawned("0-Worker", "Main", status);

			expect(await session.newSession()).toBe(true);

			const expected: Call[] =
				status === "running"
					? [`abort:0-Worker:${RESCOPE_TERMINATE_REASON}`, "dispose:0-Worker"]
					: ["dispose:0-Worker"];
			expect(calls).toEqual(expected);
			expect(AgentRegistry.global().get("0-Worker")).toBeUndefined();
		});
	}

	/**
	 * Depth, and the order within it. A grandchild is aborted and released before its parent, and
	 * each agent is aborted before it is disposed: a parent disposed first would leave its running
	 * child with nobody to receive the result.
	 */
	it("stops every generation, deepest first, aborting each before disposing it", async () => {
		registerSpawned("0-Worker", "Main", "running");
		registerSpawned("0-Worker.0-Helper", "0-Worker", "running");

		await session.newSession();

		expect(calls).toEqual([
			`abort:0-Worker.0-Helper:${RESCOPE_TERMINATE_REASON}`,
			"dispose:0-Worker.0-Helper",
			`abort:0-Worker:${RESCOPE_TERMINATE_REASON}`,
			"dispose:0-Worker",
		]);
		expect(AgentRegistry.global().descendantsOf("Main")).toEqual([]);
	});

	/** Down the tree only: an agent this session did not spawn keeps running. */
	it("leaves an agent outside this session's spawn tree running", async () => {
		AgentRegistry.global().register({
			id: "Other",
			displayName: "other",
			kind: "main",
			session: spawnedSession("Other", calls),
		});
		registerSpawned("0-Stranger", "Other", "running");

		await session.newSession();

		expect(calls).toEqual([]);
		expect(AgentRegistry.global().get("0-Stranger")?.status).toBe("running");
	});

	/**
	 * An agent that cannot be aborted does not strand the session between two conversations: the
	 * switch completes, the session is re-rooted, and a sibling is still stopped.
	 */
	it("finishes the switch when one spawned agent's abort throws", async () => {
		registerSpawned("0-Stuck", "Main", "running", new Error("provider request would not stop"));
		registerSpawned("1-Worker", "Main", "running");
		const scopeBefore = AgentRegistry.global().get("Main")?.scope;

		expect(await session.newSession()).toBe(true);

		expect(calls).toContain(`abort:0-Stuck:${RESCOPE_TERMINATE_REASON}`);
		expect(calls).not.toContain("dispose:0-Stuck");
		expect(calls).toEqual(expect.arrayContaining([`abort:1-Worker:${RESCOPE_TERMINATE_REASON}`, "dispose:1-Worker"]));
		expect(AgentRegistry.global().get("Main")?.scope).not.toBe(scopeBefore);
	});
});
