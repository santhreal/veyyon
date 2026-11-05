/**
 * A due deadline never survives its own expiry unactioned.
 *
 * THE BUG THIS LOCKS OUT. `AgentLifecycleManager` runs ONE process-wide timer
 * armed at the nearest deadline. The expiry callback walked `#adopted`, and for a
 * due entry whose `stage` it could not classify it `continue`d — leaving the
 * deadline in place. `#scheduleNext` then ran immediately after, re-selected that
 * same already-past deadline as the nearest wake, computed
 * `Math.max(0, past - now)` = 0, and armed another timer. Which fired at once.
 * Which found the same entry. Forever: a hot loop rearming a zero-delay timer,
 * one agent never put to sleep, and no error anywhere. The expiry now clears the
 * deadline before it decides.
 *
 * WHY IT WAS INVISIBLE. Every functional assertion in the suite advances fake
 * time and then asks "did it fall asleep?". A spin never changes an agent's status, so it
 * changes no functional answer; it only burns the loop. The observable proxy for
 * "the deadline was actioned and then let go" is the SCHEDULING COUNT: a settled
 * manager stops arming timers, a spinning one arms them without bound. That count
 * is what these cases assert, alongside the sleep itself.
 *
 * IF THIS REGRESSES: one adopted agent pins the event loop at 100% for the
 * lifetime of the process, and the agent it was supposed to put to sleep stays live
 * forever holding its session, MCP clients and file handles.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { AgentLifecycleManager } from "@veyyon/coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@veyyon/coding-agent/registry/agent-registry";
import type { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import { drainMicrotasks } from "../../../utils/test/helpers/drain-microtasks";

/** Minimal durable session exposing the flush-before-dispose boundary a sleep drives. */
function makeSessionStub(): { session: AgentSession; disposeCalls: () => number } {
	let disposeCount = 0;
	const stub = {
		sessionManager: { flush: async () => {} },
		dispose: async () => {
			disposeCount++;
		},
	};
	return { session: stub as unknown as AgentSession, disposeCalls: () => disposeCount };
}

/** Settle the async sleep chain (timer callback → sleep() → dispose → setStatus). */
async function flushAsync(): Promise<void> {
	await drainMicrotasks(8);
}

const TTL = 20;

describe("a due deadline is always cleared by the expiry that reads it", () => {
	let registry: AgentRegistry;
	let lifecycle: AgentLifecycleManager;
	/** Every delay the manager asked the (fake) clock for, in order. */
	let delays: number[];

	beforeEach(() => {
		AgentRegistry.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();
		registry = AgentRegistry.global();
		lifecycle = AgentLifecycleManager.global();
		vi.useFakeTimers();
		delays = [];
		// Wrap the FAKE timer installed just above, so the count measures scheduling
		// decisions rather than wall-clock behavior. Restored per test in afterEach,
		// so no later suite sees a patched global.
		const inner = globalThis.setTimeout;
		vi.spyOn(globalThis, "setTimeout").mockImplementation(((
			handler: Parameters<typeof setTimeout>[0],
			delay?: number,
			...args: unknown[]
		) => {
			delays.push(delay ?? 0);
			return (inner as typeof setTimeout)(handler, delay, ...args);
		}) as typeof setTimeout);
	});

	afterEach(() => {
		vi.restoreAllMocks();
		vi.useRealTimers();
		AgentLifecycleManager.resetGlobalForTests();
		AgentRegistry.resetGlobalForTests();
	});

	function registerIdleSub(id: string, session: AgentSession | null) {
		return registry.register({
			id,
			displayName: "task",
			kind: "sub",
			session,
			sessionFile: `/tmp/${id}.jsonl`,
			status: "idle",
		});
	}

	/**
	 * One deadline in, one sleep out, and then SILENCE: an asleep agent has no
	 * next stage, so the manager must arm nothing more. Advancing fifty further
	 * TTLs is the spin detector — the defect arms a timer on every one of them.
	 */
	it("falls asleep on the due deadline and then arms no further timer", async () => {
		const stub = makeSessionStub();
		registerIdleSub("Settle", stub.session);
		lifecycle.adopt("Settle", { idleTtlMs: TTL });

		vi.advanceTimersByTime(TTL);
		await flushAsync();

		expect(registry.get("Settle")?.status).toBe("asleep");
		expect(stub.disposeCalls()).toBe(1);
		const armedThroughSleep = delays.length;

		vi.advanceTimersByTime(TTL * 50);
		await flushAsync();

		// The deadline was cleared, so there is nothing left to re-select. A spin
		// would have added one timer per turn of the loop.
		expect(delays.length).toBe(armedThroughSleep);
		// And no arming was ever a zero-delay self-retrigger.
		expect(delays.filter(delay => delay === 0)).toEqual([]);
	});

	/**
	 * The full cycle, which arms the timer again on purpose: a wake makes the agent
	 * idle, so a fresh deadline is legitimate. The invariant becomes a BOUND: a
	 * sleep, a wake and a second sleep cost a bounded number of arms and end in
	 * silence, never an unbounded rearm at zero delay.
	 */
	it("walks idle → asleep → woken → asleep on bounded arming, never a zero-delay rearm", async () => {
		const first = makeSessionStub();
		const second = makeSessionStub();
		registerIdleSub("Walk", first.session);
		lifecycle.adopt("Walk", { idleTtlMs: TTL, revive: async () => second.session });

		vi.advanceTimersByTime(TTL);
		await flushAsync();
		expect(registry.get("Walk")?.status).toBe("asleep");

		expect(await lifecycle.ensureLive("Walk")).toBe(second.session);
		expect(registry.get("Walk")?.status).toBe("idle");

		vi.advanceTimersByTime(TTL);
		await flushAsync();
		expect(registry.get("Walk")?.status).toBe("asleep");
		expect(second.disposeCalls()).toBe(1);
		// The agent is still adopted: the next message wakes it again.
		expect(lifecycle.has("Walk")).toBe(true);
		expect(delays.length).toBeLessThanOrEqual(8);
		expect(delays.filter(delay => delay === 0)).toEqual([]);

		const armedThroughCycle = delays.length;
		vi.advanceTimersByTime(TTL * 50);
		await flushAsync();
		expect(delays.length).toBe(armedThroughCycle);
	});

	/**
	 * The refused sleep, which is the reachable shape of "an expiry that cannot act
	 * on what it read". The deadline comes due while the agent is `running`, so
	 * `sleep()` declines. The expiry has already cleared the deadline, so nothing is
	 * left to re-read; the next idle transition arms a fresh one and THAT one sleeps.
	 * The old shape kept the stale deadline and spun until the agent went idle.
	 */
	it("re-derives from the ref after a sleep it could not perform, rather than re-reading a stale deadline", async () => {
		const stub = makeSessionStub();
		registerIdleSub("Busy", stub.session);
		lifecycle.adopt("Busy", { idleTtlMs: TTL });

		// A follow-up turn starts one tick before the deadline would have fired.
		vi.advanceTimersByTime(TTL - 1);
		registry.setStatus("Busy", "running");
		vi.advanceTimersByTime(TTL * 20);
		await flushAsync();

		expect(registry.get("Busy")?.status).toBe("running");
		expect(stub.disposeCalls()).toBe(0);
		expect(delays.filter(delay => delay === 0)).toEqual([]);
		const armedWhileRunning = delays.length;

		// Going idle again arms a fresh budget from the new activity timestamp.
		registry.setStatus("Busy", "idle");
		vi.advanceTimersByTime(TTL);
		await flushAsync();

		expect(registry.get("Busy")?.status).toBe("asleep");
		expect(stub.disposeCalls()).toBe(1);
		// The running window cost no arming beyond the one status transition.
		expect(delays.length - armedWhileRunning).toBeLessThanOrEqual(3);
	});
});
