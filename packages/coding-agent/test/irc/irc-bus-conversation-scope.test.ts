/**
 * The IRC bus across TWO conversations sharing one process.
 *
 * WHY TWO. Every defect asserted here is invisible with one conversation in the
 * registry, by construction: each is a lookup that reaches state belonging to
 * SOMEBODY ELSE, and with a single conversation there is nobody else to reach.
 * A one-conversation test of `forgetAgents` or the main-UI relay passes on the
 * unscoped code and on the scoped code alike, which is exactly how these
 * survived the suite that already covered them.
 *
 * Two live `kind: "main"` refs is not a hypothetical shape. ACP's `session/new`
 * keeps every session it opens in one map and only drops one on `session/close`,
 * and each registers as `acp:<sessionId>` with its own scope, so a client that
 * opens a second tab has exactly this registry.
 *
 * What each test pins:
 * - a log line remembers the conversation it was recorded in;
 * - a `/new` in one conversation cannot erase another's traffic, even when both
 *   ran an agent under the same model-chosen name;
 * - the display-only relay lands on the driving session of the traffic's OWN
 *   conversation, and on no other.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { IrcBus } from "@veyyon/coding-agent/irc/bus";
import { AgentLifecycleManager } from "@veyyon/coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@veyyon/coding-agent/registry/agent-registry";
import type { AgentSession } from "@veyyon/coding-agent/session/agent-session";

/** A recipient that accepts the hand-off, and records every relay card pushed at it. */
function deliveringSession(relays: string[]): AgentSession {
	return {
		deliverIrcMessage: async () => "delivered",
		emitIrcRelayObservation: (record: { content: string }) => {
			relays.push(record.content);
		},
	} as unknown as AgentSession;
}

let bus: IrcBus;
let registry: AgentRegistry;

beforeEach(() => {
	AgentRegistry.resetGlobalForTests();
	AgentLifecycleManager.resetGlobalForTests();
	IrcBus.resetGlobalForTests();
	bus = IrcBus.global();
	registry = AgentRegistry.global();
});

/** Register one conversation: a driving root plus one subagent that inherits its scope. */
function conversation(scope: string, rootId: string, subId: string, relays: string[]): void {
	registry.register({
		id: rootId,
		displayName: "main",
		kind: "main",
		session: deliveringSession(relays),
		status: "running",
		scope,
	});
	registry.register({
		id: subId,
		displayName: "reviewer",
		kind: "sub",
		parentId: rootId,
		session: deliveringSession(relays),
		status: "running",
	});
}

describe("Bus traffic is attributed to the conversation that produced it", () => {
	/**
	 * The stamp is the whole mechanism, so it is asserted directly: everything
	 * below reads it, and an unstamped line silently degrades every reader to the
	 * permissive branch rather than failing anywhere visible.
	 */
	test("records the sender's conversation on every log line", async () => {
		const relays: string[] = [];
		conversation("session-a", "acp:a", "Reviewer-A", relays);
		conversation("session-b", "acp:b", "Reviewer-B", relays);

		await bus.send({ from: "Reviewer-A", to: "acp:a", body: "a" });
		await bus.send({ from: "Reviewer-B", to: "acp:b", body: "b" });

		expect(bus.log().map(entry => [entry.message.body, entry.scope])).toEqual([
			["a", "session-a"],
			["b", "session-b"],
		]);
	});

	/**
	 * The `forgetAgents` leak, in the shape that makes it reachable: agent ids are
	 * model-chosen task names, so two conversations in one process routinely each
	 * run a `Reviewer`. The registry map holds one ref per id at a time, so this
	 * is the ordinary sequence (B's Reviewer finishes and is unregistered, A then
	 * spawns its own under the same name) and A's `/new` purged BOTH sets of
	 * lines because the filter only ever compared ids.
	 *
	 * Re-injecting the defect (dropping the `scope` argument at the call site, or
	 * restoring the bare `!gone.has(...)` filter) turns the surviving line into an
	 * empty log and fails here. With one conversation registered there is no
	 * second `Reviewer` to collide with and both versions pass.
	 */
	test("a re-root in one conversation leaves another conversation's traffic alone", async () => {
		const relays: string[] = [];
		conversation("session-b", "acp:b", "Reviewer", relays);
		await bus.send({ from: "Reviewer", to: "acp:b", body: "B's reviewer reported in" });
		// B's spawn finishes and is released, freeing the name.
		registry.unregister("Reviewer");

		conversation("session-a", "acp:a", "Reviewer", relays);
		await bus.send({ from: "Reviewer", to: "acp:a", body: "A's reviewer reported in" });

		// A re-roots: it releases its own subtree and forgets its own legs, bounded
		// by the conversation that is ending.
		bus.forgetAgents(["Reviewer", "acp:a"], "session-a");

		expect(bus.log().map(entry => entry.message.body)).toEqual(["B's reviewer reported in"]);
	});

	/**
	 * The other direction, so a filter that simply stopped purging would fail:
	 * the conversation that IS ending still loses its own traffic. Without this
	 * the `/new` Comms stream opens on the transcript it replaced.
	 */
	test("still erases the traffic of the conversation that is ending", async () => {
		const relays: string[] = [];
		conversation("session-a", "acp:a", "Reviewer-A", relays);
		await bus.send({ from: "Reviewer-A", to: "acp:a", body: "A's leg" });

		bus.forgetAgents(["Reviewer-A", "acp:a"], "session-a");

		expect(bus.log()).toEqual([]);
	});

	/**
	 * The relay pastes a message BODY verbatim into a session transcript, so
	 * picking the wrong session publishes one conversation's agent chatter into
	 * another operator's window. It resolved the target as the literal id `Main`,
	 * which in a two-conversation process is at best one of them and at worst
	 * neither.
	 *
	 * Asserted in both directions in one test, because a relay that reached
	 * nobody would satisfy "did not reach B" while removing the feature.
	 */
	test("relays agent traffic to the driving session of its own conversation only", async () => {
		const relaysA: string[] = [];
		const relaysB: string[] = [];
		// B is registered FIRST on purpose. Any "first main in the registry" rule
		// then picks B, so a relay of A's traffic lands in B's transcript and this
		// test fails on the unscoped lookup rather than passing by registration
		// order.
		registry.register({
			id: "acp:b",
			displayName: "main",
			kind: "main",
			session: deliveringSession(relaysB),
			status: "running",
			scope: "session-b",
		});
		registry.register({
			id: "acp:a",
			displayName: "main",
			kind: "main",
			session: deliveringSession(relaysA),
			status: "running",
			scope: "session-a",
		});
		for (const [id, parent] of [
			["Scout-A", "acp:a"],
			["Writer-A", "acp:a"],
			["Scout-B", "acp:b"],
			["Writer-B", "acp:b"],
		] as const) {
			registry.register({
				id,
				displayName: "sub",
				kind: "sub",
				parentId: parent,
				session: deliveringSession([]),
				status: "running",
			});
		}

		await bus.send({ from: "Scout-A", to: "Writer-A", body: "A's private exchange" });

		expect(relaysA.join("\n")).toContain("A's private exchange");
		expect(relaysB).toEqual([]);
	});
});
