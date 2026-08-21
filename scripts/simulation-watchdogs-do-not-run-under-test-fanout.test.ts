/**
 * WHY: turn simulations use the product's real first-event and idle watchdogs.
 * Running eight scenarios in one Bun process made those 300 ms deadlines compete
 * for the same event loop and could turn scheduler contention into a false stream
 * timeout. The package remains in the workspace job, but its in-process fanout is
 * one. This does not control how many independent package commands the outer
 * runner starts; `testConcurrency` owns that separate bound.
 */
import { describe, expect, it } from "bun:test";
import { workspaceTestParallelism } from "./ci-test-ts";

describe("workspace package test parallelism", () => {
	it("keeps simulations sequential without slowing unrelated packages", () => {
		expect(workspaceTestParallelism("packages/simulations", 8)).toBe(1);
		expect(workspaceTestParallelism("packages/ai", 8)).toBe(8);
		expect(workspaceTestParallelism("packages/tui", 4)).toBe(4);
	});
});
