import { describe, expect, it } from "bun:test";
import { cloneExperimentState, createExperimentState } from "@veyyon/coding-agent/autoresearch/state";
import type { ExperimentResult } from "@veyyon/coding-agent/autoresearch/types";

/**
 * cloneExperimentState produces the working copy the autoresearch runtime mutates while a run is in
 * flight, leaving the persisted/base state untouched until the run commits. Its whole value is deep
 * isolation: every nested container it lists (the results array and each result's metrics/modifiedPaths/
 * scopeDeviations/asi, plus secondaryMetrics, scopePaths, offLimits, constraints) must be an independent
 * copy, so mutating the clone can never leak back into the original. A shallow copy of any one of these
 * would silently corrupt the base state — the exact bug this test class exists to catch. Scalars must
 * still carry across unchanged.
 */

function result(overrides: Partial<ExperimentResult>): ExperimentResult {
	return {
		runNumber: 1,
		commit: "c",
		metric: 5,
		metrics: { lat: 10 },
		status: "keep",
		description: "d",
		timestamp: 0,
		segment: 0,
		confidence: null,
		modifiedPaths: ["a.ts"],
		scopeDeviations: ["dev"],
		justification: null,
		flagged: false,
		flaggedReason: null,
		...overrides,
	};
}

describe("cloneExperimentState deep isolation", () => {
	it("carries scalar fields across unchanged", () => {
		const state = createExperimentState();
		state.metricName = "latency";
		state.currentSegment = 3;
		state.name = "run-A";
		const clone = cloneExperimentState(state);
		expect(clone.metricName).toBe("latency");
		expect(clone.currentSegment).toBe(3);
		expect(clone.name).toBe("run-A");
	});

	it("isolates each result's nested metrics, path lists, and asi from the original", () => {
		const state = createExperimentState();
		state.results.push(result({ asi: { nested: { v: 1 } } as unknown as ExperimentResult["asi"] }));
		const clone = cloneExperimentState(state);

		const cloned = clone.results[0];
		if (!cloned) throw new Error("expected a cloned result");
		cloned.metrics.lat = 999;
		cloned.modifiedPaths.push("b.ts");
		cloned.scopeDeviations.push("dev2");
		(cloned.asi as unknown as { nested: { v: number } }).nested.v = 42;

		const source = state.results[0];
		if (!source) throw new Error("expected the source result");
		expect(source.metrics.lat).toBe(10); // not 999
		expect(source.modifiedPaths).toEqual(["a.ts"]); // no "b.ts"
		expect(source.scopeDeviations).toEqual(["dev"]); // no "dev2"
		expect((source.asi as unknown as { nested: { v: number } }).nested.v).toBe(1); // structuredClone kept it at 1
	});

	it("isolates the results array itself, so pushing to the clone does not grow the original", () => {
		const state = createExperimentState();
		state.results.push(result({}));
		const clone = cloneExperimentState(state);
		clone.results.push(result({ commit: "extra" }));
		expect(state.results).toHaveLength(1);
		expect(clone.results).toHaveLength(2);
	});

	it("isolates secondaryMetrics objects and the scope/offLimits/constraints arrays", () => {
		const state = createExperimentState();
		state.secondaryMetrics.push({ name: "mem", unit: "mb" });
		state.scopePaths.push("src/");
		state.offLimits.push("secrets/");
		state.constraints.push("no network");
		const clone = cloneExperimentState(state);

		const clonedMetric = clone.secondaryMetrics[0];
		if (!clonedMetric) throw new Error("expected a cloned secondary metric");
		clonedMetric.unit = "gb";
		clone.scopePaths.push("test/");
		clone.offLimits.push("more/");
		clone.constraints.push("no disk");

		expect(state.secondaryMetrics[0]?.unit).toBe("mb"); // not "gb"
		expect(state.scopePaths).toEqual(["src/"]);
		expect(state.offLimits).toEqual(["secrets/"]);
		expect(state.constraints).toEqual(["no network"]);
	});
});
