import { describe, expect, it } from "bun:test";
import { runEvalConcurrency } from "@veyyon/coding-agent/eval/concurrency-bridge";
import type { ToolSession } from "@veyyon/coding-agent/tools";
import { makeToolSession } from "../helpers/tool-session";

/**
 * runEvalConcurrency resolves the worker-pool ceiling for an eval cell's
 * parallel()/pipeline() helpers from the live `task.maxConcurrency` setting. It had
 * no test. The contract mirrors the `task` tool: 0 means unbounded, and any
 * negative or non-finite value collapses to 0 (unbounded) rather than throwing or
 * spawning a bogus pool size. A regression that let a negative or NaN through would
 * either crash the pool (Invalid array length) or silently cap fan-out at one. These
 * pin the normalization for every category of input the untyped setting can hold.
 */

function session(raw: unknown): ToolSession {
	return makeToolSession({ settings: { get: () => raw } });
}

describe("runEvalConcurrency", () => {
	it("passes through a positive integer ceiling", () => {
		expect(runEvalConcurrency(undefined, { session: session(8) })).toEqual({ limit: 8 });
	});

	it("keeps 0 (unbounded) as 0", () => {
		expect(runEvalConcurrency(undefined, { session: session(0) })).toEqual({ limit: 0 });
	});

	it("collapses a negative ceiling to 0 (unbounded)", () => {
		expect(runEvalConcurrency(undefined, { session: session(-5) })).toEqual({ limit: 0 });
	});

	it("truncates a fractional ceiling toward zero", () => {
		expect(runEvalConcurrency(undefined, { session: session(3.9) })).toEqual({ limit: 3 });
	});

	it("collapses NaN and Infinity to 0", () => {
		expect(runEvalConcurrency(undefined, { session: session(Number.NaN) })).toEqual({ limit: 0 });
		expect(runEvalConcurrency(undefined, { session: session(Number.POSITIVE_INFINITY) })).toEqual({ limit: 0 });
	});

	it("collapses a non-number setting value to 0", () => {
		expect(runEvalConcurrency(undefined, { session: session("5") })).toEqual({ limit: 0 });
		expect(runEvalConcurrency(undefined, { session: session(undefined) })).toEqual({ limit: 0 });
	});
});
