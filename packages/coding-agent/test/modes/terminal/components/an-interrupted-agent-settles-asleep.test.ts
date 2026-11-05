/**
 * An interrupted agent renders as the state it stopped in (asleep, muted), never
 * retaining a transient blocked/running state.
 *
 * WHY THIS EXISTS.
 * The defect: When an agent paused at an approval prompt (`blockedOnApproval: true`)
 * was interrupted, `agentDisplayState` evaluated `blockedOnApproval` before checking
 * whether the agent was still running. As a result, the sidebar/HUD/roster row
 * retained the "blocked" warning status after the stop, leaving the operator looking
 * at an actionable prompt indicator for an agent that was no longer running.
 *
 * THE CLASS IT CLOSES.
 * Transient state modifiers (such as `blockedOnApproval` and the activity gist) only
 * apply while an agent is actively running (`status: "running"`). Once an agent stops
 * (`idle`, `asleep`), the underlying status (or `waitingOnPeer`) MUST take precedence.
 *
 * WHAT IT DOES NOT CATCH.
 * Terminal rendering font fallbacks for glyphs across exotic terminal emulators.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { AgentDashboard } from "@veyyon/coding-agent/modes/terminal/components/dashboard/agent-dashboard";
import { AgentTranscriptViewer } from "@veyyon/coding-agent/modes/terminal/components/dashboard/agent-transcript-viewer";
import { AgentRegistry, type AgentStatus } from "@veyyon/coding-agent/registry/agent-registry";
import { IrcBus } from "@veyyon/coding-agent/task/irc-bus";
import { initTheme, theme } from "@veyyon/coding-agent/theme/theme";
import type { TUI } from "@veyyon/tui";
import { type StubbedStdoutGeometry, stubStdoutGeometry } from "../../../helpers/stdout-geometry";
import { useFullColor } from "../../../helpers/theme-assertions";

let geo: StubbedStdoutGeometry;

beforeAll(async () => {
	await initTheme(false);
});

beforeEach(() => {
	AgentRegistry.resetGlobalForTests();
	IrcBus.resetGlobalForTests();
	geo = stubStdoutGeometry({ columns: 120, rows: 40 });
});

afterEach(() => {
	vi.restoreAllMocks();
	AgentRegistry.resetGlobalForTests();
	IrcBus.resetGlobalForTests();
	geo.restore();
});

function rowsOf(dashboard: AgentDashboard, callSign: string, width = 120): string[] {
	return dashboard
		.render(width)
		.map(line => stripVTControlCharacters(line).trimEnd())
		.filter(line => line.includes(callSign));
}

function rawRowsOf(dashboard: AgentDashboard, callSign: string, width = 120): string[] {
	return dashboard.render(width).filter(line => line.includes(callSign));
}

describe("an interrupted agent settles to the state it stopped in", () => {
	useFullColor();

	test("reproduces the pause+interrupt defect: an interrupted agent that was blocked on approval settles asleep", () => {
		const registry = AgentRegistry.global();
		registry.register({
			id: "0-Sub",
			displayName: "reviewer",
			kind: "sub",
			session: null,
			status: "running",
		});

		// 1. Agent pauses at an approval prompt
		registry.openApprovalWait("0-Sub", { toolName: "bash", since: Date.now() });
		const dashboardWhileBlocked = new AgentDashboard({ terminalHeight: 40 });
		try {
			const blockedRow = rowsOf(dashboardWhileBlocked, "Kestrel")[0] ?? "";
			expect(blockedRow).toContain("blocked");
			expect(blockedRow).not.toContain("asleep");
		} finally {
			dashboardWhileBlocked.dispose();
		}

		// 2. Agent is interrupted (the stop puts it to sleep)
		registry.setStatus("0-Sub", "asleep");
		const dashboardAfterInterrupt = new AgentDashboard({ terminalHeight: 40 });
		try {
			const row = rowsOf(dashboardAfterInterrupt, "Kestrel")[0] ?? "";
			expect(row).toContain("asleep");
			expect(row).not.toContain("blocked");

			// Visual check: row carries the muted colour and the asleep glyph, not the warning
			const rawRow = rawRowsOf(dashboardAfterInterrupt, "Kestrel")[0] ?? "";
			expect(rawRow).toContain(theme.getFgAnsi("muted"));
			expect(rawRow).toContain(theme.symbol("status.shadowed"));
			expect(rawRow).not.toContain(theme.symbol("status.warning"));
		} finally {
			dashboardAfterInterrupt.dispose();
		}
	});

	test("an interrupted agent clears activity gist and renders clean terminal state", () => {
		const registry = AgentRegistry.global();
		registry.register({
			id: "0-Sub",
			displayName: "reviewer",
			kind: "sub",
			session: null,
			status: "running",
		});
		registry.setActivity("0-Sub", "running test suite");

		const dashboardRunning = new AgentDashboard({ terminalHeight: 40 });
		try {
			const runningRow = rowsOf(dashboardRunning, "Kestrel")[0] ?? "";
			expect(runningRow).toContain("running test suite");
			expect(runningRow).toContain("running");
		} finally {
			dashboardRunning.dispose();
		}

		// Stopping must clear the activity
		registry.setStatus("0-Sub", "asleep");
		const dashboardStopped = new AgentDashboard({ terminalHeight: 40 });
		try {
			const stoppedRow = rowsOf(dashboardStopped, "Kestrel")[0] ?? "";
			expect(stoppedRow).toContain("asleep");
			expect(stoppedRow).not.toContain("running test suite");
		} finally {
			dashboardStopped.dispose();
		}
	});

	test("narrow terminal width renders all agent states without ANSI corruption or overflow", () => {
		const registry = AgentRegistry.global();
		const states: Array<{
			id: string;
			status: AgentStatus;
			blocked?: boolean;
			waiting?: boolean;
		}> = [
			{ id: "0-Sub", status: "running" },
			{ id: "1-Sub", status: "running", blocked: true },
			{ id: "2-Sub", status: "idle" },
			{ id: "3-Sub", status: "asleep", waiting: true },
			{ id: "4-Sub", status: "asleep" },
		];

		for (const s of states) {
			registry.register({
				id: s.id,
				displayName: "worker",
				kind: "sub",
				session: null,
				status: s.status,
			});
			if (s.blocked) registry.openApprovalWait(s.id, { toolName: "bash", since: Date.now() });
			if (s.waiting) registry.setWaitingOnPeer(s.id, true);
		}

		const narrowWidth = 40;
		const dashboard = new AgentDashboard({ terminalHeight: 40 });
		try {
			const lines = dashboard.render(narrowWidth);
			for (const line of lines) {
				// Strip ANSI to verify visible width constraint
				const visible = stripVTControlCharacters(line);
				expect(visible.length).toBeLessThanOrEqual(narrowWidth);
			}
		} finally {
			dashboard.dispose();
		}
	});

	test("transcript viewer header renders derived display state with color parity", () => {
		const registry = AgentRegistry.global();
		registry.register({
			id: "0-Sub",
			displayName: "reviewer",
			kind: "sub",
			session: null,
			status: "running",
		});

		const makeViewer = () =>
			new AgentTranscriptViewer({
				agentId: "0-Sub",
				registry,
				ui: { requestRender: () => {}, requestComponentRender: () => {} } as never,
				cwd: "/tmp",
				expandKeys: ["ctrl+o"],
				hubKeys: ["ctrl+s"],
				requestRender: () => {},
				onClose: () => {},
				onHubClose: () => {},
			});

		// 1. Running state
		const viewerRunning = makeViewer();
		try {
			const lines = viewerRunning.render(80);
			const statusLine = lines.find(l => l.includes("running")) ?? "";
			expect(statusLine).toContain("0-Sub");
			expect(statusLine).toContain("running");
			expect(statusLine).toContain(theme.getFgAnsi("accent"));
		} finally {
			viewerRunning.dispose();
		}

		// 2. Blocked on approval
		registry.openApprovalWait("0-Sub", { toolName: "bash", since: Date.now() });
		const viewerBlocked = makeViewer();
		try {
			const lines = viewerBlocked.render(80);
			const statusLine = lines.find(l => l.includes("blocked")) ?? "";
			expect(statusLine).toContain("0-Sub");
			expect(statusLine).toContain("blocked");
			expect(statusLine).toContain(theme.getFgAnsi("warning"));
		} finally {
			viewerBlocked.dispose();
		}

		// 3. Interrupted: asleep must override the pending approval
		registry.setStatus("0-Sub", "asleep");
		const viewerStopped = makeViewer();
		try {
			const lines = viewerStopped.render(80);
			const statusLine = lines.find(l => l.includes("asleep")) ?? "";
			expect(statusLine).toContain("0-Sub");
			expect(statusLine).toContain("asleep");
			expect(statusLine).not.toContain("blocked");
			expect(statusLine).toContain(theme.getFgAnsi("muted"));
		} finally {
			viewerStopped.dispose();
		}
	});

	test("stop dialog formats status cleanly with and without type prefix", () => {
		const registry = AgentRegistry.global();
		registry.register({
			id: "0-Sub",
			displayName: "reviewer",
			kind: "sub",
			session: null,
			status: "running",
		});
		let currentOverlay: { render: (w: number) => readonly string[] } | undefined;
		const ui = {
			requestRender: () => {},
			requestComponentRender: () => {},
			showOverlay: (component: unknown) => {
				currentOverlay = component as { render: (w: number) => readonly string[] };
				return {
					hide: () => {
						currentOverlay = undefined;
					},
				};
			},
			setFocus: () => {},
		} as unknown as TUI;

		const dashboard = new AgentDashboard({ terminalHeight: 40, ui });
		try {
			// Open the stop dialog with 'x'
			dashboard.handleInput("x");
			expect(currentOverlay).toBeDefined();
			const lines = currentOverlay!.render(120);
			const rendered = lines.map(l => stripVTControlCharacters(l)).join("\n");
			expect(rendered).toContain("Stop agent?");
			expect(rendered).toContain("Kestrel  reviewer · running");
		} finally {
			dashboard.dispose();
		}

		// When displayName is empty/self (no agent type)
		registry.register({
			id: "1-Sub",
			displayName: "1-Sub",
			kind: "sub",
			session: null,
			status: "running",
		});
		currentOverlay = undefined;
		const dashboardNoType = new AgentDashboard({ terminalHeight: 40, ui });
		try {
			dashboardNoType.handleInput("j");
			dashboardNoType.handleInput("x");
			expect(currentOverlay).toBeDefined();
			const lines = currentOverlay!.render(120);
			const rendered = lines.map(l => stripVTControlCharacters(l)).join("\n");
			expect(rendered).toContain("Stop agent?");
			// Must not contain leading ' · ' before status
			expect(rendered).not.toContain(" · running");
			expect(rendered).toContain("Otter  running");
		} finally {
			dashboardNoType.dispose();
		}
	});
});
