import { describe, expect, it, vi } from "bun:test";
import { SessionFocusController } from "@veyyon/coding-agent/modes/controllers/session-focus-controller";
import type { InteractiveModeContext } from "@veyyon/coding-agent/modes/types";
import { AgentLifecycleManager } from "@veyyon/coding-agent/registry/agent-lifecycle";
import { AgentRegistry, MAIN_AGENT_ID } from "@veyyon/coding-agent/registry/agent-registry";
import type { AgentSession, AgentSessionEvent } from "@veyyon/coding-agent/session/agent-session";

interface SessionStub {
	session: AgentSession;
	/** Emit an event through the listener captured by the last subscribe(). */
	emit: (event: unknown) => Promise<void>;
	unsubscribeCalls: () => number;
	setStreaming: (streaming: boolean) => void;
}

function makeSessionStub(opts: { isStreaming?: boolean } = {}): SessionStub {
	let listener: ((event: AgentSessionEvent) => Promise<void> | void) | undefined;
	let unsubscribeCalls = 0;
	const stub = {
		isStreaming: opts.isStreaming ?? false,
		subscribe(fn: (event: AgentSessionEvent) => Promise<void> | void) {
			listener = fn;
			return () => {
				unsubscribeCalls++;
			};
		},
	};
	return {
		session: stub as unknown as AgentSession,
		emit: async event => {
			if (!listener) throw new Error("no listener captured: subscribe() was never called");
			await listener(event as AgentSessionEvent);
		},
		unsubscribeCalls: () => unsubscribeCalls,
		setStreaming: streaming => {
			stub.isStreaming = streaming;
		},
	};
}

interface Harness {
	ctx: InteractiveModeContext;
	controller: SessionFocusController;
	registry: AgentRegistry;
	main: SessionStub;
	handledEvents: unknown[];
	setSessionCalls: Array<[AgentSession, string | undefined]>;
	counts: {
		clearTransientSessionUi: () => number;
		resetTranscriptAnchors: () => number;
		renderInitialMessages: () => number;
		mainUnsubscribe: () => number;
	};
}

function makeHarness(): Harness {
	const main = makeSessionStub();
	const handledEvents: unknown[] = [];
	const setSessionCalls: Array<[AgentSession, string | undefined]> = [];
	let clearTransientSessionUi = 0;
	let resetTranscriptAnchors = 0;
	let renderInitialMessages = 0;
	let mainUnsubscribe = 0;

	const ctx = {
		session: main.session,
		unsubscribe: () => {
			mainUnsubscribe++;
		},
		eventController: {
			handleEvent: async (event: unknown) => {
				handledEvents.push(event);
			},
			attachTo: (target: AgentSession) => {
				let assistantStreamSynced = false;
				ctx.unsubscribe = target.subscribe(async (event: AgentSessionEvent) => {
					if (event.type === "message_start" && event.message.role === "assistant") {
						assistantStreamSynced = true;
					} else if (
						event.type === "message_update" &&
						event.message.role === "assistant" &&
						!assistantStreamSynced
					) {
						assistantStreamSynced = true;
						await ctx.eventController.handleEvent({ type: "message_start", message: event.message });
					}
					await ctx.eventController.handleEvent(event);
				});
			},
			resetTranscriptAnchors: () => {
				resetTranscriptAnchors++;
			},
		},
		statusLine: {
			setSession: (session: AgentSession, focusedAgentId?: string) => {
				setSessionCalls.push([session, focusedAgentId]);
			},
			invalidate() {},
		},
		clearTransientSessionUi: () => {
			clearTransientSessionUi++;
		},
		renderInitialMessages: () => {
			renderInitialMessages++;
		},
		updateEditorBorderColor() {},
		ui: { requestRender() {} },
		showStatus() {},
		collabGuest: undefined,
		// Required members of the context. Omitting them used to be tolerated by
		// `?.()` calls in the controller, which meant production silently skipped
		// the composer refresh and the welcome dismissal whenever either was
		// missing. The calls are unconditional now, so the stub supplies them.
		refreshComposerShortcuts: vi.fn(),
		dismissWelcome: vi.fn(),
	} as unknown as InteractiveModeContext;

	const registry = new AgentRegistry();
	const lifecycle = new AgentLifecycleManager(registry);
	const controller = new SessionFocusController(ctx, registry, () => lifecycle);

	return {
		ctx,
		controller,
		registry,
		main,
		handledEvents,
		setSessionCalls,
		counts: {
			clearTransientSessionUi: () => clearTransientSessionUi,
			resetTranscriptAnchors: () => resetTranscriptAnchors,
			renderInitialMessages: () => renderInitialMessages,
			mainUnsubscribe: () => mainUnsubscribe,
		},
	};
}

function registerSub(registry: AgentRegistry, id: string, session: AgentSession, parentId?: string) {
	return registry.register({ id, displayName: id, kind: "sub", parentId, session, status: "running" });
}

/** Settle the async unfocus chain (registry event → void unfocus() → #attach). */
async function flushAsync(): Promise<void> {
	for (let i = 0; i < 5; i++) await Promise.resolve();
}

describe("SessionFocusController", () => {
	it("focusAgent retargets subscription, transcript anchors, and status line onto the worker session", async () => {
		const h = makeHarness();
		const worker = makeSessionStub();
		registerSub(h.registry, "Worker", worker.session, MAIN_AGENT_ID);

		await h.controller.focusAgent("Worker");

		expect(h.controller.focusedAgentId).toBe("Worker");
		expect(h.controller.target).toBe(worker.session);
		expect(h.counts.mainUnsubscribe()).toBe(1);
		expect(h.counts.clearTransientSessionUi()).toBe(1);
		expect(h.counts.resetTranscriptAnchors()).toBe(1);
		expect(h.counts.renderInitialMessages()).toBe(1);
		expect(h.setSessionCalls).toEqual([[worker.session, "Worker"]]);

		const event = { type: "message_start", message: { role: "user" } };
		await worker.emit(event);
		expect(h.handledEvents).toEqual([event]);
	});

	it("mid-turn attach synthesizes agent_start, and an orphaned assistant message_update gets a synthesized message_start", async () => {
		const h = makeHarness();
		const worker = makeSessionStub({ isStreaming: true });
		registerSub(h.registry, "Worker", worker.session, MAIN_AGENT_ID);

		await h.controller.focusAgent("Worker");
		expect(h.handledEvents).toEqual([{ type: "agent_start" }]);

		const message = { role: "assistant", content: "partial" };
		await worker.emit({ type: "message_update", message });
		expect(h.handledEvents.slice(1)).toEqual([
			{ type: "message_start", message },
			{ type: "message_update", message },
		]);

		// Guard fires once: subsequent updates pass through unsynthesized.
		await worker.emit({ type: "message_update", message });
		expect(h.handledEvents.slice(3)).toEqual([{ type: "message_update", message }]);
	});

	it("focusParent walks parentId to a registered non-main agent, then re-attaches the main session", async () => {
		const h = makeHarness();
		const parent = makeSessionStub();
		const worker = makeSessionStub();
		registerSub(h.registry, "Parent", parent.session, MAIN_AGENT_ID);
		registerSub(h.registry, "Worker", worker.session, "Parent");

		await h.controller.focusAgent("Worker");
		await h.controller.focusParent();
		expect(h.controller.focusedAgentId).toBe("Parent");
		expect(h.setSessionCalls).toEqual([
			[worker.session, "Worker"],
			[parent.session, "Parent"],
		]);

		// Parent's parent is Main → unfocus back to ctx.session.
		await h.controller.focusParent();
		expect(h.controller.focusedAgentId).toBeUndefined();
		expect(h.controller.target).toBeUndefined();
		expect(h.setSessionCalls).toEqual([
			[worker.session, "Worker"],
			[parent.session, "Parent"],
			[h.main.session, undefined],
		]);
	});

	it("aborting the focused agent auto-unfocuses back to the main session, while parking retains focus", async () => {
		const h = makeHarness();
		const worker = makeSessionStub();
		registerSub(h.registry, "Worker", worker.session, MAIN_AGENT_ID);

		await h.controller.focusAgent("Worker");
		expect(h.controller.focusedAgentId).toBe("Worker");

		// Parking the focused agent keeps the operator focused on the agent
		h.registry.setStatus("Worker", "parked");
		await flushAsync();
		expect(h.controller.focusedAgentId).toBe("Worker");

		// Aborting the focused agent returns to main
		h.registry.setStatus("Worker", "aborted");
		await flushAsync();

		expect(h.controller.focusedAgentId).toBeUndefined();
		expect(h.setSessionCalls).toEqual([
			[worker.session, "Worker"],
			[h.main.session, undefined],
		]);
	});

	it("re-attaches live subscription and view when a focused parked agent is revived with a new session", async () => {
		// WHY: When an agent is focused and sits idle, its idle TTL parks it (session
		// disposed). If it is subsequently woken by an incoming peer message or task
		// tool, a new AgentSession is created. The focused view must re-attach to the
		// new session so live events stream to the transcript without requiring a manual
		// re-focus cycle.
		const h = makeHarness();
		const workerInitial = makeSessionStub();
		registerSub(h.registry, "Worker", workerInitial.session, MAIN_AGENT_ID);

		await h.controller.focusAgent("Worker");
		expect(h.controller.focusedAgentId).toBe("Worker");
		expect(h.controller.target).toBe(workerInitial.session);

		// Agent parks: session detached in registry, but focus view remains on Worker
		h.registry.detachSession("Worker");
		h.registry.setStatus("Worker", "parked");
		await flushAsync();
		expect(h.controller.focusedAgentId).toBe("Worker");

		// Agent is revived with a new session
		const workerRevived = makeSessionStub({ isStreaming: true });
		h.registry.attachSession("Worker", workerRevived.session);
		h.registry.setStatus("Worker", "running");
		await flushAsync();

		expect(h.controller.focusedAgentId).toBe("Worker");
		expect(h.controller.target).toBe(workerRevived.session);
		expect(workerInitial.unsubscribeCalls()).toBe(1);

		// Newly revived streaming session synthesizes agent_start and handles live events
		expect(h.handledEvents).toContainEqual({ type: "agent_start" });
		const liveEvent = { type: "message_start", message: { role: "assistant" } };
		await workerRevived.emit(liveEvent);
		expect(h.handledEvents).toContainEqual(liveEvent);
	});

	it("discards stale focusAgent completion when rapid switching or unfocus happens during in-flight revival", async () => {
		// WHY: Slow revivals (e.g. disk I/O, MCP, replay) could resolve after the operator
		// has already focused another agent or hit Esc to return to main. Stale resolution
		// must not overwrite the newer view.
		const h = makeHarness();
		const workerB = makeSessionStub();
		registerSub(h.registry, "WorkerB", workerB.session, MAIN_AGENT_ID);

		const { promise: slowRevivePromise, resolve: resolveSlowRevive } = Promise.withResolvers<AgentSession>();
		const slowWorker = makeSessionStub();

		// Register WorkerA as parked with a controlled deferred revive
		h.registry.register({
			id: "WorkerA",
			displayName: "WorkerA",
			kind: "sub",
			parentId: MAIN_AGENT_ID,
			session: null,
			status: "parked",
		});

		const lifecycle = new AgentLifecycleManager(h.registry);
		lifecycle.adopt("WorkerA", {
			idleTtlMs: 10_000,
			revive: async () => slowRevivePromise,
		});
		const controller = new SessionFocusController(h.ctx, h.registry, () => lifecycle);

		// Start focusing WorkerA (revival in flight)
		const focusAPromise = controller.focusAgent("WorkerA");

		// Operator quickly switches to WorkerB before WorkerA finishes
		await controller.focusAgent("WorkerB");
		expect(controller.focusedAgentId).toBe("WorkerB");
		expect(controller.target).toBe(workerB.session);

		// WorkerA revival finally finishes
		resolveSlowRevive(slowWorker.session);
		await focusAPromise;

		// WorkerB MUST remain focused; WorkerA must not clobber it
		expect(controller.focusedAgentId).toBe("WorkerB");
		expect(controller.target).toBe(workerB.session);

		// Test unfocus during in-flight revival
		const { promise: slowRevivePromise2, resolve: resolveSlowRevive2 } = Promise.withResolvers<AgentSession>();
		const slowWorker2 = makeSessionStub();
		h.registry.register({
			id: "WorkerC",
			displayName: "WorkerC",
			kind: "sub",
			parentId: MAIN_AGENT_ID,
			session: null,
			status: "parked",
		});
		lifecycle.adopt("WorkerC", {
			idleTtlMs: 10_000,
			revive: async () => slowRevivePromise2,
		});

		const focusCPromise = controller.focusAgent("WorkerC");
		await controller.unfocus();
		expect(controller.focusedAgentId).toBeUndefined();
		expect(controller.target).toBeUndefined();

		resolveSlowRevive2(slowWorker2.session);
		await focusCPromise;

		expect(controller.focusedAgentId).toBeUndefined();
		expect(controller.target).toBeUndefined();
	});

	it("refuses to attach when an agent is removed or aborted during in-flight revival", async () => {
		// WHY: If an agent is unregistered or terminated while its revival promise is
		// resolving, attaching its reconstructed session would leave a defunct view.
		const h = makeHarness();
		const { promise: slowRevivePromise, resolve: resolveSlowRevive } = Promise.withResolvers<AgentSession>();
		const workerStub = makeSessionStub();

		h.registry.register({
			id: "WorkerRemoved",
			displayName: "WorkerRemoved",
			kind: "sub",
			parentId: MAIN_AGENT_ID,
			session: null,
			status: "parked",
		});

		const lifecycle = new AgentLifecycleManager(h.registry);
		lifecycle.adopt("WorkerRemoved", {
			idleTtlMs: 10_000,
			revive: async () => slowRevivePromise,
		});
		const controller = new SessionFocusController(h.ctx, h.registry, () => lifecycle);

		const focusPromise = controller.focusAgent("WorkerRemoved");

		// Unregister agent before revival resolves
		h.registry.unregister("WorkerRemoved");

		resolveSlowRevive(workerStub.session);
		await expect(focusPromise).rejects.toThrow();
		expect(controller.focusedAgentId).toBeUndefined();
	});

	it("auto-unfocuses when the focused agent is removed from the registry", async () => {
		// WHY: Removing an agent from the registry (e.g. close budget expiry or release)
		// while the operator is focused on it must return the view to main.
		const h = makeHarness();
		const worker = makeSessionStub();
		registerSub(h.registry, "Worker", worker.session, MAIN_AGENT_ID);

		await h.controller.focusAgent("Worker");
		expect(h.controller.focusedAgentId).toBe("Worker");

		h.registry.unregister("Worker");
		await flushAsync();

		expect(h.controller.focusedAgentId).toBeUndefined();
		expect(h.controller.target).toBeUndefined();
		expect(h.setSessionCalls.at(-1)).toEqual([h.main.session, undefined]);
	});

	it("focusAgent on MAIN_AGENT_ID returns to main session", async () => {
		const h = makeHarness();
		const worker = makeSessionStub();
		registerSub(h.registry, "Worker", worker.session, MAIN_AGENT_ID);

		await h.controller.focusAgent("Worker");
		expect(h.controller.focusedAgentId).toBe("Worker");

		await h.controller.focusAgent(MAIN_AGENT_ID);
		expect(h.controller.focusedAgentId).toBeUndefined();
		expect(h.controller.target).toBeUndefined();
	});

	it("rechecks conversation scope after an asynchronous focus lookup", async () => {
		const h = makeHarness();
		const main = makeSessionStub();
		const worker = makeSessionStub();
		h.registry.register({
			id: MAIN_AGENT_ID,
			displayName: MAIN_AGENT_ID,
			kind: "main",
			session: main.session,
			scope: "conversation-a",
			status: "running",
		});
		registerSub(h.registry, "Worker", worker.session, MAIN_AGENT_ID).scope = "conversation-a";

		const focusing = h.controller.focusAgent("Worker");
		const ref = h.registry.get("Worker");
		if (!ref) throw new Error("Worker registration missing");
		ref.scope = "conversation-b";

		await expect(focusing).rejects.toThrow("belongs to a different conversation");
		expect(h.controller.focusedAgentId).toBeUndefined();
		expect(h.controller.target).toBeUndefined();
	});

	it("does not report a stale return to main after removal races a newer focus", async () => {
		const h = makeHarness();
		const workerA = makeSessionStub();
		const workerB = makeSessionStub();
		registerSub(h.registry, "WorkerA", workerA.session, MAIN_AGENT_ID);
		registerSub(h.registry, "WorkerB", workerB.session, MAIN_AGENT_ID);
		const statuses = vi.fn();
		h.ctx.showStatus = statuses;

		await h.controller.focusAgent("WorkerA");
		h.main.setStreaming(true);
		const mainAttach = Promise.withResolvers<void>();
		h.ctx.eventController.handleEvent = async event => {
			if (event.type === "agent_start") await mainAttach.promise;
		};

		h.registry.unregister("WorkerA");
		await h.controller.focusAgent("WorkerB");
		mainAttach.resolve();
		await flushAsync();

		expect(h.controller.focusedAgentId).toBe("WorkerB");
		expect(h.controller.target).toBe(workerB.session);
		expect(statuses).not.toHaveBeenCalledWith("Agent WorkerA is gone; returned to main session");
	});

	it("dispose unregisters registry listener and clears focus state", async () => {
		const h = makeHarness();
		const worker = makeSessionStub();
		registerSub(h.registry, "Worker", worker.session, MAIN_AGENT_ID);

		await h.controller.focusAgent("Worker");
		h.controller.dispose();

		expect(h.controller.focusedAgentId).toBeUndefined();
		expect(h.controller.target).toBeUndefined();

		// Registry events after dispose do not trigger any further status/unfocus calls
		const callsBefore = h.setSessionCalls.length;
		h.registry.setStatus("Worker", "aborted");
		await flushAsync();
		expect(h.setSessionCalls.length).toBe(callsBefore);
	});

	it("proves no orphan subscriptions on multiple focus and unfocus cycles", async () => {
		// WHY: Switching focus must unsubscribe from the previous session before
		// subscribing to the next one, preventing memory leaks and phantom event handling.
		const h = makeHarness();
		const workerA = makeSessionStub();
		const workerB = makeSessionStub();
		registerSub(h.registry, "WorkerA", workerA.session, MAIN_AGENT_ID);
		registerSub(h.registry, "WorkerB", workerB.session, MAIN_AGENT_ID);

		// 1. Focus WorkerA
		await h.controller.focusAgent("WorkerA");
		expect(h.counts.mainUnsubscribe()).toBe(1);
		expect(workerA.unsubscribeCalls()).toBe(0);

		// 2. Focus WorkerB (WorkerA must be unsubscribed)
		await h.controller.focusAgent("WorkerB");
		expect(workerA.unsubscribeCalls()).toBe(1);
		expect(workerB.unsubscribeCalls()).toBe(0);

		// 3. Unfocus back to main (WorkerB must be unsubscribed)
		await h.controller.unfocus();
		expect(workerB.unsubscribeCalls()).toBe(1);
	});
});
