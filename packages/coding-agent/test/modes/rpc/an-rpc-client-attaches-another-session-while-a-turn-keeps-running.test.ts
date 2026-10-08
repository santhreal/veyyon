/**
 * An RPC client attaches another session while the one it drove keeps its turn running.
 *
 * WHY THIS SUITE EXISTS: backgrounding a running turn was reachable only from the terminal's
 * `/new`. RPC `new_session` with `background: true` and `switch_session` to a transcript a
 * background conversation writes both go through `RpcSessionSlot`, which moves the driven session
 * into `BackgroundSessions` and re-routes the client. The class this closes is "the client and the
 * background set disagree about who owns a session": a session the client still receives events
 * from after it left, a session both driven and registered, a session dropped without being
 * registered or disposed, a session adopted twice, a failure that leaves the client on nothing, or
 * more conversations streaming off-screen than `session.backgroundLimit`. The generative case
 * drives random command sequences against the real slot and the real background set and checks
 * every invariant after each step.
 *
 * Not caught: the stdin dispatch in `runRpcMode` (which command reaches the slot, the
 * `parentSession` refusal, the `available_commands_update` it emits), which needs the spawned CLI.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { type RpcSessionRouting, RpcSessionSlot } from "@veyyon/coding-agent/modes/rpc/rpc-session-slot";
import type { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import {
	type AttachableSession,
	BACKGROUND_LIMIT_STOP_REASON,
	BackgroundSessions,
} from "@veyyon/coding-agent/session/background-sessions";

interface Conversation {
	readonly id: string;
	readonly file: string;
	readonly session: AgentSession;
	readonly aborts: string[];
	readonly streaming: () => boolean;
	readonly disposed: () => boolean;
	/** Begins a turn that runs until it finishes or is aborted. */
	start(): void;
	finish(): void;
}

/** The `session.backgroundLimit` every fake session reads, mutable per test. */
let backgroundLimit = 3;

function conversation(id: string): Conversation {
	let turn = Promise.withResolvers<void>();
	let running = false;
	let disposed = false;
	const aborts: string[] = [];
	const file = `/repo/sessions/${id}.jsonl`;
	const end = () => {
		running = false;
		turn.resolve();
	};
	const session = {
		sessionManager: {
			getSessionId: () => id,
			getSessionName: () => `Title of ${id}`,
			getSessionFile: () => file,
			flush: async () => {},
		},
		settings: {
			get: (key: string) => {
				if (key !== "session.backgroundLimit") throw new Error(`unexpected setting ${key}`);
				return backgroundLimit;
			},
		},
		get isStreaming() {
			return running;
		},
		waitForQuiescence: async (signal?: AbortSignal) => {
			if (!running || signal?.aborted) return;
			const aborted = Promise.withResolvers<void>();
			signal?.addEventListener("abort", () => aborted.resolve(), { once: true });
			await Promise.race([turn.promise, aborted.promise]);
		},
		abort: async (options?: { reason?: string }) => {
			aborts.push(options?.reason ?? "");
			end();
		},
		dispose: async () => {
			disposed = true;
		},
	} as unknown as AgentSession;
	return {
		id,
		file,
		session,
		aborts,
		streaming: () => running,
		disposed: () => disposed,
		start: () => {
			running = true;
			turn = Promise.withResolvers<void>();
		},
		finish: end,
	};
}

function attachable(conv: Conversation): AttachableSession {
	return { session: conv.session, setToolUIContext: () => {}, setToolNotifier: () => {} };
}

interface Harness {
	readonly slot: RpcSessionSlot;
	readonly keeper: BackgroundSessions;
	readonly initial: Conversation;
	/** Every session this harness built, the initial one first. */
	readonly conversations: Conversation[];
	/** Sessions whose events currently reach the client. */
	readonly routed: Set<AgentSession>;
	/** Sessions the routing installed the client's tool UI and extensions on, in order. */
	readonly adopted: AgentSession[];
	/** The conversation the client drives. */
	driven(): Conversation;
	/** Await every registered conversation whose turn ended, so the set reflects it. */
	settle(): Promise<void>;
}

interface HarnessOptions {
	readonly factory?: boolean;
	readonly failBuild?: boolean;
	readonly failAdopt?: boolean;
}

const keepers: BackgroundSessions[] = [];

afterEach(async () => {
	for (const keeper of keepers.splice(0)) {
		for (const running of keeper.list()) await keeper.cancel(running.sessionId, "test teardown");
	}
	backgroundLimit = 3;
});

function harness(options: HarnessOptions = {}): Harness {
	const keeper = new BackgroundSessions();
	keepers.push(keeper);
	const initial = conversation("s0");
	const conversations = [initial];
	const routed = new Set<AgentSession>();
	const adopted: AgentSession[] = [];
	const routing: RpcSessionRouting = {
		route: session => {
			routed.add(session);
			return () => {
				routed.delete(session);
			};
		},
		adopt: async next => {
			if (options.failAdopt) throw new Error("adopt failed");
			adopted.push(next.session);
		},
	};
	const createNextSession =
		options.factory === false
			? undefined
			: async () => {
					if (options.failBuild) throw new Error("build failed");
					const next = conversation(`s${conversations.length}`);
					conversations.push(next);
					return attachable(next);
				};
	const slot = new RpcSessionSlot(initial.session, { routing, createNextSession, keeper });
	return {
		slot,
		keeper,
		initial,
		conversations,
		routed,
		adopted,
		driven: () => {
			const found = conversations.find(conv => conv.session === slot.session);
			if (!found) throw new Error("the slot drives a session this harness never built");
			return found;
		},
		settle: async () => {
			for (const conv of conversations) {
				if (!conv.streaming()) await keeper.find(conv.file)?.settled;
			}
		},
	};
}

/** A deterministic generator, so a failing seed reproduces. */
function mulberry32(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

function expectedMessage(id: string, streaming: boolean, displaced: readonly string[], limit: number): string {
	const outcome = streaming ? "continues in the background" : "closes once its background jobs finish";
	const stopped = displaced.length > 0 ? `; stopped ${displaced.join(", ")} (background limit ${limit})` : "";
	return `${id} ${outcome}${stopped}`;
}

/** Every invariant that holds between commands, whatever sequence led here. */
function expectConsistent(h: Harness): void {
	const driven = h.driven();
	// The client receives events from the session it drives and from nothing else.
	expect([...h.routed]).toEqual([driven.session]);
	expect(driven.disposed()).toBe(false);
	expect(h.keeper.find(driven.file)).toBeUndefined();
	for (const conv of h.conversations) {
		if (conv === driven) continue;
		const registered = h.keeper.find(conv.file) !== undefined;
		// Left behind: still running in the background, or ended and disposed. Never both, never neither.
		expect({ id: conv.id, registered, disposed: conv.disposed() }).toEqual({
			id: conv.id,
			registered: !conv.disposed(),
			disposed: !registered,
		});
		if (registered) expect(conv.streaming()).toBe(true);
	}
	expect(h.keeper.size).toBeLessThanOrEqual(backgroundLimit);
	// Each built session is adopted once; a reclaimed one keeps the state it was adopted with.
	expect(h.adopted).toEqual(h.conversations.slice(1).map(conv => conv.session));
}

describe("an RPC session handoff", () => {
	it("resets an idle session in place: nothing is built and nothing enters the background", async () => {
		const h = harness();
		await expect(h.slot.background()).resolves.toBeUndefined();
		expect(h.conversations).toHaveLength(1);
		expect(h.slot.session).toBe(h.initial.session);
		expect(h.keeper.size).toBe(0);
		expectConsistent(h);
	});

	it("keeps the running turn and attaches the client to a new session", async () => {
		const h = harness();
		h.initial.start();
		const handoff = await h.slot.background();
		expect(handoff).toEqual({
			sessionId: "s0",
			sessionFile: h.initial.file,
			streaming: true,
			displaced: [],
			message: "s0 continues in the background",
		});
		expect(h.slot.session).toBe(h.conversations[1].session);
		expect(h.keeper.list().map(c => ({ sessionId: c.sessionId, streaming: c.streaming }))).toEqual([
			{ sessionId: "s0", streaming: true },
		]);
		expect(h.initial.aborts).toEqual([]);
		expectConsistent(h);
	});

	it("refuses on a host that cannot build a second session, and the client keeps its session", async () => {
		const h = harness({ factory: false });
		h.initial.start();
		await expect(h.slot.background()).rejects.toThrow("cannot create a second session");
		expect(h.slot.session).toBe(h.initial.session);
		expect(h.keeper.size).toBe(0);
		expect(h.initial.streaming()).toBe(true);
		expectConsistent(h);
	});

	it.each([
		["building", { failBuild: true }, "build failed"],
		["adopting", { failAdopt: true }, "adopt failed"],
	] as const)("leaves the client on its session when %s the next one fails", async (_label, options, message) => {
		const h = harness(options);
		h.initial.start();
		await expect(h.slot.background()).rejects.toThrow(message);
		expect(h.slot.session).toBe(h.initial.session);
		expect([...h.routed]).toEqual([h.initial.session]);
		expect(h.keeper.size).toBe(0);
		expect(h.initial.streaming()).toBe(true);
		// A session that was built and never attached is disposed rather than leaked.
		for (const built of h.conversations.slice(1)) expect(built.disposed()).toBe(true);
	});

	it("fails on an invalid limit before building a session or moving a conversation", async () => {
		const h = harness();
		h.initial.start();
		backgroundLimit = 0;
		await expect(h.slot.background()).rejects.toThrow("session.backgroundLimit must be at least 1, got 0");
		expect(h.conversations).toHaveLength(1);
		expect(h.slot.session).toBe(h.initial.session);
		expect(h.keeper.size).toBe(0);

		backgroundLimit = 3;
		await h.slot.background();
		const backgrounded = h.initial;
		backgroundLimit = 0;
		expect(() => h.slot.reclaim(backgrounded.file)).toThrow("session.backgroundLimit must be at least 1, got 0");
		// Still registered and still running: the refusal came before the take.
		expect(h.keeper.find(backgrounded.file)?.sessionId).toBe("s0");
		expect(h.slot.session).toBe(h.conversations[1].session);
		backgroundLimit = 3;
		expectConsistent(h);
	});

	it("attaches nothing for a transcript no background conversation writes", async () => {
		const h = harness();
		expect(h.slot.reclaim("/repo/sessions/elsewhere.jsonl")).toBeUndefined();
		h.initial.start();
		await h.slot.background();
		h.initial.finish();
		await h.settle();
		// Its turn ended and it was disposed: its transcript is a file now, not a live session.
		expect(h.slot.reclaim(h.initial.file)).toBeUndefined();
		expect(h.slot.session).toBe(h.conversations[1].session);
		expectConsistent(h);
	});

	it("re-attaches the live session for its transcript and moves the driven one to the background", async () => {
		const h = harness();
		h.initial.start();
		await h.slot.background();
		const second = h.conversations[1];
		second.start();
		const handoff = h.slot.reclaim(h.initial.file);
		expect(handoff).toEqual({
			sessionId: "s1",
			sessionFile: second.file,
			streaming: true,
			displaced: [],
			message: "s1 continues in the background",
		});
		expect(h.slot.session).toBe(h.initial.session);
		expect(h.initial.disposed()).toBe(false);
		await h.settle();
		expect(h.keeper.list().map(c => c.sessionId)).toEqual(["s1"]);
		expectConsistent(h);
	});

	it("reports an idle driven session as closing, not running, when a reclaim replaces it", async () => {
		const h = harness();
		h.initial.start();
		await h.slot.background();
		const second = h.conversations[1];
		const handoff = h.slot.reclaim(h.initial.file);
		expect(handoff).toEqual({
			sessionId: "s1",
			sessionFile: second.file,
			streaming: false,
			displaced: [],
			message: "s1 closes once its background jobs finish",
		});
		expect(h.slot.session).toBe(h.initial.session);
		await h.settle();
		// Nothing kept it running, so the list a client reads next agrees with the report.
		expect(h.keeper.list()).toEqual([]);
		expect(second.disposed()).toBe(true);
		expectConsistent(h);
	});

	it("stops the oldest background conversation when a handoff passes the limit", async () => {
		const h = harness();
		backgroundLimit = 2;
		h.driven().start();
		await h.slot.background();
		h.driven().start();
		await h.slot.background();
		h.driven().start();
		const handoff = await h.slot.background();
		expect(handoff?.displaced).toEqual(["s0"]);
		expect(handoff?.message).toBe("s2 continues in the background; stopped s0 (background limit 2)");
		await h.settle();
		expect(h.initial.aborts).toEqual([BACKGROUND_LIMIT_STOP_REASON]);
		expect(h.keeper.list().map(c => c.sessionId)).toEqual(["s1", "s2"]);
		expectConsistent(h);
	});

	it.each([1, 2, 3])("stays consistent across random command sequences under limit %i", async limit => {
		for (let seed = 1; seed <= 25; seed++) {
			backgroundLimit = limit;
			const h = harness();
			const random = mulberry32(seed * 7919 + limit);
			const pick = <T>(items: readonly T[]): T | undefined =>
				items.length === 0 ? undefined : items[Math.floor(random() * items.length)];
			const trace: string[] = [];
			for (let step = 0; step < 40; step++) {
				const driven = h.driven();
				const background = h.conversations.filter(conv => h.keeper.find(conv.file) !== undefined);
				const op = Math.floor(random() * 6);
				if (op === 0) {
					trace.push(`start ${driven.id}`);
					if (!driven.streaming()) driven.start();
				} else if (op === 1) {
					trace.push(`background ${driven.id}`);
					const running = h.keeper.list().map(c => c.sessionId);
					const expectedDisplaced = running.slice(0, Math.max(0, running.length + 1 - limit));
					const built = h.conversations.length;
					const streaming = driven.streaming();
					const handoff = await h.slot.background();
					if (streaming) {
						expect(handoff).toEqual({
							sessionId: driven.id,
							sessionFile: driven.file,
							streaming: true,
							displaced: expectedDisplaced,
							message: expectedMessage(driven.id, true, expectedDisplaced, limit),
						});
						expect(h.conversations).toHaveLength(built + 1);
						expect(h.slot.session).toBe(h.conversations[built].session);
					} else {
						expect(handoff).toBeUndefined();
						expect(h.conversations).toHaveLength(built);
						expect(h.slot.session).toBe(driven.session);
					}
				} else if (op === 2) {
					const target = pick(background);
					const file = target?.file ?? "/repo/sessions/unknown.jsonl";
					trace.push(`reclaim ${target?.id ?? "unknown"}`);
					const running = h.keeper
						.list()
						.map(c => c.sessionId)
						.filter(id => id !== target?.id);
					const expectedDisplaced = running.slice(0, Math.max(0, running.length + 1 - limit));
					const streaming = driven.streaming();
					const handoff = h.slot.reclaim(file);
					if (target) {
						expect(handoff).toEqual({
							sessionId: driven.id,
							sessionFile: driven.file,
							streaming,
							displaced: expectedDisplaced,
							message: expectedMessage(driven.id, streaming, expectedDisplaced, limit),
						});
						expect(h.slot.session).toBe(target.session);
					} else {
						expect(handoff).toBeUndefined();
						expect(h.slot.session).toBe(driven.session);
					}
				} else if (op === 3) {
					const target = pick(background);
					trace.push(`finish ${target?.id ?? "none"}`);
					target?.finish();
				} else if (op === 4) {
					const target = pick(background);
					trace.push(`cancel ${target?.id ?? "none"}`);
					if (target) {
						await expect(h.keeper.cancel(target.id, "client cancel")).resolves.toBe(true);
						expect(target.aborts).toContain("client cancel");
						expect(target.disposed()).toBe(true);
					}
				} else {
					trace.push(`finish driven ${driven.id}`);
					driven.finish();
				}
				await h.settle();
				try {
					expectConsistent(h);
				} catch (error) {
					throw new Error(`seed ${seed}, limit ${limit}: ${trace.join(" -> ")}\n${String(error)}`);
				}
			}
		}
	});
});
