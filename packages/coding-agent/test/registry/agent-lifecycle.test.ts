import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { AgentLifecycleManager } from "@veyyon/coding-agent/registry/agent-lifecycle";
import { AgentRegistry, MAIN_AGENT_ID } from "@veyyon/coding-agent/registry/agent-registry";
import type { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import { drainMicrotasks } from "../../../utils/test/helpers/drain-microtasks";

interface SessionStub {
	session: AgentSession;
	flushCalls: () => number;
	disposeCalls: () => number;
}

/** Minimal durable session exposing the flush-before-dispose boundary owned by the lifecycle manager. */
function makeSessionStub(dispose?: () => Promise<void>, flush?: () => Promise<void>): SessionStub {
	let flushCount = 0;
	let disposeCount = 0;
	const stub = {
		sessionManager: {
			flush: async () => {
				flushCount++;
				await flush?.();
			},
		},
		dispose: async () => {
			disposeCount++;
			await dispose?.();
		},
	};
	return {
		session: stub as unknown as AgentSession,
		flushCalls: () => flushCount,
		disposeCalls: () => disposeCount,
	};
}

/** Settle the async sleep chain (timer callback → sleep() → dispose → setStatus). */
async function flushAsync(): Promise<void> {
	await drainMicrotasks(5);
}

const TTL = 20;

describe("AgentLifecycleManager", () => {
	let registry: AgentRegistry;
	let lifecycle: AgentLifecycleManager;

	beforeEach(() => {
		AgentRegistry.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();
		registry = AgentRegistry.global();
		lifecycle = AgentLifecycleManager.global();
	});
	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
		AgentLifecycleManager.resetGlobalForTests();
		AgentRegistry.resetGlobalForTests();
	});

	function registerIdleSub(id: string, session: AgentSession | null, sessionFile: string | null = `/tmp/${id}.jsonl`) {
		return registry.register({ id, displayName: "task", kind: "sub", session, sessionFile, status: "idle" });
	}

	/**
	 * The deadline is inclusive, and expiry retains the durable transcript
	 * reference while releasing only the live session.
	 */
	it("puts an idle agent to sleep exactly at its deadline and retains its transcript reference", async () => {
		vi.useFakeTimers();
		const stub = makeSessionStub();
		registerIdleSub("1-Sub", stub.session, "/tmp/1-Sub.jsonl");
		lifecycle.adopt("1-Sub", { idleTtlMs: TTL });

		vi.advanceTimersByTime(TTL - 1);
		await flushAsync();
		expect(registry.get("1-Sub")?.status).toBe("idle");

		vi.advanceTimersByTime(1);
		await flushAsync();

		const ref = registry.get("1-Sub");
		expect(stub.flushCalls()).toBe(1);
		expect(stub.disposeCalls()).toBe(1);
		expect(ref?.status).toBe("asleep");
		expect(ref?.session).toBeNull();
		expect(ref?.sessionFile).toBe("/tmp/1-Sub.jsonl");
		expect(lifecycle.has("1-Sub")).toBe(true);
	});

	/** A running transition cancels expiry; the next idle transition starts a fresh deadline. */
	it("resets the idle deadline from the canonical activity transition and never expires a running agent", async () => {
		vi.useFakeTimers();
		const stub = makeSessionStub();
		registerIdleSub("2-Sub", stub.session);
		lifecycle.adopt("2-Sub", { idleTtlMs: TTL });
		vi.advanceTimersByTime(TTL - 1);
		registry.setStatus("2-Sub", "running");

		vi.advanceTimersByTime(TTL * 10);
		await flushAsync();
		expect(registry.get("2-Sub")?.status).toBe("running");
		expect(registry.get("2-Sub")?.session).toBe(stub.session);
		expect(stub.disposeCalls()).toBe(0);

		registry.setStatus("2-Sub", "idle");
		vi.advanceTimersByTime(TTL - 1);
		await flushAsync();
		expect(registry.get("2-Sub")?.status).toBe("idle");
		vi.advanceTimersByTime(1);
		await flushAsync();
		expect(registry.get("2-Sub")?.status).toBe("asleep");
		expect(stub.disposeCalls()).toBe(1);
	});

	/** Durable state lands before live teardown, followed by the ordinary registry lifecycle notification. */
	it("flushes before dispose and publishes the asleep transition", async () => {
		vi.useFakeTimers();
		const order: string[] = [];
		const stub = makeSessionStub(
			async () => {
				order.push("dispose");
			},
			async () => {
				order.push("persist");
			},
		);
		registerIdleSub("ordered", stub.session, "/tmp/ordered.jsonl");
		const unsubscribe = registry.onChange(event => {
			if (event.type === "status_changed" && event.ref.id === "ordered") {
				order.push(`status:${event.ref.status}`);
			}
		});
		lifecycle.adopt("ordered", { idleTtlMs: TTL });

		vi.advanceTimersByTime(TTL);
		await flushAsync();
		unsubscribe();

		expect(order).toEqual(["persist", "dispose", "status:asleep"]);
		expect(registry.get("ordered")).toMatchObject({
			status: "asleep",
			session: null,
			sessionFile: "/tmp/ordered.jsonl",
		});
	});

	/** A cohort shares one next-deadline timer and is drained without per-agent pollers. */
	it("uses one scheduler timer for multiple idle agents", async () => {
		vi.useFakeTimers();
		const first = makeSessionStub();
		const second = makeSessionStub();
		registerIdleSub("cohort-a", first.session);
		registerIdleSub("cohort-b", second.session);

		lifecycle.adopt("cohort-a", { idleTtlMs: TTL });
		lifecycle.adopt("cohort-b", { idleTtlMs: TTL });

		expect(vi.getTimerCount()).toBe(1);
		vi.advanceTimersByTime(TTL);
		await flushAsync();
		expect(registry.get("cohort-a")?.status).toBe("asleep");
		expect(registry.get("cohort-b")?.status).toBe("asleep");
	});

	it("ensureLive wakes an asleep agent through its reviver and flips it back to idle", async () => {
		const revived = makeSessionStub();
		registry.register({
			id: "3-Sub",
			displayName: "task",
			kind: "sub",
			session: null,
			sessionFile: "/tmp/3-Sub.jsonl",
			status: "asleep",
		});
		lifecycle.adopt("3-Sub", { idleTtlMs: 0, revive: async () => revived.session });

		const session = await lifecycle.ensureLive("3-Sub");

		expect(session).toBe(revived.session);
		const ref = registry.get("3-Sub");
		expect(ref?.status).toBe("idle");
		expect(ref?.session).toBe(revived.session);
		expect(ref?.sessionFile).toBe("/tmp/3-Sub.jsonl");
	});

	it("concurrent ensureLive calls during a slow revive coalesce into one reviver run", async () => {
		const gate = Promise.withResolvers<void>();
		const revived = makeSessionStub();
		let reviverRuns = 0;
		registry.register({
			id: "4-Sub",
			displayName: "task",
			kind: "sub",
			session: null,
			sessionFile: "/tmp/4-Sub.jsonl",
			status: "asleep",
		});
		lifecycle.adopt("4-Sub", {
			idleTtlMs: 0,
			revive: async () => {
				reviverRuns++;
				await gate.promise;
				return revived.session;
			},
		});

		const first = lifecycle.ensureLive("4-Sub");
		const second = lifecycle.ensureLive("4-Sub");
		gate.resolve();
		const [a, b] = await Promise.all([first, second]);

		expect(reviverRuns).toBe(1);
		expect(a).toBe(revived.session);
		expect(b).toBe(revived.session);
	});

	it("ensureLive on an unknown id throws and points at history://", async () => {
		await expect(lifecycle.ensureLive("9-Ghost")).rejects.toThrow(/history:\/\/9-Ghost/);
	});

	it("ensureLive on an asleep agent with no reviver throws and points at history://", async () => {
		registry.register({ id: "5-Sub", displayName: "task", kind: "sub", session: null, status: "asleep" });
		lifecycle.adopt("5-Sub", { idleTtlMs: 0 });

		await expect(lifecycle.ensureLive("5-Sub")).rejects.toThrow(
			'Agent "5-Sub" is asleep and cannot be woken (its transcript or workspace is gone). Read history://5-Sub for what it did.',
		);
	});

	/** A restored ref's model metadata selects its own cold-revive idle deadline. */
	it("ensureLive cold-wakes an asleep ref via the persisted factory and rejoins the lifecycle", async () => {
		vi.useFakeTimers();
		const revived = makeSessionStub();
		// Restored from disk (hub scan / resume): asleep with a sessionFile but NEVER adopted.
		registry.register({
			id: "6-Sub",
			displayName: "task",
			kind: "sub",
			session: null,
			sessionFile: "/tmp/6-Sub.jsonl",
			status: "asleep",
			model: "anthropic/claude-sonnet-4-5",
		});
		let factoryCalls = 0;
		lifecycle.setPersistedAgentReviverFactory(
			async () => {
				factoryCalls++;
				return async () => revived.session;
			},
			ref => (ref.model?.startsWith("anthropic/") ? TTL * 2 : TTL),
		);

		const session = await lifecycle.ensureLive("6-Sub");

		expect(factoryCalls).toBe(1);
		expect(session).toBe(revived.session);
		expect(registry.get("6-Sub")?.status).toBe("idle");
		expect(registry.get("6-Sub")?.session).toBe(revived.session);

		// The per-ref resolver selected 2 × TTL from the persisted model metadata.
		vi.advanceTimersByTime(TTL);
		await flushAsync();
		expect(registry.get("6-Sub")?.status).toBe("idle");
		vi.advanceTimersByTime(TTL);
		await flushAsync();
		expect(registry.get("6-Sub")?.status).toBe("asleep");
		expect(revived.disposeCalls()).toBe(1);
	});

	/**
	 * A woken ref falls asleep again on its idle TTL and is never dropped: however long
	 * it stays asleep, it is still registered and wakes again. An agent that cannot be
	 * woken a second time is the defect the asleep state replaced.
	 */
	it("a cold-woken ref falls asleep again and still wakes after any amount of time", async () => {
		vi.useFakeTimers();
		const first = makeSessionStub();
		const second = makeSessionStub();
		const sessions = [first.session, second.session];
		registry.register({
			id: "Cold-Stays",
			displayName: "task",
			kind: "sub",
			session: null,
			sessionFile: "/tmp/Cold-Stays.jsonl",
			status: "asleep",
		});
		lifecycle.setPersistedAgentReviverFactory(async () => async () => sessions.shift() as AgentSession, TTL);

		await lifecycle.ensureLive("Cold-Stays");
		vi.advanceTimersByTime(TTL);
		await flushAsync();
		expect(registry.get("Cold-Stays")?.status).toBe("asleep");

		vi.advanceTimersByTime(24 * 60 * 60_000);
		await flushAsync();
		expect(registry.get("Cold-Stays")?.status).toBe("asleep");

		expect(await lifecycle.ensureLive("Cold-Stays")).toBe(second.session);
		expect(registry.get("Cold-Stays")?.status).toBe("idle");
	});

	it("a persisted factory that declines leaves the asleep ref transcript-only", async () => {
		registry.register({
			id: "7-Sub",
			displayName: "task",
			kind: "sub",
			session: null,
			sessionFile: "/tmp/7-Sub.jsonl",
			status: "asleep",
		});
		lifecycle.setPersistedAgentReviverFactory(async () => undefined, TTL);

		await expect(lifecycle.ensureLive("7-Sub")).rejects.toThrow(
			/cannot be woken \(its transcript or workspace is gone\)/,
		);
	});

	it("a failed cold revive is not sticky: the next ensureLive re-runs the factory", async () => {
		const revived = makeSessionStub();
		registry.register({
			id: "8-Sub",
			displayName: "task",
			kind: "sub",
			session: null,
			sessionFile: "/tmp/8-Sub.jsonl",
			status: "asleep",
		});
		let factoryCalls = 0;
		lifecycle.setPersistedAgentReviverFactory(async () => {
			factoryCalls++;
			const failFirst = factoryCalls === 1;
			return async () => {
				if (failFirst) throw new Error("stale context");
				return revived.session;
			};
		}, TTL);

		await expect(lifecycle.ensureLive("8-Sub")).rejects.toThrow(/stale context/);
		expect(registry.get("8-Sub")?.status).toBe("asleep");

		const session = await lifecycle.ensureLive("8-Sub");
		expect(factoryCalls).toBe(2);
		expect(session).toBe(revived.session);
		expect(registry.get("8-Sub")?.status).toBe("idle");
	});

	it("release disposes a live adopted agent, unregisters it, and leaves no pending sleep", async () => {
		vi.useFakeTimers();
		const stub = makeSessionStub();
		registerIdleSub("6-Sub", stub.session);
		lifecycle.adopt("6-Sub", { idleTtlMs: TTL });

		await lifecycle.release("6-Sub");

		expect(stub.disposeCalls()).toBe(1);
		expect(registry.get("6-Sub")).toBeUndefined();
		expect(lifecycle.has("6-Sub")).toBe(false);

		// The disarmed timer must not fire a late sleep (which would double-dispose).
		vi.advanceTimersByTime(TTL * 10);
		await flushAsync();
		expect(stub.disposeCalls()).toBe(1);
		expect(registry.get("6-Sub")).toBeUndefined();
	});

	it("adopt(Main) is a no-op: Main is never adopted or put to sleep", async () => {
		vi.useFakeTimers();
		const stub = makeSessionStub();
		registry.register({
			id: MAIN_AGENT_ID,
			displayName: "main",
			kind: "main",
			session: stub.session,
			status: "idle",
		});
		lifecycle.adopt(MAIN_AGENT_ID, { idleTtlMs: TTL });

		expect(lifecycle.has(MAIN_AGENT_ID)).toBe(false);
		vi.advanceTimersByTime(TTL * 10);
		await flushAsync();
		expect(registry.get(MAIN_AGENT_ID)?.status).toBe("idle");
		expect(registry.get(MAIN_AGENT_ID)?.session).toBe(stub.session);
		expect(stub.disposeCalls()).toBe(0);
	});

	it("isFallingAsleep is true exactly while the sleep's dispose is in flight; asleep only after it completes", async () => {
		const gate = Promise.withResolvers<void>();
		const stub = makeSessionStub(() => gate.promise);
		registerIdleSub("7-Sub", stub.session);
		lifecycle.adopt("7-Sub", { idleTtlMs: 0 });

		// sleep() first flushes, then enters dispose(), which we hold open.
		const sleeping = lifecycle.sleep("7-Sub");
		await flushAsync();

		expect(stub.disposeCalls()).toBe(1);
		expect(lifecycle.isFallingAsleep("7-Sub")).toBe(true);
		expect(registry.get("7-Sub")).toBeDefined();
		expect(registry.get("7-Sub")?.status).toBe("idle"); // not yet flipped

		gate.resolve();
		await sleeping;

		expect(lifecycle.isFallingAsleep("7-Sub")).toBe(false);
		expect(registry.get("7-Sub")?.status).toBe("asleep");
		expect(registry.get("7-Sub")?.session).toBeNull();
	});

	it("idleTtlMs <= 0 adopts without a timer: the agent never falls asleep", async () => {
		vi.useFakeTimers();
		const stub = makeSessionStub();
		registerIdleSub("8-Sub", stub.session);
		lifecycle.adopt("8-Sub", { idleTtlMs: 0 });

		vi.advanceTimersByTime(60_000);
		await flushAsync();
		const ref = registry.get("8-Sub");
		expect(ref?.status).toBe("idle");
		expect(ref?.session).toBe(stub.session);
		expect(stub.disposeCalls()).toBe(0);
		expect(lifecycle.has("8-Sub")).toBe(true);
	});

	/**
	 * BUG: the cold-adopt compensation in `#resolveAndRevive` covered only the
	 * `#revive` call. The `ref.status !== "asleep"` re-check threw from OUTSIDE that
	 * try, so a ref whose status changed while `#persistedReviverFactory` was awaited
	 * left the reviver built from the STALE ref sitting in `#adopted` with no deadline
	 * armed. `#resolveAndRevive` prefers `#adopted.get(id)?.revive` over the factory,
	 * so that poisoned reviver is what every later wake would use, forever.
	 *
	 * If this regresses: the second ensureLive below reuses the stale reviver instead
	 * of rebuilding (factoryCalls stays 1) and `has()` reports an adoption that was
	 * never armed.
	 */
	it("drops the cold adoption when the ref's status changes during the reviver factory await", async () => {
		const gate = Promise.withResolvers<void>();
		const revived = makeSessionStub();
		registry.register({
			id: "Cold",
			displayName: "task",
			kind: "sub",
			session: null,
			sessionFile: "/tmp/Cold.jsonl",
			status: "asleep",
		});
		let factoryCalls = 0;
		lifecycle.setPersistedAgentReviverFactory(async () => {
			factoryCalls++;
			if (factoryCalls === 1) await gate.promise;
			return async () => revived.session;
		}, TTL);

		const waking = lifecycle.ensureLive("Cold");
		await flushAsync();
		// A collab mirror update flips the ref out of `asleep` while the factory is
		// still building a reviver from the ref as it was. A mirror copies the host's
		// status without the transition check, so `asleep → running` is reachable here.
		registry.mirrorStatus("Cold", "running");
		gate.resolve();

		await expect(waking).rejects.toThrow(
			'Agent "Cold" is running and cannot be woken. Read history://Cold for what it did.',
		);
		expect(factoryCalls).toBe(1);
		expect(lifecycle.has("Cold")).toBe(false);

		// The stale reviver is gone, so the next wake rebuilds through the factory.
		registry.setStatus("Cold", "asleep");
		const session = await lifecycle.ensureLive("Cold");
		expect(factoryCalls).toBe(2);
		expect(session).toBe(revived.session);
		expect(registry.get("Cold")?.status).toBe("idle");
	});

	/**
	 * A sleep on an agent that is already asleep is a no-op: it must not dispose the
	 * session a second time, and the agent must still wake afterwards.
	 */
	it("sleep() on an already-asleep agent disposes nothing and leaves it wakeable", async () => {
		vi.useFakeTimers();
		const stub = makeSessionStub();
		const woken = makeSessionStub();
		registerIdleSub("Twice", stub.session, "/tmp/Twice.jsonl");
		lifecycle.adopt("Twice", { idleTtlMs: TTL, revive: async () => woken.session });

		vi.advanceTimersByTime(TTL);
		await flushAsync();
		expect(registry.get("Twice")?.status).toBe("asleep");

		await lifecycle.sleep("Twice");
		expect(stub.disposeCalls()).toBe(1);
		expect(registry.get("Twice")?.status).toBe("asleep");

		expect(await lifecycle.ensureLive("Twice")).toBe(woken.session);
		expect(registry.get("Twice")?.status).toBe("idle");
	});
});
