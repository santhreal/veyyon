/**
 * The ONE entry point to the Agent Control Center, and the one gate on it.
 *
 * WHY ONE ENTRY POINT. `/agents`, `/cockpit` (alias `/hub`), the `app.agents.hub`
 * and `app.session.observe` keys, and the editor's `←←` gesture used to open
 * THREE different screens between them: an agent configuration list, an "Agent
 * Hub" overlay with its own roster and its own ordering, and a subagent inbox
 * behind a settings flag. Three renderings of the same registry meant "which
 * agents are running" had three answers that could disagree, and only one of
 * them opened something you could reply to. Every entry now calls
 * `showAgentsDashboard`, so there is one screen and it cannot disagree with
 * itself.
 *
 * WHY THE GATE. `←←` on an empty editor is a gesture, not a deliberate command,
 * and popping a card that says "Nothing running" every time a user backspaces
 * past the start of a line would make the gesture an irritation. It passes
 * `requireContent`, which opens the card only when there is a SUBAGENT to look
 * at. The driving session does not count: it is always registered, so counting
 * it would un-gate the gesture in every session. Agents persisted by earlier
 * runs register asynchronously, so the gate waits for that scan rather than
 * treating the initial, empty roster as the answer.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { resetSettingsForTest, Settings } from "@veyyon/coding-agent/config/settings";
import type { AgentDashboard } from "@veyyon/coding-agent/modes/components/agent-dashboard";
import { SelectorController } from "@veyyon/coding-agent/modes/controllers/selector-controller";
import { SessionObserverRegistry } from "@veyyon/coding-agent/modes/session-observer-registry";
import { initTheme } from "@veyyon/coding-agent/modes/theme/theme";
import type { InteractiveModeContext } from "@veyyon/coding-agent/modes/types";
import { AgentRegistry, MAIN_AGENT_ID } from "@veyyon/coding-agent/registry/agent-registry";
import type { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import { TempDir } from "@veyyon/utils";

const TEST_CWD = path.resolve("agents-dashboard-cwd");

interface Harness {
	controller: SelectorController;
	editor: object;
	/** The dashboard the controller mounted, if it mounted one. */
	shown: () => AgentDashboard | undefined;
	/** Settles when a dashboard is mounted, for the async persisted-scan gate. */
	shownReady: Promise<AgentDashboard>;
	focusTargets: unknown[];
	hidden: () => number;
	focusedAgents: string[];
}

/**
 * A context stub that mounts the card the way production does: a FULLSCREEN
 * OVERLAY, not the editor slot. The hub used the editor slot, and a stub that
 * kept watching the slot would report "not shown" for a card that is on screen.
 */
function harness(registry: AgentRegistry, sessionFile: string | null = null): Harness {
	let shown: AgentDashboard | undefined;
	const shownReady = Promise.withResolvers<AgentDashboard>();
	let hidden = 0;
	const editor = {};
	const focusTargets: unknown[] = [];
	const focusedAgents: string[] = [];
	const ctx = {
		keybindings: { getKeys: () => [] },
		ui: {
			terminal: { rows: 40 },
			showOverlay: (component: unknown) => {
				shown = component as AgentDashboard;
				focusTargets.push(component);
				shownReady.resolve(shown);
				return { hide: () => void hidden++ };
			},
			setFocus: (target: unknown) => {
				focusTargets.push(target);
			},
			requestRender: () => {},
		},
		editor,
		editorContainer: { children: [editor], clear: () => {}, addChild: () => {} },
		collabGuest: { agentRegistry: registry, agentRemote: undefined },
		focusAgentSession: async (id: string) => {
			focusedAgents.push(id);
		},
		session: { getToolByName: () => undefined, extensionRunner: undefined },
		sessionManager: { getCwd: () => TEST_CWD, getSessionFile: () => sessionFile },
		effectiveHideThinkingBlock: false,
		proseOnlyThinking: false,
	};
	return {
		controller: new SelectorController(ctx as unknown as InteractiveModeContext),
		editor,
		shown: () => shown,
		shownReady: shownReady.promise,
		focusTargets,
		hidden: () => hidden,
		focusedAgents,
	};
}

function registerWorker(registry: AgentRegistry): void {
	registry.register({
		id: "Worker",
		displayName: "reviewer",
		kind: "sub",
		parentId: MAIN_AGENT_ID,
		session: { subscribe: () => () => {} } as unknown as AgentSession,
		sessionFile: null,
		status: "running",
	});
}

function registerMain(registry: AgentRegistry): void {
	registry.register({
		id: MAIN_AGENT_ID,
		displayName: "main",
		kind: "main",
		session: null,
		sessionFile: null,
		status: "running",
	});
}

beforeAll(async () => {
	await initTheme();
});

beforeEach(async () => {
	// The show path reads settings (the model badge, the modal reveal), so give
	// this suite its own in-memory Settings rather than depending on another
	// suite having initialized one; it fails in isolation otherwise.
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
});

afterEach(() => {
	resetSettingsForTest();
	vi.restoreAllMocks();
	AgentRegistry.resetGlobalForTests();
});

describe("The requireContent gate on the double-left gesture", () => {
	/** Only the driving session registered means nothing to look at, so nothing opens. */
	it("stays closed when only the driving session is registered", () => {
		const registry = new AgentRegistry();
		registerMain(registry);
		const h = harness(registry);

		h.controller.showAgentsDashboard(new SessionObserverRegistry(), { requireContent: true });

		expect(h.shown()).toBeUndefined();
	});

	/** One subagent is enough, and it opens immediately rather than after a scan. */
	it("opens as soon as a subagent exists", () => {
		const registry = new AgentRegistry();
		registerMain(registry);
		registerWorker(registry);
		const h = harness(registry);

		h.controller.showAgentsDashboard(new SessionObserverRegistry(), { requireContent: true });

		expect(h.shown()).toBeDefined();
		h.shown()?.dispose();
	});

	/**
	 * The asynchronous half: an agent that exists only on disk, from an earlier
	 * run. Answering the gate from the initial roster would close the gesture off
	 * on exactly the sessions it is most useful for, the ones you came back to.
	 */
	it("opens once the persisted scan finds a subagent from an earlier run", async () => {
		using tempDir = TempDir.createSync("@veyyon-dashboard-gate-");
		const sessionFile = path.join(tempDir.path(), "main.jsonl");
		const workerSessionFile = path.join(tempDir.path(), "main", "Worker.jsonl");
		await Bun.write(sessionFile, "");
		await Bun.write(workerSessionFile, "");
		const registry = new AgentRegistry();
		registerMain(registry);
		const h = harness(registry, sessionFile);

		h.controller.showAgentsDashboard(new SessionObserverRegistry(), { requireContent: true });

		expect(h.shown()).toBeUndefined();
		const dashboard = await h.shownReady;
		expect(dashboard).toBeDefined();
		expect(registry.get("Worker")?.sessionFile).toBe(workerSessionFile);
		dashboard.dispose();
	});

	/**
	 * The explicit key is not gated. Opening `/agents` and being shown nothing is
	 * a command that appears broken; "Nothing running" is a real answer when you
	 * asked the question on purpose.
	 */
	it("opens the empty roster when asked explicitly, with no subagents at all", () => {
		const registry = new AgentRegistry();
		registerMain(registry);
		const h = harness(registry);

		h.controller.showAgentsDashboard(new SessionObserverRegistry());

		expect(h.shown()).toBeDefined();
		h.shown()?.dispose();
	});
});

describe("Mounting and closing the card", () => {
	/**
	 * Fullscreen overlay, so the card floats over the transcript on the alternate
	 * screen with mouse tracking live for its lifetime, and the transcript is left
	 * untouched underneath.
	 */
	it("mounts as a fullscreen overlay and focuses it", () => {
		const registry = new AgentRegistry();
		registerWorker(registry);
		const h = harness(registry);

		h.controller.showAgentsDashboard(new SessionObserverRegistry());

		expect(h.focusTargets[0]).toBe(h.shown());
		h.shown()?.dispose();
	});

	/**
	 * Closing hides the overlay AND returns focus to the editor area. Hiding
	 * without the focus hand-back leaves keystrokes routed at a component that is
	 * no longer on screen.
	 */
	it("hides the overlay and returns focus to the editor when closed", () => {
		const registry = new AgentRegistry();
		registerWorker(registry);
		const h = harness(registry);
		h.controller.showAgentsDashboard(new SessionObserverRegistry());

		h.shown()?.onClose?.();

		expect(h.hidden()).toBe(1);
		expect(h.focusTargets.at(-1)).toBe(h.editor);
	});

	/**
	 * Enter routes through to the session focus controller and then closes the
	 * card, which is the whole hand-over: the operator ends up in the agent's own
	 * session with the editor pointed at it, not behind a card they have to
	 * dismiss first.
	 */
	it("hands the main view to the selected agent and closes on Enter", async () => {
		const registry = new AgentRegistry();
		registerWorker(registry);
		const h = harness(registry);
		h.controller.showAgentsDashboard(new SessionObserverRegistry());

		h.shown()?.handleInput("\r");
		await Bun.sleep(0);

		expect(h.focusedAgents).toEqual(["Worker"]);
		expect(h.hidden()).toBe(1);
		expect(h.focusTargets.at(-1)).toBe(h.editor);
	});

	/**
	 * The card unsubscribes on close. It listens to the process-global registry
	 * and message bus, both of which outlive it, so a card closed without
	 * disposing keeps rebuilding a layout nobody is looking at, once per agent
	 * event and once per message, for the rest of the session.
	 */
	it("disposes the card when it closes, so it stops listening to the globals", () => {
		const registry = new AgentRegistry();
		registerWorker(registry);
		const h = harness(registry);
		h.controller.showAgentsDashboard(new SessionObserverRegistry());
		const dashboard = h.shown();
		if (!dashboard) throw new Error("the card was not mounted");
		let repaints = 0;
		dashboard.onRequestRender = () => {
			repaints++;
		};

		dashboard.onClose?.();
		registry.register({
			id: "AfterClose",
			displayName: "scout",
			kind: "sub",
			parentId: MAIN_AGENT_ID,
			session: null,
			sessionFile: null,
			status: "running",
		});

		expect(repaints).toBe(0);
	});
});
