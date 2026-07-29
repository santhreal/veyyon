/**
 * WHICH BUG THIS LOCKS OUT: mnemopi's auto-recall and auto-retain were started
 * from a session event with a bare `void`, so when they rejected the rejection
 * floated and killed the whole TUI session.
 *
 * `AgentSession#emit` already guards its listeners: it try/catches a
 * synchronous throw AND, when a listener RETURNS a promise, attaches a `.catch`
 * so the rejection is logged. `void this.maybeRecallOnAgentStart()` inside the
 * listener body defeats exactly that guard — the listener returns `undefined`,
 * `#emit` sees no promise, and the rejection reaches the process, where
 * postmortem's global `unhandledRejection` handler prints a fatal report and
 * calls `process.exit(1)`.
 *
 * `recallForContext` is a real rejection source: it merges several memory banks
 * and deliberately throws when EVERY bank fails, which is what one dead embed
 * worker or one corrupt database looks like. So a broken memory backend did not
 * cost the user their recall, it terminated their session on the first turn.
 *
 * WHAT BREAKS IF THIS REGRESSES: restore `void this.maybeRecallOnAgentStart()`
 * in `attachSessionListeners` and an unreadable memory bank takes the TUI down
 * at `agent_start`. These tests then fail twice over: the containment warning
 * is gone, and `bun test` reports the floated rejection as an unhandled error
 * against this file.
 */

import { afterEach, describe, expect, it, vi } from "bun:test";
import { MnemopiSessionState } from "@veyyon/coding-agent/mnemopi/state";
import type { AgentSession, AgentSessionEvent } from "@veyyon/coding-agent/session/agent-session";
import * as logger from "@veyyon/utils/logger";

// No `useIsolatedAgentDir()` here, deliberately. That helper reaches
// `config/settings`, which transitively loads the TUI, and this suite is a
// memory-layer unit test that must stay runnable while the TUI is being
// rewritten. It is also unnecessary: `scoped` is injected below, so
// `createScopedResources` never runs and no `AgentStorage` is ever opened. The
// repo-wide preload tripwire still refuses any write into the real `~/.veyyon`,
// so a path that did reach storage would fail loudly rather than silently.

/** One captured `logger.warn` call. */
interface WarnEntry {
	message: string;
	fields?: Record<string, unknown>;
}

/** A live `logger.warn` capture plus its restore hook. */
interface WarnCapture {
	entries: WarnEntry[];
	restore: () => void;
}

/**
 * Capture `logger.warn` so containment is asserted rather than assumed.
 *
 * Swallowing the rejection in silence would also stop the crash, and would be
 * the wrong fix: an operator whose memory backend is broken has to be able to
 * find out why recall went quiet.
 */
function captureWarnings(): WarnCapture {
	const entries: WarnEntry[] = [];
	const spy = vi.spyOn(logger, "warn").mockImplementation(((message: string, fields?: Record<string, unknown>) => {
		entries.push({ message, fields });
	}) as unknown as typeof logger.warn);
	return { entries, restore: () => spy.mockRestore() };
}

/** Yield the event loop `turns` times so a floated rejection is observable, without a wall-clock delay. */
async function drainEventLoop(turns = 4): Promise<void> {
	for (let i = 0; i < turns; i++) {
		await new Promise<void>(resolve => {
			setImmediate(resolve);
		});
	}
}

/** The session-event listener `attachSessionListeners` registered. */
type SessionListener = (event: AgentSessionEvent) => unknown;

/** A constructed state together with the listener it registered. */
interface Harness {
	state: MnemopiSessionState;
	deliver: (event: AgentSessionEvent) => void;
}

/** One recalled row, in the shape the scoped recall merge consumes. */
interface FakeRecallRow {
	id: string;
	content: string;
	score: number;
}

/** A stand-in for one entry of `MnemopiScopedResources.recall`. */
interface FakeBank {
	bank: string;
	memory: {
		recallEnhanced: () => Promise<FakeRecallRow[]>;
		remember: () => string;
	};
}

/** A recall bank that either answers or fails the way a corrupt database does. */
function bank(name: string, behavior: "ok" | "throw"): FakeBank {
	return {
		bank: name,
		memory: {
			recallEnhanced: async () => {
				if (behavior === "throw") throw new Error(`${name} database is corrupt`);
				return [{ id: `${name}-1`, content: `memory from ${name}`, score: 1 }];
			},
			remember: () => "id",
		},
	};
}

/**
 * A real `MnemopiSessionState` whose only fakes are the banks and the session
 * it subscribes to. One prior user turn is always present, because auto-recall
 * returns early without one and would never reach the failing bank.
 */
function harness(options: { banks: FakeBank[]; config?: Record<string, unknown> }): Harness {
	let listener: SessionListener | undefined;
	const session = {
		subscribe: (l: SessionListener) => {
			listener = l;
			return () => {
				listener = undefined;
			};
		},
		sessionManager: {
			getEntries: () => [{ type: "message", message: { role: "user", content: "what is the deploy command" } }],
			getCwd: () => process.cwd(),
		},
		publishVolatileMemoryContext: async () => {},
	} as unknown as AgentSession;

	const state = new MnemopiSessionState({
		sessionId: "failclosedguardhunt-session",
		session,
		config: {
			autoRecall: false,
			autoRetain: false,
			debug: false,
			bank: "retain",
			recallLimit: 10,
			recallContextTurns: 2,
			recallMaxQueryChars: 512,
			retainEveryNTurns: 1,
			...options.config,
		} as never,
		scoped: {
			recall: options.banks,
			retain: { bank: "retain", memory: { remember: () => "id" } },
			global: undefined,
		} as never,
	});

	state.attachSessionListeners();
	return {
		state,
		deliver: event => {
			if (!listener) throw new Error("attachSessionListeners registered no listener");
			listener(event);
		},
	};
}

const AGENT_START: AgentSessionEvent = { type: "agent_start" } as AgentSessionEvent;
const AGENT_END: AgentSessionEvent = { type: "agent_end", messages: [] } as unknown as AgentSessionEvent;

let warnings: WarnCapture | undefined;

afterEach(() => {
	warnings?.restore();
	warnings = undefined;
});

describe("a mnemopi background task that rejects at a turn boundary", () => {
	/**
	 * THE regression, driven through the real failure rather than a stub. Every
	 * bank throws, which is what `collectScopedRecallResults` is specified to
	 * turn into a rejection rather than a silent empty result — so
	 * `maybeRecallOnAgentStart` rejects, exactly as it would against a dead embed
	 * worker.
	 */
	it("contains a total recall failure instead of floating it", async () => {
		warnings = captureWarnings();
		const { deliver } = harness({
			banks: [bank("project", "throw"), bank("global", "throw")],
			config: { autoRecall: true },
		});

		deliver(AGENT_START);
		await drainEventLoop();

		const reported = warnings.entries.filter(e => e.message.includes("auto-recall"));
		expect(reported).toHaveLength(1);
		expect(String(reported[0]?.fields?.error)).toContain("corrupt");
	});

	/**
	 * A partial failure is not a rejection: one healthy bank answers and recall
	 * succeeds. Pins that the containment above is reporting a REAL total
	 * failure and not just any bank error.
	 */
	it("says nothing when one bank fails but another answers", async () => {
		warnings = captureWarnings();
		const { deliver } = harness({
			banks: [bank("project", "ok"), bank("broken", "throw")],
			config: { autoRecall: true },
		});

		deliver(AGENT_START);
		await drainEventLoop();

		expect(warnings.entries.filter(e => e.message.startsWith("Mnemopi: background"))).toEqual([]);
	});

	/** Auto-retain runs on `agent_end`. Same listener, same detachment, same rule. */
	it("contains an auto-retain rejection on agent_end", async () => {
		warnings = captureWarnings();
		const { state, deliver } = harness({ banks: [bank("project", "ok")], config: { autoRetain: true } });
		vi.spyOn(state, "maybeRetainOnAgentEnd").mockImplementation(async () => {
			throw new Error("retain store is read-only");
		});

		deliver(AGENT_END);
		await drainEventLoop();

		const reported = warnings.entries.filter(e => e.message.includes("auto-retain"));
		expect(reported).toHaveLength(1);
		expect(String(reported[0]?.fields?.error)).toContain("read-only");
	});

	/**
	 * BOUNDARY: a task that throws BEFORE returning a promise. Containment that
	 * relied only on `.catch` would let this one unwind into `#emit` instead.
	 */
	it("contains a task that throws synchronously rather than rejecting", async () => {
		warnings = captureWarnings();
		const { state, deliver } = harness({ banks: [bank("project", "ok")], config: { autoRecall: true } });
		vi.spyOn(state, "maybeRecallOnAgentStart").mockImplementation((() => {
			throw new Error("threw before the first await");
		}) as unknown as typeof state.maybeRecallOnAgentStart);

		expect(() => {
			deliver(AGENT_START);
		}).not.toThrow();
		await drainEventLoop();

		expect(warnings.entries.some(e => e.message.includes("auto-recall"))).toBe(true);
	});

	/**
	 * ADVERSARIAL: a backend that is down stays down. The listener has to serve
	 * the second turn exactly like the first rather than tearing itself out on
	 * the first failure.
	 */
	it("keeps serving later turns after a failure", async () => {
		warnings = captureWarnings();
		const { state, deliver } = harness({ banks: [bank("project", "ok")], config: { autoRetain: true } });
		let calls = 0;
		vi.spyOn(state, "maybeRetainOnAgentEnd").mockImplementation(async () => {
			calls++;
			throw new Error("still down");
		});

		deliver(AGENT_END);
		await drainEventLoop();
		deliver(AGENT_END);
		await drainEventLoop();

		expect(calls).toBe(2);
		expect(warnings.entries.filter(e => e.message.includes("auto-retain"))).toHaveLength(2);
	});

	/**
	 * NEGATIVE: containment must not become noise. A healthy turn says nothing,
	 * or the warning stops meaning "your memory backend is broken".
	 */
	it("stays silent when the background work succeeds", async () => {
		warnings = captureWarnings();
		const { deliver } = harness({
			banks: [bank("project", "ok")],
			config: { autoRecall: true, autoRetain: true },
		});

		deliver(AGENT_START);
		deliver(AGENT_END);
		await drainEventLoop();

		expect(warnings.entries.filter(e => e.message.startsWith("Mnemopi: background"))).toEqual([]);
	});
});
