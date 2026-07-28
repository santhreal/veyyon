/**
 * The bus's own record of agent-to-agent traffic.
 *
 * WHY IT EXISTS. Mailboxes are queues: `wait`, `inbox` and the live hand-off
 * each REMOVE the message they consume, so a surface reading mailboxes sees
 * only undelivered backlog, which on a healthy run is nothing at all. The
 * Comms view of the Agent Control Center needs the opposite -- everything that
 * was said, including what failed to land -- so the bus keeps a log that
 * delivery does not erase and streams each line to whoever is watching.
 *
 * Every test here pins a property the Comms view depends on: one entry per
 * send, the outcome recorded truthfully, failures kept rather than dropped, the
 * log bounded, and a broken listener never taking delivery down with it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { IrcBus, type IrcLogEntry, type IrcMessage } from "@veyyon/coding-agent/irc/bus";
import { AgentLifecycleManager } from "@veyyon/coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@veyyon/coding-agent/registry/agent-registry";
import type { AgentSession } from "@veyyon/coding-agent/session/agent-session";

/** A recipient that accepts delivery and reports the outcome the test asks for. */
function fakeSession(options: { outcome?: "injected" | "woken"; throws?: Error } = {}): AgentSession {
	const delivered: IrcMessage[] = [];
	return {
		deliverIrcMessage: async (msg: IrcMessage) => {
			if (options.throws) throw options.throws;
			delivered.push(msg);
			return options.outcome ?? "injected";
		},
		emitIrcRelayObservation: () => {},
	} as unknown as AgentSession;
}

describe("IrcBus traffic log", () => {
	let registry: AgentRegistry;
	let bus: IrcBus;

	beforeEach(() => {
		AgentRegistry.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();
		IrcBus.resetGlobalForTests();
		registry = AgentRegistry.global();
		bus = IrcBus.global();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	/**
	 * The delivered case, which the mailboxes cannot answer: after a successful
	 * hand-off the recipient's mailbox is empty, so a Comms view built on
	 * `inbox()` would show nothing while agents talked all run.
	 */
	it("keeps a delivered message that the mailbox no longer holds", async () => {
		registry.register({ id: "0-Sub", displayName: "reviewer", kind: "sub", session: fakeSession() });

		const receipt = await bus.send({ from: "Main", to: "0-Sub", body: "please review the diff" });

		expect(receipt.outcome).toBe("injected");
		expect(bus.unreadCount("0-Sub")).toBe(0);
		const log = bus.log();
		expect(log).toHaveLength(1);
		expect(log[0].message.from).toBe("Main");
		expect(log[0].message.to).toBe("0-Sub");
		expect(log[0].message.body).toBe("please review the diff");
		expect(log[0].outcome).toBe("injected");
		expect(log[0].error).toBeUndefined();
	});

	/** Ordering is send order, oldest first, because the view reads it as a stream. */
	it("records every send once, in order", async () => {
		registry.register({ id: "0-Sub", displayName: "reviewer", kind: "sub", session: fakeSession() });
		registry.register({ id: "1-Sub", displayName: "scout", kind: "sub", session: fakeSession() });

		await bus.send({ from: "Main", to: "0-Sub", body: "first" });
		await bus.send({ from: "0-Sub", to: "1-Sub", body: "second" });
		await bus.send({ from: "1-Sub", to: "Main", body: "third" });

		expect(bus.log().map(entry => entry.message.body)).toEqual(["first", "second", "third"]);
	});

	/**
	 * The `woken` outcome is a real distinction (an idle recipient took a turn to
	 * read it), and the view labels traffic by it, so it is recorded verbatim
	 * rather than flattened into "delivered".
	 */
	it("records the outcome the delivery actually reported", async () => {
		registry.register({
			id: "0-Sub",
			displayName: "reviewer",
			kind: "sub",
			session: fakeSession({ outcome: "woken" }),
		});

		await bus.send({ from: "Main", to: "0-Sub", body: "wake up" });

		expect(bus.log()[0].outcome).toBe("woken");
	});

	/**
	 * A message to an agent that does not exist is the one line a reader most
	 * needs: it explains a reply that never arrives. Refusals return before any
	 * mailbox is touched, so if the log recorded only successful sends this case
	 * would vanish entirely.
	 */
	it("keeps a refused send, with the reason", async () => {
		const receipt = await bus.send({ from: "Main", to: "ghost", body: "anyone there" });

		expect(receipt.outcome).toBe("failed");
		const log = bus.log();
		expect(log).toHaveLength(1);
		expect(log[0].outcome).toBe("failed");
		expect(log[0].error).toContain('Unknown agent "ghost"');
	});

	/** A live hand-off that throws is buffered and still reported as failed, once. */
	it("records a failed hand-off exactly once", async () => {
		registry.register({
			id: "0-Sub",
			displayName: "reviewer",
			kind: "sub",
			session: fakeSession({ throws: new Error("recipient disposed") }),
		});

		await bus.send({ from: "Main", to: "0-Sub", body: "still there?" });

		const log = bus.log();
		expect(log).toHaveLength(1);
		expect(log[0].outcome).toBe("failed");
		expect(log[0].error).toContain("recipient disposed");
	});

	/** An aborted agent cannot be messaged, and the refusal says so in the log. */
	it("keeps the refusal for an aborted recipient", async () => {
		registry.register({ id: "0-Sub", displayName: "reviewer", kind: "sub", session: null, status: "aborted" });

		await bus.send({ from: "Main", to: "0-Sub", body: "hello" });

		expect(bus.log()[0].outcome).toBe("failed");
		expect(bus.log()[0].error).toContain("hard-aborted");
	});

	/** Watchers see each line as it is recorded, which is what makes the view live. */
	it("streams each entry to subscribers as it is recorded", async () => {
		registry.register({ id: "0-Sub", displayName: "reviewer", kind: "sub", session: fakeSession() });
		const seen: IrcLogEntry[] = [];
		const unsubscribe = bus.onMessage(entry => seen.push(entry));

		await bus.send({ from: "Main", to: "0-Sub", body: "one" });
		await bus.send({ from: "Main", to: "0-Sub", body: "two" });
		unsubscribe();
		await bus.send({ from: "Main", to: "0-Sub", body: "after unsubscribe" });

		expect(seen.map(entry => entry.message.body)).toEqual(["one", "two"]);
	});

	/**
	 * A display feed must never break delivery. A pane that throws while
	 * rendering would otherwise unwind into an agent that was only trying to talk
	 * to another agent, turning a cosmetic bug into a lost message.
	 */
	it("delivers the message even when a listener throws, and keeps the other listeners", async () => {
		registry.register({ id: "0-Sub", displayName: "reviewer", kind: "sub", session: fakeSession() });
		const seen: string[] = [];
		bus.onMessage(() => {
			throw new Error("render blew up");
		});
		bus.onMessage(entry => seen.push(entry.message.body));

		const receipt = await bus.send({ from: "Main", to: "0-Sub", body: "survives" });

		expect(receipt.outcome).toBe("injected");
		expect(seen).toEqual(["survives"]);
		expect(bus.log()).toHaveLength(1);
	});

	/**
	 * The log is bounded, and it keeps the NEWEST lines: the stream is read from
	 * the bottom, and an unbounded log would grow for the life of a process that
	 * may run for hours of continuous chatter.
	 */
	it("caps the log at 500 lines and drops the oldest", async () => {
		registry.register({ id: "0-Sub", displayName: "reviewer", kind: "sub", session: fakeSession() });

		for (let i = 0; i < 520; i++) {
			await bus.send({ from: "Main", to: "0-Sub", body: `message ${i}` });
		}

		const log = bus.log();
		expect(log).toHaveLength(500);
		expect(log[0].message.body).toBe("message 20");
		expect(log[log.length - 1].message.body).toBe("message 519");
	});

	/**
	 * `log()` hands out a copy. Render paths hold the array across frames, and a
	 * live reference would mutate under them mid-render.
	 */
	it("returns a snapshot that later traffic does not mutate", async () => {
		registry.register({ id: "0-Sub", displayName: "reviewer", kind: "sub", session: fakeSession() });
		await bus.send({ from: "Main", to: "0-Sub", body: "first" });

		const snapshot = bus.log();
		await bus.send({ from: "Main", to: "0-Sub", body: "second" });

		expect(snapshot).toHaveLength(1);
		expect(bus.log()).toHaveLength(2);
	});

	/**
	 * A leg that THROWS instead of returning a receipt is still recorded, and the
	 * throw is then passed on unchanged.
	 *
	 * `send` reports its known failures as receipts, but not every step is inside
	 * a try: the registry lookup that opens the delivery, the waiter hand-off and
	 * the mailbox enqueue are all outside one. A collab guest's registry is a
	 * mirror of the host's and can fail on a read, which is the realistic version
	 * of this. Before the wrapper caught it, a leg that was really attempted was
	 * absent from the log, which reads to an operator as a message nobody sent.
	 * The rethrow is asserted too: the log is a display feed and must not change
	 * what the caller sees.
	 */
	it("records a leg whose delivery threw, and rethrows unchanged", async () => {
		const boom = new Error("registry mirror is unreadable");
		const brokenRegistry = {
			get: () => {
				throw boom;
			},
		} as unknown as AgentRegistry;
		const bus = new IrcBus(brokenRegistry);

		let thrown: unknown;
		try {
			await bus.send({ from: "0-Sub", to: "Worker", body: "does not land" });
		} catch (error) {
			thrown = error;
		}

		expect(thrown).toBe(boom);
		const log = bus.log();
		expect(log.length).toBe(1);
		expect(log[0]?.message.body).toBe("does not land");
		expect(log[0]?.message.to).toBe("Worker");
		expect(log[0]?.outcome).toBe("failed");
		expect(log[0]?.error).toContain("registry mirror is unreadable");
	});
});
