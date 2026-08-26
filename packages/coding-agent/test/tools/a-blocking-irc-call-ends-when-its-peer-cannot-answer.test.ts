/**
 * WHY:
 * `irc` has two blocking calls, and they disagreed about who counts as alive.
 * `op: "wait"` passed a `liveness` watcher to `IrcBus.wait`, so it ended the
 * moment its peer stopped running. `op: "send"` with `await: true` omitted it
 * entirely, so a sender whose recipient was killed, crashed, or terminated sat
 * for the full `irc.timeoutMs` (120s by default) — or forever with
 * `timeoutMs: 0` — waiting for a reply that could never arrive.
 *
 * The defect class is "two sibling paths, one guard": the fix routes both
 * blocking paths through the same watcher, and this suite sweeps both rather
 * than the one that was reported.
 *
 * The two paths need different predicates, and getting that wrong is the
 * regression this suite is most concerned with. A bare `wait` wakes nobody, so
 * its peer must be actively `running`. A `send` wakes an idle or parked
 * recipient by delivering to it, and `listVisibleTo` omits a parked ref
 * altogether, so reusing the `running` predicate there would abort every
 * send-await to an idle peer — the ordinary case — the instant it was armed.
 * `revivable` therefore asks only whether the peer still exists and was not
 * terminated.
 *
 * Each death assertion pins the REASON the call ended, not merely that it
 * ended. The peer is killed while the call is armed, and a short timeout runs
 * alongside it, so an unguarded path still settles — but by running out of
 * time, reporting "no reply", instead of reporting the peer gone. Asserting
 * the abort message therefore separates "ended because nobody can answer" from
 * "ended because the clock expired", it fails in milliseconds rather than
 * hanging a runner, and it tells the two liveness predicates apart, since each
 * states a different reason.
 *
 * What this does NOT catch:
 * - A recipient that receives the message, finishes its turn without replying,
 *   and goes `idle`. It stays revivable and the wait runs to its timeout. That
 *   is deliberate: another agent or the operator may still wake it, and the
 *   timeout already reports "they may answer later".
 * - Delivery-transport failures inside a live peer's session.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { IrcBus, type IrcMessage } from "@veyyon/coding-agent/irc/bus";
import { AgentLifecycleManager } from "@veyyon/coding-agent/registry/agent-lifecycle";
import { AGENT_STATUSES, AgentRegistry, type AgentStatus } from "@veyyon/coding-agent/registry/agent-registry";
import type { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import type { ToolSession } from "@veyyon/coding-agent/tools";
import { IrcTool } from "@veyyon/coding-agent/tools/irc";

/** A peer that accepts delivery and never answers, unless `onDeliver` replies. */
function makePeer(onDeliver?: (msg: IrcMessage) => void): AgentSession {
	const session = {
		deliverIrcMessage: async (msg: IrcMessage) => {
			onDeliver?.(msg);
			return "injected" as const;
		},
		emitIrcRelayObservation: () => {},
	};
	return session as unknown as AgentSession;
}

function makeToolSession(registry: AgentRegistry, agentId: string): ToolSession {
	return {
		cwd: "/workspace",
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated(),
		agentRegistry: registry,
		getAgentId: () => agentId,
	};
}

describe("a blocking irc call ends when its peer cannot answer", () => {
	let registry: AgentRegistry;
	let bus: IrcBus;

	beforeEach(() => {
		AgentRegistry.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();
		IrcBus.resetGlobalForTests();
		registry = AgentRegistry.global();
		bus = IrcBus.global();
		registry.register({ id: "Main", displayName: "main", kind: "main", session: makePeer(), status: "running" });
	});

	afterEach(() => {
		vi.restoreAllMocks();
		AgentRegistry.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();
		IrcBus.resetGlobalForTests();
	});

	describe("both blocking paths end rather than run to their timeout", () => {
		it("ends a send-await when the recipient is terminated", async () => {
			registry.register({
				id: "Worker",
				displayName: "worker",
				kind: "sub",
				session: makePeer(),
				status: "running",
			});
			const tool = new IrcTool(makeToolSession(registry, "Main"));

			// A short timeout runs alongside the watcher, so an unguarded path still
			// settles — as a "no reply" timeout, which is the wrong reason and fails.
			const pending = tool.execute("call-1", {
				op: "send",
				to: "Worker",
				message: "are you there",
				await: true,
				timeoutMs: 25,
			});
			registry.setStatus("Worker", "aborted");

			await expect(pending).rejects.toThrow(/agent "Worker" has exited and cannot reply/);
		});

		it("ends a send-await when the recipient leaves the registry", async () => {
			registry.register({
				id: "Worker",
				displayName: "worker",
				kind: "sub",
				session: makePeer(),
				status: "running",
			});
			const tool = new IrcTool(makeToolSession(registry, "Main"));

			const pending = tool.execute("call-1", {
				op: "send",
				to: "Worker",
				message: "are you there",
				await: true,
				timeoutMs: 25,
			});
			registry.unregister("Worker");

			await expect(pending).rejects.toThrow(/agent "Worker" has exited and cannot reply/);
		});

		it("ends a wait when the peer stops running", async () => {
			registry.register({
				id: "Worker",
				displayName: "worker",
				kind: "sub",
				session: makePeer(),
				status: "running",
			});
			const tool = new IrcTool(makeToolSession(registry, "Main"));

			const pending = tool.execute("call-1", { op: "wait", from: "Worker", timeoutMs: 25 });
			registry.setStatus("Worker", "aborted");

			const result = await pending;
			expect(result.isError).toBe(true);
			const part = result.content[0];
			expect(part?.type === "text" ? part.text : "").toMatch(/agent "Worker" is not running/);
		});
	});

	describe("a recipient that can still be woken is not treated as gone", () => {
		it("returns the reply from a peer that was idle when the send was armed", async () => {
			// The `running` predicate would abort this the instant the wait was
			// armed, because an idle peer is not running. Delivery wakes it.
			registry.register({
				id: "Worker",
				displayName: "worker",
				kind: "sub",
				session: makePeer(() => {
					void bus.send({ from: "Worker", to: "Main", body: "still here" });
				}),
				status: "idle",
			});
			const tool = new IrcTool(makeToolSession(registry, "Main"));

			const result = await tool.execute("call-1", {
				op: "send",
				to: "Worker",
				message: "are you there",
				await: true,
				timeoutMs: 0,
			});

			expect(result.isError).toBeFalsy();
			const reply: IrcMessage | null | undefined = result.details?.waited;
			expect(reply?.body).toBe("still here");
		});

		it("still bounds a send-await by its timeout when the peer stays alive and silent", async () => {
			registry.register({
				id: "Worker",
				displayName: "worker",
				kind: "sub",
				session: makePeer(),
				status: "running",
			});
			const tool = new IrcTool(makeToolSession(registry, "Main"));

			// The peer never answers and never dies, so the bound is the only thing
			// that can settle this. It resolves rather than hanging or rejecting.
			const result = await tool.execute("call-1", {
				op: "send",
				to: "Worker",
				message: "are you there",
				await: true,
				timeoutMs: 25,
			});

			expect(result.isError).toBeFalsy();
			expect(result.details?.waited).toBeNull();
			const part = result.content[0];
			expect(part?.type === "text" ? part.text : "").toMatch(/No reply from Worker/);
		});
	});

	describe("the revivable predicate across every agent status", () => {
		/**
		 * Sweeps the status union from source at run time, so a new member turns
		 * this red until someone records a decision for it.
		 */
		async function abortsAtArmTime(status: AgentStatus): Promise<boolean> {
			registry.register({
				id: "Worker",
				displayName: "worker",
				kind: "sub",
				session: status === "parked" ? null : makePeer(),
				status,
			});
			const waiting = bus.wait("Main", { from: "Worker" }, 0, undefined, {
				liveness: { registry, senderId: "Main", mode: "revivable" },
			});
			// If the watcher aborted while arming, the waiter is already gone and
			// this message lands in the mailbox instead of satisfying the wait.
			await bus.send({ from: "Worker", to: "Main", body: "reply" });
			return waiting.then(
				() => false,
				() => true,
			);
		}

		it("treats only a terminated peer as unable to reply", async () => {
			const aborting: AgentStatus[] = [];
			const surviving: AgentStatus[] = [];
			for (const status of AGENT_STATUSES) {
				const aborted = await abortsAtArmTime(status);
				(aborted ? aborting : surviving).push(status);
				AgentRegistry.resetGlobalForTests();
				IrcBus.resetGlobalForTests();
				registry = AgentRegistry.global();
				bus = IrcBus.global();
				registry.register({
					id: "Main",
					displayName: "main",
					kind: "main",
					session: makePeer(),
					status: "running",
				});
			}

			expect(aborting).toEqual(["aborted"]);
			expect(surviving).toEqual(["running", "idle", "parked"]);
		});
	});
});
