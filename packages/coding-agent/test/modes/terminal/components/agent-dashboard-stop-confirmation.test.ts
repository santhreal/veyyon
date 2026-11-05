/**
 * Stopping an agent is a deliberate two-step interaction in the agent dashboard.
 *
 * WHY. A single stray `x` used to abort a live provider turn immediately. The
 * confirmation keeps that interruption from happening until it is explicitly
 * accepted, without changing the abort-before-sleep lifecycle once accepted.
 * The pointer affordance follows the same rule: it is local to a stoppable row,
 * appears only while that row is hovered, and opens the same confirmation
 * instead of becoming a faster stop.
 *
 * These tests drive the rendered dashboard and its real keyboard/SGR mouse
 * input. Coordinates are derived from the frame produced by ModalShell so the
 * assertions follow theme and geometry changes rather than copying layout
 * constants into the suite.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { AgentDashboard } from "@veyyon/coding-agent/modes/terminal/components/dashboard/agent-dashboard";
import type { AgentLifecycleManager } from "@veyyon/coding-agent/registry/agent-lifecycle";
import { AgentRegistry, MAIN_AGENT_ID } from "@veyyon/coding-agent/registry/agent-registry";
import type { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import { initTheme } from "@veyyon/coding-agent/theme/theme";
import type { TUI } from "@veyyon/tui";
import { sgrMotion, sgrPress } from "../../../../../../hosts/terminal/engine/test/helpers/sgr-mouse";
import { type StubbedStdoutGeometry, stubStdoutGeometry } from "../../../helpers/stdout-geometry";

const WIDTH = 120;

let geometry: StubbedStdoutGeometry;
const dashboards: AgentDashboard[] = [];

interface RenderedComponent {
	render(width: number): readonly string[];
}

interface InteractiveOverlay extends RenderedComponent {
	handleInput(data: string): void;
}

/**
 * Minimal real-overlay host: it mounts the component passed to `showOverlay`,
 * forwards input as the TUI focus router would, and observes `hide` on dismiss.
 */
class OverlayHarness {
	#current: InteractiveOverlay | undefined;
	readonly ui: TUI;

	constructor() {
		this.ui = {
			requestRender: () => {},
			requestComponentRender: () => {},
			showOverlay: (component: unknown) => {
				const mounted = component as InteractiveOverlay;
				this.#current = mounted;
				return {
					hide: () => {
						if (this.#current === mounted) this.#current = undefined;
					},
				};
			},
			setFocus: () => {},
		} as unknown as TUI;
	}

	get visible(): boolean {
		return this.#current !== undefined;
	}

	get overlay(): InteractiveOverlay {
		if (!this.#current) throw new Error("no confirmation overlay is mounted");
		return this.#current;
	}

	handleInput(data: string): void {
		this.overlay.handleInput(data);
	}
}

beforeAll(async () => {
	await initTheme(false);
});

beforeEach(() => {
	AgentRegistry.resetGlobalForTests();
	geometry = stubStdoutGeometry({ columns: WIDTH, rows: 40 });
});

afterEach(() => {
	for (const dashboard of dashboards.splice(0)) dashboard.dispose();
	AgentRegistry.resetGlobalForTests();
	geometry.restore();
});

/** Rendered terminal cells without SGR styling, preserving their screen coordinates. */
function renderedLines(component: RenderedComponent): string[] {
	return component.render(WIDTH).map(line => stripVTControlCharacters(line));
}

/** The whole visible card as an operator reads it. */
function frameOf(component: RenderedComponent): string {
	return renderedLines(component).join("\n");
}

/** The card's text with its border and wrapping removed, so a wrapped sentence reads whole. */
function proseOf(component: RenderedComponent): string {
	return renderedLines(component)
		.map(line => line.replace(/[│╭╮╰╯─]/g, "").trim())
		.join(" ")
		.replace(/\s+/g, " ");
}

/** Locate visible text in the real ModalShell frame for pointer input. */
function positionOf(component: RenderedComponent, needle: string): { row: number; col: number } {
	const lines = renderedLines(component);
	const row = lines.findIndex(line => line.includes(needle));
	if (row < 0) throw new Error(`no rendered row contains ${JSON.stringify(needle)}`);
	return { row, col: lines[row]!.indexOf(needle) };
}

/** A live session double that records exactly when and why its turn is aborted. */
function recordingSession(events: string[]): AgentSession {
	return {
		subscribe: () => () => {},
		abort: async (options?: { reason?: string }) => {
			events.push(`abort:${options?.reason ?? ""}`);
		},
	} as unknown as AgentSession;
}

/**
 * A lifecycle double whose completion promise lets confirmation tests observe
 * the fire-and-forget stop without relying on arbitrary sleeps.
 *
 * It records `stop`, which is the whole lifecycle surface the dashboard
 * touches. The abort-then-sleep ordering inside a stop belongs to the
 * real manager and is pinned against it in
 * test/tools/job-cancels-an-agent-with-no-job.test.ts; what these tests own is
 * that confirmation, and only confirmation, reaches the lifecycle at all.
 */
function recordingLifecycle(events: string[]): {
	lifecycle: () => AgentLifecycleManager;
	firstStop: Promise<void>;
} {
	const stopped = Promise.withResolvers<void>();
	const manager = {
		stop: async (id: string, reason: string) => {
			events.push(`stop:${id}:${reason}`);
			stopped.resolve();
		},
	} as unknown as AgentLifecycleManager;
	return { lifecycle: () => manager, firstStop: stopped.promise };
}

/** Register the running agent used by the keyboard interaction cases. */
function registerWorker(events: string[]): void {
	AgentRegistry.global().register({
		id: "Worker",
		displayName: "reviewer",
		kind: "sub",
		parentId: MAIN_AGENT_ID,
		session: recordingSession(events),
		sessionFile: null,
		status: "running",
	});
}

/** Construct a tracked dashboard so failed assertions cannot leak its ticker. */
function dashboardWith(
	lifecycle: () => AgentLifecycleManager,
	focusAgent?: (id: string) => Promise<void>,
	ui?: TUI,
): AgentDashboard {
	const dashboard = new AgentDashboard({ terminalHeight: 40, lifecycle, focusAgent, ui });
	dashboards.push(dashboard);
	return dashboard;
}

describe("Agent dashboard stop confirmation", () => {
	/**
	 * `x` only asks the question. Seeing both the selected agent and the
	 * consequence before any lifecycle call is what separates confirmation from
	 * the former immediate-kill behavior.
	 */
	test("opens the confirmation with x without aborting or stopping", () => {
		const events: string[] = [];
		const overlays = new OverlayHarness();
		registerWorker(events);
		const dashboard = dashboardWith(recordingLifecycle(events).lifecycle, undefined, overlays.ui);

		dashboard.handleInput("x");

		const frame = frameOf(overlays.overlay);
		expect(frame).toContain("Stop agent?");
		expect(frame).toContain("Kestrel");
		expect(proseOf(overlays.overlay)).toContain(
			"This stops the current turn and puts the agent and every agent it spawned to sleep. Message it to continue; its transcript stays on disk.",
		);
		expect(frame).toContain("esc dismiss");
		expect(frame).toContain("enter yes, stop");
		expect(events).toEqual([]);
	});

	/**
	 * Both cancellation gestures are side-effect free: Escape serves keyboard
	 * users, while the rendered dismiss action proves the footer is a real mouse
	 * target rather than explanatory text.
	 */
	test("dismisses with Escape or the footer action without stopping", () => {
		const events: string[] = [];
		const overlays = new OverlayHarness();
		registerWorker(events);
		const dashboard = dashboardWith(recordingLifecycle(events).lifecycle, undefined, overlays.ui);

		dashboard.handleInput("x");
		overlays.handleInput("\x1b");
		expect(overlays.visible).toBe(false);
		expect(events).toEqual([]);

		dashboard.handleInput("x");
		const dismiss = positionOf(overlays.overlay, "esc dismiss");
		overlays.handleInput(sgrPress(dismiss.row, dismiss.col));
		expect(overlays.visible).toBe(false);
		expect(events).toEqual([]);
	});

	/**
	 * Accepting is what reaches the lifecycle, and it names the operator as the
	 * reason so the agent's transcript records why it stopped.
	 */
	test("confirms with Enter and stops the agent", async () => {
		const events: string[] = [];
		const overlays = new OverlayHarness();
		registerWorker(events);
		const lifecycle = recordingLifecycle(events);
		const dashboard = dashboardWith(lifecycle.lifecycle, undefined, overlays.ui);

		dashboard.handleInput("x");
		expect(events).toEqual([]);
		overlays.handleInput("\r");
		await lifecycle.firstStop;

		expect(events).toEqual(["stop:Worker:Interrupted by user"]);
	});

	/**
	 * The affirmative footer is an action, not a label. A repeated pointer press
	 * on the same rendered dialog still stops once, which prevents a terminal
	 * that reports a double-click from issuing two lifecycle stops.
	 */
	test("confirms through the clickable Yes action exactly once", async () => {
		const events: string[] = [];
		const overlays = new OverlayHarness();
		registerWorker(events);
		const lifecycle = recordingLifecycle(events);
		const dashboard = dashboardWith(lifecycle.lifecycle, undefined, overlays.ui);

		dashboard.handleInput("x");
		const dialog = overlays.overlay;
		const confirm = positionOf(dialog, "enter yes, stop");
		const click = sgrPress(confirm.row, confirm.col);
		dialog.handleInput(click);
		dialog.handleInput(click);
		await lifecycle.firstStop;

		expect(overlays.visible).toBe(false);
		expect(events).toEqual(["stop:Worker:Interrupted by user"]);
	});

	/**
	 * Hover advertises a stop only where it is valid. Clicking that exact
	 * row-local target asks for confirmation, while an ordinary row click keeps
	 * its existing meaning of opening the agent.
	 */
	test("reveals and clicks a row-local [x] only for a stoppable agent", () => {
		const events: string[] = [];
		const opened: string[] = [];
		const overlays = new OverlayHarness();
		AgentRegistry.global().register({
			id: MAIN_AGENT_ID,
			displayName: "main",
			kind: "main",
			session: recordingSession(events),
			sessionFile: null,
			status: "running",
		});
		AgentRegistry.global().register({
			id: "Main/advisor",
			displayName: "advisor",
			kind: "advisor",
			parentId: MAIN_AGENT_ID,
			session: null,
			sessionFile: "/tmp/advisor.jsonl",
			status: "asleep",
		});
		AgentRegistry.global().register({
			id: "Worker",
			displayName: "scout",
			kind: "sub",
			parentId: MAIN_AGENT_ID,
			session: recordingSession(events),
			sessionFile: null,
			status: "running",
		});
		const dashboard = dashboardWith(
			recordingLifecycle(events).lifecycle,
			async id => {
				opened.push(id);
			},
			overlays.ui,
		);

		const main = positionOf(dashboard, "Main");
		dashboard.handleInput(sgrMotion(main.row, main.col));
		expect(renderedLines(dashboard)[main.row]).not.toContain("[x]");
		const advisor = positionOf(dashboard, "Advisor");
		dashboard.handleInput(sgrMotion(advisor.row, advisor.col));
		expect(renderedLines(dashboard)[advisor.row]).not.toContain("[x]");

		const scout = positionOf(dashboard, "scout");
		dashboard.handleInput(sgrMotion(scout.row, scout.col));
		const hoveredScoutRow = renderedLines(dashboard)[scout.row]!;
		expect(hoveredScoutRow).toContain("[x]");
		const stopCol = hoveredScoutRow.lastIndexOf("[x]");
		dashboard.handleInput(sgrPress(scout.row, stopCol));
		expect(frameOf(overlays.overlay)).toContain("Stop agent?");
		expect(events).toEqual([]);

		overlays.handleInput("\x1b");
		const ordinaryRowTarget = positionOf(dashboard, "scout");
		dashboard.handleInput(sgrPress(ordinaryRowTarget.row, ordinaryRowTarget.col));
		expect(opened).toEqual(["Worker"]);
		expect(overlays.visible).toBe(false);
		expect(events).toEqual([]);

		// The affordance cannot be bypassed from the keyboard: move back from the
		// clicked worker to each protected row and verify `x` remains harmless.
		dashboard.handleInput("k");
		dashboard.handleInput("k");
		dashboard.handleInput("x");
		expect(overlays.visible).toBe(false);
		expect(events).toEqual([]);
		dashboard.handleInput("j");
		dashboard.handleInput("x");
		expect(overlays.visible).toBe(false);
		expect(events).toEqual([]);
	});
});
