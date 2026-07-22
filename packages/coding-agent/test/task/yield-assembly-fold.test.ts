import { describe, expect, it } from "bun:test";
import type { YieldItem } from "@veyyon/coding-agent/task/types";
import { assembleYieldResult } from "@veyyon/coding-agent/task/yield-assembly";

/**
 * assembleYieldResult folds a subagent's sequence of `yield` calls into the single payload that
 * output-schema validation then checks. It is pure and has several subtle, load-bearing rules that the
 * tool-level yield.test.ts exercises only indirectly through the running tool. Each rule here maps to a
 * concrete failure it prevents:
 *   - terminal detection scans BACKWARD for the last non-incremental (untyped or string-typed) yield;
 *     an array `type` is an incremental SECTION and never terminates on its own;
 *   - an explicit terminal payload (untyped final data, or a `type: "result"` finalize carrying data)
 *     is used VERBATIM and never wrapped under a label — the bug this exists to prevent nested a
 *     finalize object one level deep and made validation report every field missing;
 *   - incremental sections come only from array-typed yields; a repeated label promotes a single value
 *     into an array, and an array-valued label force-wraps even a lone value into a list;
 *   - a data-less terminal finalize keeps the accumulated sections; only with no sections at all does
 *     the last assistant turn become the raw result (rawText);
 *   - aborted yields are skipped, and schemaOverridden / missingData propagate from the folded items.
 * A regression in any of these corrupts what the caller receives back from a subagent run.
 */

function item(overrides: Partial<YieldItem>): YieldItem {
	return { ...overrides };
}

describe("assembleYieldResult terminal payloads", () => {
	it("returns undefined for no yields at all", () => {
		expect(assembleYieldResult([])).toBeUndefined();
	});

	it("uses an explicit terminal data payload verbatim, never wrapped in a section", () => {
		const result = assembleYieldResult([item({ type: "result", data: { a: 1 } })]);
		expect(result?.data).toEqual({ a: 1 });
		expect(result?.missingData).toBe(false);
		expect(result?.rawText).toBe(false);
	});

	it("lets an explicit terminal payload win over accumulated incremental sections", () => {
		// The string-typed `result` yield is terminal and carries data, so its object is the whole
		// result; the earlier ["findings"] section is discarded rather than nesting the finalize.
		const result = assembleYieldResult([
			item({ type: ["findings"], data: "f" }),
			item({ type: "result", data: { a: 1 } }),
		]);
		expect(result?.data).toEqual({ a: 1 });
	});

	it("marks missingData when the sole terminal yield has no data and no sections exist", () => {
		const result = assembleYieldResult([item({ data: undefined })]);
		expect(result?.data).toBeUndefined();
		expect(result?.missingData).toBe(true);
	});

	it("turns a data-less string-typed terminal into the raw last assistant turn", () => {
		// `type: "result"` with omitted data means "finish with the latest durable assistant text".
		const result = assembleYieldResult([item({ type: "result" })], "final-text");
		expect(result?.data).toBe("final-text");
		expect(result?.rawText).toBe(true);
		expect(result?.missingData).toBe(false);
	});
});

describe("assembleYieldResult incremental sections", () => {
	it("wraps a single array-typed yield under its label", () => {
		const result = assembleYieldResult([item({ type: ["findings"], data: "f" })]);
		expect(result?.data).toEqual({ findings: "f" });
		expect(result?.rawText).toBe(false);
	});

	it("promotes a repeated label from a single value into an ordered array", () => {
		const result = assembleYieldResult([
			item({ type: ["findings"], data: "a" }),
			item({ type: ["findings"], data: "b" }),
		]);
		expect(result?.data).toEqual({ findings: ["a", "b"] });
	});

	it("force-wraps a lone value into a list for an array-valued label", () => {
		const result = assembleYieldResult([item({ type: ["findings"], data: "a" })], undefined, new Set(["findings"]));
		expect(result?.data).toEqual({ findings: ["a"] });
	});

	it("keeps accumulated sections when the terminal finalize carries no data", () => {
		const result = assembleYieldResult(
			[item({ type: ["findings"], data: "f" }), item({ type: "result" })],
			"lastturn",
		);
		expect(result?.data).toEqual({ findings: "f" }); // NOT the "lastturn" text — sections win over raw
	});

	it("resolves a label with omitted data from the last assistant turn", () => {
		const result = assembleYieldResult([item({ type: ["notes"] })], "the-last-text");
		expect(result?.data).toEqual({ notes: "the-last-text" });
	});
});

describe("assembleYieldResult provenance flags", () => {
	it("skips aborted yields when folding sections", () => {
		const result = assembleYieldResult([
			item({ type: ["findings"], data: "a", status: "aborted" }),
			item({ type: ["findings"], data: "b" }),
		]);
		expect(result?.data).toEqual({ findings: "b" }); // the aborted "a" contributed nothing
	});

	it("propagates schemaOverridden from an incremental item", () => {
		const result = assembleYieldResult([item({ type: ["findings"], data: "a", schemaOverridden: true })]);
		expect(result?.schemaOverridden).toBe(true);
	});
});
