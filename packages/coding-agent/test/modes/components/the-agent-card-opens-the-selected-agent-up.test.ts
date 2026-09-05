/**
 * WHY THIS SUITE EXISTS.
 *
 * The Live roster spends one row on each agent, and the one line it has for
 * "what is it doing" is a gist. The detail pane under the roster is where the
 * next questions are answered for the SELECTED agent: what it was asked to do,
 * which tool it is inside and for how long, what it has cost, what it printed
 * last, and why it is not moving. These tests pin that the pane draws from the
 * executor's progress, follows the selection, never resizes the card as the
 * cursor moves, and stays out of the way when there is nothing to show or no
 * room to show it.
 *
 * Not caught here: the exact glyphs and colours of the pane, which follow the
 * theme preset, and the argot expansion of the output tail, which happens in
 * the executor before `recentOutput` is populated and is proven by the
 * `argot-subagent-*` suites.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { AgentDashboard } from "@veyyon/coding-agent/modes/components/agent-dashboard";
import type { ObservableSession } from "@veyyon/coding-agent/modes/session-observer-registry";
import { SessionObserverRegistry } from "@veyyon/coding-agent/modes/session-observer-registry";
import { initTheme } from "@veyyon/coding-agent/modes/theme/theme";
import { AgentRegistry, MAIN_AGENT_ID } from "@veyyon/coding-agent/registry/agent-registry";
import type { AgentProgress } from "@veyyon/coding-agent/task/types";
import { type StubbedStdoutGeometry, stubStdoutGeometry } from "../../helpers/stdout-geometry";

const ANSI_PATTERN = /\x1b\[[0-?]*[ -/]*[@-~]/g;

let geometry: StubbedStdoutGeometry;

beforeEach(async () => {
	await initTheme(false);
	AgentRegistry.resetGlobalForTests();
	geometry = stubStdoutGeometry({ columns: 120, rows: 40 });
});

afterEach(() => {
	AgentRegistry.resetGlobalForTests();
	geometry.restore();
});

function frameOf(dashboard: AgentDashboard, width = 120): string[] {
	return dashboard.render(width).map(line => line.replace(ANSI_PATTERN, ""));
}

function progressOf(overrides: Partial<AgentProgress>): AgentProgress {
	return {
		index: 0,
		id: "Scout",
		agent: "scout",
		agentSource: "bundled",
		status: "running",
		task: "Find every caller of parseConfig",
		recentTools: [],
		recentOutput: [],
		toolCount: 0,
		requests: 0,
		tokens: 0,
		cost: 0,
		durationMs: 0,
		...overrides,
	};
}

function scoutSession(progress: AgentProgress): ObservableSession {
	return { id: "Scout", kind: "subagent", label: "Subagent", status: "active", lastUpdate: Date.now(), progress };
}

function observersWith(sessions: ObservableSession[]): SessionObserverRegistry {
	const observers = new SessionObserverRegistry();
	observers.getSessions = () => sessions;
	return observers;
}

function registerMain(): void {
	AgentRegistry.global().register({
		id: MAIN_AGENT_ID,
		displayName: "main",
		kind: "main",
		session: null,
		status: "running",
	});
}

function registerSubagent(id: string, displayName = "scout"): void {
	AgentRegistry.global().register({ id, displayName, kind: "sub", session: null, status: "running" });
}

describe("the agent card opens the selected agent up", () => {
	test("shows the selected agent's assignment, current tool, stats and last output under the roster", () => {
		registerMain();
		registerSubagent("Scout");
		const observers = observersWith([
			scoutSession(
				progressOf({
					assignment: "Find every caller of parseConfig and list the files",
					currentTool: "search",
					lastIntent: "Finding parseConfig callers",
					currentToolStartMs: Date.now() - 12_000,
					toolCount: 14,
					requests: 4,
					contextTokens: 47_000,
					contextWindow: 200_000,
					cost: 0.12,
					durationMs: 95_000,
					recentOutput: ["src/config/loader.ts:42", "src/cli.ts:17", "older line"],
				}),
			),
		]);
		const dashboard = new AgentDashboard({ terminalHeight: 40, observers });
		dashboard.handleInput("j"); // down: from Main onto Scout

		const frame = frameOf(dashboard);
		// The call sign is an assigned code name, so rows are found by their TYPE column.
		const rosterRow = frame.findIndex(line => /\S+\s+scout\s+running/.test(line));
		const rule = frame.findIndex((line, index) => index > rosterRow && /─+ \S+ scout ─+/.test(line));
		const pane = frame.slice(rule, rule + 6).join("\n");

		expect(rosterRow).toBeGreaterThan(-1);
		expect(rule).toBeGreaterThan(rosterRow);
		expect(pane).toContain("Find every caller of parseConfig and list the files");
		expect(pane).toContain("search: Finding parseConfig callers");
		expect(pane).toMatch(/1[12]\.\ds/); // the elapsed time, past the five-second mark
		expect(pane).toContain("1m35s");
		expect(pane).toContain("14 ");
		expect(pane).toContain("4 req");
		expect(pane).toContain("47K/200K");
		expect(pane).toContain("$0.12");
		// Newest last, two lines, oldest of the three dropped.
		expect(pane).toContain("src/cli.ts:17");
		expect(pane).toContain("src/config/loader.ts:42");
		expect(pane).not.toContain("older line");
		expect(pane.indexOf("src/cli.ts:17")).toBeLessThan(pane.indexOf("src/config/loader.ts:42"));
		dashboard.dispose();
	});

	test("names a retry wait in the tool slot instead of the tool", () => {
		registerMain();
		registerSubagent("Scout");
		const observers = observersWith([
			scoutSession(
				progressOf({
					currentTool: "bash",
					retryState: {
						attempt: 2,
						maxAttempts: 5,
						delayMs: 30_000,
						errorMessage: "429 rate limited",
						startedAtMs: Date.now(),
					},
				}),
			),
		]);
		const dashboard = new AgentDashboard({ terminalHeight: 40, observers });
		dashboard.handleInput("j");

		const frame = frameOf(dashboard).join("\n");

		expect(frame).toMatch(/retrying 2\/5 in \d+\.\ds: 429 rate limited/);
		dashboard.dispose();
	});

	test("follows the selection and keeps the card the same height while the cursor moves", () => {
		registerMain();
		registerSubagent("Scout", "scout");
		registerSubagent("Reviewer", "reviewer");
		const observers = observersWith([scoutSession(progressOf({ assignment: "scout assignment text" }))]);
		const dashboard = new AgentDashboard({ terminalHeight: 40, observers });

		const onMain = frameOf(dashboard);
		dashboard.handleInput("j");
		const onScout = frameOf(dashboard);
		dashboard.handleInput("j");
		const onReviewer = frameOf(dashboard);

		expect(onMain.join("\n")).toContain("The driving session.");
		expect(onScout.join("\n")).toContain("scout assignment text");
		expect(onReviewer.join("\n")).toContain("No live progress");
		expect(onReviewer.join("\n")).not.toContain("scout assignment text");
		expect(drawnRows(onScout)).toBe(drawnRows(onMain));
		expect(drawnRows(onReviewer)).toBe(drawnRows(onMain));
		dashboard.dispose();
	});

	test("draws no pane while no agent has progress to show", () => {
		registerMain();
		registerSubagent("Scout");
		const dashboard = new AgentDashboard({ terminalHeight: 40, observers: observersWith([]) });
		dashboard.handleInput("j");

		const frame = frameOf(dashboard).join("\n");

		expect(frame).toMatch(/\S+\s+scout\s+running/);
		expect(frame).not.toMatch(/─+ \S+ scout ─+/);
		expect(frame).not.toContain("No live progress");
		dashboard.dispose();
	});

	test("gives the roster the whole body on a terminal too short for both", () => {
		geometry.restore();
		geometry = stubStdoutGeometry({ columns: 120, rows: 14 });
		registerMain();
		registerSubagent("Scout");
		const observers = observersWith([scoutSession(progressOf({ assignment: "scout assignment text" }))]);
		const dashboard = new AgentDashboard({ terminalHeight: 14, observers });
		dashboard.handleInput("j");

		const frame = frameOf(dashboard).join("\n");

		expect(frame).toMatch(/\S+\s+scout\s+running/);
		expect(frame).not.toContain("scout assignment text");
		dashboard.dispose();
	});
});

/**
 * Rows the CARD occupies. The dashboard renders into the whole terminal and
 * floats its card in the middle, so `render().length` is the viewport and says
 * nothing about the card's height.
 */
function drawnRows(lines: readonly string[]): number {
	const first = lines.findIndex(line => line.trim().length > 0);
	if (first < 0) return 0;
	let last = lines.length - 1;
	while (last > first && lines[last]!.trim().length === 0) last--;
	return last - first + 1;
}
