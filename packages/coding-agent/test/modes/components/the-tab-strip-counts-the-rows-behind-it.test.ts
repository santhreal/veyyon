/**
 * `Live (n)` is the number of rows the Live pane shows, and nothing else.
 *
 * WHY THIS SUITE EXISTS. `ViewTab.count` says in its own doc comment that it is
 * "rows behind the tab, so the strip says how much is there before you switch".
 * It was counting only the RUNNING agents while the pane listed every agent in
 * the roster, parked and idle ones included. A twenty-agent roster with three
 * parked read `Live (17)` directly above twenty visible rows, so the one number
 * on screen disagreed with the list under it, in a card whose whole job is
 * answering "what is running right now".
 *
 * Nothing caught it because every existing assertion used a roster of one, where
 * the two definitions give the same answer. That is the shape of this bug: it is
 * invisible until the roster is mixed, which is exactly when somebody opens the
 * card. So these tests use mixed rosters on purpose.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { AgentDashboard } from "@veyyon/coding-agent/modes/components/agent-dashboard";
import { initTheme } from "@veyyon/coding-agent/modes/theme/theme";
import { AgentRegistry } from "@veyyon/coding-agent/registry/agent-registry";
import { stubStdoutGeometry, type StubbedStdoutGeometry } from "../../helpers/stdout-geometry";

const ANSI_PATTERN = /\x1b\[[0-?]*[ -/]*[@-~]/g;

/** A registry entry the way the task executor writes one. */
function register(id: string, status: "running" | "idle" | "parked" | "aborted"): void {
	AgentRegistry.global().register({ id, displayName: "reviewer", kind: "sub", session: null, status });
}

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

/** The card's frame with styling stripped, and the roster rows in it. */
function frameOf(dashboard: AgentDashboard): { text: string; rows: string[] } {
	const lines = dashboard.render(120).map(line => line.replace(ANSI_PATTERN, ""));
	return { text: lines.join("\n"), rows: lines.filter(line => line.includes("reviewer")) };
}

describe("the Live tab counts the rows behind it", () => {
	/**
	 * The regression itself, in the shape that produced it: a mixed roster where
	 * "how many rows" and "how many are running" are different numbers. The count
	 * is asserted against the ROWS ACTUALLY DRAWN rather than against a literal,
	 * so the two can never drift apart again without this failing.
	 */
	test("a roster with parked and idle agents counts every row it draws", () => {
		register("0-Sub", "running");
		register("1-Sub", "idle");
		register("2-Sub", "parked");
		register("3-Sub", "running");
		const dashboard = new AgentDashboard({ terminalHeight: 40 });

		const { text, rows } = frameOf(dashboard);

		expect(rows).toHaveLength(4);
		expect(text).toContain("Live (4)");
		expect(text).not.toContain("Live (2)");
		dashboard.dispose();
	});

	/**
	 * The all-running case, which is the one every earlier test used and the
	 * reason the bug survived. It must still be right, and it is the case where
	 * the old and new definitions agree.
	 */
	test("a roster where everything is running counts the same either way", () => {
		register("0-Sub", "running");
		register("1-Sub", "running");
		const dashboard = new AgentDashboard({ terminalHeight: 40 });

		const { text, rows } = frameOf(dashboard);

		expect(rows).toHaveLength(2);
		expect(text).toContain("Live (2)");
		dashboard.dispose();
	});

	/**
	 * And the case that would have made the old count read zero while the pane
	 * showed a full roster: nothing running at all. An operator opening the card
	 * to find out why nothing is progressing is the person most badly served by a
	 * strip that says there is nothing there.
	 */
	test("a roster with nothing running still counts its rows", () => {
		register("0-Sub", "idle");
		register("1-Sub", "parked");
		register("2-Sub", "aborted");
		const dashboard = new AgentDashboard({ terminalHeight: 40 });

		const { text, rows } = frameOf(dashboard);

		expect(rows).toHaveLength(3);
		expect(text).toContain("Live (3)");
		expect(text).not.toContain("Live (0)");
		dashboard.dispose();
	});

	/**
	 * An empty roster really is zero, so the fix did not turn the count into a
	 * number that is never zero.
	 */
	test("an empty roster counts zero", () => {
		const dashboard = new AgentDashboard({ terminalHeight: 40 });

		expect(frameOf(dashboard).text).toContain("Live (0)");
		dashboard.dispose();
	});
});
