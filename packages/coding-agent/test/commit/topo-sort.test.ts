import { describe, expect, it } from "bun:test";
import type { SplitCommitGroup } from "@veyyon/coding-agent/commit/agentic/state";
import { computeDependencyOrder } from "@veyyon/coding-agent/commit/agentic/topo-sort";

/**
 * computeDependencyOrder topologically sorts a split-commit plan so a group's
 * declared dependencies land before it. It is Kahn's algorithm with three guards
 * that were untested: an out-of-range dependency index is rejected (not silently
 * dropped), a duplicate dependency edge is counted once (so in-degree stays
 * correct), and a cycle is reported as an error rather than yielding a truncated
 * order. A regression here would either commit groups in the wrong order (a build
 * that references code from a not-yet-applied commit) or silently drop the tail of
 * a cyclic plan. `dependencies: [0]` on group 1 means "group 1 depends on group 0",
 * so 0 must be ordered first.
 */

const g = (dependencies: number[]): SplitCommitGroup => ({ dependencies }) as SplitCommitGroup;

describe("computeDependencyOrder valid plans", () => {
	it("orders a linear chain so each dependency precedes its dependent", () => {
		expect(computeDependencyOrder([g([]), g([0]), g([1])])).toEqual([0, 1, 2]);
	});

	it("keeps independent groups in index order", () => {
		expect(computeDependencyOrder([g([]), g([]), g([])])).toEqual([0, 1, 2]);
	});

	it("orders a diamond so the shared root precedes both middles and the join is last", () => {
		expect(computeDependencyOrder([g([]), g([0]), g([0]), g([1, 2])])).toEqual([0, 1, 2, 3]);
	});

	it("returns an empty order for an empty plan", () => {
		expect(computeDependencyOrder([])).toEqual([]);
	});

	it("counts a duplicate dependency edge only once", () => {
		// If the duplicate inflated in-degree, group 1 would never reach 0 and the
		// plan would be misreported as cyclic.
		expect(computeDependencyOrder([g([]), g([0, 0])])).toEqual([0, 1]);
	});

	it("treats a missing dependencies field as no dependencies", () => {
		expect(computeDependencyOrder([{} as SplitCommitGroup, g([0])])).toEqual([0, 1]);
	});
});

describe("computeDependencyOrder rejected plans", () => {
	it("rejects a dependency index past the last group", () => {
		expect(computeDependencyOrder([g([5])])).toEqual({ error: "Invalid dependency index: 5" });
	});

	it("rejects a negative dependency index", () => {
		expect(computeDependencyOrder([g([-1])])).toEqual({ error: "Invalid dependency index: -1" });
	});

	it("reports a two-node cycle instead of a truncated order", () => {
		expect(computeDependencyOrder([g([1]), g([0])])).toEqual({
			error: "Circular dependency detected in split commit plan.",
		});
	});

	it("reports a self-dependency as a cycle", () => {
		expect(computeDependencyOrder([g([0])])).toEqual({
			error: "Circular dependency detected in split commit plan.",
		});
	});
});
