import { describe, expect, it } from "bun:test";
import { applyOpsToPhases } from "@veyyon/coding-agent/tools/todo";

/**
 * Todo init rejects duplicate phase names and duplicate task contents.
 */

describe("todo init duplicate adversarial", () => {
	it("duplicate phase names produce errors", () => {
		const { phases, errors } = applyOpsToPhases([], [
			{
				op: "init",
				list: [
					{ phase: "Same", items: ["a"] },
					{ phase: "Same", items: ["b"] },
				],
			},
		]);
		expect(errors.some(e => /duplicate phase/i.test(e))).toBe(true);
		// Still may construct phases; lock that errors are non-empty.
		expect(errors.length).toBeGreaterThan(0);
		expect(Array.isArray(phases)).toBe(true);
	});

	it("duplicate task contents across phases produce errors", () => {
		const { errors } = applyOpsToPhases([], [
			{
				op: "init",
				list: [
					{ phase: "A", items: ["shared"] },
					{ phase: "B", items: ["shared"] },
				],
			},
		]);
		expect(errors.some(e => /duplicate task/i.test(e))).toBe(true);
	});

	it("duplicate tasks within one phase produce errors", () => {
		const { errors } = applyOpsToPhases([], [
			{
				op: "init",
				list: [{ phase: "A", items: ["x", "x"] }],
			},
		]);
		expect(errors.some(e => /duplicate task/i.test(e))).toBe(true);
	});
});
