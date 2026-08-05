/**
 * `IrcBus.forgetAgents`: erasing the traffic of agents a session has released.
 *
 * WHY IT EXISTS. The registry refs of a released spawn tree disappear, but the
 * bus is process-global and its log is not keyed by conversation. Without this,
 * a driving session that re-roots to a different transcript (`/new`, `/resume`)
 * opened its brand-new Comms stream on the PREVIOUS session's chatter, between
 * agents that no longer exist and cannot be opened. The mailboxes and waiters
 * are the same problem one level down: a released agent's undelivered mail was
 * kept for a recipient that would never read it, and a `wait` it was blocked on
 * hung for the life of the process.
 *
 * Every test here pins one thing the caller depends on: unrelated traffic
 * SURVIVES, the named agents' traces do not, a pending wait unblocks, and an
 * empty release is a no-op rather than a log wipe.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { IrcBus } from "@veyyon/coding-agent/irc/bus";
import { AgentLifecycleManager } from "@veyyon/coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@veyyon/coding-agent/registry/agent-registry";
import type { AgentSession } from "@veyyon/coding-agent/session/agent-session";

/** A recipient whose session refuses the hand-off, so the message stays in its mailbox. */
function bufferingSession(): AgentSession {
	return {
		deliverIrcMessage: async () => {
			throw new Error("busy");
		},
		emitIrcRelayObservation: () => {},
	} as unknown as AgentSession;
}

let bus: IrcBus;

beforeEach(() => {
	AgentRegistry.resetGlobalForTests();
	AgentLifecycleManager.resetGlobalForTests();
	IrcBus.resetGlobalForTests();
	bus = IrcBus.global();
	const registry = AgentRegistry.global();
	for (const id of ["Old-Sub", "Old-Peer", "New-Sub", "New-Peer"]) {
		registry.register({
			id,
			displayName: "reviewer",
			kind: "sub",
			session: bufferingSession(),
			status: "running",
		});
	}
});

describe("Forgetting released agents", () => {
	/**
	 * The reason the method exists: a new conversation's Comms stream must open
	 * on its own traffic. Both directions are asserted, because a filter that
	 * emptied the whole log would also hide the released chatter and would look
	 * like a fix while destroying the record of the live conversation.
	 */
	test("drops every line the released agents took part in and keeps the rest", async () => {
		await bus.send({ from: "Old-Sub", to: "Old-Peer", body: "old outbound leg" });
		await bus.send({ from: "Old-Peer", to: "New-Sub", body: "old inbound leg" });
		await bus.send({ from: "New-Sub", to: "New-Peer", body: "current conversation leg" });

		bus.forgetAgents(["Old-Sub", "Old-Peer"]);

		expect(bus.log().map(entry => entry.message.body)).toEqual(["current conversation leg"]);
	});

	/**
	 * A released agent's undelivered mail is kept for a recipient that will never
	 * read it, and a nonzero unread count is what surfaces as a pending-mail
	 * badge for an agent the roster no longer shows.
	 */
	test("empties the released agent's mailbox", async () => {
		await bus.send({ from: "New-Sub", to: "Old-Sub", body: "never read" });
		expect(bus.unreadCount("Old-Sub")).toBe(1);

		bus.forgetAgents(["Old-Sub"]);

		expect(bus.unreadCount("Old-Sub")).toBe(0);
		expect(bus.inbox("Old-Sub")).toEqual([]);
	});

	/** Only the named agents are forgotten: a live agent's backlog is not collateral. */
	test("leaves an unrelated agent's mailbox intact", async () => {
		await bus.send({ from: "New-Sub", to: "Old-Sub", body: "released backlog" });
		await bus.send({ from: "Old-Sub", to: "New-Peer", body: "live backlog" });

		bus.forgetAgents(["Old-Sub"]);

		expect(bus.unreadCount("New-Peer")).toBe(1);
		expect(bus.inbox("New-Peer").map(message => message.body)).toEqual(["live backlog"]);
	});

	/**
	 * A waiter is a promise something is blocked on, so releasing an agent must
	 * settle it: `wait` with a non-positive timeout waits forever, and
	 * `forgetAgents` clears the wait's timer as it cleans up, so nothing else
	 * will ever settle that promise. It resolves `null`, the same answer a
	 * timeout gives, because the peer is gone and no message is coming.
	 *
	 * `IrcWaiter.cancel` had NO caller before `forgetAgents` and was cleanup-only
	 * -- it deregistered the waiter and cleared the timer without resolving --
	 * so this is the case that would silently hang a peer for the life of the
	 * process, with nothing in the types to show it. Awaiting the promise the bus
	 * already returned is the assertion: a regression stops settling it, and the
	 * test fails on its own timeout rather than on a guessed delay.
	 */
	test("resolves a pending wait with null instead of leaving it blocked forever", async () => {
		const pending = bus.wait("Old-Sub", {}, 0);

		bus.forgetAgents(["Old-Sub"]);

		expect(await pending).toBeNull();
	});

	/**
	 * A session with nothing to release must not wipe the log. `forgetAgents([])`
	 * builds an empty id set, and a filter run against it would still rewrite the
	 * log array, so the early return is the contract: releasing no agents changes
	 * nothing at all.
	 */
	test("changes nothing when no agents are released", async () => {
		await bus.send({ from: "New-Sub", to: "New-Peer", body: "still here" });
		await bus.send({ from: "New-Peer", to: "Old-Sub", body: "also still here" });

		bus.forgetAgents([]);

		expect(bus.log().map(entry => entry.message.body)).toEqual(["still here", "also still here"]);
		expect(bus.unreadCount("Old-Sub")).toBe(1);
	});
});
