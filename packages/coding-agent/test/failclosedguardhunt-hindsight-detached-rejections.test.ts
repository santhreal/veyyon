/**
 * WHICH BUG THIS LOCKS OUT: background Hindsight memory work started from a
 * session event used to float its rejection, and a floated rejection kills the
 * whole TUI session.
 *
 * `HindsightSessionState.attachSessionListeners` registers one listener on
 * `AgentSession#subscribe`. That emitter already protects itself: `#emit` wraps
 * each listener in a try/catch AND, when a listener RETURNS a promise, attaches
 * a `.catch` so a rejection is logged instead of floated. Writing
 * `void this.someAsyncWork()` inside the listener body opts out of exactly that
 * protection: the listener then returns `undefined`, `#emit` sees no promise,
 * and the rejection reaches the process. `@veyyon/utils` postmortem installs a
 * global `unhandledRejection` handler that prints a fatal report and calls
 * `process.exit(1)`, so a Hindsight server answering a mental-model list with a
 * malformed body did not cost the user their mental models: it terminated their
 * session at a turn boundary, with a crash dump instead of an explanation.
 *
 * WHAT BREAKS IF THIS REGRESSES: put `void` back in front of any of the four
 * background tasks in `attachSessionListeners` and a transient memory-backend
 * failure at `agent_start`/`agent_end` takes the TUI down. These tests fail in
 * two ways when that happens, and both are deliberate: the containment warning
 * disappears, and `bun test` reports the floated rejection as an unhandled
 * error against this file.
 *
 * Memory is optional enrichment. The only correct failure is a warning plus a
 * turn without the extra context.
 */

import { afterEach, describe, expect, it, vi } from "bun:test";
import { HindsightSessionState } from "@veyyon/coding-agent/hindsight/state";
import type { AgentSession, AgentSessionEvent } from "@veyyon/coding-agent/session/agent-session";
import { logger } from "@veyyon/utils";

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
 * Swallowing the rejection silently would also stop the crash, and would be the
 * wrong fix: an operator whose memory backend is broken has to be able to find
 * out. The warning is the loud half of the degradation.
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
	state: HindsightSessionState;
	deliver: (event: AgentSessionEvent) => void;
}

/**
 * A real `HindsightSessionState` whose only fakes are the transport and the
 * session it subscribes to. `mentalModelsList` is what the server answers when
 * the mental-model TTL reload fires.
 */
function harness(options: { mentalModelsList?: () => Promise<unknown>; config?: Record<string, unknown> }): Harness {
	let listener: SessionListener | undefined;
	const session = {
		subscribe: (l: SessionListener) => {
			listener = l;
			return () => {
				listener = undefined;
			};
		},
		sessionManager: { getEntries: () => [] },
		publishVolatileMemoryContext: async () => {},
	} as unknown as AgentSession;

	const client = {
		registerProviderTextTransform: () => () => {},
		listMentalModels: options.mentalModelsList ?? (async () => ({ items: [] })),
	};

	const state = new HindsightSessionState({
		sessionId: "failclosedguardhunt-session",
		bankId: "failclosedguardhunt-bank",
		banksSet: new Set<string>(),
		client: client as never,
		session,
		config: {
			autoRecall: false,
			autoRetain: false,
			debug: false,
			mentalModelsEnabled: false,
			mentalModelMaxRenderChars: 4096,
			mentalModelRefreshIntervalMs: 0,
			retainEveryNTurns: 1,
			...options.config,
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

describe("a Hindsight background task that rejects at a turn boundary", () => {
	/**
	 * THE regression, driven through the real failure. `loadMentalModelsBlock`
	 * catches the transport call but not the shape of what came back, so a server
	 * answering `items` as anything other than an array rejects with a TypeError
	 * from `.filter`. That rejection used to be floated by
	 * `void this.refreshMentalModelsSnippet().then(...)` — a `.then` with no
	 * `.catch` — and killed the session.
	 */
	it("contains a malformed mental-model response instead of floating it", async () => {
		warnings = captureWarnings();
		const { state, deliver } = harness({
			config: { mentalModelsEnabled: true },
			mentalModelsList: async () => ({ items: "this is not an array" }),
		});
		// A snapshot already loaded, and the refresh interval elapsed: the state a
		// session is in from its second turn onward.
		state.mentalModelsLoadedAt = 0;

		deliver(AGENT_END);
		await drainEventLoop();

		const reported = warnings.entries.filter(e => e.message.includes("mental-model TTL reload"));
		expect(reported).toHaveLength(1);
		expect(String(reported[0]?.fields?.error)).toContain("filter");
	});

	/**
	 * The MM TTL reload also publishes the refreshed block. A failure in that
	 * SECOND await is downstream of the first and equally detached, so the
	 * containment has to cover the whole task, not just its first step.
	 */
	it("contains a failure in the publish step that follows the refresh", async () => {
		warnings = captureWarnings();
		const { state, deliver } = harness({ config: { mentalModelsEnabled: true } });
		state.mentalModelsLoadedAt = 0;
		vi.spyOn(state, "refreshMentalModelsSnippet").mockImplementation(async () => {
			throw new Error("publish-step precondition failed");
		});

		deliver(AGENT_END);
		await drainEventLoop();

		expect(warnings.entries.some(e => e.message.includes("mental-model TTL reload"))).toBe(true);
	});

	/** Auto-recall runs on `agent_start`. Same listener, same detachment, same rule. */
	it("contains an auto-recall rejection on agent_start", async () => {
		warnings = captureWarnings();
		const { state, deliver } = harness({ config: { autoRecall: true } });
		vi.spyOn(state, "maybeRecallOnAgentStart").mockImplementation(async () => {
			throw new Error("recall backend unreachable");
		});

		deliver(AGENT_START);
		await drainEventLoop();

		const reported = warnings.entries.filter(e => e.message.includes("auto-recall"));
		expect(reported).toHaveLength(1);
		expect(String(reported[0]?.fields?.error)).toContain("recall backend unreachable");
	});

	/** Auto-retain runs on `agent_end`. */
	it("contains an auto-retain rejection on agent_end", async () => {
		warnings = captureWarnings();
		const { state, deliver } = harness({ config: { autoRetain: true } });
		vi.spyOn(state, "maybeRetainOnAgentEnd").mockImplementation(async () => {
			throw new Error("retain backend unreachable");
		});

		deliver(AGENT_END);
		await drainEventLoop();

		expect(warnings.entries.some(e => e.message.includes("auto-retain"))).toBe(true);
	});

	/**
	 * BOUNDARY: a task that throws BEFORE returning a promise. `#runDetached`
	 * cannot rely on the work always being an async function — a synchronous
	 * throw would escape a bare `.catch()` and unwind into `#emit` instead.
	 */
	it("contains a task that throws synchronously rather than rejecting", async () => {
		warnings = captureWarnings();
		const { state, deliver } = harness({ config: { autoRetain: true } });
		vi.spyOn(state, "maybeRetainOnAgentEnd").mockImplementation((() => {
			throw new Error("threw before the first await");
		}) as unknown as typeof state.maybeRetainOnAgentEnd);

		expect(() => {
			deliver(AGENT_END);
		}).not.toThrow();
		await drainEventLoop();

		expect(warnings.entries.some(e => e.message.includes("auto-retain"))).toBe(true);
	});

	/**
	 * ADVERSARIAL: the subscription has to survive its own failures. A backend
	 * that is down stays down, so the SECOND turn must be handled exactly like
	 * the first rather than finding a listener that tore itself out.
	 */
	it("keeps serving later turns after a failure", async () => {
		warnings = captureWarnings();
		const { state, deliver } = harness({ config: { autoRecall: true } });
		let calls = 0;
		vi.spyOn(state, "maybeRecallOnAgentStart").mockImplementation(async () => {
			calls++;
			throw new Error("still down");
		});

		deliver(AGENT_START);
		await drainEventLoop();
		deliver(AGENT_START);
		await drainEventLoop();

		expect(calls).toBe(2);
		expect(warnings.entries.filter(e => e.message.includes("auto-recall"))).toHaveLength(2);
	});

	/**
	 * NEGATIVE: containment must not become noise. A turn where everything works
	 * says nothing, or the warning stops meaning "your memory backend is broken".
	 */
	it("stays silent when the background work succeeds", async () => {
		warnings = captureWarnings();
		const { deliver } = harness({
			config: { mentalModelsEnabled: true, autoRecall: true, autoRetain: true },
			mentalModelsList: async () => ({ items: [] }),
		});

		deliver(AGENT_START);
		deliver(AGENT_END);
		await drainEventLoop();

		expect(warnings.entries.filter(e => e.message.startsWith("Hindsight: background"))).toEqual([]);
	});
});
