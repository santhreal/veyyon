/**
 * Contract: the agent hub's relative-time age ticker repaints itself only,
 * never the whole UI (BACKLOG P6).
 *
 * The age ticker fires every 5s purely to refresh the "Xs ago" column; it
 * never changes row count or layout. Before this fix it called the full
 * `ui.requestRender()`, re-walking the whole transcript tree on a fixed
 * cadence even while nothing else changed — a needless full-tree repaint
 * for an idle, open hub.
 */
import { afterEach, beforeAll, describe, expect, it, setSystemTime, vi } from "bun:test";
import { IrcBus } from "@veyyon/coding-agent/irc/bus";
import { AgentHubOverlayComponent } from "@veyyon/coding-agent/modes/components/agent-hub";
import { SessionObserverRegistry } from "@veyyon/coding-agent/modes/session-observer-registry";
import { initTheme } from "@veyyon/coding-agent/modes/theme/theme";
import { AgentRegistry } from "@veyyon/coding-agent/registry/agent-registry";
import type { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import type { TUI } from "@veyyon/tui";

describe("Agent hub age ticker repaint scope", () => {
	beforeAll(async () => {
		await initTheme();
	});

	afterEach(() => {
		vi.useRealTimers();
		setSystemTime();
		vi.restoreAllMocks();
		AgentRegistry.resetGlobalForTests();
	});

	it("uses requestComponentRender, not the full requestRender, on each age tick", async () => {
		vi.useFakeTimers();
		let hub: AgentHubOverlayComponent | undefined;
		try {
			const agents = new AgentRegistry();
			setSystemTime(1000);
			agents.register({ id: "A", displayName: "Alpha", kind: "sub", session: {} as AgentSession });

			const requestRender = vi.fn();
			const requestComponentRender = vi.fn();
			const ui = { requestRender, requestComponentRender } as unknown as TUI;

			hub = new AgentHubOverlayComponent({
				observers: new SessionObserverRegistry(),
				hubKeys: [],
				onDone: () => {},
				requestRender,
				registry: agents,
				irc: new IrcBus(agents),
				focusAgent: async () => {},
				ui,
			});
			// Let the async persisted-subagents scan settle first so its one-off
			// `requestRender()` (unrelated to the age ticker) doesn't pollute the
			// call counts below.
			await hub.persistedSubagentsReady;

			requestRender.mockClear();
			requestComponentRender.mockClear();

			// AGE_TICK_MS is 5s; advance three ticks.
			vi.advanceTimersByTime(15_000);

			expect(requestComponentRender).toHaveBeenCalledTimes(3);
			for (const call of requestComponentRender.mock.calls) {
				expect(call[0]).toBe(hub);
			}
			expect(requestRender).not.toHaveBeenCalled();
		} finally {
			hub?.dispose();
		}
	});

	it("stops ticking once disposed", () => {
		vi.useFakeTimers();
		let hub: AgentHubOverlayComponent | undefined;
		try {
			const agents = new AgentRegistry();
			const requestRender = vi.fn();
			const requestComponentRender = vi.fn();
			const ui = { requestRender, requestComponentRender } as unknown as TUI;

			hub = new AgentHubOverlayComponent({
				observers: new SessionObserverRegistry(),
				hubKeys: [],
				onDone: () => {},
				requestRender,
				registry: agents,
				irc: new IrcBus(agents),
				focusAgent: async () => {},
				ui,
			});
			hub.dispose();
			hub = undefined;

			requestComponentRender.mockClear();
			vi.advanceTimersByTime(30_000);
			expect(requestComponentRender).not.toHaveBeenCalled();
		} finally {
			hub?.dispose();
		}
	});
});
