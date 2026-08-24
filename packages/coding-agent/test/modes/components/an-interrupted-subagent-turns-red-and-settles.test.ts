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
import { AgentDashboard } from "@veyyon/coding-agent/modes/components/agent-dashboard";
import { initTheme, theme } from "@veyyon/coding-agent/modes/theme/theme";
import { AgentRegistry } from "@veyyon/coding-agent/registry/agent-registry";
import { type StubbedStdoutGeometry, stubStdoutGeometry } from "../../helpers/stdout-geometry";
import { useFullColor } from "../../helpers/theme-assertions";

const ANSI_PATTERN = /\x1b\[[0-?]*[ -/]*[@-~]/g;


let geo: StubbedStdoutGeometry;

beforeAll(async () => {
	await initTheme(false);
});

beforeEach(() => {
	AgentRegistry.resetGlobalForTests();
	geo = stubStdoutGeometry({ columns: 120, rows: 40 });
});

afterEach(() => {
	vi.restoreAllMocks();
	AgentRegistry.resetGlobalForTests();
	geo.restore();
});

function rowsOf(dashboard: AgentDashboard, callSign: string): string[] {
	return dashboard
		.render(120)
		.map(line => line.replace(ANSI_PATTERN, "").trimEnd())
		.filter(line => line.includes(callSign));
}

function rawRowsOf(dashboard: AgentDashboard, callSign: string): string[] {
	return dashboard
		.render(120)
		.filter(line => line.includes(callSign));
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
});
