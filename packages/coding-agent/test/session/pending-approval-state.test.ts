import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { AgentRegistry, type RegistryEvent } from "@veyyon/coding-agent/registry/agent-registry";

/**
 * THE BUG THIS LOCKS OUT.
 *
 * A subagent stopped at an approval prompt is `running`, because it is mid-turn, and is
 * therefore indistinguishable by status from a subagent grinding through a build. Three
 * consumers get that wrong in three different ways, and all three were live:
 *
 *   - `subagent.maxRuntimeMs` ABORTS a child whose approval card is still on the
 *     operator's screen. The operator then answers a prompt for an agent that is already
 *     dead, and the work is lost with no report. A runtime budget is meant to bound the
 *     AGENT's work, not the human's reading speed.
 *   - the agent dashboard and the rosters cannot tell a blocked spawn from a busy one,
 *     so a permanently stuck agent renders as healthy.
 *   - the operator's prompt queue has nothing to attribute a request to, so the moment
 *     two children ask at once the ladder is unusable.
 *
 * `AgentRef.pendingApproval` is that state, and this file pins the three properties the
 * consumers depend on: it is OBSERVABLE (an event fires on both edges), it does not
 * masquerade as activity, and the waited time it reports is the TOTAL rather than only
 * whatever interval happens to be open.
 *
 * WHY THE ACCUMULATOR IS ASSERTED SEPARATELY. `since` alone under-credits. An agent that
 * answered three prompts and went back to work has no open interval at all, so a budget
 * reading only `pendingApprovalSince` charges it every second the operator spent
 * reading and aborts it for being slow at someone else's job. That near-miss is the
 * reason the banked total exists, so it gets its own cases rather than riding along.
 *
 * IF IT REGRESSES: subagents are killed for the operator's reading speed, and a blocked
 * agent looks identical to a working one right up until the operator gives up on it.
 */

const AGENT = "Worker";

function registry(): AgentRegistry {
	AgentRegistry.resetGlobalForTests();
	const reg = AgentRegistry.global();
	reg.register({ id: AGENT, displayName: "worker", kind: "sub", session: null, status: "running" });
	return reg;
}

let reg: AgentRegistry;
beforeEach(() => {
	// Fake timers, so every duration below is an EXACT number rather than a range with
	// a tolerance. The banked total is arithmetic over `Date.now()`, and asserting it
	// within a slop window would hide an off-by-one-interval bug inside the tolerance.
	vi.useFakeTimers();
	reg = registry();
});
afterEach(() => {
	vi.useRealTimers();
});

describe("a pending approval is observable state, not a private boolean", () => {
	/**
	 * The attribution. An unlabeled prompt from an anonymous agent is nearly as bad as no
	 * prompt: with two children asking at once the operator cannot tell which answer goes
	 * where. Asserted as the whole object so a field quietly dropped from the payload is
	 * a failure rather than an unnoticed `undefined` at the render site.
	 */
	it("carries the requesting tool and the reason, so a queued prompt can be attributed", () => {
		reg.setPendingApproval(AGENT, { toolName: "read", reason: "path leaves the working directory", since: 1_000 });

		expect(reg.get(AGENT)?.pendingApproval).toEqual({
			toolName: "read",
			reason: "path leaves the working directory",
			since: 1_000,
		});
	});

	/**
	 * Both EDGES emit. A dashboard that repaints only when an agent starts waiting shows
	 * a stale "blocked" badge forever after the prompt is answered, which is the same
	 * class of lie as not showing it at all.
	 */
	it("emits on both the start and the end of a wait", () => {
		const events: RegistryEvent["type"][] = [];
		const off = reg.onChange(event => {
			if (event.ref.id === AGENT) events.push(event.type);
		});

		reg.setPendingApproval(AGENT, { toolName: "bash", since: 1_000 });
		reg.setPendingApproval(AGENT, undefined);
		off();

		expect(events).toEqual(["status_changed", "status_changed"]);
	});

	/**
	 * And a redundant clear is silent, so a wrapper that clears in a `finally` on a path
	 * that never set the flag does not spam every roster in the process with repaints.
	 */
	it("emits nothing when clearing an agent that was not waiting", () => {
		const events: RegistryEvent["type"][] = [];
		const off = reg.onChange(event => {
			if (event.ref.id === AGENT) events.push(event.type);
		});

		reg.setPendingApproval(AGENT, undefined);
		off();

		expect(events).toEqual([]);
	});

	/**
	 * Waiting on a human is NOT agent activity. Bumping `lastActivity` here would push
	 * out the very deadlines measured from real work, so a long prompt would silently
	 * extend an idle TTL, which inverts the meaning of both.
	 *
	 * ADVANCING THE CLOCK IS LOAD-BEARING, not padding. Written without it this case
	 * was VACUOUS: `register` stamps `lastActivity` with `Date.now()`, and a mutation
	 * that re-stamps it inside `setPendingApproval` lands in the same millisecond, so
	 * before and after compared equal and the defect passed. Mutation-verified: adding
	 * `ref.lastActivity = Date.now()` to the setter left this green until the clock was
	 * forced to move. Any rewrite that stops moving it re-introduces the blind spot.
	 */
	it("does not count as activity", () => {
		const before = reg.get(AGENT)?.lastActivity as number;
		vi.advanceTimersByTime(5_000);

		reg.setPendingApproval(AGENT, { toolName: "bash", since: before });
		reg.setPendingApproval(AGENT, undefined);

		expect(reg.get(AGENT)?.lastActivity).toBe(before);
	});

	/** An unknown id is a no-op rather than a throw: the wrapper clears unconditionally. */
	it("ignores an id that is not registered", () => {
		reg.setPendingApproval("NoSuchAgent", { toolName: "bash", since: 1_000 });

		expect(reg.pendingApprovalSince("NoSuchAgent")).toBeUndefined();
		expect(reg.approvalWaitedMs("NoSuchAgent")).toBe(0);
	});
});

describe("the waited time a runtime budget must exclude", () => {
	/** Nothing waited yet is 0, not undefined: the value is only ever summed. */
	it("reports zero before any wait, so a caller cannot sum undefined into NaN", () => {
		expect(reg.approvalWaitedMs(AGENT)).toBe(0);
		expect(reg.pendingApprovalSince(AGENT)).toBeUndefined();
		// The concrete consequence of getting this wrong: NaN compares false against
		// every budget comparison, which disables the abort entirely rather than
		// mis-timing it.
		expect(Number.isNaN(reg.approvalWaitedMs(AGENT) + 1)).toBe(false);
	});

	/** An OPEN wait is reported through `since`, and is not yet banked. */
	it("reports an open wait through since and banks nothing for it yet", () => {
		reg.setPendingApproval(AGENT, { toolName: "bash", since: Date.now() });
		vi.advanceTimersByTime(5_000);

		expect(reg.approvalWaitedMs(AGENT)).toBe(0);
		expect(Date.now() - (reg.pendingApprovalSince(AGENT) as number)).toBe(5_000);
	});

	/**
	 * THE UNDER-CREDIT DEFECT, stated directly. Three prompts answered, none open. A
	 * budget reading only `pendingApprovalSince` sees nothing to exclude and charges the
	 * agent the operator's entire reading time, then aborts it for being slow at a job
	 * that was not its own.
	 */
	it("banks every closed wait, so an agent that answered and resumed is still credited", () => {
		for (let i = 0; i < 3; i += 1) {
			reg.setPendingApproval(AGENT, { toolName: "bash", since: Date.now() });
			vi.advanceTimersByTime(40_000);
			reg.setPendingApproval(AGENT, undefined);
		}

		// No open interval at all: `since` alone would report nothing to exclude.
		expect(reg.pendingApprovalSince(AGENT)).toBeUndefined();
		// Exact, because the clock is driven rather than observed.
		expect(reg.approvalWaitedMs(AGENT)).toBe(120_000);
	});

	/**
	 * The composition a budget actually performs: banked closed waits PLUS the open one.
	 * Two closed and one open is the multi-prompt case, and it is the shape that fails
	 * if either half is dropped.
	 */
	it("composes banked and open intervals into the full exclusion", () => {
		for (const waited of [30_000, 20_000]) {
			reg.setPendingApproval(AGENT, { toolName: "bash", since: Date.now() });
			vi.advanceTimersByTime(waited);
			reg.setPendingApproval(AGENT, undefined);
		}
		reg.setPendingApproval(AGENT, { toolName: "edit", since: Date.now() });
		vi.advanceTimersByTime(10_000);

		const since = reg.pendingApprovalSince(AGENT);
		const excluded = reg.approvalWaitedMs(AGENT) + (since === undefined ? 0 : Date.now() - since);

		// 30s + 20s banked, 10s still open.
		expect(reg.approvalWaitedMs(AGENT)).toBe(50_000);
		expect(excluded).toBe(60_000);
	});

	/**
	 * A clock that steps backwards must never REDUCE the banked total. A negative
	 * contribution would make the exclusion smaller than waits already recorded, which
	 * is worse than not counting the interval at all: it would retroactively re-charge
	 * the agent for time it had already been credited, so answering a prompt could
	 * bring an agent CLOSER to being aborted than not answering it.
	 */
	it("never subtracts from the banked total when the clock steps backwards", () => {
		reg.setPendingApproval(AGENT, { toolName: "bash", since: Date.now() });
		vi.advanceTimersByTime(10_000);
		reg.setPendingApproval(AGENT, undefined);
		expect(reg.approvalWaitedMs(AGENT)).toBe(10_000);

		// A `since` in the FUTURE is what a backwards clock step looks like on clear.
		reg.setPendingApproval(AGENT, { toolName: "bash", since: Date.now() + 60_000 });
		reg.setPendingApproval(AGENT, undefined);

		expect(reg.approvalWaitedMs(AGENT)).toBe(10_000);
	});
});
