/**
 * WHY: `/new` used to abort the turn in flight. The session object the UI
 * displays is the same object that runs the turn, and `AgentSession.newSession`
 * resets that object in place — starting with `await this.abort()`. So a `/new`
 * typed while the agent was mid-answer threw the answer away.
 *
 * The class this closes is "a session-switch command silently destroys work in
 * flight": every command that routes through the new-session flow is swept
 * below from the controller's own prototype, so a new one fails here until its
 * behavior on a running turn is recorded.
 *
 * What it does NOT catch: whether the handed-off session's provider stream
 * actually completes (that lives in the agent loop, not in this seam), and
 * whether the terminal repaints correctly after the swap.
 */

import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { CommandController } from "@veyyon/coding-agent/modes/controllers/command-controller";
import { getThemeByName, setThemeInstance } from "@veyyon/coding-agent/modes/theme/theme";
import type { InteractiveModeContext } from "@veyyon/coding-agent/modes/types";
import type { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import { BackgroundSessions, SHUTDOWN_DRAIN_TIMEOUT_MS } from "@veyyon/coding-agent/session/background-sessions";

function createContainer() {
	return {
		children: [] as unknown[],
		addChild(child: unknown) {
			this.children.push(child);
		},
		clear() {
			this.children = [];
		},
		disposeChildren() {
			this.children = [];
		},
	};
}

interface SessionCalls {
	newSession: number;
	abort: number;
	flush: number;
}

interface FakeSession {
	readonly id: string;
	readonly calls: SessionCalls;
	isStreaming: boolean;
	isCompacting: boolean;
	newSession(): Promise<boolean>;
	abort(): Promise<void>;
	abortCompaction(): void;
	waitForIdle(): Promise<void>;
	sessionManager: {
		getSessionId(): string;
		getSessionName(): string;
		getCwd(): string;
		getSessionFile(): string;
		flush(): Promise<void>;
	};
}

function makeSession(id: string, streaming: boolean, idle?: Promise<void>): FakeSession {
	const calls: SessionCalls = { newSession: 0, abort: 0, flush: 0 };
	return {
		id,
		calls,
		isStreaming: streaming,
		isCompacting: false,
		async newSession() {
			calls.newSession++;
			return true;
		},
		async abort() {
			calls.abort++;
		},
		abortCompaction() {},
		waitForIdle() {
			return idle ?? Promise.resolve();
		},
		sessionManager: {
			getSessionId: () => id,
			getSessionName: () => id,
			getCwd: () => "/repo",
			getSessionFile: () => `/repo/.veyyon/${id}.jsonl`,
			async flush() {
				calls.flush++;
			},
		},
	};
}

interface Harness {
	controller: CommandController;
	current: FakeSession;
	next: FakeSession;
	attached: string[];
	counts: { factoryCalls: number };
	/** Every line the flow presented, VT stripped, in order. */
	presented(): string[];
}

function harness(options: { streaming: boolean; withFactory?: boolean; keepBackground?: boolean }): Harness {
	const current = makeSession("session-a", options.streaming);
	const next = makeSession("session-b", false);
	const attached: string[] = [];
	const counts = { factoryCalls: 0 };
	const lines: string[] = [];
	const createNextSession = async (): Promise<AgentSession> => {
		counts.factoryCalls++;
		return next as unknown as AgentSession;
	};
	const ctx = {
		session: current,
		sessionManager: current.sessionManager,
		// The flow reads exactly one key. Anything else is a caller this harness
		// has not been taught about, and answering it with a default would let a
		// new setting silently take its off-value here.
		settings: {
			get(key: string): unknown {
				// Mirrors the shipped default so a test that omits the flag exercises what an
				// operator who never opened /settings gets.
				if (key === "session.newKeepsBackground") return options.keepBackground ?? false;
				throw new Error(`Unexpected setting read: ${key}`);
			},
		},
		createNextSession: options.withFactory === false ? undefined : createNextSession,
		attachMainSession: (session: AgentSession) => {
			attached.push((session as unknown as FakeSession).id);
			return BackgroundSessions.global().keep(current as unknown as AgentSession);
		},
		clearTransientSessionUi: () => {},
		resetObserverRegistry: () => {},
		resetTranscript: () => {},
		reloadTodos: async () => {},
		updateEditorBorderColor: () => {},
		present: (value: unknown) => {
			for (const item of Array.isArray(value) ? value : [value]) {
				const component = item as { render?: (width: number) => string[] };
				if (typeof component.render !== "function") continue;
				for (const line of component.render(120)) lines.push(stripVTControlCharacters(line).trim());
			}
		},
		showError: () => {},
		showWarning: () => {},
		statusLine: { invalidate: () => {}, resetActiveTime: () => {} },
		ui: { requestRender: () => {} },
		chatContainer: createContainer(),
		statusContainer: createContainer(),
	} as unknown as InteractiveModeContext;
	return {
		controller: new CommandController(ctx),
		current,
		next,
		attached,
		counts,
		presented: () => lines.filter(line => line.length > 0),
	};
}

/**
 * Every command that reaches the new-session flow, read from the controller's
 * prototype rather than listed by hand: a new `handle…Command` that resets the
 * session shows up here without anyone remembering to add it.
 */
const SESSION_SWITCH_COMMANDS = Object.getOwnPropertyNames(CommandController.prototype)
	.filter(name => /^handle(Clear|Drop|Fresh|Fork)Command$/.test(name))
	.sort();

describe("/new while a turn is running", () => {
	beforeAll(async () => {
		const theme = await getThemeByName("dark");
		if (!theme) throw new Error("Expected dark theme");
		setThemeInstance(theme);
	});

	afterEach(async () => {
		await BackgroundSessions.global().drain();
	});

	it("does not reset the running session, and displays a new one instead", async () => {
		const h = harness({ streaming: true, keepBackground: true });

		await h.controller.handleClearCommand();

		expect(h.current.calls.newSession).toBe(0);
		expect(h.current.calls.abort).toBe(0);
		expect(h.counts.factoryCalls).toBe(1);
		expect(h.attached).toEqual(["session-b"]);
	});

	it("resets in place when nothing is running, so an idle /new costs no extra session", async () => {
		const h = harness({ streaming: false });

		await h.controller.handleClearCommand();

		expect(h.current.calls.newSession).toBe(1);
		expect(h.counts.factoryCalls).toBe(0);
		expect(h.attached).toEqual([]);
	});

	it("resets in place when the host cannot build a second session", async () => {
		const h = harness({ streaming: true, withFactory: false });

		await h.controller.handleClearCommand();

		expect(h.current.calls.newSession).toBe(1);
		expect(h.attached).toEqual([]);
	});

	it("keeps /drop resetting in place, because it deletes the file the turn is writing", async () => {
		const h = harness({ streaming: true });

		await h.controller.handleDropCommand();

		expect(h.counts.factoryCalls).toBe(0);
		expect(h.current.calls.newSession).toBe(1);
	});

	/**
	 * `session.newKeepsBackground` off. The operator chose to stop paying for a
	 * conversation the moment it leaves the screen, so the handoff must decline
	 * and the in-place reset must run — that path is the one that aborts the turn
	 * and closes the provider stream.
	 *
	 * The keeper staying EMPTY is the money assertion available at this seam:
	 * nothing was handed anywhere, so nothing outlives the command. Whether
	 * `AgentSession.newSession` really aborts is its own contract and is not
	 * proven here — the fake counts the call rather than performing it.
	 */
	it("stops the running turn instead of backgrounding it when the setting says so", async () => {
		const h = harness({ streaming: true, keepBackground: false });

		await h.controller.handleClearCommand();

		expect(h.counts.factoryCalls).toBe(0);
		expect(h.attached).toEqual([]);
		expect(h.current.calls.newSession).toBe(1);
		expect(BackgroundSessions.global().size).toBe(0);
	});

	it("says the old session was stopped, so the operator knows it is not still billing", async () => {
		const h = harness({ streaming: true, keepBackground: false });

		await h.controller.handleClearCommand();

		expect(h.presented().join(" ")).toContain("previous session stopped");
	});

	it("says the old session is still running when it is kept", async () => {
		const h = harness({ streaming: true, keepBackground: true });

		await h.controller.handleClearCommand();

		const outcome = h.presented().join(" ");
		expect(outcome).toContain("session-a");
		expect(outcome).toContain("keeps running");
		expect(outcome).not.toContain("stopped");
	});

	/**
	 * The shipped default, read through the real settings machinery rather than
	 * restated as a literal, so flipping the schema without revisiting this
	 * contract turns the file red.
	 *
	 * `/new` stops the old turn unless the operator asked for otherwise. A
	 * conversation that leaves the screen stops costing money by default;
	 * keeping one alive is the deliberate choice, not the accident of having
	 * typed `/new` while a turn happened to be streaming.
	 */
	it("stops the old turn under the shipped default, so /new costs nothing after it leaves the screen", async () => {
		const shipped = Settings.isolated({}).get("session.newKeepsBackground");
		expect(shipped).toBe(false);

		const h = harness({ streaming: true, keepBackground: shipped });

		await h.controller.handleClearCommand();

		expect(h.counts.factoryCalls).toBe(0);
		expect(h.attached).toEqual([]);
		expect(BackgroundSessions.global().size).toBe(0);
		expect(h.presented().join(" ")).toContain("previous session stopped");
	});

	/**
	 * An idle `/new` reports neither outcome. There was no turn, so "stopped"
	 * would name a turn that never ran and "keeps running" would name a session
	 * that is finished — both are the kind of reassurance that teaches an
	 * operator to stop reading the line.
	 */
	it("reports no turn outcome when nothing was running", async () => {
		for (const keepBackground of [true, false]) {
			const h = harness({ streaming: false, keepBackground });

			await h.controller.handleClearCommand();

			const outcome = h.presented().join(" ");
			expect(outcome).toContain("New session started");
			expect(outcome).not.toContain("stopped");
			expect(outcome).not.toContain("keeps running");
		}
	});

	/**
	 * `/drop` deletes the transcript, so it resets in place under either value.
	 * It also must not borrow the `/new` wording: "Session dropped — previous
	 * session stopped" states one act twice.
	 */
	it("leaves /drop stating only its own outcome under either setting", async () => {
		for (const keepBackground of [true, false]) {
			const h = harness({ streaming: true, keepBackground });

			await h.controller.handleDropCommand();

			expect(h.counts.factoryCalls).toBe(0);
			expect(h.presented().join(" ")).not.toContain("previous session stopped");
		}
	});

	it("sweeps every session-switch command, so a new one has to record its behavior", () => {
		expect(SESSION_SWITCH_COMMANDS).toEqual(
			["handleClearCommand", "handleForkCommand", "handleFreshCommand", "handleDropCommand"].sort(),
		);
	});
});

describe("a handed-off session", () => {
	afterEach(async () => {
		await BackgroundSessions.global().drain();
	});

	it("is flushed once its turn settles, and then let go of", async () => {
		const turn = Promise.withResolvers<void>();
		const session = makeSession("session-a", true, turn.promise);
		const keeper = BackgroundSessions.global();

		const kept = keeper.keep(session as unknown as AgentSession);
		expect(keeper.size).toBe(1);
		expect(session.calls.flush).toBe(0);

		turn.resolve();
		await kept.settled;

		expect(session.calls.flush).toBe(1);
		expect(keeper.size).toBe(0);
	});

	it("is never disposed, because disposal tears down the managers the new session inherited", async () => {
		const session = makeSession("session-a", true);
		let disposed = 0;
		const withDispose = { ...session, dispose: async () => void disposed++ };

		await BackgroundSessions.global().keep(withDispose as unknown as AgentSession).settled;

		expect(disposed).toBe(0);
	});

	it("handed over twice is kept once", async () => {
		const session = makeSession("session-a", true) as unknown as AgentSession;
		const keeper = BackgroundSessions.global();

		const first = keeper.keep(session);
		const second = keeper.keep(session);

		expect(second).toBe(first);
		await first.settled;
	});

	it("drain resolves when a turn throws during settle", async () => {
		const session = makeSession("session-a", true);
		const broken = {
			...session,
			waitForIdle: async () => {
				throw new Error("stream broke");
			},
		};
		const keeper = BackgroundSessions.global();

		keeper.keep(broken as unknown as AgentSession);
		await keeper.drain();

		expect(keeper.size).toBe(0);
	});

	it("drain terminates and abandons a session whose turn never settles", async () => {
		const session = makeSession("session-a", true);
		const hung = {
			...session,
			waitForIdle: () => new Promise<void>(() => {}),
		};
		const keeper = BackgroundSessions.global();

		keeper.keep(hung as unknown as AgentSession);
		const start = Date.now();
		await keeper.drain(50);
		const elapsed = Date.now() - start;

		expect(elapsed).toBeGreaterThanOrEqual(40);
		expect(elapsed).toBeLessThan(1_000);
		expect(keeper.size).toBe(0);
	});

	it("first settle resolving after re-handoff does not delete the second entry", async () => {
		const turn1 = Promise.withResolvers<void>();
		const turn2 = Promise.withResolvers<void>();
		let idleCall = 0;
		const session = makeSession("session-a", true);
		session.waitForIdle = () => {
			idleCall++;
			return idleCall === 1 ? turn1.promise : turn2.promise;
		};

		const keeper = BackgroundSessions.global();

		const entry1 = keeper.keep(session as unknown as AgentSession);
		expect(keeper.size).toBe(1);

		const taken = keeper.take(session.sessionManager.getSessionFile());
		expect(taken).toBe(session as unknown as AgentSession);
		expect(keeper.size).toBe(0);

		const entry2 = keeper.keep(session as unknown as AgentSession);
		expect(keeper.size).toBe(1);
		expect(entry2.handoff).toBeGreaterThan(entry1.handoff);

		turn1.resolve();
		await entry1.settled;

		expect(keeper.size).toBe(1);
		expect(keeper.kept[0]).toBe(entry2);

		let drainDone = false;
		const drainPromise = keeper.drain(500).then(() => {
			drainDone = true;
		});

		await Promise.resolve();
		expect(drainDone).toBe(false);

		turn2.resolve();
		await drainPromise;
		expect(drainDone).toBe(true);
		expect(keeper.size).toBe(0);
	});

	it("drain timeout on an earlier handoff does not delete a subsequent handoff", async () => {
		const turn1 = Promise.withResolvers<void>();
		const turn2 = Promise.withResolvers<void>();
		let idleCall = 0;
		const session = makeSession("session-a", true);
		session.waitForIdle = () => {
			idleCall++;
			return idleCall === 1 ? turn1.promise : turn2.promise;
		};

		const keeper = BackgroundSessions.global();

		keeper.keep(session as unknown as AgentSession);
		const drainPromise = keeper.drain(30);

		const taken = keeper.take(session.sessionManager.getSessionFile());
		expect(taken).toBe(session as unknown as AgentSession);
		const entry2 = keeper.keep(session as unknown as AgentSession);
		expect(keeper.size).toBe(1);

		await drainPromise;

		expect(keeper.size).toBe(1);
		expect(keeper.kept[0]).toBe(entry2);

		turn1.resolve();
		turn2.resolve();
		await entry2.settled;
		expect(keeper.size).toBe(0);
	});

	it("bounds shutdown drain to the standard shutdown timeout", () => {
		expect(SHUTDOWN_DRAIN_TIMEOUT_MS).toBe(5_000);
	});
});

describe("resuming a session that is still running", () => {
	afterEach(async () => {
		await BackgroundSessions.global().drain();
	});

	it("hands back the live object, keyed by the transcript /resume names", () => {
		const session = makeSession("session-a", true);
		const keeper = BackgroundSessions.global();
		keeper.keep(session as unknown as AgentSession);

		const live = keeper.take(session.sessionManager.getSessionFile());

		expect(live).toBe(session as unknown as AgentSession);
	});

	it("leaves the background set once reclaimed, so it is not counted twice", () => {
		const session = makeSession("session-a", true);
		const keeper = BackgroundSessions.global();
		keeper.keep(session as unknown as AgentSession);

		keeper.take(session.sessionManager.getSessionFile());

		expect(keeper.size).toBe(0);
		expect(keeper.take(session.sessionManager.getSessionFile())).toBeUndefined();
	});

	it("does not answer for a transcript nobody handed over", () => {
		const session = makeSession("session-a", true);
		const keeper = BackgroundSessions.global();
		keeper.keep(session as unknown as AgentSession);

		expect(keeper.take("/repo/.veyyon/session-z.jsonl")).toBeUndefined();
		expect(keeper.size).toBe(1);
	});

	it("matches the transcript through a non-normalized path, which is what a selector passes", () => {
		const session = makeSession("session-a", true);
		const keeper = BackgroundSessions.global();
		keeper.keep(session as unknown as AgentSession);

		const live = keeper.take("/repo/.veyyon/../.veyyon/session-a.jsonl");

		expect(live).toBe(session as unknown as AgentSession);
	});
});
