/**
 * A revive racing a close must never leave a live `AgentSession` that no registry
 * entry owns.
 *
 * THE BUG THIS LOCKS OUT. Reviving a parked agent means calling its reviver
 * (transcript replay, MCP handshake, auth), which is slow, and then attaching the
 * rebuilt session to its ref. The close timer fires independently. In the window
 * between those two, the close path unregistered the ref — and `attachSession` and
 * `setStatus` both NO-OP on an unknown id. So `#revive` sailed through both calls
 * without touching anything and `ensureLive` RESOLVED, handing the caller a fully
 * live session: MCP clients connected, file handles open, LSP running, owned by
 * nothing. No registry entry referenced it, so no teardown path could ever reach
 * it. The agent looked awake to whoever woke it and was invisible to `dispose()`.
 *
 * TWO GUARDS, BOTH ASSERTED HERE, because either alone leaves the hole open:
 *  1. `close()` refuses while a revive is recorded in `#revivals`. Status cannot
 *     see an in-flight wake — a reviving agent reads `parked` right up until its
 *     session attaches — so the close must consult the revival set. The wake wins
 *     and the ref survives.
 *  2. `#revive()` re-reads the ref AFTER the rebuild and, if it is gone, disposes
 *     the session it just built and throws. This is the backstop for every path
 *     that drops a ref without consulting `#revivals` (explicit release, process
 *     teardown).
 *
 * IF THIS REGRESSES: waking a subagent that was closing leaks its whole live
 * resource set for the lifetime of the process, and the leak is unobservable —
 * nothing holds a reference to report on.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { AgentLifecycleManager } from "@veyyon/coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@veyyon/coding-agent/registry/agent-registry";
import type { AgentSession } from "@veyyon/coding-agent/session/agent-session";

interface SessionStub {
	session: AgentSession;
	disposeCalls: () => number;
}

function makeSessionStub(): SessionStub {
	let disposeCount = 0;
	const stub = {
		sessionManager: { flush: async () => {} },
		dispose: async () => {
			disposeCount++;
		},
	};
	return { session: stub as unknown as AgentSession, disposeCalls: () => disposeCount };
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve!: () => void;
	const promise = new Promise<void>(r => {
		resolve = r;
	});
	return { promise, resolve };
}

/** Let the microtask chain inside ensureLive reach its first await. */
async function flushAsync(): Promise<void> {
	for (let i = 0; i < 8; i++) await Promise.resolve();
}

describe("a revive racing a close leaks no session", () => {
	let registry: AgentRegistry;
	let lifecycle: AgentLifecycleManager;

	beforeEach(() => {
		AgentRegistry.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();
		registry = AgentRegistry.global();
		lifecycle = AgentLifecycleManager.global();
	});

	afterEach(() => {
		AgentLifecycleManager.resetGlobalForTests();
		AgentRegistry.resetGlobalForTests();
	});

	/** A parked ref with a reviver gated on `gate`, so the race window is explicit. */
	function parkAdopted(id: string, gate: Promise<void>, revived: SessionStub, reviverRuns: { n: number }) {
		registry.register({
			id,
			displayName: "task",
			kind: "sub",
			session: null,
			sessionFile: `/tmp/${id}.jsonl`,
			status: "parked",
		});
		lifecycle.adopt(id, {
			idleTtlMs: 0,
			closeParkedMs: 0,
			revive: async () => {
				reviverRuns.n++;
				await gate;
				return revived.session;
			},
		});
	}

	/**
	 * GUARD 1. The close lands squarely inside the revive window. It must decline,
	 * the ref must survive, and the woken session must be the one the registry now
	 * holds — an attach that no-opped onto a dropped ref is exactly what produced
	 * the orphan.
	 */
	it("refuses a close while a revive is in flight, and the woken session is the one the registry owns", async () => {
		const gate = deferred();
		const revived = makeSessionStub();
		const runs = { n: 0 };
		parkAdopted("Waking", gate.promise, revived, runs);

		const waking = lifecycle.ensureLive("Waking");
		await flushAsync();
		// The reviver is suspended: the wake is recorded but the session is not attached,
		// and the ref still reads `parked`, which is why status alone cannot see this.
		expect(runs.n).toBe(1);
		expect(registry.get("Waking")?.status).toBe("parked");

		// The close deadline fires right here.
		await lifecycle.close("Waking");
		// Refused: the ref is still registered and still adopted.
		expect(registry.get("Waking")).toBeDefined();
		expect(lifecycle.has("Waking")).toBe(true);

		gate.resolve();
		const session = await waking;

		// The wake won, end to end, and the registry owns exactly what the caller got.
		expect(session).toBe(revived.session);
		expect(registry.get("Waking")?.session).toBe(revived.session);
		expect(registry.get("Waking")?.status).toBe("idle");
		// Nothing was thrown away: an orphan-disposal here would mean the guard fired
		// when it should not have.
		expect(revived.disposeCalls()).toBe(0);
	});

	/**
	 * GUARD 2. The backstop, driven through `release`, which drops a ref WITHOUT
	 * consulting the revival set (process teardown and explicit release both do).
	 * The rebuilt session cannot be attached to anything, so `ensureLive` must
	 * REJECT and must dispose what it built. Resolving here is the orphan: a live
	 * session handed to a caller with no registry entry behind it.
	 */
	it("rejects and disposes the rebuilt session when the ref is released mid-revive", async () => {
		const gate = deferred();
		const revived = makeSessionStub();
		const runs = { n: 0 };
		parkAdopted("Dropped", gate.promise, revived, runs);

		const waking = lifecycle.ensureLive("Dropped");
		await flushAsync();
		expect(runs.n).toBe(1);

		// The ref goes away while the reviver is still building.
		await lifecycle.release("Dropped");
		expect(registry.get("Dropped")).toBeUndefined();

		gate.resolve();

		// Loud, with the exact operator-facing wording and the transcript pointer, so a
		// wake that arrives a moment too late is told what happened.
		await expect(waking).rejects.toThrow(
			'Agent "Dropped" was released while it was being revived. Its transcript remains readable at history://Dropped.',
		);
		// THE anti-orphan assertion: the session the reviver built was disposed exactly
		// once, right here, because no other code path can still reach it.
		expect(revived.disposeCalls()).toBe(1);
		expect(registry.get("Dropped")).toBeUndefined();
		expect(lifecycle.has("Dropped")).toBe(false);
	});

	/**
	 * The same race one step later: the revive completed and attached, and only THEN
	 * does the close deadline fire. Now there is nothing in flight and the agent is
	 * `idle`, so the close must decline on status and leave the live session alone.
	 * This is the case that keeps guard 1 from being written as "never close", which
	 * would make the close budget dead.
	 */
	it("still declines to close an agent that finished waking, and disposes nothing", async () => {
		const gate = deferred();
		const revived = makeSessionStub();
		const runs = { n: 0 };
		parkAdopted("Awake", gate.promise, revived, runs);

		gate.resolve();
		const session = await lifecycle.ensureLive("Awake");
		expect(registry.get("Awake")?.status).toBe("idle");

		await lifecycle.close("Awake");

		expect(registry.get("Awake")?.session).toBe(session);
		expect(registry.get("Awake")?.status).toBe("idle");
		expect(revived.disposeCalls()).toBe(0);
	});
});
