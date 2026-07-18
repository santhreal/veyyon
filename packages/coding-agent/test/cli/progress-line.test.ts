import { describe, expect, it } from "bun:test";
import { makeCoarseStepPrinter } from "@veyyon/coding-agent/cli/progress-line";

// Non-TTY progress degradation: `veyyon say hello 2>log` used to write
// thousands of `\r`-rewrite frames into the redirected log; the coarse step
// printer bounds output to one line per key per 25% step.

describe("makeCoarseStepPrinter", () => {
	it("prints one line per 25% step per key, never repeating a step", () => {
		const lines: string[] = [];
		const print = makeCoarseStepPrinter(line => lines.push(line));
		for (let pct = 0; pct <= 100; pct += 1) print("downloading model.onnx", pct);
		expect(lines).toEqual([
			"downloading model.onnx (0%)",
			"downloading model.onnx (25%)",
			"downloading model.onnx (50%)",
			"downloading model.onnx (75%)",
			"downloading model.onnx (100%)",
		]);
	});

	it("tracks keys independently so interleaved files each get their own steps", () => {
		const lines: string[] = [];
		const print = makeCoarseStepPrinter(line => lines.push(line));
		print("a", 0);
		print("b", 0);
		print("a", 30);
		print("b", 10);
		print("a", 30);
		expect(lines).toEqual(["a (0%)", "b (0%)", "a (25%)"]);
	});

	it("a key without a percent prints once (stage lines), then stays quiet", () => {
		const lines: string[] = [];
		const print = makeCoarseStepPrinter(line => lines.push(line));
		print("resolving deps");
		print("resolving deps");
		print("resolving deps");
		expect(lines).toEqual(["resolving deps"]);
	});

	it("honors a custom step size", () => {
		const lines: string[] = [];
		const print = makeCoarseStepPrinter(line => lines.push(line), 50);
		for (let pct = 0; pct <= 100; pct += 10) print("x", pct);
		expect(lines).toEqual(["x (0%)", "x (50%)", "x (100%)"]);
	});
});
