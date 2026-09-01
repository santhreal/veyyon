import { describe, expect, it } from "bun:test";
import { estimateCost, estimateTokens } from "../src/core/token-counter";

describe("estimateTokens", () => {
	it("returns positive number for non-empty text", () => {
		expect(estimateTokens("hello world")).toBeGreaterThan(0);
	});
	it("returns 0 for empty string", () => {
		expect(estimateTokens("")).toBe(0);
	});
	it("increases with longer text", () => {
		const short = estimateTokens("hello");
		const long = estimateTokens("hello ".repeat(100));
		expect(long).toBeGreaterThan(short);
	});
	it("is deterministic", () => {
		expect(estimateTokens("hello world")).toBe(estimateTokens("hello world"));
	});
});

describe("estimateCost", () => {
	it("returns cost estimate with all fields", () => {
		const result = estimateCost(1_000_000, "claude-sonnet-4");
		expect(result.tokens).toBe(1_000_000);
		expect(result.model).toBe("claude-sonnet-4");
		expect(result.cost_usd).toBe(3.0);
		expect(result.rate_per_1m).toBe(3.0);
	});
	it("uses claude-sonnet-4 as default model", () => {
		const result = estimateCost(1000);
		expect(result.model).toBe("claude-sonnet-4");
		expect(result.rate_per_1m).toBe(3.0);
	});
	it("calculates cost correctly for gpt-4o", () => {
		const result = estimateCost(1_000_000, "gpt-4o");
		expect(result.rate_per_1m).toBe(2.5);
		expect(result.cost_usd).toBe(2.5);
	});
	it("calculates cost correctly for gpt-4o-mini", () => {
		const result = estimateCost(1_000_000, "gpt-4o-mini");
		expect(result.rate_per_1m).toBe(0.15);
		expect(result.cost_usd).toBe(0.15);
	});
	it("calculates cost correctly for claude-haiku", () => {
		const result = estimateCost(1_000_000, "claude-haiku");
		expect(result.rate_per_1m).toBe(0.8);
		expect(result.cost_usd).toBe(0.8);
	});
	it("uses default rate for unknown model", () => {
		const result = estimateCost(1_000_000, "unknown-model");
		expect(result.rate_per_1m).toBe(3.0);
		expect(result.cost_usd).toBe(3.0);
	});
	it("returns 0 cost for 0 tokens", () => {
		const result = estimateCost(0);
		expect(result.cost_usd).toBe(0);
		expect(result.tokens).toBe(0);
	});
	it("rounds cost to 6 decimal places", () => {
		// 100 tokens at 3.0/1M = 0.0003
		const result = estimateCost(100, "claude-sonnet-4");
		expect(result.cost_usd).toBe(0.0003);
	});
	it("handles fractional tokens", () => {
		const result = estimateCost(500_000, "claude-sonnet-4");
		expect(result.cost_usd).toBe(1.5);
	});
});
