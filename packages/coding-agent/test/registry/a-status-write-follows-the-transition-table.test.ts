/**
 * WHY. Seven fixes on the base landed on one mechanism, the agent lifecycle, and
 * none named the invariant: a ref's status may only move along the edges the
 * lifecycle defines. Every writer (executor, lifecycle manager, tan controller,
 * a revived session's turn sync) called `setStatus` with whatever it had in
 * hand, so `aborted → idle` (a late `agent_end` after a kill) and
 * `parked → running` (a turn reported on a ref whose session was released)
 * were silently accepted and the roster showed an agent that did not exist.
 *
 * This suite closes the class at the choke point: `AgentRegistry.setStatus` is
 * the only writer of `AgentRef.status`, and it consults `AGENT_TRANSITIONS`.
 *
 * Variant space is derived at run time from `AGENT_STATUSES`, so a new status
 * turns the suite red until its row is added to the table AND the expected
 * edge set below is updated: the edge set is pinned by exact equality, not by
 * "every listed edge is legal".
 *
 * Not caught here: a caller that reaches a legal status through the wrong
 * sequence of legal edges (e.g. `running → idle → running` where a single
 * `running` was meant). The table constrains edges, not paths.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { AgentLifecycleManager, syncStatusWithTurns } from "@veyyon/coding-agent/registry/agent-lifecycle";
import {
	AGENT_STATUSES,
	AGENT_TRANSITIONS,
	AgentRegistry,
	type AgentStatus,
	AgentTransitionError,
} from "@veyyon/coding-agent/registry/agent-registry";
import type { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import type { AgentSessionEvent } from "@veyyon/coding-agent/session/agent-session-types";

/** Every edge the lifecycle performs, pinned by exact equality. */
const LEGAL_EDGES: ReadonlySet<`${AgentStatus}->${AgentStatus}`> = new Set([
	"running->idle",
	"running->parked",
	"running->aborted",
	"idle->running",
	"idle->parked",
	"idle->aborted",
	"parked->idle",
	"parked->aborted",
]);

function sessionStub(): AgentSession {
	return { sessionManager: { flush: async () => {} }, dispose: async () => {} } as unknown as AgentSession;
}

describe("a status write follows the transition table", () => {
	let registry: AgentRegistry;

	beforeEach(() => {
		AgentRegistry.resetGlobalForTests();
		registry = AgentRegistry.global();
	});
	afterEach(() => {
		AgentRegistry.resetGlobalForTests();
	});

	it("declares exactly the edges the lifecycle performs, for every status", () => {
		const declared = new Set<string>();
		for (const from of AGENT_STATUSES) {
			expect(AGENT_TRANSITIONS[from]).toBeDefined();
			for (const to of AGENT_TRANSITIONS[from]) declared.add(`${from}->${to}`);
		}
		expect([...declared].sort()).toEqual([...LEGAL_EDGES].sort());
	});

	it("accepts each legal edge and rejects each illegal one, sweeping the full status square", () => {
		const events: AgentStatus[] = [];
		registry.onChange(event => {
			if (event.type === "status_changed") events.push(event.ref.status);
		});
		for (const from of AGENT_STATUSES) {
			for (const to of AGENT_STATUSES) {
				const id = `${from}-${to}`;
				registry.register({ id, displayName: id, kind: "sub", session: sessionStub(), status: from });
				events.length = 0;
				if (from === to) {
					registry.setStatus(id, to);
					expect(registry.get(id)?.status).toBe(from);
					expect(events).toEqual([]);
					continue;
				}
				if (LEGAL_EDGES.has(`${from}->${to}`)) {
					registry.setStatus(id, to);
					expect(registry.get(id)?.status).toBe(to);
					expect(events).toEqual([to]);
					continue;
				}
				let thrown: unknown;
				try {
					registry.setStatus(id, to);
				} catch (error) {
					thrown = error;
				}
				expect(thrown).toBeInstanceOf(AgentTransitionError);
				const error = thrown as AgentTransitionError;
				expect({ id: error.id, from: error.from, to: error.to }).toEqual({ id, from, to });
				expect(registry.get(id)?.status).toBe(from);
				expect(events).toEqual([]);
			}
		}
	});

	it("keeps aborted terminal", () => {
		expect(AGENT_TRANSITIONS.aborted).toEqual([]);
	});

	it("lets a collab mirror copy a status the host reached through states the guest never saw", () => {
		registry.register({ id: "peer", displayName: "peer", kind: "sub", session: null, status: "running" });
		registry.mirrorStatus("peer", "parked");
		expect(registry.get("peer")?.status).toBe("parked");
		registry.mirrorStatus("peer", "running");
		expect(registry.get("peer")?.status).toBe("running");
	});

	describe("a session's turn events reach the registry only from the state they describe", () => {
		let lifecycle: AgentLifecycleManager;
		let listeners: Array<(event: AgentSessionEvent) => void>;
		let session: AgentSession;

		beforeEach(() => {
			AgentLifecycleManager.resetGlobalForTests();
			lifecycle = AgentLifecycleManager.global();
			listeners = [];
			session = {
				subscribe: (listener: (event: AgentSessionEvent) => void) => {
					listeners.push(listener);
					return () => {};
				},
				sessionManager: { flush: async () => {} },
				dispose: async () => {},
			} as unknown as AgentSession;
		});
		afterEach(() => {
			AgentLifecycleManager.resetGlobalForTests();
		});

		const emit = (type: "agent_start" | "agent_end") => {
			for (const listener of listeners) listener({ type } as AgentSessionEvent);
		};

		it("moves idle → running → idle across a turn", () => {
			registry.register({ id: "w", displayName: "w", kind: "sub", session, status: "idle" });
			syncStatusWithTurns(registry, "w", session);
			emit("agent_start");
			expect(registry.get("w")?.status).toBe("running");
			emit("agent_end");
			expect(registry.get("w")?.status).toBe("idle");
		});

		it("drops a turn end that lands after a kill instead of resurrecting the agent", () => {
			registry.register({ id: "w", displayName: "w", kind: "sub", session, status: "running" });
			syncStatusWithTurns(registry, "w", session);
			registry.setStatus("w", "aborted");
			emit("agent_end");
			expect(registry.get("w")?.status).toBe("aborted");
		});

		it("drops a turn start reported on a parked ref", () => {
			registry.register({ id: "w", displayName: "w", kind: "sub", session: null, status: "parked" });
			syncStatusWithTurns(registry, "w", session);
			emit("agent_start");
			expect(registry.get("w")?.status).toBe("parked");
			expect(lifecycle.has("w")).toBe(false);
		});
	});
});
