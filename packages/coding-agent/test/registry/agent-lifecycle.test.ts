import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { AgentLifecycleManager } from "@veyyon/coding-agent/registry/agent-lifecycle";
import { AgentRegistry, MAIN_AGENT_ID } from "@veyyon/coding-agent/registry/agent-registry";
import type { AgentSession } from "@veyyon/coding-agent/session/agent-session";

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

function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve!: () => void;
	const promise = new Promise<void>(r => {
		resolve = r;
	});
	return { promise, resolve };
}

/** Settle the async park chain (timer callback → park() → dispose → setStatus). */
async function flushAsync(): Promise<void> {
	for (let i = 0; i < 5; i++) await Promise.resolve();
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
	 * reference while closing only the live session.
	 */
	it("parks an idle agent exactly at its deadline and retains its transcript reference", async () => {
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
		expect(ref?.status).toBe("parked");
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
		expect(registry.get("2-Sub")?.status).toBe("parked");
		expect(stub.disposeCalls()).toBe(1);
	});

	/** Durable state lands before live teardown, followed by the ordinary registry lifecycle notification. */
	it("flushes before close and publishes the parked transition", async () => {
		vi.useFakeTimers();
		const order: string[] = [];
		const stub = makeSessionStub(
			async () => {
				order.push("close");
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

		expect(order).toEqual(["persist", "close", "status:parked"]);
		expect(registry.get("ordered")).toMatchObject({
			status: "parked",
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
		expect(registry.get("cohort-a")?.status).toBe("parked");
		expect(registry.get("cohort-b")?.status).toBe("parked");
	});

	it("ensureLive revives a parked agent through its reviver and flips it back to idle", async () => {
		const revived = makeSessionStub();
		registry.register({
			id: "3-Sub",
			displayName: "task",
			kind: "sub",
			session: null,
			sessionFile: "/tmp/3-Sub.jsonl",
			status: "parked",
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
		const gate = deferred();
		const revived = makeSessionStub();
		let reviverRuns = 0;
		registry.register({
			id: "4-Sub",
			displayName: "task",
			kind: "sub",
			session: null,
			sessionFile: "/tmp/4-Sub.jsonl",
			status: "parked",
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

	it("ensureLive on a parked agent without a reviver throws as not revivable", async () => {
		registry.register({ id: "5-Sub", displayName: "task", kind: "sub", session: null, status: "parked" });
		lifecycle.adopt("5-Sub", { idleTtlMs: 0 });

		await expect(lifecycle.ensureLive("5-Sub")).rejects.toThrow(/cannot be revived.*no reviver registered/);
	});

	/** A restored ref's model metadata selects its own cold-revive idle deadline. */
	it("ensureLive cold-revives a parked ref via the persisted factory and rejoins the lifecycle", async () => {
		vi.useFakeTimers();
		const revived = makeSessionStub();
		// Restored from disk (hub scan / resume): parked with a sessionFile but NEVER adopted.
		registry.register({
			id: "6-Sub",
			displayName: "task",
			kind: "sub",
			session: null,
			sessionFile: "/tmp/6-Sub.jsonl",
			status: "parked",
			model: "anthropic/claude-sonnet-4-5",
		});
		let factoryCalls = 0;
		lifecycle.setPersistedSubagentReviverFactory(
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
		expect(registry.get("6-Sub")?.status).toBe("parked");
		expect(revived.disposeCalls()).toBe(1);
	});

	/**
	 * A ref revived from disk must rejoin the CLOSE stage, not just the park stage.
	 *
	 * It used to be cold-adopted with both close budgets hardcoded to zero, so an agent
	 * restored from disk and woken once parked on its idle TTL and then stayed listed for
	 * the rest of the session whatever `subagent.autoClose.*` said. Resume a session,
	 * message a few old agents, and the roster grew monotonically, which is the one thing
	 * the close stage exists to prevent. Locks the budgets travelling through the same
	 * injected seam as the idle TTL.
	 */
	it("closes a cold-revived ref on the injected close budget instead of listing it forever", async () => {
		vi.useFakeTimers();
		const revived = makeSessionStub();
		registry.register({
			id: "Cold-Closes",
			displayName: "task",
			kind: "sub",
			session: null,
			sessionFile: "/tmp/Cold-Closes.jsonl",
			status: "parked",
		});
		lifecycle.setPersistedSubagentReviverFactory(async () => async () => revived.session, TTL, {
			parkedMs: TTL * 3,
			waitingMs: TTL * 3,
		});

		await lifecycle.ensureLive("Cold-Closes");
		expect(registry.get("Cold-Closes")?.status).toBe("idle");

		// Parks on the idle TTL, exactly as before.
		vi.advanceTimersByTime(TTL);
		await flushAsync();
		expect(registry.get("Cold-Closes")?.status).toBe("parked");

		// And is then CLOSED on the injected budget. Before the fix it stayed parked here
		// forever, so this is the assertion that goes red on a hardcoded zero.
		vi.advanceTimersByTime(TTL * 3);
		await flushAsync();
		expect(registry.get("Cold-Closes")).toBeUndefined();
		expect(lifecycle.has("Cold-Closes")).toBe(false);
	});

	/**
	 * A cold-revived ref that stopped to wait on a peer gets the LONGER budget.
	 *
	 * The waiting budget exists because an agent that stopped to let a peer finish is the
	 * one you are most likely to message next. That reasoning does not stop applying just
	 * because the ref came from disk, so the waiting budget has to survive the cold-adopt
	 * path too rather than collapsing to the quiet one.
	 */
	it("spends the waiting budget on a cold-revived ref that is waiting on a peer", async () => {
		vi.useFakeTimers();
		const revived = makeSessionStub();
		registry.register({
			id: "Cold-Waits",
			displayName: "task",
			kind: "sub",
			session: null,
			sessionFile: "/tmp/Cold-Waits.jsonl",
			status: "parked",
		});
		lifecycle.setPersistedSubagentReviverFactory(async () => async () => revived.session, TTL, {
			parkedMs: TTL * 2,
			waitingMs: TTL * 6,
		});

		await lifecycle.ensureLive("Cold-Waits");
		registry.setWaitingOnPeer("Cold-Waits", true);
		vi.advanceTimersByTime(TTL);
		await flushAsync();
		expect(registry.get("Cold-Waits")?.status).toBe("parked");

		// The quiet budget has elapsed and it is STILL listed, because the waiting budget
		// is the one being spent.
		vi.advanceTimersByTime(TTL * 2);
		await flushAsync();
		expect(registry.get("Cold-Waits")?.status).toBe("parked");

		vi.advanceTimersByTime(TTL * 4);
		await flushAsync();
		expect(registry.get("Cold-Waits")).toBeUndefined();
	});

	/**
	 * A host that installs a factory WITHOUT budgets keeps the old never-close behaviour.
	 *
	 * The control for the two cases above. ACP installs no factory at all and other
	 * embedders may install one without budgets, so the default must not silently acquire
	 * a close stage nobody asked for. This also stops the two tests above from passing
	 * because closing became unconditional.
	 */
	it("never closes a cold-revived ref when the host injected no close budget", async () => {
		vi.useFakeTimers();
		const revived = makeSessionStub();
		registry.register({
			id: "Cold-Stays",
			displayName: "task",
			kind: "sub",
			session: null,
			sessionFile: "/tmp/Cold-Stays.jsonl",
			status: "parked",
		});
		lifecycle.setPersistedSubagentReviverFactory(async () => async () => revived.session, TTL);

		await lifecycle.ensureLive("Cold-Stays");
		vi.advanceTimersByTime(TTL);
		await flushAsync();
		expect(registry.get("Cold-Stays")?.status).toBe("parked");

		vi.advanceTimersByTime(TTL * 100);
		await flushAsync();
		expect(registry.get("Cold-Stays")?.status).toBe("parked");
	});

	it("a persisted factory that declines leaves the parked ref transcript-only", async () => {
		registry.register({
			id: "7-Sub",
			displayName: "task",
			kind: "sub",
			session: null,
			sessionFile: "/tmp/7-Sub.jsonl",
			status: "parked",
		});
		lifecycle.setPersistedSubagentReviverFactory(async () => undefined, TTL);

		await expect(lifecycle.ensureLive("7-Sub")).rejects.toThrow(/cannot be revived.*no reviver registered/);
	});

	it("a failed cold revive is not sticky: the next ensureLive re-runs the factory", async () => {
		const revived = makeSessionStub();
		registry.register({
			id: "8-Sub",
			displayName: "task",
			kind: "sub",
			session: null,
			sessionFile: "/tmp/8-Sub.jsonl",
			status: "parked",
		});
		let factoryCalls = 0;
		lifecycle.setPersistedSubagentReviverFactory(async () => {
			factoryCalls++;
			const failFirst = factoryCalls === 1;
			return async () => {
				if (failFirst) throw new Error("stale context");
				return revived.session;
			};
		}, TTL);

		await expect(lifecycle.ensureLive("8-Sub")).rejects.toThrow(/stale context/);
		expect(registry.get("8-Sub")?.status).toBe("parked");

		const session = await lifecycle.ensureLive("8-Sub");
		expect(factoryCalls).toBe(2);
		expect(session).toBe(revived.session);
		expect(registry.get("8-Sub")?.status).toBe("idle");
	});

	it("release disposes a live adopted agent, unregisters it, and leaves no pending park", async () => {
		vi.useFakeTimers();
		const stub = makeSessionStub();
		registerIdleSub("6-Sub", stub.session);
		lifecycle.adopt("6-Sub", { idleTtlMs: TTL });

		await lifecycle.release("6-Sub");

		expect(stub.disposeCalls()).toBe(1);
		expect(registry.get("6-Sub")).toBeUndefined();
		expect(lifecycle.has("6-Sub")).toBe(false);

		// The disarmed timer must not fire a late park (which would double-dispose).
		vi.advanceTimersByTime(TTL * 10);
		await flushAsync();
		expect(stub.disposeCalls()).toBe(1);
		expect(registry.get("6-Sub")).toBeUndefined();
	});

	it("adopt(Main) is a no-op: Main is never adopted or parked", async () => {
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

	it("isParking is true exactly while park's dispose is in flight; parked only after it completes", async () => {
		const gate = deferred();
		const stub = makeSessionStub(() => gate.promise);
		registerIdleSub("7-Sub", stub.session);
		lifecycle.adopt("7-Sub", { idleTtlMs: 0 });

		// park() first flushes, then enters dispose(), which we hold open.
		const parking = lifecycle.park("7-Sub");
		await flushAsync();

		expect(stub.disposeCalls()).toBe(1);
		expect(lifecycle.isParking("7-Sub")).toBe(true);
		expect(registry.get("7-Sub")).toBeDefined();
		expect(registry.get("7-Sub")?.status).toBe("idle"); // not yet flipped

		gate.resolve();
		await parking;

		expect(lifecycle.isParking("7-Sub")).toBe(false);
		expect(registry.get("7-Sub")?.status).toBe("parked");
		expect(registry.get("7-Sub")?.session).toBeNull();
	});

	it("idleTtlMs <= 0 adopts without a timer: the agent never parks", async () => {
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
	 * `#revive` call. The `ref.status !== "parked"` re-check threw from OUTSIDE that
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
		const gate = deferred();
		const revived = makeSessionStub();
		registry.register({
			id: "Cold",
			displayName: "task",
			kind: "sub",
			session: null,
			sessionFile: "/tmp/Cold.jsonl",
			status: "parked",
		});
		let factoryCalls = 0;
		lifecycle.setPersistedSubagentReviverFactory(async () => {
			factoryCalls++;
			if (factoryCalls === 1) await gate.promise;
			return async () => revived.session;
		}, TTL);

		const waking = lifecycle.ensureLive("Cold");
		await flushAsync();
		// A collab mirror update / re-registration flips the ref out of `parked` while
		// the factory is still building a reviver from the ref as it was.
		registry.setStatus("Cold", "running");
		gate.resolve();

		await expect(waking).rejects.toThrow(
			'Agent "Cold" is running and cannot be revived. Its transcript remains readable at history://Cold.',
		);
		expect(factoryCalls).toBe(1);
		expect(lifecycle.has("Cold")).toBe(false);

		// The stale reviver is gone, so the next wake rebuilds through the factory.
		registry.setStatus("Cold", "parked");
		const session = await lifecycle.ensureLive("Cold");
		expect(factoryCalls).toBe(2);
		expect(session).toBe(revived.session);
		expect(registry.get("Cold")?.status).toBe("idle");
	});

	/**
	 * BUG: `#revive` re-read the ref only to ask whether it had been RELEASED. A ref
	 * flipped to `aborted` mid-revive was resurrected: the abort's dispose ran against
	 * a parked ref and therefore against no session, then `#revive` attached the
	 * freshly rebuilt one and set `idle`. That session is a leaked process, MCP client
	 * and file-handle set for the rest of the run, and the terminal agent is back in
	 * the roster.
	 *
	 * If this regresses: the wake resolves instead of rejecting, `disposeCalls()` is 0
	 * and the ref reads `idle` with a live session.
	 */
	it("refuses the wake and disposes the rebuilt session when the ref is aborted mid-revive", async () => {
		const gate = deferred();
		const revived = makeSessionStub();
		registry.register({
			id: "Killed",
			displayName: "task",
			kind: "sub",
			session: null,
			sessionFile: "/tmp/Killed.jsonl",
			status: "parked",
		});
		lifecycle.adopt("Killed", {
			idleTtlMs: 0,
			revive: async () => {
				await gate.promise;
				return revived.session;
			},
		});

		const waking = lifecycle.ensureLive("Killed");
		await flushAsync();
		registry.setStatus("Killed", "aborted");
		gate.resolve();

		await expect(waking).rejects.toThrow(
			'Agent "Killed" was terminated while it was being revived. Its transcript remains readable at history://Killed.',
		);
		expect(revived.disposeCalls()).toBe(1);
		expect(registry.get("Killed")?.status).toBe("aborted");
		expect(registry.get("Killed")?.session).toBeNull();
	});

	/**
	 * BUG: `park()` disarmed the deadline and rescheduled BEFORE checking whether the
	 * agent was parkable at all. Called on an already-parked agent it wiped the armed
	 * close deadline and returned without re-arming, and `parked` is a stable state,
	 * so no later `status_changed` ever re-derived one: the agent stayed listed for
	 * the rest of the run and never closed.
	 *
	 * If this regresses: the close below never fires and the ref is still registered.
	 */
	it("park() on an already-parked agent leaves its close deadline armed", async () => {
		vi.useFakeTimers();
		const stub = makeSessionStub();
		registerIdleSub("Twice", stub.session, "/tmp/Twice.jsonl");
		lifecycle.adopt("Twice", { idleTtlMs: TTL, closeParkedMs: TTL * 5 });

		vi.advanceTimersByTime(TTL);
		await flushAsync();
		expect(registry.get("Twice")?.status).toBe("parked");

		// A second park on a ref that is already parked must be a pure no-op.
		await lifecycle.park("Twice");
		expect(stub.disposeCalls()).toBe(1);

		vi.advanceTimersByTime(TTL * 5);
		await flushAsync();
		expect(registry.get("Twice")).toBeUndefined();
		expect(lifecycle.has("Twice")).toBe(false);
	});

	/**
	 * BUG: `close()` refused a reviving agent and then re-derived its deadline through
	 * `#refreshDeadline`. The ref is still `parked` during a revive, so the derivation
	 * produced `lastActivity + closeParkedMs` — the very instant that had just fired —
	 * and `#scheduleNext` armed a `setTimeout` of 0. That timer re-entered `close`,
	 * which refused and armed 0 again: a hot loop for the whole duration of the wake,
	 * starving the event loop the revive is waiting on. The operator sees veyyon peg a
	 * core and hang the moment they message a long-parked agent.
	 *
	 * If this regresses: `close` is re-entered once per millisecond for the whole
	 * revive, and the failed-revive close below never fires because nothing else
	 * re-examines a ref whose revive threw.
	 */
	it("close() during an in-flight revive arms a future re-check instead of spinning", async () => {
		vi.useFakeTimers();
		registry.register({
			id: "Waking",
			displayName: "task",
			kind: "sub",
			session: null,
			sessionFile: "/tmp/Waking.jsonl",
			status: "parked",
		});
		const gate = Promise.withResolvers<AgentSession>();
		lifecycle.adopt("Waking", { idleTtlMs: 0, closeParkedMs: TTL, revive: () => gate.promise });
		const closeCalls = vi.spyOn(lifecycle, "close");

		const waking = lifecycle.ensureLive("Waking");
		await flushAsync();

		// Drive the clock past the close budget one millisecond at a time, draining the
		// scheduler's async expiry drain between steps, while the wake is still
		// rebuilding the session. The spin needs exactly this interleaving to show up.
		for (let elapsed = 0; elapsed < TTL * 5; elapsed++) {
			vi.advanceTimersByTime(1);
			await flushAsync();
		}

		// One refusal, not one per millisecond.
		expect(closeCalls).toHaveBeenCalledTimes(1);
		expect(registry.get("Waking")?.status).toBe("parked");

		// A revive that THROWS leaves the ref `parked` with no status change, so the
		// re-check armed by that refusal is the only thing that can ever close it.
		gate.reject(new Error("stale context"));
		await expect(waking).rejects.toThrow("stale context");
		for (let elapsed = 0; elapsed < 1_000; elapsed += TTL) {
			vi.advanceTimersByTime(TTL);
			await flushAsync();
		}

		expect(registry.get("Waking")).toBeUndefined();
		expect(lifecycle.has("Waking")).toBe(false);
	});
});
