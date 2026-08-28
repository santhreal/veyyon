/**
 * Two top-level conversations in one process, each with its own driving agent.
 *
 * WHY IT EXISTS. `#refs` is keyed by id and every interactive top-level session
 * registered under the one constant `"Main"`, so a second conversation did not
 * appear beside the first: it OVERWROTE it. `/new` on a streaming turn hands
 * the running conversation to the background and attaches the screen to a fresh
 * one, and the moment the fresh one registered, the running one was gone from
 * every roster while still spending. Worse than invisible: the evicted session
 * went on reporting under the same key, so its `agent_end` flipped the
 * FOREGROUND row to idle mid-turn and its `noteTurn` refreshed the wrong row's
 * clock. The operator watched a session that was not the one running.
 *
 * THE CLASS. Any surface that identifies "the driving agent" by comparing an id
 * against one process-wide name. A name cannot pick out one of two, so each such
 * comparison is the same defect wearing a different hat: the roster puts the
 * wrong row first, `irc` delivers to the wrong conversation's session, adoption
 * parks a driving agent, and a parent chain terminates in the wrong place. The
 * fix is one rule applied everywhere — a driving agent is recognized by its ROLE
 * (`kind === "main"`), and the name it answers to is resolved against the
 * conversation that WROTE it. These tests sweep the consumers rather than pin
 * the `/new` incident, so a new consumer that reintroduces a name comparison has
 * a test here that already covers its behavior.
 *
 * WHAT IT DOES NOT CATCH. Reaching a conversation in ANOTHER PROCESS: identity
 * here is process-local, and a second terminal's session is not in this
 * registry at all. It also does not prove the dashboard SHOWS a background
 * conversation — the roster is still scope-filtered by construction, which is a
 * separate surface change; what is proven here is that the row survives to be
 * shown. And it cannot see a consumer that reads `AgentRef.id` and parses it as
 * a string instead of asking for the role.
 */
import { beforeEach, describe, expect, test, vi } from "bun:test";
import { collectLiveAgents, MAIN_CALL_SIGN } from "@veyyon/coding-agent/modes/components/agent-activity";
import { AgentLifecycleManager } from "@veyyon/coding-agent/registry/agent-lifecycle";
import {
	type AgentRef,
	AgentRegistry,
	MAIN_AGENT_ID,
	mainAgentIdFor,
} from "@veyyon/coding-agent/registry/agent-registry";
import * as logger from "@veyyon/utils/logger";

const CONVERSATION_A = "session-a";
const CONVERSATION_B = "session-b";

let registry: AgentRegistry;

beforeEach(() => {
	AgentRegistry.resetGlobalForTests();
	registry = AgentRegistry.global();
});

/** Register a driving agent the way a top-level session does. */
function driver(conversationId: string): AgentRef {
	return registry.register({
		id: mainAgentIdFor(conversationId),
		displayName: "main",
		kind: "main",
		session: null,
		sessionFile: `/transcripts/${conversationId}.jsonl`,
		scope: conversationId,
	});
}

/** Register a subagent owned by `parentId` inside `conversationId`. */
function subagent(id: string, parentId: string, conversationId: string): AgentRef {
	return registry.register({
		id,
		displayName: "sub",
		kind: "sub",
		parentId,
		session: null,
		sessionFile: `/transcripts/${conversationId}/${id}.jsonl`,
		scope: conversationId,
	});
}

function ids(refs: readonly AgentRef[]): string[] {
	return refs.map(ref => ref.id);
}

describe("Both conversations survive registration", () => {
	/**
	 * The eviction itself. Two driving agents registered in one process are two
	 * rows, not one. This is the assertion the shipped defect failed: the probe
	 * that found it saw a single ref carrying the SECOND conversation's file.
	 */
	test("a second conversation does not evict the first", () => {
		driver(CONVERSATION_A);
		driver(CONVERSATION_B);

		expect(ids(registry.list()).sort()).toEqual([mainAgentIdFor(CONVERSATION_A), mainAgentIdFor(CONVERSATION_B)]);
		expect(registry.get(mainAgentIdFor(CONVERSATION_A))?.sessionFile).toBe(`/transcripts/${CONVERSATION_A}.jsonl`);
		expect(registry.get(mainAgentIdFor(CONVERSATION_B))?.sessionFile).toBe(`/transcripts/${CONVERSATION_B}.jsonl`);
	});

	/**
	 * The tripwire under the id rule, so the class stays closed if a future host
	 * mints a colliding id anyway. An id is the key, so a collision is data loss
	 * — the displaced agent keeps running and reporting through a row that is no
	 * longer its own — and the shipped defect was exactly that, silent. Reported
	 * rather than refused: dropping the new ref would leave a live agent with no
	 * row, which is the worse of the two failures.
	 */
	test("reusing an id for a different agent is reported", () => {
		const reported: unknown[] = [];
		const spy = vi.spyOn(logger, "error").mockImplementation((...args: unknown[]) => {
			reported.push(args);
		});

		driver(CONVERSATION_A);
		registry.register({
			id: mainAgentIdFor(CONVERSATION_A),
			displayName: "main",
			kind: "main",
			session: null,
			sessionFile: "/transcripts/someone-else.jsonl",
			scope: CONVERSATION_A,
		});

		expect(reported).toHaveLength(1);
		spy.mockRestore();
	});

	/**
	 * The same agent re-registering is the ordinary case — a revive re-attaches
	 * its own row — and must stay silent, or the tripwire above is noise nobody
	 * reads by the time a real collision happens.
	 */
	test("an agent re-registering its own row is silent", () => {
		const reported: unknown[] = [];
		const spy = vi.spyOn(logger, "error").mockImplementation((...args: unknown[]) => {
			reported.push(args);
		});

		driver(CONVERSATION_A);
		driver(CONVERSATION_A);

		expect(reported).toEqual([]);
		spy.mockRestore();
	});

	/**
	 * The status corruption, which is the half an operator actually saw. A
	 * background conversation finishing its turn must not mark the foreground
	 * one idle. Under the shipped defect both writes landed on the same row.
	 */
	test("a background conversation's status does not touch the foreground row", () => {
		driver(CONVERSATION_A);
		driver(CONVERSATION_B);
		registry.setStatus(mainAgentIdFor(CONVERSATION_A), "running");
		registry.setStatus(mainAgentIdFor(CONVERSATION_B), "running");

		registry.setStatus(mainAgentIdFor(CONVERSATION_A), "idle");

		expect(registry.get(mainAgentIdFor(CONVERSATION_A))?.status).toBe("idle");
		expect(registry.get(mainAgentIdFor(CONVERSATION_B))?.status).toBe("running");
	});

	/** The same separation for the activity clock every roster sorts and ages by. */
	test("a background conversation's turn does not refresh the foreground clock", () => {
		const a = driver(CONVERSATION_A);
		const b = driver(CONVERSATION_B);
		const beforeB = b.lastActivity;

		registry.noteTurn(a.id);

		expect(registry.get(a.id)?.lastActivity).toBeGreaterThanOrEqual(beforeB);
		expect(registry.get(b.id)?.lastActivity).toBe(beforeB);
	});

	/** An id derived from the conversation is unique exactly when the conversation is. */
	test("driving-agent ids are distinct per conversation and stable per call", () => {
		expect(mainAgentIdFor(CONVERSATION_A)).not.toBe(mainAgentIdFor(CONVERSATION_B));
		expect(mainAgentIdFor(CONVERSATION_A)).toBe(mainAgentIdFor(CONVERSATION_A));
	});
});

describe("The name resolves inside the conversation that wrote it", () => {
	/**
	 * `Main` is what the model is told to address and what it writes. With two
	 * driving agents live it names a ROLE, so the answer depends on who is
	 * asking. A resolver that returned one fixed ref would deliver a message
	 * written in one conversation into the other one's session.
	 */
	test("the alias resolves to the asking conversation's own driver", () => {
		driver(CONVERSATION_A);
		driver(CONVERSATION_B);

		expect(registry.resolveId(MAIN_AGENT_ID, CONVERSATION_A)?.id).toBe(mainAgentIdFor(CONVERSATION_A));
		expect(registry.resolveId(MAIN_AGENT_ID, CONVERSATION_B)?.id).toBe(mainAgentIdFor(CONVERSATION_B));
	});

	/**
	 * A subagent writes the alias too, and it must reach ITS conversation's
	 * driver. This is the routing case: `SubB` answering `Main` from
	 * conversation B must not wake conversation A's session.
	 */
	test("a subagent's alias reaches its own conversation's driver", () => {
		driver(CONVERSATION_A);
		const b = driver(CONVERSATION_B);
		subagent("Worker", b.id, CONVERSATION_B);

		const scope = registry.scopeOf("Worker");

		expect(registry.resolveId(MAIN_AGENT_ID, scope)?.id).toBe(b.id);
	});

	/**
	 * An exact id outranks the alias, so a host that legitimately names its root
	 * `Main` — which is still legal, and which several embedded hosts do —
	 * resolves to itself rather than being re-routed by role.
	 */
	test("an exact id wins over the alias", () => {
		registry.register({
			id: MAIN_AGENT_ID,
			displayName: "main",
			kind: "main",
			session: null,
			sessionFile: "/transcripts/legacy.jsonl",
			scope: CONVERSATION_A,
		});
		driver(CONVERSATION_B);

		expect(registry.resolveId(MAIN_AGENT_ID, CONVERSATION_B)?.sessionFile).toBe("/transcripts/legacy.jsonl");
	});

	/**
	 * A name that resolves to nothing stays unresolved rather than falling back
	 * to any driver in the process. Silently redirecting an unknown peer into
	 * the nearest conversation is how a message reaches a stranger.
	 */
	test("an unknown name resolves to nothing", () => {
		driver(CONVERSATION_A);

		expect(registry.resolveId("Nobody", CONVERSATION_A)).toBeUndefined();
	});

	/** A conversation with no registered driver has no driver, not someone else's. */
	test("the alias resolves to nothing in a conversation with no driver", () => {
		driver(CONVERSATION_A);

		expect(registry.resolveId(MAIN_AGENT_ID, "session-unrelated")).toBeUndefined();
		expect(registry.mainInScope("session-unrelated")).toBeUndefined();
	});

	/**
	 * A driving agent that outlived its teardown must not shadow the live one.
	 * Newest wins, because a roster pointing at a dead predecessor is worse than
	 * one pointing at the session actually answering.
	 */
	test("the newest driver wins when a stale one shares the conversation", () => {
		const stale = registry.register({
			id: "main:stale",
			displayName: "main",
			kind: "main",
			session: null,
			sessionFile: "/transcripts/stale.jsonl",
			scope: CONVERSATION_A,
		});
		const live = driver(CONVERSATION_A);

		expect(live.createdAt).toBeGreaterThanOrEqual(stale.createdAt);
		expect(registry.mainInScope(CONVERSATION_A)?.id).toBe(live.id);
	});
});

describe("Consumers identify the driver by role", () => {
	/**
	 * The roster used to put the row whose id was literally `Main` first. With a
	 * derived id that comparison never matches, so an unfixed consumer sorts the
	 * driving agent among its own subagents and hands it a subagent call sign.
	 *
	 * The subagents are registered BEFORE the driver on purpose. Registration
	 * order is the tie-break, so a fixture that registers the driver first is
	 * sorted correctly by a consumer that lost the rule entirely, and cannot see
	 * the defect. This order happens for real: a roster seeds the subagents it
	 * finds on disk, and a conversation adopted from the background registers its
	 * driver after them.
	 */
	test("a driving agent sorts first and keeps the main call sign", () => {
		const driverId = mainAgentIdFor(CONVERSATION_A);
		subagent("Early", driverId, CONVERSATION_A);
		subagent("Late", driverId, CONVERSATION_A);
		const a = driver(CONVERSATION_A);

		const roster = collectLiveAgents(registry.listInScope(CONVERSATION_A));

		expect(roster[0]?.id).toBe(a.id);
		expect(roster[0]?.callSign).toBe(MAIN_CALL_SIGN);
		expect(roster.filter(row => row.callSign === MAIN_CALL_SIGN)).toHaveLength(1);
	});

	/** Each conversation's roster names its own driver, and only its own. */
	test("each conversation's roster holds exactly one driver", () => {
		const a = driver(CONVERSATION_A);
		const b = driver(CONVERSATION_B);
		subagent("WorkerA", a.id, CONVERSATION_A);
		subagent("WorkerB", b.id, CONVERSATION_B);

		expect(ids(registry.listInScope(CONVERSATION_A)).sort()).toEqual([a.id, "WorkerA"].sort());
		expect(ids(registry.listInScope(CONVERSATION_B)).sort()).toEqual([b.id, "WorkerB"].sort());
	});

	/**
	 * Adoption arms a park-then-close timer, which is meaningless for a session
	 * the operator is typing into and destructive for one running in the
	 * background: parking releases the session. Refused by role, so BOTH drivers
	 * are refused rather than only the one that answers to the old name.
	 */
	test("neither conversation's driver can be adopted", () => {
		const a = driver(CONVERSATION_A);
		const b = driver(CONVERSATION_B);
		const lifecycle = new AgentLifecycleManager(registry);

		lifecycle.adopt(a.id, { idleTtlMs: 1, closeParkedMs: 1, closeWaitingMs: 1, revive: undefined });
		lifecycle.adopt(b.id, { idleTtlMs: 1, closeParkedMs: 1, closeWaitingMs: 1, revive: undefined });

		expect(lifecycle.has(a.id)).toBe(false);
		expect(lifecycle.has(b.id)).toBe(false);
		lifecycle.dispose();
	});

	/** A real subagent is still adoptable: the refusal is about the role, not about being registered. */
	test("a subagent is still adopted", () => {
		const a = driver(CONVERSATION_A);
		subagent("Worker", a.id, CONVERSATION_A);
		const lifecycle = new AgentLifecycleManager(registry);

		lifecycle.adopt("Worker", { idleTtlMs: 60_000, closeParkedMs: 0, closeWaitingMs: 0, revive: undefined });

		expect(lifecycle.has("Worker")).toBe(true);
		lifecycle.dispose();
	});
});
