/**
 * An agent row names the model it is running and the conversation it is in.
 *
 * WHY THIS SUITE EXISTS. `AgentRef` is written once, by `register`, and the
 * driving session was wired to nothing after that: `task/executor.ts` reports a
 * subagent's status and activity, `persisted-revive.ts` reports a revived one's,
 * and no caller reported the main agent's. So its Agent Control Center row was
 * frozen at process start — it named the model the process booted on however
 * many times the operator had switched since, and its age counted from the
 * process rather than from the work. A session a day old, mid-turn, on a model
 * chosen an hour ago, rendered as `Main running 1d ago claude-opus-4-6` while
 * the status line named the model actually answering.
 *
 * THE CLASS. Not "the main agent": any ref whose recorded field has drifted from
 * the live session behind it, and any clock carried across a conversation
 * boundary. The model is fixed by reading the session instead of the record, so
 * there is no update path left to forget on a new switch path — every one of
 * `setModel`, `setModelTemporary`, `cycleModel`, the retry fallback and the
 * overflow promotion is covered by construction rather than by a call site.
 *
 * WHAT IT DOES NOT CATCH. The dashboard's own preference for a subagent's
 * executor-reported selector (`agent-dashboard-model-badge.test.ts` owns that),
 * and the rendering of the age string (`agent-dashboard-age-ticker.test.ts`).
 * This suite is about what the roster row is handed.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { collectLiveAgents } from "../../src/modes/components/dashboard/agent-activity";
import { AgentRegistry, MAIN_AGENT_ID } from "../../src/registry/agent-registry";
import type { AgentSession } from "../../src/session/agent-session";

/** A session stands in for the live model read; nothing else on it is touched. */
function sessionOn(provider: string, id: string): AgentSession {
	return { model: { provider, id } } as unknown as AgentSession;
}

function rowFor(registry: AgentRegistry, id: string) {
	const row = collectLiveAgents(registry.list()).find(agent => agent.id === id);
	if (!row) throw new Error(`no roster row for ${id}`);
	return row;
}

describe("a roster row tracks the live model and the current conversation", () => {
	let registry: AgentRegistry;

	beforeEach(() => {
		AgentRegistry.resetGlobalForTests();
		registry = AgentRegistry.global();
	});

	afterEach(() => {
		AgentRegistry.resetGlobalForTests();
	});

	test("the row names the model the session switched to, not the one it registered with", () => {
		registry.register({
			id: MAIN_AGENT_ID,
			displayName: "main",
			kind: "main",
			session: null,
			scope: "conversation-a",
			model: "anthropic/claude-opus-4-6",
		});
		// The session lands after registration (sdk.ts attaches it), and by the time
		// anyone opens the roster the operator has switched models in it.
		registry.attachSession(MAIN_AGENT_ID, sessionOn("zai", "glm-5.2"), null);

		expect(rowFor(registry, MAIN_AGENT_ID).model).toBe("zai/glm-5.2");
	});

	test("a parked agent with no session keeps the model recorded at registration", () => {
		// The recorded value is not dead weight: a parked ref has no session to ask,
		// and dropping it would blank the column for exactly the agents an operator
		// opens the roster to find.
		registry.register({
			id: "Kestrel",
			displayName: "task",
			kind: "sub",
			session: null,
			status: "parked",
			model: "google/gemini-3.7-flash",
		});

		expect(rowFor(registry, "Kestrel").model).toBe("google/gemini-3.7-flash");
	});

	test("re-rooting into a new conversation restarts the row's clock", async () => {
		registry.register({
			id: MAIN_AGENT_ID,
			displayName: "main",
			kind: "main",
			session: null,
			scope: "conversation-a",
		});
		const before = rowFor(registry, MAIN_AGENT_ID);

		await Bun.sleep(5);
		registry.rescope(MAIN_AGENT_ID, "conversation-b");
		const after = rowFor(registry, MAIN_AGENT_ID);

		expect({
			createdAdvanced: after.createdAt > before.createdAt,
			activityAdvanced: after.lastActivity > before.lastActivity,
		}).toEqual({ createdAdvanced: true, activityAdvanced: true });
	});

	test("a rescope to the same conversation leaves the clock alone", async () => {
		// `/move` rewrites a path without ending the conversation, and the scope it
		// resolves to is the one already recorded. Restarting the clock there would
		// report a day-old session as new.
		registry.register({
			id: MAIN_AGENT_ID,
			displayName: "main",
			kind: "main",
			session: null,
			scope: "conversation-a",
		});
		const before = rowFor(registry, MAIN_AGENT_ID);

		await Bun.sleep(5);
		registry.rescope(MAIN_AGENT_ID, "conversation-a");

		expect(rowFor(registry, MAIN_AGENT_ID).createdAt).toBe(before.createdAt);
	});

	test("a turn advances the row's age without touching status, activity or listeners", async () => {
		registry.register({
			id: MAIN_AGENT_ID,
			displayName: "main",
			kind: "main",
			session: null,
			status: "running",
		});
		registry.setActivity(MAIN_AGENT_ID, "reading agent-loop.ts");
		const before = rowFor(registry, MAIN_AGENT_ID);
		let events = 0;
		registry.onChange(() => {
			events += 1;
		});

		await Bun.sleep(5);
		registry.noteTurn(MAIN_AGENT_ID);
		const after = rowFor(registry, MAIN_AGENT_ID);

		expect({
			advanced: after.lastActivity > before.lastActivity,
			status: after.status,
			activity: after.activity,
			events,
		}).toEqual({
			advanced: true,
			status: "running",
			activity: "reading agent-loop.ts",
			events: 0,
		});
	});

	test("noting a turn for an agent that is gone is a no-op, not a throw", () => {
		// The driving session's subscription outlives an unregister on teardown.
		expect(() => registry.noteTurn("NoSuchAgent")).not.toThrow();
	});
});
