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
import { Settings } from "@veyyon/coding-agent/config/settings";
import { IrcBus, type IrcLogEntry, type IrcMessage } from "@veyyon/coding-agent/irc/bus";
import { AgentLifecycleManager } from "@veyyon/coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@veyyon/coding-agent/registry/agent-registry";
import { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import { SessionManager } from "@veyyon/coding-agent/session/session-manager";
import { TempDir } from "@veyyon/utils";

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

	describe("delivery telemetry", () => {
		it("records no agent-communication telemetry below the canonical rich threshold", async () => {
			registry.register({ id: "0-Sub", displayName: "reviewer", kind: "sub", session: fakeSession() });

			for (const level of ["off", "basic"] as const) {
				const instrumented = new IrcBus(registry, undefined, () => level);
				await instrumented.send({ from: "Main", to: "0-Sub", body: "minimal mode" });
				expect(instrumented.log()[0]?.telemetry).toBeUndefined();
			}
		});

		it("keeps rich telemetry to safe outcome and byte-count facts without duplicating content", async () => {
			registry.register({ id: "0-Sub", displayName: "reviewer", kind: "sub", session: fakeSession() });
			const instrumented = new IrcBus(registry, undefined, () => "rich");
			const body = "hé";

			await instrumented.send({ from: "Main", to: "0-Sub", body });

			const telemetry = instrumented.log()[0]?.telemetry;
			expect(telemetry).toEqual({ level: "rich", outcome: "injected", payloadBytes: 3 });
			expect(telemetry).not.toHaveProperty("sender");
			expect(telemetry).not.toHaveProperty("route");
			expect(JSON.stringify(telemetry)).not.toContain(body);
		});

		it("adds content-free route, identity class, kind, and millisecond latency facts at ultra", async () => {
			registry.register({ id: "0-Sub", displayName: "reviewer", kind: "sub", session: fakeSession() });
			const instrumented = new IrcBus(registry, undefined, () => "ultra");

			await instrumented.send({
				from: "Main",
				to: "0-Sub",
				body: "review this",
				replyTo: "earlier-message",
			});

			const telemetry = instrumented.log()[0]?.telemetry;
			expect(telemetry).toMatchObject({
				level: "ultra",
				outcome: "injected",
				payloadBytes: 11,
				sender: "Main",
				recipientClass: "sub",
				route: "injected",
				revived: false,
				messageKind: "reply",
			});
			expect(telemetry?.deliveryLatencyMs).toBeGreaterThanOrEqual(0);
			expect(telemetry).not.toHaveProperty("body");
			expect(JSON.stringify(telemetry)).not.toContain("review this");
		});

		it("distinguishes wake and waiter-satisfied delivery paths", async () => {
			registry.register({
				id: "0-Woken",
				displayName: "sleeper",
				kind: "sub",
				session: fakeSession({ outcome: "woken" }),
			});
			registry.register({ id: "0-Waiter", displayName: "waiter", kind: "sub", session: fakeSession() });
			const instrumented = new IrcBus(registry, undefined, () => "ultra");
			const waiting = instrumented.wait("0-Waiter", { from: "Main" }, 100, undefined, { drainPending: false });

			await instrumented.send({ from: "Main", to: "0-Woken", body: "wake" });
			await instrumented.send({ from: "Main", to: "0-Waiter", body: "satisfy" });

			expect((await waiting)?.body).toBe("satisfy");
			expect(instrumented.log().map(entry => entry.telemetry?.route)).toEqual(["wake", "waiter"]);
			expect(instrumented.log().map(entry => entry.telemetry?.outcome)).toEqual(["woken", "injected"]);
		});

		it("records revival separately from the underlying wake hand-off", async () => {
			const session = fakeSession({ outcome: "woken" });
			registry.register({
				id: "0-Parked",
				displayName: "parked",
				kind: "sub",
				session: null,
				status: "parked",
			});
			const lifecycle = AgentLifecycleManager.global();
			lifecycle.adopt("0-Parked", { idleTtlMs: 0, revive: async () => session });
			const instrumented = new IrcBus(registry, lifecycle, () => "ultra");

			await instrumented.send({ from: "Main", to: "0-Parked", body: "resume" });

			expect(instrumented.log()[0]?.telemetry).toMatchObject({
				outcome: "revived",
				route: "wake",
				revived: true,
				recipientClass: "sub",
			});
		});

		it("records refusals and buffered retry paths without adding a second delivery event", async () => {
			const instrumented = new IrcBus(registry, undefined, () => "ultra");
			await instrumented.send({ from: "Main", to: "ghost", body: "refused" });

			registry.register({
				id: "0-Flaky",
				displayName: "flaky",
				kind: "sub",
				session: fakeSession({ throws: new Error("not ready") }),
			});
			await instrumented.send({ from: "Main", to: "0-Flaky", body: "retry me" });

			expect(instrumented.log().map(entry => entry.telemetry?.route)).toEqual(["refused", "buffered"]);
			expect(instrumented.log().map(entry => entry.telemetry?.outcome)).toEqual(["failed", "failed"]);
			const retried = await instrumented.wait("0-Flaky", {}, 10);
			expect(retried?.body).toBe("retry me");
			expect(instrumented.log()).toHaveLength(2);
		});

		it("persists sent and received rich events with one shared id across JSONL reloads", async () => {
			const tempDir = TempDir.createSync("@veyyon-irc-telemetry-");
			try {
				const senderManager = SessionManager.create(tempDir.path(), tempDir.path());
				const recipientManager = SessionManager.create(tempDir.path(), tempDir.path());
				await Promise.all([senderManager.ensureOnDisk(), recipientManager.ensureOnDisk()]);
				const richSettings = Settings.isolated({ "session.instrumentation": "rich" });
				const sender = Object.assign(fakeSession(), {
					settings: richSettings,
					sessionManager: senderManager,
					recordIrcDeliveryTelemetry: AgentSession.prototype.recordIrcDeliveryTelemetry,
				});
				const recipient = Object.assign(fakeSession(), {
					settings: richSettings,
					sessionManager: recipientManager,
					recordIrcDeliveryTelemetry: AgentSession.prototype.recordIrcDeliveryTelemetry,
				});
				registry.register({ id: "Main", displayName: "main", kind: "main", session: sender });
				registry.register({ id: "0-Sub", displayName: "reviewer", kind: "sub", session: recipient });
				const instrumented = new IrcBus(registry, undefined, () => "rich");
				const body = "persist no body";

				await instrumented.send({ from: "Main", to: "0-Sub", body });
				await Promise.all([senderManager.flush(), recipientManager.flush()]);

				const senderFile = senderManager.getSessionFile();
				const recipientFile = recipientManager.getSessionFile();
				if (!senderFile || !recipientFile) throw new Error("Expected both IRC telemetry session files");
				const [senderReloaded, recipientReloaded] = await Promise.all([
					SessionManager.open(senderFile, tempDir.path()),
					SessionManager.open(recipientFile, tempDir.path()),
				]);
				const senderPersisted = senderReloaded
					.getEntries()
					.find(entry => entry.type === "custom" && entry.customType === "irc:delivery-telemetry");
				const recipientPersisted = recipientReloaded
					.getEntries()
					.find(entry => entry.type === "custom" && entry.customType === "irc:delivery-telemetry");
				expect(senderPersisted).toMatchObject({
					type: "custom",
					customType: "irc:delivery-telemetry",
					data: {
						level: "rich",
						direction: "sent",
						outcome: "injected",
						payloadBytes: 15,
					},
				});
				expect(recipientPersisted).toMatchObject({
					type: "custom",
					customType: "irc:delivery-telemetry",
					data: {
						level: "rich",
						direction: "received",
						outcome: "injected",
						payloadBytes: 15,
					},
				});
				const senderData =
					senderPersisted?.type === "custom" ? (senderPersisted.data as { messageId?: unknown }) : undefined;
				const recipientData =
					recipientPersisted?.type === "custom" ? (recipientPersisted.data as { messageId?: unknown }) : undefined;
				expect(typeof senderData?.messageId).toBe("string");
				expect(recipientData?.messageId).toBe(senderData?.messageId);
				expect(JSON.stringify([senderPersisted, recipientPersisted])).not.toContain(body);
				expect(senderReloaded.buildSessionContext().messages.some(message => message.role === "custom")).toBe(
					false,
				);
				expect(recipientReloaded.buildSessionContext().messages.some(message => message.role === "custom")).toBe(
					false,
				);
			} finally {
				await tempDir.remove();
			}
		});

		/**
		 * Each participant owns its instrumentation policy. A process-global
		 * level must neither leak metadata into an off session nor suppress an
		 * enabled peer's directional record.
		 */
		it("persists IRC telemetry independently for mixed participant policies", async () => {
			using tempDir = TempDir.createSync("@veyyon-irc-mixed-policy-");
			const senderManager = SessionManager.create(tempDir.path(), tempDir.path());
			const recipientManager = SessionManager.create(tempDir.path(), tempDir.path());
			const sender = Object.assign(fakeSession(), {
				settings: Settings.isolated({ "session.instrumentation": "off" }),
				sessionManager: senderManager,
				recordIrcDeliveryTelemetry: AgentSession.prototype.recordIrcDeliveryTelemetry,
			});
			const recipient = Object.assign(fakeSession(), {
				settings: Settings.isolated({ "session.instrumentation": "ultra" }),
				sessionManager: recipientManager,
				recordIrcDeliveryTelemetry: AgentSession.prototype.recordIrcDeliveryTelemetry,
			});
			registry.register({ id: "Main", displayName: "main", kind: "main", session: sender });
			registry.register({ id: "0-Sub", displayName: "reviewer", kind: "sub", session: recipient });
			const globallyOff = new IrcBus(registry, undefined, () => "off");

			await globallyOff.send({ from: "Main", to: "0-Sub", body: "policy-owned" });

			expect(globallyOff.log()[0]?.telemetry).toBeUndefined();
			expect(
				senderManager
					.getEntries()
					.find(entry => entry.type === "custom" && entry.customType === "irc:delivery-telemetry"),
			).toBeUndefined();
			expect(
				recipientManager
					.getEntries()
					.find(entry => entry.type === "custom" && entry.customType === "irc:delivery-telemetry"),
			).toMatchObject({
				type: "custom",
				customType: "irc:delivery-telemetry",
				data: {
					level: "ultra",
					direction: "received",
					outcome: "injected",
					payloadBytes: 12,
					sender: "Main",
					recipientClass: "sub",
					route: "injected",
				},
			});
		});

		it("writes only one sent record when sender and recipient are the same session", async () => {
			const session = fakeSession();
			const persisted = vi.fn(() => {});
			session.recordIrcDeliveryTelemetry = persisted;
			registry.register({ id: "Main", displayName: "main", kind: "main", session });
			const instrumented = new IrcBus(registry, undefined, () => "rich");

			await instrumented.send({ from: "Main", to: "Main", body: "self note" });

			expect(persisted).toHaveBeenCalledTimes(1);
			expect(persisted).toHaveBeenCalledWith(
				expect.objectContaining({ direction: "sent", messageId: expect.any(String) }),
			);
		});
	});
});
