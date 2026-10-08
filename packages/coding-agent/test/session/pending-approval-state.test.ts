import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { AgentRegistry, type RegistryEvent } from "@veyyon/coding-agent/registry/agent-registry";

/**
 * THE BUG THIS LOCKS OUT.
 *
 * An agent stopped at an approval prompt is `running`, because it is mid-turn, and is
 * therefore indistinguishable by status from an agent grinding through a build. Three
 * consumers get that wrong in three different ways, and all three were live:
 *
 *   - `agent.maxRuntimeMs` ABORTS a child whose approval card is still on the
 *     operator's screen. The operator then answers a prompt for an agent that is already
 *     dead, and the work is lost with no report. A runtime budget is meant to bound the
 *     AGENT's work, not the human's reading speed.
 *   - the agent dashboard and the rosters cannot tell a blocked spawn from a busy one,
 *     so a permanently stuck agent renders as healthy.
 *   - the operator's prompt queue has nothing to attribute a request to, so the moment
 *     two children ask at once the ladder is unusable.
 *
 * `AgentRef.pendingApproval` is that state, and this file pins the four properties the
 * consumers depend on: it is OBSERVABLE (an event fires on both edges), it does not
 * masquerade as activity, the waited time it reports is the TOTAL rather than only
 * whatever interval happens to be open, and overlapping waits of one agent count as one
 * span that ends only when the last of them closes.
 *
 * WHY THE ACCUMULATOR IS ASSERTED SEPARATELY. `since` alone under-credits. An agent that
 * answered three prompts and went back to work has no open interval at all, so a budget
 * reading only `pendingApprovalSince` charges it every second the operator spent
 * reading and aborts it for being slow at someone else's job. That near-miss is the
 * reason the banked total exists, so it gets its own cases rather than riding along.
 *
 * IF IT REGRESSES: agents are killed for the operator's reading speed, and a blocked
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
		reg.openApprovalWait(AGENT, { toolName: "read", reason: "path leaves the working directory", since: 1_000 });

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

		const close = reg.openApprovalWait(AGENT, { toolName: "bash", since: 1_000 });
		close();
		off();

		expect(events).toEqual(["status_changed", "status_changed"]);
	});

	/**
	 * And a redundant close is silent, so a caller that closes in a `finally` after an
	 * earlier close does not spam every roster in the process with repaints, nor bank the
	 * interval twice.
	 */
	it("emits and banks nothing when a closed wait is closed again", () => {
		const close = reg.openApprovalWait(AGENT, { toolName: "bash", since: Date.now() });
		vi.advanceTimersByTime(5_000);
		close();
		const events: RegistryEvent["type"][] = [];
		const off = reg.onChange(event => {
			if (event.ref.id === AGENT) events.push(event.type);
		});

		vi.advanceTimersByTime(5_000);
		close();
		off();

		expect(events).toEqual([]);
		expect(reg.approvalWaitedMs(AGENT)).toBe(5_000);
	});

	/**
	 * Waiting on a human is NOT agent activity. Bumping `lastActivity` here would push
	 * out the very deadlines measured from real work, so a long prompt would silently
	 * extend an idle TTL, which inverts the meaning of both.
	 *
	 * ADVANCING THE CLOCK IS LOAD-BEARING, not padding. Written without it this case
	 * was VACUOUS: `register` stamps `lastActivity` with `Date.now()`, and a mutation
	 * that re-stamps it inside `openApprovalWait` lands in the same millisecond, so
	 * before and after compared equal and the defect passed. Mutation-verified: adding
	 * `ref.lastActivity = Date.now()` to the setter left this green until the clock was
	 * forced to move. Any rewrite that stops moving it re-introduces the blind spot.
	 */
	it("does not count as activity", () => {
		const before = reg.get(AGENT)?.lastActivity as number;
		vi.advanceTimersByTime(5_000);

		reg.openApprovalWait(AGENT, { toolName: "bash", since: before })();

		expect(reg.get(AGENT)?.lastActivity).toBe(before);
	});

	/** An unknown id is a no-op rather than a throw: the wrapper closes unconditionally. */
	it("ignores an id that is not registered", () => {
		reg.openApprovalWait("NoSuchAgent", { toolName: "bash", since: 1_000 })();

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
		reg.openApprovalWait(AGENT, { toolName: "bash", since: Date.now() });
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
			const close = reg.openApprovalWait(AGENT, { toolName: "bash", since: Date.now() });
			vi.advanceTimersByTime(40_000);
			close();
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
			const close = reg.openApprovalWait(AGENT, { toolName: "bash", since: Date.now() });
			vi.advanceTimersByTime(waited);
			close();
		}
		reg.openApprovalWait(AGENT, { toolName: "edit", since: Date.now() });
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
		const close = reg.openApprovalWait(AGENT, { toolName: "bash", since: Date.now() });
		vi.advanceTimersByTime(10_000);
		close();
		expect(reg.approvalWaitedMs(AGENT)).toBe(10_000);

		// A `since` in the FUTURE is what a backwards clock step looks like on close.
		reg.openApprovalWait(AGENT, { toolName: "bash", since: Date.now() + 60_000 })();

		expect(reg.approvalWaitedMs(AGENT)).toBe(10_000);
	});
});

/**
 * One agent with several cards open at once: a batch raises one card per call, and the
 * calls of two tools raise theirs side by side. The agent is waiting on a person from the
 * first card to the last, so the mark must hold across that whole span and the span must
 * be banked once. A single slot written per card and cleared per answer cleared the mark
 * at the first answer while the second card was still open.
 */
describe("overlapping waits of one agent", () => {
	it("stays waiting until the last open wait closes, from the first one's start", () => {
		const start = Date.now();
		const closeBash = reg.openApprovalWait(AGENT, { toolName: "bash", since: Date.now() });
		vi.advanceTimersByTime(10_000);
		const closeEdit = reg.openApprovalWait(AGENT, { toolName: "edit", since: Date.now() });
		vi.advanceTimersByTime(20_000);

		closeBash();

		expect(reg.get(AGENT)?.pendingApproval).toEqual({ toolName: "edit", since: start });
		expect(reg.approvalWaitedMs(AGENT)).toBe(0);

		vi.advanceTimersByTime(20_000);
		closeEdit();

		expect(reg.get(AGENT)?.pendingApproval).toBeUndefined();
		// 50s of waiting on a person, not 30s + 40s counted per card.
		expect(reg.approvalWaitedMs(AGENT)).toBe(50_000);
	});

	it("names the latest wait still open when a later one closes first", () => {
		const start = Date.now();
		reg.openApprovalWait(AGENT, { toolName: "bash", since: start });
		vi.advanceTimersByTime(5_000);
		reg.openApprovalWait(AGENT, { toolName: "edit", reason: "path leaves the working directory", since: Date.now() });
		vi.advanceTimersByTime(5_000);
		const closeWrite = reg.openApprovalWait(AGENT, { toolName: "write", since: Date.now() });

		expect(reg.get(AGENT)?.pendingApproval).toEqual({ toolName: "write", since: start });

		closeWrite();

		expect(reg.get(AGENT)?.pendingApproval).toEqual({
			toolName: "edit",
			reason: "path leaves the working directory",
			since: start,
		});
	});

	it("leaves an agent registered again under the same id untouched by a wait its predecessor opened", () => {
		const close = reg.openApprovalWait(AGENT, { toolName: "bash", since: Date.now() });
		reg.unregister(AGENT);
		reg.register({ id: AGENT, displayName: "worker", kind: "sub", session: null, status: "running" });
		const events: RegistryEvent["type"][] = [];
		const off = reg.onChange(event => {
			if (event.ref.id === AGENT) events.push(event.type);
		});
		vi.advanceTimersByTime(5_000);

		close();
		off();

		expect(events).toEqual([]);
		expect(reg.get(AGENT)?.pendingApproval).toBeUndefined();
		expect(reg.approvalWaitedMs(AGENT)).toBe(0);
	});

	it("starts a new span after every wait has closed", () => {
		reg.openApprovalWait(AGENT, { toolName: "bash", since: Date.now() })();
		vi.advanceTimersByTime(30_000);
		const reopened = Date.now();

		reg.openApprovalWait(AGENT, { toolName: "bash", since: reopened });

		expect(reg.pendingApprovalSince(AGENT)).toBe(reopened);
	});

	it("keeps two agents' waits apart", () => {
		reg.register({ id: "Peer", displayName: "peer", kind: "sub", session: null, status: "running" });
		const closeWorker = reg.openApprovalWait(AGENT, { toolName: "bash", since: Date.now() });
		vi.advanceTimersByTime(10_000);
		const peerStart = Date.now();
		reg.openApprovalWait("Peer", { toolName: "edit", since: peerStart });
		vi.advanceTimersByTime(10_000);

		closeWorker();

		expect(reg.get(AGENT)?.pendingApproval).toBeUndefined();
		expect(reg.approvalWaitedMs(AGENT)).toBe(20_000);
		expect(reg.get("Peer")?.pendingApproval).toEqual({ toolName: "edit", since: peerStart });
		expect(reg.approvalWaitedMs("Peer")).toBe(0);
	});
});
