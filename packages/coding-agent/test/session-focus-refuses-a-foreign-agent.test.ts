/**
 * Handing the main view to an agent, in a process that holds TWO conversations.
 *
 * WHY TWO. `focusAgent(id)` took a bare id and called `ensureLive` on it. With
 * one conversation in the registry every id is the caller's own, so a test can
 * only ever exercise the benign case: it passes identically whether the boundary
 * is checked or not.
 *
 * WHY THIS ONE MATTERS MORE THAN A DISPLAY FILTER. `ensureLive` REVIVES a parked
 * ref. An unguarded call therefore did not merely show a stranger's transcript,
 * it restarted that agent inside this process and pointed the transcript, the
 * status line and the editor's interrupt key at it. The roster the operator
 * clicks through is already scoped, so this is the defence behind it, for a
 * caller that arrives with an id from anywhere else.
 */
import { describe, expect, it, vi } from "bun:test";
import { SessionFocusController } from "@veyyon/coding-agent/modes/controllers/session-focus-controller";
import type { InteractiveModeContext } from "@veyyon/coding-agent/modes/types";
import type { AgentLifecycleManager } from "@veyyon/coding-agent/registry/agent-lifecycle";
import { AgentRegistry, MAIN_AGENT_ID } from "@veyyon/coding-agent/registry/agent-registry";
import type { AgentSession } from "@veyyon/coding-agent/session/agent-session";

function sessionStub(): AgentSession {
	return {
		isStreaming: false,
		subscribe: () => () => {},
		getAgentId: () => MAIN_AGENT_ID,
	} as unknown as AgentSession;
}

function harness(): { controller: SessionFocusController; registry: AgentRegistry; revivals: string[] } {
	const main = sessionStub();
	const ctx = {
		session: main,
		unsubscribe: () => {},
		eventController: { handleEvent: async () => {}, resetTranscriptAnchors: () => {} },
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

	const registry = new AgentRegistry();
	const revivals: string[] = [];
	const spied = {
		ensureLive: async (id: string) => {
			revivals.push(id);
			return registry.get(id)?.session ?? sessionStub();
		},
	} as unknown as AgentLifecycleManager;

	// The driving agent of conversation A, plus a subagent of each conversation.
	registry.register({ id: MAIN_AGENT_ID, displayName: "main", kind: "main", session: main, scope: "session-a" });
	registry.register({
		id: "Scout-A",
		displayName: "scout",
		kind: "sub",
		parentId: MAIN_AGENT_ID,
		session: sessionStub(),
		status: "running",
	});
	registry.register({ id: "acp:b", displayName: "main", kind: "main", session: sessionStub(), scope: "session-b" });
	registry.register({
		id: "Scout-B",
		displayName: "scout",
		kind: "sub",
		parentId: "acp:b",
		session: null,
		sessionFile: "/tmp/scout-b.jsonl",
		status: "parked",
	});

	return { controller: new SessionFocusController(ctx, registry, () => spied), registry, revivals };
}

describe("Focusing an agent respects the conversation boundary", () => {
	/**
	 * The refusal is asserted alongside `revivals` staying empty, because the
	 * damage happens before anything is displayed: a thrown error after the revive
	 * would look like a refusal while having already restarted the agent.
	 */
	it("refuses a parked agent of another conversation without reviving it", async () => {
		const h = harness();

		await expect(h.controller.focusAgent("Scout-B")).rejects.toThrow(/different conversation/);
		expect(h.revivals).toEqual([]);
		expect(h.controller.focusedAgentId).toBeUndefined();
	});

	/** The other direction: this conversation's own agent still focuses. */
	it("focuses an agent of its own conversation", async () => {
		const h = harness();

		await h.controller.focusAgent("Scout-A");

		expect(h.revivals).toEqual(["Scout-A"]);
		expect(h.controller.focusedAgentId).toBe("Scout-A");
	});
});
