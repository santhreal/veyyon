/**
 * An agent that stopped, for any reason, can be woken for the rest of the session.
 *
 * WHY THIS SUITE EXISTS. Agents used to end in one of two dead states. A killed, timed
 * out or failed run was `aborted`, which was terminal: a message to it was refused. A
 * finished agent was `parked` and then pruned from the roster an hour later, after
 * which it could not be messaged either. Both left an operator with an agent that had
 * stopped before finishing its goal and no way to tell it to continue.
 *
 * THE CLASS IT CLOSES. Every way a run can end (finished, each watchdog abort, a failure
 * with no watchdog, an isolated run, an explicit stop) leaves an agent that is still
 * registered however much time passes and that `ensureLive` wakes. The abort sweep is
 * keyed by `AbortReason`, so a new reason fails the type check until its outcome is
 * recorded here.
 *
 * WHAT IT DOES NOT CATCH. A one-shot eval helper (`keepAlive: false`) is still removed
 * when its run ends; that is asserted as the one exception. A wake can still fail when
 * the agent's workspace is gone (an isolated run with no persisted factory), and the
 * caller is pointed at the transcript instead.
 *
 * Time is driven with fake timers because the manager schedules one real `setTimeout`
 * per next deadline.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { AgentLifecycleManager } from "@veyyon/coding-agent/registry/agent-lifecycle";
import { AgentRegistry, type AgentStatus } from "@veyyon/coding-agent/registry/agent-registry";
import * as sdkModule from "@veyyon/coding-agent/sdk";
import type { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import { finalizeSubagentLifecycle, runSubprocess, saysItIsWaitingOnAPeer } from "@veyyon/coding-agent/task/executor";
import type { AbortReason } from "@veyyon/coding-agent/task/run-monitor";
import { drainMicrotasks } from "../../utils/test/helpers/drain-microtasks";
import {
	createAssistantStopMessage,
	createAssistantToolCallMessage,
	createMockSession,
	yieldSuccessEvent,
} from "./helpers/agent-session";

const IDLE_TTL_MS = 5 * 60_000;
const ONE_WEEK_MS = 7 * 24 * 60 * 60_000;

/**
 * The calls the lifecycle manager makes on a session: a durable flush, dispose, and
 * abort for a running one. `onAbort` stands in for the turn ending, which a real
 * session reports through `agent_end`.
 */
function fakeSession(onAbort?: () => void): AgentSession {
	return {
		sessionManager: { flush: async (): Promise<void> => {} },
		dispose: async (): Promise<void> => {},
		abort: async (): Promise<void> => {
			onAbort?.();
		},
	} as unknown as AgentSession;
}

/** A session whose durable flush fails the first `n` times, which postpones its sleep. */
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

/** Register an idle, adopted agent, as a finished run leaves one. */
function adoptIdleAgent(id: string, session: AgentSession = fakeSession()): void {
	const registry = AgentRegistry.global();
	registry.register({ id, displayName: id, kind: "sub", session, sessionFile: `/repo/${id}.jsonl` });
	registry.setStatus(id, "idle");
	AgentLifecycleManager.global().adopt(id, { idleTtlMs: IDLE_TTL_MS, revive: async () => fakeSession() });
}

/**
 * Count how many times the lifecycle manager re-arms its single scheduler timer: the
 * only externally visible trace of a due deadline left in place, which re-arms with a
 * zero delay forever while every registry assertion stays green.
 */
function countSchedulerWakes(): { count: () => number; restore: () => void } {
	const spy = vi.spyOn(globalThis, "setTimeout");
	return { count: () => spy.mock.calls.length, restore: () => spy.mockRestore() };
}

/** Advance the clock and let the manager's async sleep work settle. */
async function advance(ms: number): Promise<void> {
	vi.advanceTimersByTime(ms);
	await drainMicrotasks(8);
}

function useFreshLifecycle(options: { fakeTimers: boolean }): void {
	beforeEach(() => {
		if (options.fakeTimers) vi.useFakeTimers();
		AgentRegistry.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();
	});
	afterEach(() => {
		vi.restoreAllMocks();
		AgentLifecycleManager.resetGlobalForTests();
		AgentRegistry.resetGlobalForTests();
		if (options.fakeTimers) vi.useRealTimers();
	});
}

/**
 * Where each watchdog abort leaves the agent the moment its run settles. A request-limit
 * stop keeps its session live (`idle`); every other abort closes it (`asleep`). Keyed by
 * `AbortReason` so a new reason is a type error here until someone records its outcome.
 */
const STATUS_AFTER_ABORT = {
	signal: "asleep",
	terminate: "asleep",
	timeout: "asleep",
	budget: "idle",
} satisfies Record<AbortReason, AgentStatus>;

interface RunEnding {
	name: string;
	aborted: boolean;
	abortKind?: AbortReason;
	settlesAs: AgentStatus;
}

const RUN_ENDINGS: RunEnding[] = [
	{ name: "finished", aborted: false, settlesAs: "idle" },
	{ name: "failed with no watchdog", aborted: true, settlesAs: "asleep" },
	...(Object.entries(STATUS_AFTER_ABORT) as [AbortReason, AgentStatus][]).map(([abortKind, settlesAs]) => ({
		name: `aborted by ${abortKind}`,
		aborted: true,
		abortKind,
		settlesAs,
	})),
];

describe("every way a run ends leaves an agent that wakes", () => {
	useFreshLifecycle({ fakeTimers: true });

	it.each(RUN_ENDINGS)("$name: settles, falls asleep, stays listed and wakes a week later", async ending => {
		const registry = AgentRegistry.global();
		const session = fakeSession();
		const woken = fakeSession();
		registry.register({ id: "Worker", displayName: "task", kind: "sub", session, sessionFile: "/repo/Worker.jsonl" });

		await finalizeSubagentLifecycle({
			id: "Worker",
			session,
			aborted: ending.aborted,
			abortKind: ending.abortKind,
			keepAlive: true,
			isolated: false,
			agentIdleTtlMs: IDLE_TTL_MS,
			reviveSession: async () => woken,
		});
		expect(registry.get("Worker")?.status).toBe(ending.settlesAs);

		await advance(IDLE_TTL_MS);
		expect(registry.get("Worker")?.status).toBe("asleep");
		expect(registry.get("Worker")?.session).toBeNull();

		await advance(ONE_WEEK_MS);
		expect(registry.get("Worker")?.status).toBe("asleep");

		expect(await AgentLifecycleManager.global().ensureLive("Worker")).toBe(woken);
		expect(registry.get("Worker")?.status).toBe("idle");
	});

	/**
	 * An isolated run's worktree is merged and removed when the run ends, so it falls
	 * asleep at once with no reviver of its own. A wake goes through the persisted-agent
	 * factory, which rebuilds it from the transcript.
	 */
	it("an isolated run falls asleep at once and wakes through the persisted factory", async () => {
		const registry = AgentRegistry.global();
		const session = fakeSession();
		const rebuilt = fakeSession();
		registry.register({ id: "Isolated", displayName: "task", kind: "sub", session, sessionFile: "/repo/I.jsonl" });
		AgentLifecycleManager.global().setPersistedAgentReviverFactory(async () => async () => rebuilt, IDLE_TTL_MS);

		await finalizeSubagentLifecycle({
			id: "Isolated",
			session,
			aborted: false,
			keepAlive: true,
			isolated: true,
			agentIdleTtlMs: IDLE_TTL_MS,
			reviveSession: async () => fakeSession(),
		});
		expect(registry.get("Isolated")?.status).toBe("asleep");

		await advance(ONE_WEEK_MS);
		expect(await AgentLifecycleManager.global().ensureLive("Isolated")).toBe(rebuilt);
		expect(registry.get("Isolated")?.status).toBe("idle");
	});

	/** With no factory to rebuild it, the caller is told the workspace is gone and pointed at the transcript. */
	it("an isolated run that cannot be rebuilt points the caller at history://", async () => {
		const registry = AgentRegistry.global();
		const session = fakeSession();
		registry.register({ id: "Gone", displayName: "task", kind: "sub", session, sessionFile: "/repo/Gone.jsonl" });

		await finalizeSubagentLifecycle({
			id: "Gone",
			session,
			aborted: false,
			keepAlive: true,
			isolated: true,
			agentIdleTtlMs: IDLE_TTL_MS,
			reviveSession: null,
		});

		expect(registry.get("Gone")?.status).toBe("asleep");
		await expect(AgentLifecycleManager.global().ensureLive("Gone")).rejects.toThrow(
			'Agent "Gone" is asleep and cannot be woken (its transcript or workspace is gone). Read history://Gone for what it did.',
		);
	});

	/** The one exception: a one-shot eval helper is removed when its run ends. */
	it("a one-shot helper is unregistered when its run ends", async () => {
		const registry = AgentRegistry.global();
		const session = fakeSession();
		registry.register({ id: "Helper", displayName: "task", kind: "sub", session, sessionFile: null });

		await finalizeSubagentLifecycle({
			id: "Helper",
			session,
			aborted: false,
			keepAlive: false,
			isolated: false,
			agentIdleTtlMs: IDLE_TTL_MS,
			reviveSession: null,
		});

		expect(registry.get("Helper")).toBeUndefined();
	});
});

/**
 * An explicit stop (`x` on the roster, `job cancel`, a collab kill) aborts the turn in
 * flight and puts the agent and everything it spawned to sleep, deepest first. None of
 * them is removed, and each one wakes when messaged.
 */
describe("stopping an agent puts it and its children to sleep", () => {
	useFreshLifecycle({ fakeTimers: false });

	it("aborts the running turns, sleeps the whole subtree, and every member wakes", async () => {
		const registry = AgentRegistry.global();
		const lifecycle = AgentLifecycleManager.global();
		for (const [id, parentId] of [
			["Lead", undefined],
			["Helper", "Lead"],
		] as const) {
			const session = fakeSession(() => registry.setStatus(id, "idle"));
			registry.register({
				id,
				displayName: "task",
				kind: "sub",
				parentId,
				session,
				sessionFile: `/repo/${id}.jsonl`,
			});
			registry.setStatus(id, "idle");
			lifecycle.adopt(id, { idleTtlMs: IDLE_TTL_MS, revive: async () => fakeSession() });
			registry.setStatus(id, "running");
		}

		await lifecycle.stop("Lead", "stopped by the operator");

		for (const id of ["Lead", "Helper"]) {
			expect(registry.get(id)?.status).toBe("asleep");
			expect(registry.get(id)?.session).toBeNull();
		}
		await lifecycle.ensureLive("Helper");
		await lifecycle.ensureLive("Lead");
		expect(registry.get("Lead")?.status).toBe("idle");
		expect(registry.get("Helper")?.status).toBe("idle");
	});
});

/**
 * Messaging an agent while its stopped session is still closing.
 *
 * THE WINDOW. A stopped run awaits `dispose()` under a five-second deadline, and a
 * message to an agent that just stopped is the most likely message there is. A wake
 * landing in that window must not receive the session being torn down, and must not
 * be refused either: it waits for the close, then wakes the agent from the transcript
 * the close flushed.
 */
describe("a wake that lands while a stopped session is closing", () => {
	useFreshLifecycle({ fakeTimers: false });

	it("waits for the close, then wakes the agent with a fresh session", async () => {
		const disposing = Promise.withResolvers<void>();
		const woken = fakeSession();
		let wakeInsideWindow: Promise<AgentSession> | undefined;
		const session = {
			sessionManager: { flush: async (): Promise<void> => {} },
			dispose: async (): Promise<void> => {
				wakeInsideWindow = AgentLifecycleManager.global().ensureLive("Stopped");
				await disposing.promise;
			},
		} as unknown as AgentSession;
		AgentRegistry.global().register({
			id: "Stopped",
			displayName: "Stopped",
			kind: "sub",
			session,
			sessionFile: "/repo/Stopped.jsonl",
		});

		const settled = finalizeSubagentLifecycle({
			id: "Stopped",
			session,
			aborted: true,
			abortKind: "timeout",
			keepAlive: true,
			isolated: false,
			agentIdleTtlMs: IDLE_TTL_MS,
			reviveSession: async () => woken,
		});

		await Promise.resolve();
		expect(wakeInsideWindow).toBeDefined();
		disposing.resolve();
		await settled;

		expect(await wakeInsideWindow).toBe(woken);
		expect(AgentRegistry.global().get("Stopped")?.status).toBe("idle");
		expect(AgentRegistry.global().get("Stopped")?.session).toBe(woken);
	});
});

/**
 * Which sign-off counts as "waiting on a peer".
 *
 * The flag is display-only: the roster shows the agent as `waiting` rather than idle or
 * asleep. These cases pin the POSITION rule: the clause counts when it opens a sentence,
 * follows a label or list marker, or follows a subject making the agent the waiter, and
 * does not count when it is buried mid-sentence in prose about something else.
 */
describe("waiting sign-off detection", () => {
	it.each([
		"Waiting on SourceLfsGates before I can integrate.",
		"waiting for the audit to finish, then I will land it.",
		"Blocked: waits for InstallerTests to report.",
		"I am WAITING ON the reviewer.",
		"Landed the parser. Still waiting for the differential run.",
		"Handed the schema over; I'm waiting on Main to pick an owner.",
		"Status:\n- Parser landed\n- Waiting on ReviewBot for the diff review\n",
		"* waiting for the merge window to open",
		"1. Waiting on Main to pick an owner",
		"> Waiting on the installer gates",
	])("treats %p as waiting", text => {
		expect(saysItIsWaitingOnAPeer(text)).toBe(true);
	});

	it.each([
		"Stopped waiting and shipped it.",
		"The fix was worth waiting for the rebuild to prove.",
		"No waiting involved; the cache was warm.",
		"That regression was not worth waiting on.",
		"Done. Nothing is pending.",
		"- The fix was worth waiting for the rebuild to prove.",
		"- Everything landed; nothing pending.",
	])("does not treat %p as waiting", text => {
		expect(saysItIsWaitingOnAPeer(text)).toBe(false);
	});

	it("treats absent output as not waiting", () => {
		expect(saysItIsWaitingOnAPeer(undefined)).toBe(false);
		expect(saysItIsWaitingOnAPeer("")).toBe(false);
	});

	/**
	 * Reading the sign-off must not disturb the sleep clock. `setWaitingOnPeer` emits no
	 * event and leaves `lastActivity` alone, because a bump there would restart the idle
	 * countdown.
	 */
	describe("on the sleep clock", () => {
		useFreshLifecycle({ fakeTimers: true });

		it("still falls asleep on schedule after reading the sign-off", async () => {
			const session = fakeSession();
			AgentRegistry.global().register({
				id: "Blocked",
				displayName: "task",
				kind: "sub",
				session,
				sessionFile: "/repo/Blocked.jsonl",
			});
			await finalizeSubagentLifecycle({
				id: "Blocked",
				session,
				aborted: false,
				keepAlive: true,
				isolated: false,
				agentIdleTtlMs: IDLE_TTL_MS,
				signOff: "Waiting on InstallerTests before I can integrate.",
				reviveSession: async () => fakeSession(),
			});
			expect(AgentRegistry.global().get("Blocked")?.waitingOnPeer).toBe(true);

			await advance(IDLE_TTL_MS - 1_000);
			expect(AgentRegistry.global().get("Blocked")?.status).toBe("idle");

			await advance(1_000);
			expect(AgentRegistry.global().get("Blocked")?.status).toBe("asleep");
		});
	});
});

/**
 * THE INVARIANT: after any expiry pass, no adopted entry still holds a deadline that is
 * already in the past. Violating it changes nothing about any agent; the single
 * next-deadline timer re-selects the stranded entry and wakes again with a zero delay
 * for the rest of the process. The scheduler wake count is the only trace.
 */
describe("no due deadline survives an expiry unactioned", () => {
	let wakes: { count: () => number; restore: () => void };
	useFreshLifecycle({ fakeTimers: true });
	beforeEach(() => {
		wakes = countSchedulerWakes();
	});
	afterEach(() => {
		wakes.restore();
	});

	/** A sleep whose flush failed stays live, is retried a full TTL later, and then sleeps. */
	it("sleeps an agent on the retry after its first flush failed, without a hot loop", async () => {
		adoptIdleAgent("Flaky", flakySession(1));

		await advance(IDLE_TTL_MS);
		expect(AgentRegistry.global().get("Flaky")?.status).toBe("idle");
		expect(AgentRegistry.global().get("Flaky")?.session).not.toBeNull();

		await advance(IDLE_TTL_MS);
		expect(AgentRegistry.global().get("Flaky")?.status).toBe("asleep");

		const settled = wakes.count();
		await advance(25);
		expect(wakes.count() - settled, "the scheduler re-armed inside a quiet window").toBe(0);
	});

	/** The quiet control: an agent on a future deadline does not wake the scheduler at all. */
	it("does not wake at all while every deadline is in the future", async () => {
		adoptIdleAgent("Quiet");

		const armed = wakes.count();
		await advance(IDLE_TTL_MS - 1_000);

		expect(wakes.count()).toBe(armed);
		expect(AgentRegistry.global().get("Quiet")?.status).toBe("idle");
	});

	/**
	 * Expiries drain serially, so a later agent in the batch can run a whole turn and go
	 * idle again while the first one's flush is blocked. Its queued sleep then describes
	 * an agent that no longer exists, and the fresh deadline its turn armed wins.
	 */
	it("drops a queued sleep for an agent that went idle again during the drain", async () => {
		const flushGate = Promise.withResolvers<void>();
		const slow = {
			sessionManager: {
				flush: async (): Promise<void> => {
					await flushGate.promise;
				},
			},
			dispose: async (): Promise<void> => {},
		} as unknown as AgentSession;
		adoptIdleAgent("Slow", slow);
		adoptIdleAgent("Busy");

		await advance(IDLE_TTL_MS);
		AgentRegistry.global().setStatus("Busy", "running");
		AgentRegistry.global().setStatus("Busy", "idle");

		flushGate.resolve();
		await advance(0);

		expect(AgentRegistry.global().get("Slow")?.status).toBe("asleep");
		expect(AgentRegistry.global().get("Busy")?.status).toBe("idle");
		expect(AgentRegistry.global().get("Busy")?.session).not.toBeNull();

		await advance(IDLE_TTL_MS);
		expect(AgentRegistry.global().get("Busy")?.status).toBe("asleep");
	});
});

/**
 * WHICH text the waiting signal reads, driven through a real `runSubprocess`: the
 * sign-off, falling back to the run's accumulated text only when the final message
 * carried none. A "waiting on X" line written early and since resolved must not mark
 * the agent as waiting.
 */
describe("the waiting signal reads the sign-off, not the whole run", () => {
	const artifactDirs: string[] = [];
	useFreshLifecycle({ fakeTimers: false });
	afterEach(() => {
		for (const dir of artifactDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	/**
	 * Run one agent that emits `turns` as assistant messages and then yields. The stub
	 * registers the agent because the real `createAgentSession` does; without it every
	 * registry call in `finalizeSubagentLifecycle` is a no-op on an unknown id.
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
					if (options.endWithBareToolCall) {
						pushTurn(createAssistantToolCallMessage("yield", "tool-yield", { result: { data: "done" } }));
					}
					emit(yieldSuccessEvent("done"));
				},
				{ activeToolNames: ["yield"] },
			);
			AgentRegistry.global().register({ id, displayName: id, kind: "sub", session, sessionFile: null });
			return { session, extensionsResult: {}, setToolUIContext: () => {}, setToolNotifier: () => {} } as never;
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

	it("ignores a waiting line the agent has since resolved", async () => {
		await runWithTurns("Revised", [
			"Status:\n- Parser landed\n- Waiting on ReviewBot for the diff review\n",
			"ReviewBot answered and I landed the parser fix. Nothing pending.",
		]);

		expect(AgentRegistry.global().get("Revised")?.waitingOnPeer).toBe(false);
	});

	it("still detects a waiting sign-off", async () => {
		await runWithTurns("Waiter", [
			"Landed the parser fix and pushed it.",
			"Waiting on ReviewBot before I can integrate.",
		]);

		expect(AgentRegistry.global().get("Waiter")?.waitingOnPeer).toBe(true);
	});

	it("falls back to the run's text when the final message carried none", async () => {
		await runWithTurns("Silent", ["Waiting on ReviewBot before I can integrate."], {
			endWithBareToolCall: true,
		});

		expect(AgentRegistry.global().get("Silent")?.waitingOnPeer).toBe(true);
	});
});
