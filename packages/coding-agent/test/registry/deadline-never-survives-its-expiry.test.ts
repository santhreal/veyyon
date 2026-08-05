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
 * one agent never parked, and no error anywhere. `arm`/`disarm` now write
 * `deadline` and `stage` as a pair and the expiry clears before it decides.
 *
 * WHY IT WAS INVISIBLE. Every functional assertion in the suite advances fake
 * time and then asks "did it park?". A spin never changes an agent's status, so it
 * changes no functional answer; it only burns the loop. The observable proxy for
 * "the deadline was actioned and then let go" is the SCHEDULING COUNT: a settled
 * manager stops arming timers, a spinning one arms them without bound. That count
 * is what these cases assert, alongside the park itself.
 *
 * IF THIS REGRESSES: one adopted subagent pins the event loop at 100% for the
 * lifetime of the process, and the agent it was supposed to park stays live
 * forever holding its session, MCP clients and file handles.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { AgentLifecycleManager } from "@veyyon/coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@veyyon/coding-agent/registry/agent-registry";
import type { AgentSession } from "@veyyon/coding-agent/session/agent-session";

/** Minimal durable session exposing the flush-before-dispose boundary park drives. */
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

/** Settle the async park chain (timer callback → park() → dispose → setStatus). */
async function flushAsync(): Promise<void> {
	for (let i = 0; i < 8; i++) await Promise.resolve();
}

const TTL = 20;
const CLOSE = 40;

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
	 * The park stage. One deadline in, one park out, and then SILENCE: with the
	 * close budget disabled a parked agent has no next stage, so the manager must
	 * arm nothing more. Advancing fifty further TTLs is the spin detector — the
	 * defect arms a timer on every one of them.
	 */
	it("parks on the due deadline and then arms no further timer", async () => {
		const stub = makeSessionStub();
		registerIdleSub("Settle", stub.session);
		lifecycle.adopt("Settle", { idleTtlMs: TTL });

		vi.advanceTimersByTime(TTL);
		await flushAsync();

		expect(registry.get("Settle")?.status).toBe("parked");
		expect(stub.disposeCalls()).toBe(1);
		const armedThroughPark = delays.length;

		vi.advanceTimersByTime(TTL * 50);
		await flushAsync();

		// The deadline was cleared, so there is nothing left to re-select. A spin
		// would have added one timer per turn of the loop.
		expect(delays.length).toBe(armedThroughPark);
		// And no arming was ever a zero-delay self-retrigger.
		expect(delays.filter(delay => delay === 0)).toEqual([]);
	});

	/**
	 * The two-stage walk, which is where a single uncleared entry does the most
	 * damage: the park expiry hands off to a close deadline, so the timer is armed
	 * again on purpose. That makes "the manager armed another timer" legitimate
	 * here, and the invariant becomes a BOUND: two stages cost a bounded number of
	 * arms and end with the ref gone, never an unbounded rearm at zero delay.
	 */
	it("walks idle → parked → closed on bounded arming, never a zero-delay rearm", async () => {
		const stub = makeSessionStub();
		registerIdleSub("Walk", stub.session);
		lifecycle.adopt("Walk", { idleTtlMs: TTL, closeParkedMs: CLOSE });

		vi.advanceTimersByTime(TTL);
		await flushAsync();
		expect(registry.get("Walk")?.status).toBe("parked");

		vi.advanceTimersByTime(CLOSE);
		await flushAsync();

		// Closed for good: the ref is dropped and the adoption released.
		expect(registry.get("Walk")).toBeUndefined();
		expect(lifecycle.has("Walk")).toBe(false);
		// Two real stages, so a handful of arms. A spin on either stage blows past this.
		expect(delays.length).toBeLessThanOrEqual(8);
		expect(delays.filter(delay => delay === 0)).toEqual([]);

		const armedThroughClose = delays.length;
		vi.advanceTimersByTime(CLOSE * 50);
		await flushAsync();
		expect(delays.length).toBe(armedThroughClose);
	});

	/**
	 * The refused park, which is the reachable shape of "an expiry that cannot act
	 * on what it read". The park deadline comes due while the agent is `running`, so
	 * `park()` declines. The expiry has already cleared the deadline, so nothing is
	 * left to re-read; the next idle transition arms a fresh one and THAT one parks.
	 * The old shape kept the stale deadline and spun until the agent went idle.
	 */
	it("re-derives from the ref after a park it could not perform, rather than re-reading a stale deadline", async () => {
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

		expect(registry.get("Busy")?.status).toBe("parked");
		expect(stub.disposeCalls()).toBe(1);
		// The running window cost no arming beyond the one status transition.
		expect(delays.length - armedWhileRunning).toBeLessThanOrEqual(3);
	});
});
