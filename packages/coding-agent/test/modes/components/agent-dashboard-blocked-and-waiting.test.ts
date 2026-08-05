/**
 * A HUNG AGENT MUST NOT READ AS A BUSY ONE.
 *
 * The Control Center's Live roster drew `AgentStatus` and nothing else, and
 * `AgentStatus` cannot express the two states an operator most needs to see:
 *
 * - An agent stopped at an approval prompt is `running`, because it IS mid-turn.
 *   A spawn waiting on a person and a spawn grinding through a build were the
 *   same row, so the dashboard actively hid the one thing it exists to surface.
 *   `AgentRef.pendingApproval` is the only discriminator; there is no status for
 *   it.
 * - An agent that stopped to wait on a peer is `parked`, exactly like one that
 *   simply finished. `AgentRef.waitingOnPeer` already carried the difference and
 *   the lifecycle manager already spent it on a longer close budget, so the
 *   state was trusted everywhere except on screen. That is the abandoned-subagent
 *   case.
 *
 * PINNED HERE: the rendered words and the column arithmetic. The status column
 * is measured over every row, so a longer word than the raw status would slide
 * the age, model and activity columns left on precisely the rows that most need
 * reading; the measure and the paint have to agree on which word is drawn.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AgentDashboard } from "@veyyon/coding-agent/modes/components/agent-dashboard";
import { initTheme, theme } from "@veyyon/coding-agent/modes/theme/theme";
import { AgentRegistry } from "@veyyon/coding-agent/registry/agent-registry";
import { type StubbedStdoutGeometry, stubStdoutGeometry } from "../../helpers/stdout-geometry";

const ANSI_PATTERN = /\x1b\[[0-?]*[ -/]*[@-~]/g;

let geo: StubbedStdoutGeometry;

beforeEach(async () => {
	await initTheme(false);
	AgentRegistry.resetGlobalForTests();
	geo = stubStdoutGeometry({ columns: 120, rows: 40 });
});

afterEach(() => {
	AgentRegistry.resetGlobalForTests();
	geo.restore();
});

function rowsOf(dashboard: AgentDashboard, callSign: string): string[] {
	return dashboard
		.render(120)
		.map(line => line.replace(ANSI_PATTERN, "").trimEnd())
		.filter(line => line.includes(callSign));
}

function registerSub(id: string, type: string): void {
	AgentRegistry.global().register({ id, displayName: type, kind: "sub", session: null, status: "running" });
}

describe("an agent blocked on an approval prompt", () => {
	/**
	 * The operator's standing concern in one assertion: the roster says
	 * `blocked`, not `running`, while a person is being waited on.
	 */
	test("reads as blocked rather than running", () => {
		registerSub("0-Sub", "reviewer");
		registerSub("1-Sub", "scout");
		AgentRegistry.global().setPendingApproval("1-Sub", { toolName: "bash", since: Date.now() });
		const dashboard = new AgentDashboard({ terminalHeight: 40 });
		try {
			const working = rowsOf(dashboard, "Kestrel")[0] ?? "";
			const blocked = rowsOf(dashboard, "Otter")[0] ?? "";
			expect(working).toContain("running");
			expect(blocked).toContain("blocked");
			expect(blocked).not.toContain("running");
		} finally {
			dashboard.dispose();
		}
	});

	/**
	 * Answering the prompt puts the row back to work. Asserted because the
	 * registry banks the closed wait rather than deleting it, so a reader of the
	 * wrong field would leave the row blocked forever.
	 */
	test("goes back to running when the prompt is answered", () => {
		vi.useFakeTimers();
		registerSub("0-Sub", "reviewer");
		const registry = AgentRegistry.global();
		registry.setPendingApproval("0-Sub", { toolName: "bash", since: Date.now() });
		const dashboard = new AgentDashboard({ terminalHeight: 40 });
		try {
			expect(rowsOf(dashboard, "Kestrel")[0] ?? "").toContain("blocked");
			registry.setPendingApproval("0-Sub", undefined);
			// The card coalesces registry events before rebuilding its roster.
			vi.advanceTimersByTime(1000);
			const after = rowsOf(dashboard, "Kestrel")[0] ?? "";
			expect(after).toContain("running");
			expect(after).not.toContain("blocked");
		} finally {
			vi.useRealTimers();
			dashboard.dispose();
		}
	});

	/**
	 * A DIFFERENT GLYPH, not only a different word. The leading mark is the part
	 * a reader scans down the column, and it is the whole signal on a terminal
	 * rendering no colour at all.
	 */
	test("carries a different leading glyph from a working agent", () => {
		registerSub("0-Sub", "reviewer");
		registerSub("1-Sub", "scout");
		AgentRegistry.global().setPendingApproval("1-Sub", { toolName: "bash", since: Date.now() });
		const dashboard = new AgentDashboard({ terminalHeight: 40 });
		try {
			const working = rowsOf(dashboard, "Kestrel")[0] ?? "";
			const blocked = rowsOf(dashboard, "Otter")[0] ?? "";
			const glyph = (row: string) =>
				row
					.slice(row.indexOf("│") + 1)
					.trim()
					.split(" ")[0];
			expect(glyph(blocked)).toBe(theme.symbol("status.warning"));
			expect(glyph(blocked)).not.toBe(glyph(working));
		} finally {
			dashboard.dispose();
		}
	});
});

describe("an agent parked waiting on a peer", () => {
	/**
	 * The abandonment case. Both rows are `parked` to the registry; only one of
	 * them is stopped on a reply that may never come.
	 */
	test("reads as waiting, and a finished one still reads as parked", () => {
		const registry = AgentRegistry.global();
		registerSub("0-Sub", "reviewer");
		registerSub("1-Sub", "scout");
		registry.setWaitingOnPeer("1-Sub", true);
		registry.setStatus("0-Sub", "parked");
		registry.setStatus("1-Sub", "parked");
		const dashboard = new AgentDashboard({ terminalHeight: 40 });
		try {
			const finished = rowsOf(dashboard, "Kestrel")[0] ?? "";
			const waiting = rowsOf(dashboard, "Otter")[0] ?? "";
			expect(finished).toContain("parked");
			expect(waiting).toContain("waiting");
			expect(waiting).not.toContain("parked");
		} finally {
			dashboard.dispose();
		}
	});

	/**
	 * `waitingOnPeer` is written at the end of a run and left in place while the
	 * agent is woken again, so a row read from it alone would label a working
	 * agent with the reason it stopped LAST time.
	 */
	test("does not label a running agent from a stale wait flag", () => {
		const registry = AgentRegistry.global();
		registerSub("0-Sub", "reviewer");
		registry.setWaitingOnPeer("0-Sub", true);
		const dashboard = new AgentDashboard({ terminalHeight: 40 });
		try {
			const row = rowsOf(dashboard, "Kestrel")[0] ?? "";
			expect(row).toContain("running");
			expect(row).not.toContain("waiting");
		} finally {
			dashboard.dispose();
		}
	});

	/**
	 * THE COLUMN GUARD. `waiting` is one cell wider than the `parked` it is
	 * derived from, and the status column is padded to the widest value across
	 * the whole roster. Measuring `agent.status` while painting the display word
	 * pads one cell short, and every column after it slides left on the wider
	 * rows. Asserted as the exact start column of the age, which is what follows.
	 */
	test("leaves the columns after the status aligned across both rows", () => {
		const registry = AgentRegistry.global();
		registerSub("0-Sub", "reviewer");
		registerSub("1-Sub", "scout");
		registry.setWaitingOnPeer("1-Sub", true);
		registry.setStatus("0-Sub", "parked");
		registry.setStatus("1-Sub", "parked");
		const dashboard = new AgentDashboard({ terminalHeight: 40 });
		try {
			const finished = rowsOf(dashboard, "Kestrel")[0] ?? "";
			const waiting = rowsOf(dashboard, "Otter")[0] ?? "";
			const age = "just now";
			expect(finished).toContain(age);
			expect(waiting).toContain(age);
			expect(waiting.indexOf(age)).toBe(finished.indexOf(age));
		} finally {
			dashboard.dispose();
		}
	});
});

describe("a card closed before its disk scan lands", () => {
	/**
	 * The card scans the session tree for subagents of previous runs, which is
	 * real filesystem work started in the constructor. A card closed while that
	 * is in flight used to rebuild its roster and ask the host to repaint, which
	 * is precisely the work `dispose` exists to stop: the overlay is gone, the
	 * subscriptions are dropped and the timers are cleared, and then one more
	 * layout is built for nobody.
	 *
	 * Driven with a REAL tree so the scan actually finds something and the
	 * callback actually runs; a scan that finds nothing returns early for an
	 * unrelated reason and would pass this test on the wrong path.
	 */
	test("does not rebuild or request a repaint after dispose", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-dashboard-scan-"));
		try {
			const sessionFile = path.join(root, "parent.jsonl");
			await fs.writeFile(sessionFile, "");
			await fs.mkdir(path.join(root, "parent"), { recursive: true });
			await fs.writeFile(path.join(root, "parent", "0-Sub.jsonl"), "");

			const dashboard = new AgentDashboard({ terminalHeight: 40, sessionFile });
			let repaints = 0;
			dashboard.onRequestRender = () => {
				repaints += 1;
			};
			dashboard.dispose();
			await dashboard.persistedSubagentsReady;

			expect(repaints).toBe(0);
			// The scan still ran and still registered the agent: what is suppressed
			// is the card's reaction to it, not the registry write.
			expect(AgentRegistry.global().get("0-Sub")?.status).toBe("parked");
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});
});
