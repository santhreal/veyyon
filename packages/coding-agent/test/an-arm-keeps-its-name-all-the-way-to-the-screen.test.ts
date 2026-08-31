/**
 * WHY: a breadth iteration measures several arms, one wins, and the winner is
 * re-applied and logged. Every field that says WHICH arm won and WHO reviewed it
 * lived only in the certify tool's text output, so the stored run, the rebuilt
 * state and the run screen all showed an unattributed result. An operator
 * reading the screen after four iterations could not tell a swarm round from a
 * serial one.
 *
 * The class it closes is attribution dropped at a boundary: the tool argument,
 * the database column, the state rebuild, and the surface that renders it. Each
 * boundary is crossed here with the real tool and a real database, and the
 * suite fails if any one of them stops carrying the pair.
 *
 * What it does not catch: whether the arm named is the arm that produced the
 * diff. That is the model's claim, and nothing downstream can check it.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import { renderRunDetail, runScreenRows } from "@veyyon/coding-agent/autoresearch/screen";
import {
	type AutoresearchHarness,
	logRun,
	openExperiment,
	seedMeasuredRun,
	stateOf,
	useAutoresearchRepo,
} from "./helpers/autoresearch-session";
import { useIsolatedAgentDir } from "./helpers/isolated-agent-dir";
import { useTruecolorTheme } from "./helpers/theme-assertions";

useIsolatedAgentDir();
useTruecolorTheme("dark");

afterEach(() => {
	vi.restoreAllMocks();
});

const freshRepo = useAutoresearchRepo("veyyon-arm-attribution-");

function openSwarm(breadth = 3): Promise<AutoresearchHarness> {
	return openExperiment(freshRepo(), { name: "arm attribution", breadth });
}

describe("an arm keeps its name", () => {
	it("carries the arm and its reviewer from log_experiment into the rebuilt state", async () => {
		const harness = await openSwarm();
		seedMeasuredRun(harness, { metric: 80 });
		const details = await logRun(harness, {
			metric: 80,
			status: "keep",
			description: "hoist the compiled matcher",
			arm: "a1",
			certified_by: "a0",
		});
		expect(details.experiment.arm).toBe("a1");
		expect(details.experiment.certifiedBy).toBe("a0");

		// The dashboard and the screen read the rebuilt state, not the tool's
		// return value, so a pair that only reaches `details` reaches nobody.
		const result = stateOf(harness).results.at(-1);
		expect(result?.arm).toBe("a1");
		expect(result?.certifiedBy).toBe("a0");
	});

	it("leaves the pair null for a serial run nobody attributed", async () => {
		const harness = await openSwarm(1);
		seedMeasuredRun(harness, { metric: 90 });
		const details = await logRun(harness, { metric: 90, status: "keep", description: "serial" });
		expect(details.experiment.arm).toBeNull();
		expect(details.experiment.certifiedBy).toBeNull();
		const result = stateOf(harness).results.at(-1);
		expect(result?.arm).toBeNull();
		expect(result?.certifiedBy).toBeNull();
	});

	it("does not erase the arm run_experiment recorded when the log omits it", async () => {
		// The measurement knows its arm; the log call that follows may not repeat
		// it. An overwriting write turned every logged arm back into a blank.
		const harness = await openSwarm();
		seedMeasuredRun(harness, { metric: 70, arm: "a2" });
		const details = await logRun(harness, { metric: 70, status: "keep", description: "kept" });
		expect(details.experiment.arm).toBe("a2");
		expect(stateOf(harness).results.at(-1)?.arm).toBe("a2");
	});

	it("does not erase a reviewer's verdict recorded before the log", async () => {
		// `certify_arms` flags an arm's measurement, then the winner is logged.
		// Logging used to write `flagged = 0` over the flag, so a gamed arm that
		// somehow reached the log looked clean in the history.
		const harness = await openSwarm();
		const runId = seedMeasuredRun(harness, { metric: 60, arm: "a1" });
		harness.storage.markRunCertified(runId, "a0", true, "caches by input identity");
		const details = await logRun(harness, {
			metric: 60,
			status: "keep",
			description: "kept anyway",
			arm: "a1",
		});
		expect(details.experiment.flagged).toBe(true);
		expect(details.experiment.flaggedReason).toBe("caches by input identity");
		expect(details.experiment.certifiedBy).toBe("a0");
		const result = stateOf(harness).results.at(-1);
		expect(result?.flagged).toBe(true);
		expect(result?.certifiedBy).toBe("a0");
	});

	it("lets the log correct the reviewer the measurement recorded", async () => {
		// The certify pass records the ring's reviewer; a director that overrules
		// the ring names itself on the log call, and that is the later fact.
		const harness = await openSwarm();
		const runId = seedMeasuredRun(harness, { metric: 50, arm: "a1" });
		harness.storage.markRunCertified(runId, "a0", false, null);
		const details = await logRun(harness, {
			metric: 50,
			status: "keep",
			description: "kept",
			arm: "a1",
			certified_by: "director",
		});
		expect(details.experiment.certifiedBy).toBe("director");
		expect(stateOf(harness).results.at(-1)?.certifiedBy).toBe("director");
	});

	it("names the arm in the run list and its reviewer in the detail pane", async () => {
		const harness = await openSwarm();
		const runId = seedMeasuredRun(harness, { metric: 80 });
		await logRun(harness, {
			metric: 80,
			status: "keep",
			description: "hoist the compiled matcher",
			arm: "a1",
			certified_by: "a0",
		});
		// The screen renders from the runtime the log tool refreshed, which is the
		// object the overlay holds while a loop runs.
		const row = runScreenRows(harness.runtime).find(candidate => candidate.value === `run:${runId}`);
		expect(row?.description).toContain("a1");
		expect(row?.filterText).toContain("a1");

		const detail = renderRunDetail(harness.runtime, `run:${runId}`, 60).join("\n");
		expect(detail).toContain("Arm");
		expect(detail).toContain("a1");
		expect(detail).toContain("Reviewed by");
		expect(detail).toContain("a0");
	});
});
