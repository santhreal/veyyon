import { describe, expect, it } from "bun:test";
import type { VariantSpecLike } from "../src/variant-collapse";
import { isVariantCollapsedSpec, stripEffortTierSuffix } from "../src/variant-collapse";

describe("stripEffortTierSuffix", () => {
	it("strips -minimal suffix", () => {
		expect(stripEffortTierSuffix("model-minimal")).toBe("model");
	});
	it("strips -low suffix", () => {
		expect(stripEffortTierSuffix("model-low")).toBe("model");
	});
	it("strips -medium suffix", () => {
		expect(stripEffortTierSuffix("model-medium")).toBe("model");
	});
	it("strips -high suffix", () => {
		expect(stripEffortTierSuffix("model-high")).toBe("model");
	});
	it("strips -xhigh suffix", () => {
		expect(stripEffortTierSuffix("model-xhigh")).toBe("model");
	});
	it("strips -max suffix", () => {
		expect(stripEffortTierSuffix("model-max")).toBe("model");
	});
	it("strips -none suffix", () => {
		expect(stripEffortTierSuffix("model-none")).toBe("model");
	});
	it("strips -thinking suffix", () => {
		expect(stripEffortTierSuffix("model-thinking")).toBe("model");
	});
	it("returns undefined when no tier suffix", () => {
		expect(stripEffortTierSuffix("model")).toBeUndefined();
	});
	it("returns undefined for non-suffix ending", () => {
		expect(stripEffortTierSuffix("model-mini")).toBeUndefined();
	});
	it("only strips the last suffix", () => {
		// "model-high-low" -> strips "-low" -> "model-high"
		expect(stripEffortTierSuffix("model-high-low")).toBe("model-high");
	});
	it("handles empty string", () => {
		expect(stripEffortTierSuffix("")).toBeUndefined();
	});
	it("handles id that is just a suffix", () => {
		expect(stripEffortTierSuffix("high")).toBeUndefined();
	});
});

describe("isVariantCollapsedSpec", () => {
	const makeSpec = (overrides: Record<string, unknown> = {}): VariantSpecLike =>
		({
			id: "test-model",
			provider: "test",
			api: "anthropic",
			...overrides,
		}) as unknown as VariantSpecLike;

	it("returns false for a plain spec without collapse markers", () => {
		expect(isVariantCollapsedSpec(makeSpec())).toBe(false);
	});
	it("returns true for a spec with thinking.effortRouting", () => {
		expect(
			isVariantCollapsedSpec(makeSpec({ thinking: { effortRouting: { off: "base", high: "base-thinking" } } })),
		).toBe(true);
	});
	it("returns false for spec with thinking but no effortRouting", () => {
		expect(isVariantCollapsedSpec(makeSpec({ thinking: { budget: 1000 } }))).toBe(false);
	});
	it("returns false for spec without requestModelId", () => {
		expect(isVariantCollapsedSpec(makeSpec())).toBe(false);
	});
});
