/**
 * Unit tests for the release watcher's gate decision (scripts/release.ts
 * decideReleaseGate). The watcher must report whether the RELEASE-bearing
 * workflow (ci.yml, name "CI") published — and must NOT conflate an
 * independent workflow (Security/Docs) failing on the same commit with the
 * release outcome. Regression guard for the recurring "release reported failed
 * because Security was red, even though the npm publish succeeded" nuisance.
 */
import { describe, expect, it } from "bun:test";
import { decideReleaseGate, type WorkflowRun } from "./release";

const run = (name: string, status: string, conclusion: string | null, databaseId = 1): WorkflowRun => ({
	databaseId,
	name,
	status,
	conclusion,
});

describe("decideReleaseGate", () => {
	it("is pending while the CI workflow is still running", () => {
		const gate = decideReleaseGate([run("CI", "in_progress", null)]);
		expect(gate.state).toBe("pending");
		expect(gate.usedFallback).toBe(false);
		expect(gate.releaseRuns).toHaveLength(1);
	});

	it("passes when the CI workflow completes green", () => {
		const gate = decideReleaseGate([run("CI", "completed", "success")]);
		expect(gate.state).toBe("passed");
		expect(gate.siblingFailures).toEqual([]);
	});

	it("fails when the CI workflow completes non-green", () => {
		const gate = decideReleaseGate([run("CI", "completed", "failure")]);
		expect(gate.state).toBe("failed");
	});

	it("passes the release even when a sibling Security workflow is red", () => {
		const gate = decideReleaseGate([
			run("CI", "completed", "success", 10),
			run("Security", "completed", "failure", 11),
		]);
		expect(gate.state).toBe("passed");
		expect(gate.siblingFailures.map(r => r.name)).toEqual(["Security"]);
		expect(gate.siblingFailures[0].databaseId).toBe(11);
	});

	it("stays pending on the release while CI runs, regardless of a completed red sibling", () => {
		const gate = decideReleaseGate([run("CI", "in_progress", null, 10), run("Security", "completed", "failure", 11)]);
		// Must NOT short-circuit to failed on the sibling — the release chain is
		// still live and could publish.
		expect(gate.state).toBe("pending");
		expect(gate.siblingFailures.map(r => r.name)).toEqual(["Security"]);
	});

	it("fails the release when CI is red even if every sibling is green", () => {
		const gate = decideReleaseGate([
			run("CI", "completed", "failure", 10),
			run("Security", "completed", "success", 11),
			run("Docs", "completed", "success", 12),
		]);
		expect(gate.state).toBe("failed");
		expect(gate.siblingFailures).toEqual([]);
	});

	it("treats skipped and cancelled sibling conclusions distinctly", () => {
		const gate = decideReleaseGate([
			run("CI", "completed", "success", 10),
			run("Docs", "completed", "skipped", 11), // not a failure
			run("Checks", "completed", "cancelled", 12), // a failure
		]);
		expect(gate.state).toBe("passed");
		expect(gate.siblingFailures.map(r => r.name)).toEqual(["Checks"]);
	});

	it("counts multiple CI runs and stays pending until all CI runs finish", () => {
		const gate = decideReleaseGate([run("CI", "completed", "success", 10), run("CI", "in_progress", null, 11)]);
		expect(gate.state).toBe("pending");
		expect(gate.releaseRuns).toHaveLength(2);
	});

	it("fails if any CI run is red, even when another CI run is green", () => {
		const gate = decideReleaseGate([run("CI", "completed", "success", 10), run("CI", "completed", "failure", 11)]);
		expect(gate.state).toBe("failed");
	});

	it("falls back to gating on all runs when no CI workflow is present", () => {
		const gate = decideReleaseGate([
			run("Security", "completed", "success", 10),
			run("Docs", "completed", "failure", 11),
		]);
		expect(gate.usedFallback).toBe(true);
		expect(gate.releaseRuns).toHaveLength(2);
		// With no dedicated release workflow, a red run in the fallback set fails.
		expect(gate.state).toBe("failed");
		// Fallback has no siblings — everything is the gate.
		expect(gate.siblingFailures).toEqual([]);
	});

	it("respects a custom release workflow name", () => {
		const gate = decideReleaseGate([run("Release", "completed", "success", 10)], "Release");
		expect(gate.state).toBe("passed");
		expect(gate.usedFallback).toBe(false);
	});
});
