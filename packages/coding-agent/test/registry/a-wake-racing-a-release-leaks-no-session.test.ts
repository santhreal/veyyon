/**
 * A wake racing a release must never leave a live `AgentSession` that no registry
 * entry owns.
 *
 * THE BUG THIS LOCKS OUT. Waking an asleep agent means calling its reviver
 * (transcript replay, MCP handshake, auth), which is slow, and then attaching the
 * rebuilt session to its ref. In the window between those two, the ref can be
 * released (the end of its conversation, process teardown) or replaced by a new
 * registration under the same id, and `attachSession` and `setStatus` both NO-OP on
 * an unknown id. `ensureLive` then resolved with a fully live session owned by
 * nothing: MCP clients connected, file handles open, unreachable by any teardown.
 *
 * THE GUARD. `#revive()` re-reads the ref AFTER the rebuild and, if it is gone or
 * replaced, disposes the session it just built and throws with a transcript pointer.
 *
 * IF THIS REGRESSES: the wake resolves, the rebuilt session is never disposed, and
 * the leak is unobservable because nothing holds a reference to report on.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { AgentLifecycleManager } from "@veyyon/coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@veyyon/coding-agent/registry/agent-registry";
import type { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import { drainMicrotasks } from "../../../utils/test/helpers/drain-microtasks";

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

/** Let the microtask chain inside ensureLive reach its first await. */
async function flushAsync(): Promise<void> {
	await drainMicrotasks(8);
}

describe("a wake racing a release leaks no session", () => {
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

	/** An asleep ref with a reviver gated on `gate`, so the race window is explicit. */
	function adoptAsleep(id: string, gate: Promise<void>, revived: SessionStub, reviverRuns: { n: number }) {
		registry.register({
			id,
			displayName: "task",
			kind: "sub",
			session: null,
			sessionFile: `/tmp/${id}.jsonl`,
			status: "asleep",
		});
		lifecycle.adopt(id, {
			idleTtlMs: 0,
			revive: async () => {
				reviverRuns.n++;
				await gate;
				return revived.session;
			},
		});
	}

	/**
	 * Driven through `release`, which drops a ref WITHOUT consulting the wake in
	 * flight (process teardown and the end of a conversation both do). The rebuilt session cannot be attached to anything, so `ensureLive` must
	 * REJECT and must dispose what it built. Resolving here is the orphan: a live
	 * session handed to a caller with no registry entry behind it.
	 */
	it("rejects and disposes the rebuilt session when the ref is released mid-revive", async () => {
		const gate = Promise.withResolvers<void>();
		const revived = makeSessionStub();
		const runs = { n: 0 };
		adoptAsleep("Dropped", gate.promise, revived, runs);

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
			'Agent "Dropped" was released while it was waking. Its transcript remains readable at history://Dropped.',
		);
		// THE anti-orphan assertion: the session the reviver built was disposed exactly
		// once, right here, because no other code path can still reach it.
		expect(revived.disposeCalls()).toBe(1);
		expect(registry.get("Dropped")).toBeUndefined();
		expect(lifecycle.has("Dropped")).toBe(false);
	});

	/**
	 * Reusing an id while its previous generation wakes must not attach the old
	 * session to the replacement ref. Registry identity, not the id string alone,
	 * distinguishes the two generations.
	 */
	it("rejects and disposes a revived session when the id was re-registered mid-revive", async () => {
		const gate = Promise.withResolvers<void>();
		const revived = makeSessionStub();
		const runs = { n: 0 };
		adoptAsleep("Reused", gate.promise, revived, runs);

		const waking = lifecycle.ensureLive("Reused");
		await flushAsync();
		expect(runs.n).toBe(1);

		registry.unregister("Reused");
		const replacement = registry.register({
			id: "Reused",
			displayName: "replacement",
			kind: "sub",
			session: null,
			sessionFile: "/tmp/replacement.jsonl",
			scope: "another-conversation",
			status: "asleep",
		});
		gate.resolve();
		await expect(waking).rejects.toThrow(
			'Agent "Reused" was replaced while it was waking. Its transcript remains readable at history://Reused.',
		);
		expect(revived.disposeCalls()).toBe(1);
		expect(registry.get("Reused")).toBe(replacement);
		expect(replacement.session).toBeNull();
		expect(replacement.status).toBe("asleep");
	});

	/**
	 * Even if a replacement ref happens to hold the same session reference, registry
	 * identity must still guard against attaching the old sessionFile or waking a replaced ref.
	 */
	it("rejects and disposes a revived session when the ref was replaced even if session matched", async () => {
		const gate = Promise.withResolvers<void>();
		const revived = makeSessionStub();
		const runs = { n: 0 };
		adoptAsleep("ReplacedSameSession", gate.promise, revived, runs);

		const waking = lifecycle.ensureLive("ReplacedSameSession");
		await flushAsync();
		expect(runs.n).toBe(1);

		registry.unregister("ReplacedSameSession");
		const replacement = registry.register({
			id: "ReplacedSameSession",
			displayName: "replacement-same-session",
			kind: "sub",
			session: revived as never,
			sessionFile: "/tmp/new-generation.jsonl",
			scope: "scoped-conv",
			status: "idle",
		});
		gate.resolve();
		await expect(waking).rejects.toThrow(
			'Agent "ReplacedSameSession" was replaced while it was waking. Its transcript remains readable at history://ReplacedSameSession.',
		);
		expect(revived.disposeCalls()).toBe(1);
		expect(registry.get("ReplacedSameSession")).toBe(replacement);
	});
});
