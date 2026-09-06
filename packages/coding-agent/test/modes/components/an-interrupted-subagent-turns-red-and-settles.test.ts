/**
 * An interrupted or terminal subagent renders as its terminal status (aborted/error/red,
 * idle, parked), never retaining a transient blocked/running state.
 *
 * WHY THIS EXISTS.
 * The defect: When a subagent paused at an approval prompt (`blockedOnApproval: true`)
 * was interrupted (`status: "aborted"`), `agentDisplayState` evaluated `blockedOnApproval`
 * before checking whether the agent was still running. As a result, the sidebar/HUD/roster
 * row retained the "blocked" warning status instead of turning red ("aborted"), leaving
 * the operator looking at an actionable prompt indicator for a terminated agent.
 *
 * THE CLASS IT CLOSES.
 * Subagent terminal state overrides: Transient state modifiers (such as `blockedOnApproval`)
 * only apply while an agent is actively running (`status: "running"`). Once an agent
 * reaches a terminal or stopped state (`aborted`, `idle`, `parked`), the underlying status
 * (or `waitingOnPeer` for idle/parked) MUST take precedence.
 *
 * WHAT IT DOES NOT CATCH.
 * Terminal rendering font fallbacks for glyphs across exotic terminal emulators.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "bun:test";
import { IrcBus } from "@veyyon/coding-agent/irc/bus";
import { AgentDashboard } from "@veyyon/coding-agent/modes/components/agent-dashboard";
import { AgentTranscriptViewer } from "@veyyon/coding-agent/modes/components/agent-transcript-viewer";
import { initTheme, theme } from "@veyyon/coding-agent/modes/theme/theme";
import { AgentRegistry } from "@veyyon/coding-agent/registry/agent-registry";
import type { TUI } from "@veyyon/tui";
import { type StubbedStdoutGeometry, stubStdoutGeometry } from "../../helpers/stdout-geometry";
import { useFullColor } from "../../helpers/theme-assertions";

const ANSI_PATTERN = /\x1b\[[0-?]*[ -/]*[@-~]/g;

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
		.map(line => line.replace(ANSI_PATTERN, "").trimEnd())
		.filter(line => line.includes(callSign));
}

function rawRowsOf(dashboard: AgentDashboard, callSign: string, width = 120): string[] {
	return dashboard.render(width).filter(line => line.includes(callSign));
}

describe("an interrupted or terminal subagent settles to terminal display state", () => {
	useFullColor();

	test("reproduces the pause+interrupt defect: an interrupted subagent that was blocked on approval turns red (aborted)", () => {
		const registry = AgentRegistry.global();
		registry.register({
			id: "0-Sub",
			displayName: "reviewer",
			kind: "sub",
			session: null,
			status: "running",
		});

		// 1. Subagent pauses at an approval prompt
		registry.setPendingApproval("0-Sub", { toolName: "bash", since: Date.now() });
		const dashboardWhileBlocked = new AgentDashboard({ terminalHeight: 40 });
		try {
			const blockedRow = rowsOf(dashboardWhileBlocked, "Kestrel")[0] ?? "";
			expect(blockedRow).toContain("blocked");
			expect(blockedRow).not.toContain("aborted");
		} finally {
			dashboardWhileBlocked.dispose();
		}

		// 2. Subagent is interrupted (status transitions to aborted)
		registry.setStatus("0-Sub", "aborted");
		const dashboardAfterInterrupt = new AgentDashboard({ terminalHeight: 40 });
		try {
			const row = rowsOf(dashboardAfterInterrupt, "Kestrel")[0] ?? "";
			expect(row).toContain("aborted");
			expect(row).not.toContain("blocked");

			// Visual check: row must carry the error / red color code and aborted glyph
			const rawRow = rawRowsOf(dashboardAfterInterrupt, "Kestrel")[0] ?? "";
			const errorAnsi = theme.getFgAnsi("error");
			expect(rawRow).toContain(errorAnsi);
			expect(rawRow).toContain(theme.symbol("status.aborted"));
		} finally {
			dashboardAfterInterrupt.dispose();
		}
	});

	test("an interrupted subagent that had waitingOnPeer set turns red (aborted), not waiting", () => {
		const registry = AgentRegistry.global();
		registry.register({
			id: "0-Sub",
			displayName: "scout",
			kind: "sub",
			session: null,
			status: "parked",
		});
		registry.setWaitingOnPeer("0-Sub", true);

		// While parked + waitingOnPeer, it renders as waiting
		const dashboardWaiting = new AgentDashboard({ terminalHeight: 40 });
		try {
			const waitingRow = rowsOf(dashboardWaiting, "Kestrel")[0] ?? "";
			expect(waitingRow).toContain("waiting");
			expect(waitingRow).not.toContain("aborted");
		} finally {
			dashboardWaiting.dispose();
		}

		// Subagent is interrupted / aborted: terminal status must override waitingOnPeer
		registry.setStatus("0-Sub", "aborted");
		const dashboardAborted = new AgentDashboard({ terminalHeight: 40 });
		try {
			const row = rowsOf(dashboardAborted, "Kestrel")[0] ?? "";
			expect(row).toContain("aborted");
			expect(row).not.toContain("waiting");

			const rawRow = rawRowsOf(dashboardAborted, "Kestrel")[0] ?? "";
			const errorAnsi = theme.getFgAnsi("error");
			expect(rawRow).toContain(errorAnsi);
			expect(rawRow).toContain(theme.symbol("status.aborted"));
		} finally {
			dashboardAborted.dispose();
		}
	});

	test("an interrupted subagent clears activity gist and renders clean terminal state", () => {
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

		// Aborting must clear the activity
		registry.setStatus("0-Sub", "aborted");
		const dashboardAborted = new AgentDashboard({ terminalHeight: 40 });
		try {
			const abortedRow = rowsOf(dashboardAborted, "Kestrel")[0] ?? "";
			expect(abortedRow).toContain("aborted");
			expect(abortedRow).not.toContain("running test suite");
		} finally {
			dashboardAborted.dispose();
		}
	});

	test("narrow terminal width renders all agent states without ANSI corruption or overflow", () => {
		const registry = AgentRegistry.global();
		const states: Array<{
			id: string;
			status: "running" | "idle" | "parked" | "aborted";
			blocked?: boolean;
			waiting?: boolean;
		}> = [
			{ id: "0-Sub", status: "running" },
			{ id: "1-Sub", status: "running", blocked: true },
			{ id: "2-Sub", status: "idle" },
			{ id: "3-Sub", status: "parked", waiting: true },
			{ id: "4-Sub", status: "parked" },
			{ id: "5-Sub", status: "aborted" },
		];

		for (const s of states) {
			registry.register({
				id: s.id,
				displayName: "worker",
				kind: "sub",
				session: null,
				status: s.status,
			});
			if (s.blocked) registry.setPendingApproval(s.id, { toolName: "bash", since: Date.now() });
			if (s.waiting) registry.setWaitingOnPeer(s.id, true);
		}

		const narrowWidth = 40;
		const dashboard = new AgentDashboard({ terminalHeight: 40 });
		try {
			const lines = dashboard.render(narrowWidth);
			for (const line of lines) {
				// Strip ANSI to verify visible width constraint
				const visible = line.replace(ANSI_PATTERN, "");
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
		registry.setPendingApproval("0-Sub", { toolName: "bash", since: Date.now() });
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

		// 3. Interrupted / aborted (must override pending approval)
		registry.setStatus("0-Sub", "aborted");
		const viewerAborted = makeViewer();
		try {
			const lines = viewerAborted.render(80);
			const statusLine = lines.find(l => l.includes("aborted")) ?? "";
			expect(statusLine).toContain("0-Sub");
			expect(statusLine).toContain("aborted");
			expect(statusLine).not.toContain("blocked");
			expect(statusLine).toContain(theme.getFgAnsi("error"));
		} finally {
			viewerAborted.dispose();
		}
	});

	test("termination dialog formats status cleanly with and without type prefix", () => {
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
			// Open termination dialog with 'x'
			dashboard.handleInput("x");
			expect(currentOverlay).toBeDefined();
			const lines = currentOverlay!.render(120);
			const rendered = lines.map(l => l.replace(ANSI_PATTERN, "")).join("\n");
			expect(rendered).toContain("Terminate agent?");
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
			const rendered = lines.map(l => l.replace(ANSI_PATTERN, "")).join("\n");
			expect(rendered).toContain("Terminate agent?");
			// Must not contain leading ' · ' before status
			expect(rendered).not.toContain(" · running");
			expect(rendered).toContain("Otter  running");
		} finally {
			dashboardNoType.dispose();
		}
	});
});
