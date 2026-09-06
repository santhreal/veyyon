/**
 * WHY. `SessionFocusController.focusAgent` attaches the transcript, the status
 * line and the editor's interrupt to `ensureLive(id)`, which returns `ref.session`
 * whenever one is set. `AgentLifecycleManager.park` flushes that same session,
 * then disposes it and detaches it. The two ran independently: a park whose
 * flush was in flight when the operator pressed the key disposed the session
 * the screen had just attached, and the screen stayed on a dead session until
 * the next revive. The same race ran the other way when the idle TTL elapsed
 * while an agent was on screen.
 *
 * Closed here: a focus pins the agent for as long as it is focused, and a park
 * observing a pin is deferred to the unpin, at which point the idle TTL counts
 * again from that moment. Every dispose the lifecycle performs on a focused
 * session is a defect this suite catches, whichever side of the flush the focus
 * lands on.
 *
 * Not caught here: a session disposed by something other than the lifecycle
 * manager (process teardown, an explicit kill), which unfocuses through the
 * registry event and is covered by the focus controller suite.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import { SessionFocusController } from "@veyyon/coding-agent/modes/terminal/controllers/session-focus-controller";
import type { InteractiveModeContext } from "@veyyon/coding-agent/modes/terminal/types";
import { AgentLifecycleManager } from "@veyyon/coding-agent/registry/agent-lifecycle";
import { AgentRegistry, MAIN_AGENT_ID } from "@veyyon/coding-agent/registry/agent-registry";
import type { AgentSession } from "@veyyon/coding-agent/session/agent-session";

interface SessionStub {
	session: AgentSession;
	disposeCalls: () => number;
	/** Resolves once `flush()` has been entered; `releaseFlush` lets it return. */
	flushEntered: Promise<void>;
	releaseFlush: () => void;
}

function makeSessionStub(): SessionStub {
	let disposeCount = 0;
	const entered = Promise.withResolvers<void>();
	const gate = Promise.withResolvers<void>();
	const stub = {
		isStreaming: false,
		subscribe: () => () => {},
		sessionManager: {
			flush: async () => {
				entered.resolve();
				await gate.promise;
			},
		},
		dispose: async () => {
			disposeCount++;
		},
	};
	return {
		session: stub as unknown as AgentSession,
		disposeCalls: () => disposeCount,
		flushEntered: entered.promise,
		releaseFlush: gate.resolve,
	};
}

function makeController(registry: AgentRegistry, lifecycle: AgentLifecycleManager, main: AgentSession) {
	const ctx = {
		session: main,
		unsubscribe: () => {},
		eventController: {
			handleEvent: async () => {},
			attachTo: () => {},
			resetTranscriptAnchors: () => {},
		},
		statusLine: { setSession: () => {}, invalidate() {} },
		clearTransientSessionUi: () => {},
		renderInitialMessages: () => {},
		updateEditorBorderColor() {},
		ui: { requestRender() {} },
		showStatus() {},
		collabGuest: undefined,
		refreshComposerShortcuts: vi.fn(),
		dismissWelcome: vi.fn(),
	} as unknown as InteractiveModeContext;
	return new SessionFocusController(ctx, registry, () => lifecycle);
}

async function settle(): Promise<void> {
	for (let i = 0; i < 16; i++) await Promise.resolve();
}

describe("a focused agent is never parked under the screen", () => {
	const registry = new AgentRegistry();
	const lifecycle = new AgentLifecycleManager(registry);
	const main = makeSessionStub();
	registry.register({ id: MAIN_AGENT_ID, displayName: "main", kind: "main", session: main.session });
	const controller = makeController(registry, lifecycle, main.session);

	afterEach(async () => {
		await controller.unfocus();
		vi.useRealTimers();
	});

	function idleAdopted(id: string, idleTtlMs: number): SessionStub {
		const stub = makeSessionStub();
		registry.register({
			id,
			displayName: id,
			kind: "sub",
			parentId: MAIN_AGENT_ID,
			session: stub.session,
			status: "idle",
			sessionFile: `/repo/.veyyon/agents/${id}.jsonl`,
		});
		lifecycle.adopt(id, { idleTtlMs, revive: async () => stub.session });
		return stub;
	}

	it("a focus arriving while the park is flushing keeps the session live", async () => {
		const stub = idleAdopted("Scout-flush", 0);
		const park = lifecycle.park("Scout-flush");
		await stub.flushEntered;
		await controller.focusAgent("Scout-flush");
		stub.releaseFlush();
		await park;
		expect(stub.disposeCalls()).toBe(0);
		expect(registry.get("Scout-flush")?.status).toBe("idle");
		expect(registry.get("Scout-flush")?.session).toBe(stub.session);
		expect(controller.target).toBe(stub.session);
	});

	it("an idle TTL elapsing on a focused agent defers the park to the unfocus", async () => {
		vi.useFakeTimers();
		const stub = idleAdopted("Scout-ttl", 1_000);
		await controller.focusAgent("Scout-ttl");
		expect(lifecycle.isPinned("Scout-ttl")).toBe(true);
		stub.releaseFlush();
		vi.advanceTimersByTime(5_000);
		await settle();
		expect(stub.disposeCalls()).toBe(0);
		expect(registry.get("Scout-ttl")?.status).toBe("idle");

		await controller.unfocus();
		expect(lifecycle.isPinned("Scout-ttl")).toBe(false);
		// The TTL counts from the unfocus, not from the last activity.
		vi.advanceTimersByTime(999);
		await settle();
		expect(registry.get("Scout-ttl")?.status).toBe("idle");
		vi.advanceTimersByTime(1);
		await settle();
		await settle();
		expect(stub.disposeCalls()).toBe(1);
		expect(registry.get("Scout-ttl")?.status).toBe("parked");
	});

	it("a focus that fails leaves no pin behind", async () => {
		const stub = idleAdopted("Scout-gone", 0);
		registry.unregister("Scout-gone");
		await expect(controller.focusAgent("Scout-gone")).rejects.toThrow(/Unknown agent/);
		expect(lifecycle.isPinned("Scout-gone")).toBe(false);
		stub.releaseFlush();
	});

	it("moving focus to another agent releases the first one's pin", async () => {
		const first = idleAdopted("Scout-first", 0);
		const second = idleAdopted("Scout-second", 0);
		await controller.focusAgent("Scout-first");
		await controller.focusAgent("Scout-second");
		expect(lifecycle.isPinned("Scout-first")).toBe(false);
		expect(lifecycle.isPinned("Scout-second")).toBe(true);
		first.releaseFlush();
		second.releaseFlush();
		await lifecycle.park("Scout-first");
		expect(registry.get("Scout-first")?.status).toBe("parked");
		await lifecycle.park("Scout-second");
		expect(registry.get("Scout-second")?.status).toBe("idle");
	});
});
