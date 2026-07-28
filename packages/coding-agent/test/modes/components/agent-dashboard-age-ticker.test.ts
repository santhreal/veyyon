/**
 * The relative-time ticker: how the card keeps "3m ago" honest, and what it is
 * allowed to repaint to do it.
 *
 * WHY THIS SUITE EXISTS. The ticker fires every five seconds purely to advance
 * the age column. It never changes the row count and never changes the layout,
 * so it must repaint ITSELF and nothing else. It used to call the full
 * `ui.requestRender()`, which re-walks the entire UI tree, including the whole
 * transcript, on a fixed cadence for an idle card sitting open on screen. That
 * is a repaint of everything to update six characters.
 *
 * The dispose half matters just as much: the timer outlives the card unless the
 * card clears it, and a leaked interval keeps calling into a component that has
 * been unmounted for the rest of the session.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, setSystemTime, test, vi } from "bun:test";
import { AgentDashboard } from "@veyyon/coding-agent/modes/components/agent-dashboard";
import { initTheme } from "@veyyon/coding-agent/modes/theme/theme";
import { AgentRegistry, MAIN_AGENT_ID } from "@veyyon/coding-agent/registry/agent-registry";
import type { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import type { TUI } from "@veyyon/tui";
import { type StubbedStdoutGeometry, stubStdoutGeometry } from "../../helpers/stdout-geometry";

const ANSI_PATTERN = /\x1b\[[0-?]*[ -/]*[@-~]/g;

let geometry: StubbedStdoutGeometry;

beforeAll(async () => {
	await initTheme(false);
});

beforeEach(() => {
	AgentRegistry.resetGlobalForTests();
	geometry = stubStdoutGeometry({ columns: 120, rows: 40 });
});

afterEach(() => {
	vi.useRealTimers();
	setSystemTime();
	vi.restoreAllMocks();
	AgentRegistry.resetGlobalForTests();
	geometry.restore();
});

/** A TUI double that records which of the two repaint entry points was used. */
function recordingUi(): { ui: TUI; full: ReturnType<typeof vi.fn>; scoped: ReturnType<typeof vi.fn> } {
	const full = vi.fn();
	const scoped = vi.fn();
	return { ui: { requestRender: full, requestComponentRender: scoped } as unknown as TUI, full, scoped };
}

function registerSub(id: string): void {
	AgentRegistry.global().register({
		id,
		displayName: "scout",
		kind: "sub",
		parentId: MAIN_AGENT_ID,
		session: { subscribe: () => () => {} } as unknown as AgentSession,
		sessionFile: null,
		status: "running",
	});
}

describe("Age ticker repaint scope", () => {
	/**
	 * One component-scoped repaint per five-second tick, and never the full-tree
	 * one. Three ticks are asserted rather than one so a ticker that fired once
	 * and stopped cannot pass.
	 */
	test("repaints only itself on each tick", () => {
		vi.useFakeTimers();
		registerSub("A");
		const { ui, full, scoped } = recordingUi();
		const dashboard = new AgentDashboard({ terminalHeight: 40, ui });

		vi.advanceTimersByTime(15_000);

		expect(scoped).toHaveBeenCalledTimes(3);
		for (const call of scoped.mock.calls) expect(call[0]).toBe(dashboard);
		expect(full).not.toHaveBeenCalled();
		dashboard.dispose();
	});

	/** Nothing ticks before the first interval elapses, so the cadence is the stated five seconds. */
	test("does not repaint before the first tick is due", () => {
		vi.useFakeTimers();
		registerSub("A");
		const { ui, scoped } = recordingUi();
		const dashboard = new AgentDashboard({ terminalHeight: 40, ui });

		vi.advanceTimersByTime(4_999);

		expect(scoped).not.toHaveBeenCalled();
		dashboard.dispose();
	});

	/**
	 * The timer is cleared on dispose. A leaked interval calls into an unmounted
	 * component every five seconds for the rest of the process.
	 */
	test("stops ticking once disposed", () => {
		vi.useFakeTimers();
		registerSub("A");
		const { ui, scoped } = recordingUi();
		const dashboard = new AgentDashboard({ terminalHeight: 40, ui });

		dashboard.dispose();
		vi.advanceTimersByTime(30_000);

		expect(scoped).not.toHaveBeenCalled();
	});
});

describe("What the ticker is for", () => {
	/**
	 * The point of the repaint: the age text actually advances. Without this the
	 * suite above would pass for a ticker that repainted a frozen label, which is
	 * the cost with none of the benefit.
	 */
	test("advances the rendered age as time passes, without a layout rebuild", () => {
		vi.useFakeTimers();
		setSystemTime(new Date("2026-07-26T12:00:00Z"));
		registerSub("A");
		const dashboard = new AgentDashboard({ terminalHeight: 40 });
		const frame = () => dashboard.render(120).join("\n").replace(ANSI_PATTERN, "");
		// One second in: under a minute reads as "just now" rather than a count.
		setSystemTime(new Date("2026-07-26T12:00:01Z"));
		expect(frame()).toContain("just now");

		// Same terminal geometry, so the card does NOT rebuild its layout: the
		// pane it built at open time is the one being re-rendered, and it has to
		// read the clock now rather than replay the one it was constructed with.
		setSystemTime(new Date("2026-07-26T12:03:00Z"));

		expect(frame()).toContain("3m ago");
		expect(frame()).not.toContain("just now");
		dashboard.dispose();
	});
});
