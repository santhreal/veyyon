/**
 * An ArkType node holds no closure for a member nothing has read.
 *
 * WHY THIS SUITE EXISTS. ArkType 0.56 allocated four members on every node it constructed: an
 * `assert` arrow, a `pipe` bound function carrying a bound `pipe.try`, a `rootApply` closure and an
 * `allows` closure. A tool parameter schema builds hundreds of nodes, and a launch builds about 1,600
 * of them, nearly all of which are only ever traversed as a child of another node and never asserted,
 * piped or called. `patches/@ark%2Fschema@0.56.2.patch` creates each of the four on first read and
 * caches it on the node, which halves the function cells a build retains per node.
 *
 * The class it closes: a closure ArkType allocates per node at construction. The census pins every
 * closure a node still holds as an own property once a build returns, by exact equality, so an
 * ArkType upgrade that drops the patch, or adds an eager member, turns this red until the set is
 * re-decided. The function cells the build retained per node are bounded below the unpatched count.
 * Every member the patch defers is read on schemas that select each of the four `rootApply`
 * strategies, in a jitless process as the CLI runs ArkType and in this compiling process, where the
 * scope assigns its compiled traversal over `allows`.
 *
 * WHAT IT DOES NOT CATCH: a per-node allocation that is not a function cell, such as an object or an
 * array, and a per-node closure stored somewhere other than an own property of the node that adds
 * less than one function cell per node.
 */

import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import * as path from "node:path";
import { exerciseLazyMembers, LAZY_MEMBERS, type LazyMemberBehaviour } from "./fixtures/arktype-lazy-members";
import type { NodeClosureReport } from "./fixtures/arktype-node-closures";

const FIXTURE = path.join(import.meta.dirname, "fixtures", "arktype-node-closures.ts");

function jitlessReport(): NodeClosureReport {
	const run = spawnSync(process.execPath, [FIXTURE], { encoding: "utf8" });
	if (run.status !== 0) throw new Error(`node closure fixture exited ${run.status}: ${run.stderr}`);
	return JSON.parse(run.stdout) as NodeClosureReport;
}

/** What every lazily created member does once read, in either validation mode. */
function expectMembersBehave(behaviour: LazyMemberBehaviour): void {
	expect(behaviour.strategies).toEqual(["allows", "optimistic", "branchedOptimistic", "contextual"]);
	expect(behaviour.detachedAssertReturns).toEqual({ id: "x" });
	expect(behaviour.detachedAssertThrows).toBe("id must be a string (was a number)");
	expect(behaviour.assertIsCached).toBe(true);
	expect(behaviour.objectApply).toEqual([{ id: "y", size: 2 }, true]);
	expect(behaviour.pipeResult).toEqual([4, true]);
	expect(behaviour.pipeTryResult).toEqual({ ok: true });
	expect(behaviour.pipeTryRejects).toBe(true);
	expect(behaviour.pipeIsCached).toBe(true);
	expect(behaviour.unionMorphs).toEqual([3, 8, true]);
	expect(behaviour.allows).toEqual([true, false]);
	expect(behaviour.contextualAllows).toEqual([true, false]);
	expect(behaviour.contextualApply).toEqual([3, true]);
	expect(behaviour.allowsReassignable).toBe(true);
	expect(behaviour.ownAfterRead).toEqual([...LAZY_MEMBERS]);
}

describe("an ArkType node holds no closure for a member nothing read", () => {
	const report = jitlessReport();

	it("leaves assert, pipe and rootApply off every node the build did not ask for them", () => {
		const { census } = report;
		expect(census.nodes).toBeGreaterThan(200);
		// The build pipes its own top-level node once, and parsing an optional key asks its value
		// node whether it allows `undefined`; nothing else reads a deferred member.
		expect(census.lazyMembersOwnAfterBuild.assert).toBe(0);
		expect(census.lazyMembersOwnAfterBuild.rootApply).toBe(0);
		expect(census.lazyMembersOwnAfterBuild.pipe).toBe(1);
		expect(census.lazyMembersOwnAfterBuild.allows).toBeLessThan(census.nodes / 4);
	});

	it("holds only the closures ArkType still allocates per node at construction", () => {
		expect(report.census.closureKeys).toEqual([
			"_traverse",
			"contextFreeMorph",
			"declaresKey",
			"lastMorph",
			"traverseAllows",
			"traverseApply",
			"traverseOptimistic",
		]);
	});

	it("retains fewer than five function cells per node it builds", () => {
		// Measured 4.49 with the patch and 8.96 without it, on this schema.
		expect(report.census.functionsPerNode).toBeLessThan(5);
	});

	it("creates each deferred member on first read in a jitless process", () => {
		expectMembersBehave(report.behaviour);
	});

	it("creates each deferred member on first read in a process that compiles validators", () => {
		expectMembersBehave(exerciseLazyMembers());
	});
});
