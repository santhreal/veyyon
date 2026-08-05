/**
 * When a finished subagent stops being listed at all.
 *
 * WHY THIS SUITE EXISTS. Parking was the only stage: a finished agent released its
 * session after `subagent.idleTtlMs` and then stayed in the roster, revivable, for
 * the rest of the session. Over a long run every subagent ever spawned accumulates
 * there. A real session ended with nine parked agents listed, the oldest quiet for
 * over two hours, so `irc list` and the Control Center fill with agents nobody is
 * going to message again.
 *
 * The second stage closes them. It is deliberately NOT symmetric: an agent whose
 * last message said it was waiting on another agent stopped on purpose to let a peer
 * finish, and it is the one most likely to be messaged next, so it gets a longer
 * grace. Closing it on the ordinary timer would drop exactly the peer the operator
 * is about to need.
 *
 * What closing costs is bounded on purpose: the transcript is untouched and stays
 * readable through `history://`. What is dropped is the live reference and the
 * ability to wake it by messaging, not the record of what it did.
 *
 * Time is driven with fake timers because the manager schedules one real
 * `setTimeout` per next-deadline; a wall-clock wait would make these cases slow and
 * eventually flaky.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { AgentLifecycleManager, type AgentReviver } from "@veyyon/coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@veyyon/coding-agent/registry/agent-registry";
import * as sdkModule from "@veyyon/coding-agent/sdk";
import type { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import { finalizeSubagentLifecycle, runSubprocess, saysItIsWaitingOnAPeer } from "@veyyon/coding-agent/task/executor";
import { resolveSubagentAutoCloseBudget } from "@veyyon/coding-agent/task/subagent-settings";
import {
	createAssistantStopMessage,
	createAssistantToolCallMessage,
	createMockSession,
	yieldSuccessEvent,
} from "./helpers/subagent-session";

const IDLE_TTL_MS = 5 * 60_000;
const CLOSE_PARKED_MS = 5 * 60_000;
const CLOSE_WAITING_MS = 30 * 60_000;

/**
 * The two calls `park` makes on a session: a durable flush, then dispose. Nothing
 * else about a real session matters to the lifecycle manager.
 */
function fakeSession(): AgentSession {
	return {
		sessionManager: { flush: async (): Promise<void> => {} },
		dispose: async (): Promise<void> => {},
	} as unknown as AgentSession;
}

/**
 * A session whose durable flush fails the first `n` times. Park refuses to dispose a
 * session it could not flush, because discarding unflushed work is worse than staying
 * live, so this is how a park gets postponed rather than completed.
 */
function flakySession(failures: number): AgentSession {
	let remaining = failures;
	return {
		sessionManager: {
			flush: async (): Promise<void> => {
				if (remaining-- > 0) throw new Error("flush failed");
			},
		},
		dispose: async (): Promise<void> => {},
	} as unknown as AgentSession;
}

/** Register an idle, adopted subagent, exactly as a finished run leaves one. */
function adoptIdleAgent(
	id: string,
	options: {
		waitingOnPeer?: boolean;
		closeParkedMs?: number;
		closeWaitingMs?: number;
		session?: AgentSession;
		/** Overrides the reviver, for cases that need to hold a wake open. */
		revive?: AgentReviver;
	} = {},
): void {
	const registry = AgentRegistry.global();
	const session = options.session ?? fakeSession();
	registry.register({ id, displayName: id, kind: "sub", session, sessionFile: `/tmp/${id}.jsonl` });
	if (options.waitingOnPeer !== undefined) registry.setWaitingOnPeer(id, options.waitingOnPeer);
	registry.setStatus(id, "idle");
	AgentLifecycleManager.global().adopt(id, {
		idleTtlMs: IDLE_TTL_MS,
		closeParkedMs: options.closeParkedMs ?? CLOSE_PARKED_MS,
		closeWaitingMs: options.closeWaitingMs ?? CLOSE_WAITING_MS,
		revive: options.revive ?? (async () => fakeSession()),
	});
}

/**
 * Count how many times the lifecycle manager re-arms its single scheduler timer.
 *
 * This is the only externally visible trace of a stranded deadline: a due entry the
 * expiry cannot action stays in the map, already in the past, so every
 * `#scheduleNext` selects it again with a zero delay. Nothing about the registry
 * changes while that happens, which is exactly why the original bug was invisible to
 * every functional assertion and showed up only as CPU burn.
 */
function countSchedulerWakes(): { count: () => number; restore: () => void } {
	const spy = vi.spyOn(globalThis, "setTimeout");
	return { count: () => spy.mock.calls.length, restore: () => spy.mockRestore() };
}

/** Advance the clock and let the manager's async park/close work settle. */
async function advance(ms: number): Promise<void> {
	vi.advanceTimersByTime(ms);
	// The expiry handler runs its stages in an async drain, so the microtask queue
	// has to turn over before the registry reflects them.
	for (let i = 0; i < 8; i++) await Promise.resolve();
}

/**
 * The WIRING from the operator's setting to the close stage, which nothing else covers.
 *
 * Every other case in this file hands `adopt()` a budget directly, so the suite proves the
 * MECHANISM works GIVEN a budget and says nothing about whether a budget ever arrives. The supply
 * line is `resolveSubagentAutoCloseBudget(settings)` -> `autoClose` -> `finalizeSubagentLifecycle`
 * -> `adopt`. Drop the `autoClose` argument at the executor call site, or return zeros from the
 * resolver, and nothing closes an agent ever again while this suite stays fully green.
 */
describe("the operator's setting reaches the close stage", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		AgentRegistry.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();
	});

	afterEach(() => {
		AgentLifecycleManager.resetGlobalForTests();
		AgentRegistry.resetGlobalForTests();
		vi.useRealTimers();
	});

	/**
	 * A default install resolves a REAL budget, not zero.
	 *
	 * Zero is the documented "never close" value, so a resolver returning it by accident disables
	 * the feature for everyone with no error anywhere. Asserted as literals rather than against the
	 * constants the resolver reads, because a test that imports the number it pins follows that
	 * number wherever somebody moves it.
	 */
	it("resolves five minutes quiet and thirty minutes waiting on a default install", () => {
		const budget = resolveSubagentAutoCloseBudget(Settings.isolated({}));

		expect(budget.parkedMs).toBe(5 * 60_000);
		expect(budget.waitingMs).toBe(30 * 60_000);
	});

	/**
	 * That resolved budget, handed to the real finalizer the way production hands it, closes.
	 *
	 * `finalizeSubagentLifecycle` is the only production caller of `adopt`, and it reads
	 * `args.autoClose?.parkedMs ?? 0`, so the `?? 0` silently disables the whole stage the moment
	 * the argument stops being passed.
	 */
	it("closes an agent finished through the real finalizer with the resolved budget", async () => {
		const budget = resolveSubagentAutoCloseBudget(Settings.isolated({}));
		const registry = AgentRegistry.global();
		const session = fakeSession();
		registry.register({
			id: "Wired",
			displayName: "task",
			kind: "sub",
			session,
			sessionFile: "/tmp/Wired.jsonl",
		});

		await finalizeSubagentLifecycle({
			id: "Wired",
			session,
			aborted: false,
			keepAlive: true,
			isolated: false,
			agentIdleTtlMs: IDLE_TTL_MS,
			autoClose: budget,
			reviveSession: async () => fakeSession(),
		});

		expect(registry.get("Wired")?.status).toBe("idle");

		await advance(IDLE_TTL_MS);
		expect(registry.get("Wired")?.status).toBe("parked");

		await advance(budget.parkedMs);
		expect(registry.get("Wired")).toBeUndefined();
	});

	/**
	 * And the off switch really switches it off, through the same path.
	 *
	 * Pairs with the case above so neither can pass by closing unconditionally.
	 */
	it("never closes when the operator turned auto-close off", async () => {
		const budget = resolveSubagentAutoCloseBudget(Settings.isolated({ "subagent.autoClose.enabled": false }));
		expect(budget).toEqual({ parkedMs: 0, waitingMs: 0 });

		const registry = AgentRegistry.global();
		const session = fakeSession();
		registry.register({
			id: "Kept",
			displayName: "task",
			kind: "sub",
			session,
			sessionFile: "/tmp/Kept.jsonl",
		});

		await finalizeSubagentLifecycle({
			id: "Kept",
			session,
			aborted: false,
			keepAlive: true,
			isolated: false,
			agentIdleTtlMs: IDLE_TTL_MS,
			autoClose: budget,
			reviveSession: async () => fakeSession(),
		});

		await advance(IDLE_TTL_MS);
		expect(registry.get("Kept")?.status).toBe("parked");
		await advance(CLOSE_WAITING_MS * 4);
		expect(registry.get("Kept")?.status).toBe("parked");
	});
});

describe("parked subagents are closed once they are quiet", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		AgentRegistry.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();
	});

	afterEach(() => {
		AgentLifecycleManager.resetGlobalForTests();
		AgentRegistry.resetGlobalForTests();
		vi.useRealTimers();
	});

	/**
	 * The headline, in two stages. The idle TTL parks (session released, ref kept),
	 * and the close budget then drops the ref, which is what stops rosters from
	 * accumulating finished agents.
	 */
	it("parks on the idle TTL, then closes on the close budget", async () => {
		adoptIdleAgent("Quiet");

		await advance(IDLE_TTL_MS);
		expect(AgentRegistry.global().get("Quiet")?.status).toBe("parked");
		expect(AgentRegistry.global().get("Quiet")?.session).toBeNull();

		await advance(CLOSE_PARKED_MS);
		expect(AgentRegistry.global().get("Quiet")).toBeUndefined();
	});

	/**
	 * The close budget is counted from the PARK, not from the spawn. Asserted by
	 * checking the agent is still listed one tick before its budget elapses: a
	 * deadline measured from the wrong origin would have closed it already.
	 */
	it("counts the close budget from the moment it parked", async () => {
		adoptIdleAgent("Quiet");
		await advance(IDLE_TTL_MS);

		await advance(CLOSE_PARKED_MS - 1_000);
		expect(AgentRegistry.global().get("Quiet")?.status).toBe("parked");

		await advance(1_000);
		expect(AgentRegistry.global().get("Quiet")).toBeUndefined();
	});

	/**
	 * The waiting case. Same park, longer hold: at the ordinary budget it is still
	 * there, and only the waiting budget closes it. This is the whole asymmetry, so
	 * both halves are asserted rather than just the end state.
	 */
	it("holds a waiting agent for the longer budget", async () => {
		adoptIdleAgent("Waiter", { waitingOnPeer: true });
		await advance(IDLE_TTL_MS);
		expect(AgentRegistry.global().get("Waiter")?.status).toBe("parked");

		await advance(CLOSE_PARKED_MS);
		expect(AgentRegistry.global().get("Waiter")?.status).toBe("parked");

		await advance(CLOSE_WAITING_MS - CLOSE_PARKED_MS);
		expect(AgentRegistry.global().get("Waiter")).toBeUndefined();
	});

	/**
	 * Two agents, one waiting, on one scheduler. The manager keeps a single
	 * next-deadline timer for every adopted agent, so a per-agent budget is only real
	 * if the shorter one firing leaves the longer one alone.
	 */
	it("closes a quiet agent while a waiting one keeps its longer hold", async () => {
		adoptIdleAgent("Quiet");
		adoptIdleAgent("Waiter", { waitingOnPeer: true });

		await advance(IDLE_TTL_MS);
		await advance(CLOSE_PARKED_MS);

		expect(AgentRegistry.global().get("Quiet")).toBeUndefined();
		expect(AgentRegistry.global().get("Waiter")?.status).toBe("parked");
	});

	/**
	 * The off switch has to be an off switch, not a very long timer. A zero budget
	 * (what `subagent.autoClose.enabled: false` resolves to) leaves the agent parked
	 * and revivable for the rest of the session.
	 */
	it("never closes when the budget is disabled", async () => {
		adoptIdleAgent("Kept", { closeParkedMs: 0, closeWaitingMs: 0 });

		await advance(IDLE_TTL_MS);
		expect(AgentRegistry.global().get("Kept")?.status).toBe("parked");

		await advance(24 * 60 * 60_000);
		expect(AgentRegistry.global().get("Kept")?.status).toBe("parked");
	});

	/**
	 * Reviving cancels the close. An agent someone messaged is live again, so the
	 * close deadline armed when it parked must not fire underneath the operator who
	 * just woke it.
	 *
	 * After the wake it re-enters the ordinary cycle: idle, then parked again once
	 * its idle TTL elapses. So the assertion is that it still EXISTS after the close
	 * budget would have dropped it, not that it stays live. A second park is the
	 * correct outcome and the close budget starts over from it.
	 */
	it("does not close an agent that was revived", async () => {
		adoptIdleAgent("Woken");
		await advance(IDLE_TTL_MS);
		expect(AgentRegistry.global().get("Woken")?.status).toBe("parked");

		await AgentLifecycleManager.global().ensureLive("Woken");
		expect(AgentRegistry.global().get("Woken")?.status).toBe("idle");

		await advance(CLOSE_PARKED_MS);

		// Re-parked by its idle TTL rather than closed: the wake reset the cycle.
		expect(AgentRegistry.global().get("Woken")?.status).toBe("parked");
	});

	/**
	 * The off switch cannot be half-off. A zero quiet budget beside a live waiting
	 * budget is a reachable adoption (the two arrive as separate fields), and honouring
	 * the waiting one would close precisely the agents an operator is most likely to
	 * message while keeping every ordinary finished agent listed: the exact inverse of
	 * both settings. `adopt` normalizes it rather than trusting the caller, so this
	 * holds for any adoption and not only the one the settings resolver produces.
	 */
	it("never closes a waiting agent when the quiet budget is disabled", async () => {
		adoptIdleAgent("Waiter", { waitingOnPeer: true, closeParkedMs: 0, closeWaitingMs: CLOSE_WAITING_MS });

		await advance(IDLE_TTL_MS);
		expect(AgentRegistry.global().get("Waiter")?.status).toBe("parked");

		await advance(CLOSE_WAITING_MS * 2);
		expect(AgentRegistry.global().get("Waiter")?.status).toBe("parked");
	});

	/**
	 * The budget is chosen from the flag as it stands when the agent parks, not from
	 * whatever it was when the agent was adopted.
	 *
	 * WHY THIS MATTERS. The flag describes the agent's latest word, and an agent can
	 * revise it: one that signed off "waiting on X", was messaged, and has since
	 * reported done is no longer waiting. Only a live read lets that agent fall back to
	 * the ordinary budget. If the budget were fixed at adoption, the first sign-off
	 * would keep the longer grace for the rest of the session and the operator's quiet
	 * budget would never apply to it again.
	 */
	it("chooses the budget from the flag at park time, not at adoption", async () => {
		adoptIdleAgent("Revised", { waitingOnPeer: true });

		// It is no longer waiting: what a follow-up turn's sign-off records.
		AgentRegistry.global().setWaitingOnPeer("Revised", false);

		await advance(IDLE_TTL_MS);
		expect(AgentRegistry.global().get("Revised")?.status).toBe("parked");

		await advance(CLOSE_PARKED_MS);
		expect(AgentRegistry.global().get("Revised")).toBeUndefined();
	});

	/** And the reverse: an agent that only says it is waiting later still earns the hold. */
	it("honors a waiting flag set after adoption", async () => {
		adoptIdleAgent("LateWaiter");
		AgentRegistry.global().setWaitingOnPeer("LateWaiter", true);

		await advance(IDLE_TTL_MS);
		await advance(CLOSE_PARKED_MS);
		expect(AgentRegistry.global().get("LateWaiter")?.status).toBe("parked");

		await advance(CLOSE_WAITING_MS - CLOSE_PARKED_MS);
		expect(AgentRegistry.global().get("LateWaiter")).toBeUndefined();
	});

	/**
	 * A running agent is never touched by either stage. This is the distinction the
	 * whole feature rests on: an agent blocked on a long test is working, not quiet,
	 * and closing it would kill live work.
	 */
	it("leaves a running agent alone", async () => {
		adoptIdleAgent("Busy");
		AgentRegistry.global().setStatus("Busy", "running");

		await advance(IDLE_TTL_MS + CLOSE_WAITING_MS);

		const ref = AgentRegistry.global().get("Busy");
		expect(ref?.status).toBe("running");
		expect(ref?.session).not.toBeNull();
	});

	/**
	 * A park that could not flush must be retried, and retrying must not strand the
	 * scheduler.
	 *
	 * WHY THIS EXISTS. The two-stage rewrite made the expiry read a `stage` field to
	 * decide between parking and closing, and it skipped any due deadline that carried
	 * no stage. `park` re-arms its own deadline when the flush fails, and the expiry
	 * that invoked it had already cleared the stage, so the re-armed deadline had none:
	 * the entry became permanently unactionable. Worse than the missed park, the
	 * deadline stayed in the map while already being in the past, so `#scheduleNext`
	 * kept selecting it as the next wake with a zero delay and the scheduler spun on a
	 * hot loop for the rest of the session.
	 *
	 * One flush failure is enough to reach it, which is why this asserts recovery (the
	 * agent eventually parks) rather than only that nothing threw.
	 *
	 * The spin is NOT asserted here, and deliberately so: under fake timers the
	 * zero-delay re-arm lands in a microtask after `advanceTimersByTime` has returned,
	 * so the loop never compounds inside a test and any count-based assertion would
	 * pass on the broken code. The stranded deadline is the shared cause of both
	 * symptoms, and this case fails on it.
	 */
	it("re-parks an agent whose first flush failed", async () => {
		adoptIdleAgent("Flaky", { session: flakySession(1) });

		await advance(IDLE_TTL_MS);
		// The flush threw, so the session is deliberately still live.
		expect(AgentRegistry.global().get("Flaky")?.status).toBe("idle");
		expect(AgentRegistry.global().get("Flaky")?.session).not.toBeNull();

		await advance(IDLE_TTL_MS);
		expect(AgentRegistry.global().get("Flaky")?.status).toBe("parked");

		// And the ordinary close still follows the retried park.
		await advance(CLOSE_PARKED_MS);
		expect(AgentRegistry.global().get("Flaky")).toBeUndefined();
	});
});

/**
 * The same behavior driven through the function a finished run actually calls.
 *
 * WHY SEPARATE FROM THE CASES ABOVE. Those drive `AgentLifecycleManager` directly, so
 * they prove the two-stage timer and nothing about whether anything arms it. The
 * budgets reach the manager only if the executor resolves them from settings, reads
 * the agent's sign-off, and passes both at adoption. A break anywhere on that path
 * leaves every case above green and the feature completely inert, which is the
 * failure this pins.
 */
describe("a finished run arms the close through the executor", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		AgentRegistry.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();
	});

	afterEach(() => {
		AgentLifecycleManager.resetGlobalForTests();
		AgentRegistry.resetGlobalForTests();
		vi.useRealTimers();
	});

	/**
	 * Settle a completed subagent exactly as a real run does. An isolated run gets no
	 * reviver, because its worktree is merged and cleaned when the run ends.
	 */
	async function finishRun(id: string, signOff: string, isolated = false): Promise<void> {
		const session = fakeSession();
		AgentRegistry.global().register({
			id,
			displayName: id,
			kind: "sub",
			session,
			sessionFile: `/tmp/${id}.jsonl`,
		});
		await finalizeSubagentLifecycle({
			id,
			session,
			aborted: false,
			keepAlive: true,
			isolated,
			agentIdleTtlMs: IDLE_TTL_MS,
			autoClose: { parkedMs: CLOSE_PARKED_MS, waitingMs: CLOSE_WAITING_MS },
			signOff,
			reviveSession: isolated ? null : async () => fakeSession(),
		});
	}

	/** An ordinary sign-off parks and then closes on the quiet budget. */
	it("closes an ordinary finished subagent", async () => {
		await finishRun("Reporter", "Landed the parser fix and pushed it.");

		await advance(IDLE_TTL_MS);
		expect(AgentRegistry.global().get("Reporter")?.status).toBe("parked");

		await advance(CLOSE_PARKED_MS);
		expect(AgentRegistry.global().get("Reporter")).toBeUndefined();
	});

	/**
	 * The end-to-end waiting case: the sign-off text alone has to buy the longer hold,
	 * with nothing in the test setting the flag by hand. This is the only case that
	 * proves the sign-off is read at all.
	 */
	it("gives the longer hold to an agent whose sign-off says it is waiting", async () => {
		await finishRun("Blocked", "Waiting on InstallerTests before I can integrate.");

		await advance(IDLE_TTL_MS);
		await advance(CLOSE_PARKED_MS);
		expect(AgentRegistry.global().get("Blocked")?.status).toBe("parked");

		await advance(CLOSE_WAITING_MS - CLOSE_PARKED_MS);
		expect(AgentRegistry.global().get("Blocked")).toBeUndefined();
	});

	/**
	 * Reading the sign-off must not disturb the lifecycle clock. `setWaitingOnPeer`
	 * deliberately emits no event and leaves `lastActivity` alone, because a bump there
	 * would restart the idle countdown and postpone the park it is supposed to precede.
	 */
	it("still parks on schedule after reading the sign-off", async () => {
		await finishRun("Blocked", "Waiting on InstallerTests before I can integrate.");

		await advance(IDLE_TTL_MS - 1_000);
		expect(AgentRegistry.global().get("Blocked")?.status).toBe("idle");

		await advance(1_000);
		expect(AgentRegistry.global().get("Blocked")?.status).toBe("parked");
	});

	/**
	 * An isolated run is parked immediately, with no reviver, and must still be closed.
	 *
	 * WHY THIS EXISTS. The first version of this feature closed nothing here. Isolated
	 * runs take a different branch that parks the ref directly and never handed it to
	 * the lifecycle manager, so the close stage was never armed and every isolated
	 * subagent stayed in the roster for the whole session. That is the worst version of
	 * the accumulation this feature exists to stop, because an isolated agent has no
	 * reviver: messaging it cannot work, so the roster offered a peer that could never
	 * answer.
	 *
	 * There is no park stage to wait through, so the close is counted from the run
	 * ending, which is why this advances the quiet budget alone.
	 */
	it("closes an isolated subagent, which parks with no reviver", async () => {
		await finishRun("Worktree", "Merged the patch and cleaned the worktree.", true);

		const parked = AgentRegistry.global().get("Worktree");
		expect(parked?.status).toBe("parked");
		expect(parked?.session).toBeNull();

		await advance(CLOSE_PARKED_MS);
		expect(AgentRegistry.global().get("Worktree")).toBeUndefined();
	});

	/**
	 * An isolated agent stays un-revivable right up to the close. Arming the close
	 * required adopting it, and adoption is also what `ensureLive` consults, so this
	 * pins that the adoption carries no reviver: a caller must still be told the run is
	 * gone and pointed at the transcript, not handed a broken session.
	 */
	it("keeps an isolated subagent un-revivable while it waits to be closed", async () => {
		await finishRun("Worktree", "Merged the patch.", true);

		await expect(AgentLifecycleManager.global().ensureLive("Worktree")).rejects.toThrow(/history:\/\/Worktree/);
	});

	/** The waiting grace applies to isolated runs too; the sign-off is read on that path. */
	it("gives an isolated subagent the longer hold when it says it is waiting", async () => {
		await finishRun("Worktree", "Waiting on Main to pick a merge strategy.", true);

		await advance(CLOSE_PARKED_MS);
		expect(AgentRegistry.global().get("Worktree")?.status).toBe("parked");

		await advance(CLOSE_WAITING_MS - CLOSE_PARKED_MS);
		expect(AgentRegistry.global().get("Worktree")).toBeUndefined();
	});
});

/**
 * Which sign-off counts as "waiting on a peer".
 *
 * The flag only ever LENGTHENS a grace, so a false positive costs a ref that
 * lingers and a false negative costs the ordinary budget. That asymmetry is why a
 * phrase match is acceptable here at all.
 *
 * What it is NOT allowed to be is a bare word check. "waiting for" means two
 * different things with the same surface form, so these cases pin the POSITION rule:
 * the clause counts when it opens a sentence, follows a label, or follows a subject
 * making the agent the waiter, and does not count when it is buried mid-sentence in
 * prose about something else.
 */
describe("waiting sign-off detection", () => {
	/** The real shapes agents sign off with when they stop to let a peer finish. */
	it.each([
		"Waiting on SourceLfsGates before I can integrate.",
		"waiting for the audit to finish, then I will land it.",
		"Blocked: waits for InstallerTests to report.",
		"I am WAITING ON the reviewer.",
		"Landed the parser. Still waiting for the differential run.",
		"Handed the schema over; I'm waiting on Main to pick an owner.",
		// Bulleted status lines: the most common shape in practice, and the one the
		// position rule missed until the marker class was added.
		"Status:\n- Parser landed\n- Waiting on ReviewBot for the diff review\n",
		"* waiting for the merge window to open",
		"1. Waiting on Main to pick an owner",
		"> Waiting on the installer gates",
	])("treats %p as waiting", text => {
		expect(saysItIsWaitingOnAPeer(text)).toBe(true);
	});

	/**
	 * Prose that merely contains the word, including the case that caught the first
	 * version of this matcher: "worth waiting for" is a comment about a rebuild, not a
	 * report that this agent is blocked, yet it is character-for-character the same
	 * "waiting for" the real signal uses. A bare phrase check hands an ordinary
	 * finished agent six times its budget on sentences like these.
	 */
	it.each([
		"Stopped waiting and shipped it.",
		"The fix was worth waiting for the rebuild to prove.",
		"No waiting involved; the cache was warm.",
		"That regression was not worth waiting on.",
		"Done. Nothing is pending.",
		// A marker does not license the whole line: the clause still has to start there.
		"- The fix was worth waiting for the rebuild to prove.",
		"- Everything landed; nothing pending.",
	])("does not treat %p as waiting", text => {
		expect(saysItIsWaitingOnAPeer(text)).toBe(false);
	});

	/** An agent that produced no final text is not waiting on anything. */
	it("treats absent output as not waiting", () => {
		expect(saysItIsWaitingOnAPeer(undefined)).toBe(false);
		expect(saysItIsWaitingOnAPeer("")).toBe(false);
	});
});

/**
 * The scheduler invariant, stated as a test rather than as a comment.
 *
 * THE INVARIANT: after any expiry pass, no adopted entry may still hold a deadline
 * that is already in the past. `deadline` and `stage` are written only through
 * `arm`/`disarm`, so an entry is either armed with a stage the expiry can act on or
 * not armed at all, and the expiry clears every due entry before deciding what to do
 * with it.
 *
 * WHY IT NEEDS ITS OWN CASE. Violating it changes nothing observable about any
 * agent: the ref keeps its status, no work is lost, no error is raised. The single
 * next-deadline timer just re-selects the stranded entry, computes a zero delay from
 * a past deadline, and wakes again immediately, for the rest of the process. Every
 * functional assertion in this file stays green through that. The scheduler wake
 * count is the only trace, so it is what is asserted.
 */
describe("no due deadline survives an expiry unactioned", () => {
	let wakes: { count: () => number; restore: () => void };

	beforeEach(() => {
		vi.useFakeTimers();
		AgentRegistry.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();
		wakes = countSchedulerWakes();
	});

	afterEach(() => {
		wakes.restore();
		AgentLifecycleManager.resetGlobalForTests();
		AgentRegistry.resetGlobalForTests();
		vi.useRealTimers();
	});

	/**
	 * The reachable path to a stranded deadline is a park that could not flush: it is
	 * the one place a deadline is re-armed from inside an expiry that already cleared
	 * the previous one. One failed flush is enough to reach it.
	 *
	 * HOW THE SPIN IS OBSERVED. The stranded entry does not burn inside the advance
	 * that creates it: `#scheduleNext` re-arms with a zero delay only after the
	 * expiry callback returns, so the loop needs further clock time to compound. The
	 * measurement window is therefore taken AFTER the agent has parked, when a healthy
	 * manager has exactly one deadline left (the close budget, five minutes out) and
	 * must not wake the scheduler even once. A stranded deadline wakes it on every
	 * millisecond of that window instead.
	 *
	 * The park assertion is kept beside it because the two are one defect: the entry
	 * the expiry cannot classify is both the missed park and the hot loop.
	 */
	it("does not re-wake in a hot loop after a park whose flush failed", async () => {
		adoptIdleAgent("Flaky", { session: flakySession(1) });

		await advance(IDLE_TTL_MS);
		expect(AgentRegistry.global().get("Flaky")?.status).toBe("idle");

		await advance(IDLE_TTL_MS);

		const settled = wakes.count();
		await advance(25);
		expect(wakes.count() - settled, "the scheduler re-armed inside a quiet window").toBe(0);
		expect(AgentRegistry.global().get("Flaky")?.status).toBe("parked");
	});

	/**
	 * The quiet case, which pins the other half: an agent sitting on a future deadline
	 * must not wake the scheduler at all. Without this, a bound like the one above
	 * could be satisfied by a manager that simply never schedules anything.
	 */
	it("does not wake at all while every deadline is in the future", async () => {
		adoptIdleAgent("Quiet");

		const armed = wakes.count();
		await advance(IDLE_TTL_MS - 1_000);

		expect(wakes.count()).toBe(armed);
		expect(AgentRegistry.global().get("Quiet")?.status).toBe("idle");
	});

	/**
	 * A stage captured by the expiry must not be applied to an agent whose state moved
	 * on while the drain was blocked.
	 *
	 * THE INTERLEAVING. Expiries are drained serially so a large idle cohort cannot
	 * trigger a burst of persistence work, and that serialization is the hazard: the
	 * first agent's park awaits a durable flush, and a later agent in the same batch
	 * can be messaged, run a whole turn and go idle again inside that window. Its
	 * queued "park" then describes an agent that no longer exists, and applying it
	 * throws away a session that just did work and restarted its own TTL.
	 *
	 * The signal is the deadline: the expiry disarmed every due entry, so an entry
	 * holding one again has had a fresher decision made for it, and that decision wins.
	 */
	it("drops a queued park for an agent that went idle again during the drain", async () => {
		const flushGate = Promise.withResolvers<void>();
		const slow = {
			sessionManager: {
				flush: async (): Promise<void> => {
					await flushGate.promise;
				},
			},
			dispose: async (): Promise<void> => {},
		} as unknown as AgentSession;
		// Adoption order is drain order, so the blocked park runs first.
		adoptIdleAgent("Slow", { session: slow });
		adoptIdleAgent("Busy");

		await advance(IDLE_TTL_MS);

		// Both were due. The drain is stuck on Slow's flush; Busy is messaged and
		// finishes a turn, which is exactly what the executor's agent_start/agent_end
		// subscription does to the registry.
		AgentRegistry.global().setStatus("Busy", "running");
		AgentRegistry.global().setStatus("Busy", "idle");

		flushGate.resolve();
		await advance(0);

		expect(AgentRegistry.global().get("Slow")?.status).toBe("parked");
		expect(AgentRegistry.global().get("Busy")?.status).toBe("idle");
		expect(AgentRegistry.global().get("Busy")?.session).not.toBeNull();

		// And the fresh deadline is real: Busy parks a full TTL after its own last turn.
		await advance(IDLE_TTL_MS);
		expect(AgentRegistry.global().get("Busy")?.status).toBe("parked");
	});
});

/**
 * Closing must not drop a ref somebody is currently waking.
 *
 * THE INTERLEAVING. `close` runs off the shared timer while `ensureLive` is awaiting
 * a rebuilt session, and a reviving agent is still `parked` right up until its new
 * session is attached, so a status check alone cannot see the wake. `release` then
 * unregisters the ref, and `attachSession`/`setStatus` both no-op on an unknown id:
 * the caller would be handed a live session that no registry entry owns, no roster
 * lists, and nothing will ever dispose. Silent on every channel.
 *
 * A cold revive is slow on purpose (transcript replay, MCP, auth), and the waiting
 * grace means the agents carrying a close deadline are exactly the ones an operator
 * is most likely to message, so the window is not theoretical.
 */
describe("a revive in flight is not closed underneath", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		AgentRegistry.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();
	});

	afterEach(() => {
		AgentLifecycleManager.resetGlobalForTests();
		AgentRegistry.resetGlobalForTests();
		vi.useRealTimers();
	});

	it("keeps the ref and completes the wake when the close budget elapses mid-revive", async () => {
		const gate = Promise.withResolvers<void>();
		const revived = fakeSession();
		adoptIdleAgent("Woken", {
			revive: async () => {
				await gate.promise;
				return revived;
			},
		});

		await advance(IDLE_TTL_MS);
		expect(AgentRegistry.global().get("Woken")?.status).toBe("parked");

		const waking = AgentLifecycleManager.global().ensureLive("Woken");
		await advance(CLOSE_PARKED_MS);

		// The close fired here. It must have deferred rather than dropped the ref.
		expect(AgentRegistry.global().get("Woken")?.status).toBe("parked");

		gate.resolve();
		expect(await waking).toBe(revived);
		expect(AgentRegistry.global().get("Woken")?.status).toBe("idle");
		expect(AgentRegistry.global().get("Woken")?.session).toBe(revived);
	});

	/**
	 * The deferral is a deferral, not a cancellation: once the woken agent goes quiet
	 * again it parks and closes on the ordinary budget, so a wake cannot make an agent
	 * permanently unclosable.
	 */
	it("still closes the agent once the wake has settled and it goes quiet again", async () => {
		const gate = Promise.withResolvers<void>();
		adoptIdleAgent("Woken", {
			revive: async () => {
				await gate.promise;
				return fakeSession();
			},
		});

		await advance(IDLE_TTL_MS);
		const waking = AgentLifecycleManager.global().ensureLive("Woken");
		await advance(CLOSE_PARKED_MS);
		gate.resolve();
		await waking;

		await advance(IDLE_TTL_MS);
		expect(AgentRegistry.global().get("Woken")?.status).toBe("parked");

		await advance(CLOSE_PARKED_MS);
		expect(AgentRegistry.global().get("Woken")).toBeUndefined();
	});

	/**
	 * An explicit `release` during a revive is a hard removal and stays one, but it
	 * must not resolve the wake with an orphan. The rebuilt session is disposed here
	 * and the caller is told, because a session nothing owns is a leaked process, MCP
	 * client and file handle set for the rest of the run.
	 */
	it("disposes the rebuilt session and reports the loss when the ref is released mid-revive", async () => {
		const gate = Promise.withResolvers<void>();
		let disposed = 0;
		adoptIdleAgent("Dropped", {
			revive: async () => {
				await gate.promise;
				return {
					sessionManager: { flush: async (): Promise<void> => {} },
					dispose: async (): Promise<void> => {
						disposed++;
					},
				} as unknown as AgentSession;
			},
		});

		await advance(IDLE_TTL_MS);
		const waking = AgentLifecycleManager.global().ensureLive("Dropped");
		await AgentLifecycleManager.global().release("Dropped");

		gate.resolve();
		await expect(waking).rejects.toThrow(/released while it was being revived/);
		expect(disposed).toBe(1);
		expect(AgentRegistry.global().get("Dropped")).toBeUndefined();
	});
});

/**
 * Messaging an agent that just failed.
 *
 * THE WINDOW. The abort path flips the ref to `aborted` and then AWAITS `dispose()`
 * under a five-second deadline, so for the length of that teardown the ref reads
 * `aborted` while still holding the session being torn down. `AgentRef.session` is
 * documented "Null exactly when parked/aborted", and `ensureLive` returns
 * `ref.session` whenever it is set, so the doc and the code disagreed for exactly as
 * long as the kill took and a wake landing inside it was handed a dying session
 * rather than being refused.
 *
 * That wake is not exotic. An agent that just failed is the one an operator messages
 * next, and an `irc` message to a subagent goes through `ensureLive`.
 *
 * NOT a close-budget case: the sdk's dispose wrapper unregisters any ref that is not
 * `parked`, so an aborted ref is removed by its own teardown and needs no second
 * stage. This suite fakes the session, so the ref survives here and the refusal can
 * be observed on its own.
 */
describe("an aborted subagent refuses a wake", () => {
	beforeEach(() => {
		AgentRegistry.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();
	});

	afterEach(() => {
		AgentLifecycleManager.resetGlobalForTests();
		AgentRegistry.resetGlobalForTests();
	});

	it("refuses a wake that arrives while the killed session is still disposing", async () => {
		const disposing = Promise.withResolvers<void>();
		let wakeInsideWindow: Promise<AgentSession> | undefined;
		const session = {
			sessionManager: { flush: async (): Promise<void> => {} },
			dispose: async (): Promise<void> => {
				// Inside dispose the ref is already `aborted` and still carries this
				// session, which is the whole window under test.
				wakeInsideWindow = AgentLifecycleManager.global().ensureLive("Killed");
				await disposing.promise;
			},
		} as unknown as AgentSession;

		AgentRegistry.global().register({
			id: "Killed",
			displayName: "Killed",
			kind: "sub",
			session,
			sessionFile: "/tmp/Killed.jsonl",
		});

		const settled = finalizeSubagentLifecycle({
			id: "Killed",
			session,
			aborted: true,
			abortKind: "timeout",
			keepAlive: true,
			isolated: false,
			agentIdleTtlMs: IDLE_TTL_MS,
			autoClose: { parkedMs: CLOSE_PARKED_MS, waitingMs: CLOSE_WAITING_MS },
			signOff: "Waiting on ReviewBot before I can continue.",
			reviveSession: async () => fakeSession(),
		});

		// Give dispose a turn to start and issue the wake.
		await Promise.resolve();
		expect(AgentRegistry.global().get("Killed")?.status).toBe("aborted");
		expect(wakeInsideWindow).toBeDefined();
		await expect(wakeInsideWindow).rejects.toThrow(/was terminated and cannot be revived/);

		disposing.resolve();
		await settled;

		// And the documented invariant holds once the kill has settled, so the next
		// caller to trust it does not get the torn-down session either.
		expect(AgentRegistry.global().get("Killed")?.session).toBeNull();
	});
});

/**
 * WHICH text the waiting signal reads, driven through a real `runSubprocess`.
 *
 * THE DEFECT. Three comments said the signal reads the agent's last message. Every
 * caller handed it `monitor.rawOutput()`, which is `finalOutputChunks` joined, filled
 * from the `agent_end` event's `messages` (every message the run produced) and
 * falling back to every `message_end` chunk. So a "waiting on X" line an agent wrote
 * early and has since resolved kept the longer grace for the rest of the session,
 * and the position rules the matcher is built on were being applied to a whole
 * transcript rather than to a sign-off.
 *
 * Both directions are pinned. Reading only the sign-off is not automatically safer:
 * under-detecting drops the peer an operator is about to message, which is the harm
 * the waiting budget exists to prevent, so the resolver falls back to the run's
 * accumulated text when the final message carried none (a bare `yield` tool call).
 */
describe("the waiting signal reads the sign-off, not the whole run", () => {
	const artifactDirs: string[] = [];

	beforeEach(() => {
		AgentRegistry.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();
	});

	afterEach(() => {
		vi.restoreAllMocks();
		AgentLifecycleManager.resetGlobalForTests();
		AgentRegistry.resetGlobalForTests();
		for (const dir of artifactDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	/**
	 * Run one subagent that emits `turns` as assistant messages and then yields.
	 *
	 * `artifactsDir` is mandatory: without it the child transcript is routed into the
	 * developer's real profile and the run fails before it produces anything.
	 *
	 * The stub registers the agent because the real `createAgentSession` does. Stand in
	 * for the sdk without it and every registry call in `finalizeSubagentLifecycle` is a
	 * silent no-op on an unknown id, so both assertions below read `undefined` and pass
	 * or fail for a reason that has nothing to do with the sign-off.
	 */
	async function runWithTurns(
		id: string,
		turns: readonly string[],
		options: { endWithBareToolCall?: boolean } = {},
	): Promise<void> {
		const dir = mkdtempSync(path.join(tmpdir(), "veyyon-signoff-"));
		artifactDirs.push(dir);
		vi.spyOn(sdkModule, "createAgentSession").mockImplementation(async () => {
			const session = createMockSession(
				({ emit, pushTurn }) => {
					for (const text of turns) pushTurn(createAssistantStopMessage(text));
					// A final message whose only content is the yield call, which is how a
					// subagent can finish leaving no last-message text at all.
					if (options.endWithBareToolCall) {
						pushTurn(createAssistantToolCallMessage("yield", "tool-yield", { result: { data: "done" } }));
					}
					emit(yieldSuccessEvent("done"));
				},
				{ activeToolNames: ["yield"] },
			);
			AgentRegistry.global().register({ id, displayName: id, kind: "sub", session, sessionFile: null });
			return { session, extensionsResult: {}, setToolUIContext: () => {} } as never;
		});
		await runSubprocess({
			cwd: "/tmp",
			agent: { name: "task", description: "test", systemPrompt: "test", source: "bundled" },
			task: "work",
			index: 0,
			id,
			settings: Settings.isolated(),
			modelRegistry: {
				refresh: async () => {},
				getAvailable: () => [],
				getApiKey: async () => "test-key",
			} as never,
			enableLsp: false,
			artifactsDir: dir,
		});
	}

	/**
	 * The headline. An agent that WAS waiting, was answered, and has since reported
	 * done is not waiting. Reading the whole run finds the resolved line and keeps the
	 * long grace forever; reading the sign-off does not.
	 */
	it("ignores a waiting line the agent has since resolved", async () => {
		await runWithTurns("Revised", [
			"Status:\n- Parser landed\n- Waiting on ReviewBot for the diff review\n",
			"ReviewBot answered and I landed the parser fix. Nothing pending.",
		]);

		expect(AgentRegistry.global().get("Revised")?.waitingOnPeer).toBe(false);
	});

	/** The control: the same signal still fires when the sign-off itself is the waiting one. */
	it("still detects a waiting sign-off", async () => {
		await runWithTurns("Waiter", [
			"Landed the parser fix and pushed it.",
			"Waiting on ReviewBot before I can integrate.",
		]);

		expect(AgentRegistry.global().get("Waiter")?.waitingOnPeer).toBe(true);
	});

	/**
	 * The fallback, and the reason it is the broad one. An agent that ended on a bare
	 * `yield` call left no last-message text, so there is no sign-off to read. Reading
	 * nothing there would deny the longer grace to an agent that genuinely stopped to
	 * wait, which drops the peer the operator is about to message; falling back to the
	 * run's accumulated text can only over-match, and over-matching makes a ref linger.
	 */
	it("falls back to the run's text when the final message carried none", async () => {
		await runWithTurns("Silent", ["Waiting on ReviewBot before I can integrate."], {
			endWithBareToolCall: true,
		});

		expect(AgentRegistry.global().get("Silent")?.waitingOnPeer).toBe(true);
	});
});
