import { describe, expect, it } from "bun:test";
import { parseClaudeRateLimitHeaders } from "../src/usage/claude";

describe("parseClaudeRateLimitHeaders", () => {
	it("returns null for empty headers", () => {
		expect(parseClaudeRateLimitHeaders({}, 1000)).toBeNull();
	});
	it("returns null for unrelated headers", () => {
		expect(parseClaudeRateLimitHeaders({ "content-type": "application/json" }, 1000)).toBeNull();
	});
	it("parses 5h utilization header", () => {
		const result = parseClaudeRateLimitHeaders({ "anthropic-ratelimit-unified-5h-utilization": "0.5" }, 1000);
		expect(result).not.toBeNull();
		expect(result!.limits.length).toBe(1);
		expect(result!.limits[0]!.id).toBe("anthropic:5h");
		expect(result!.limits[0]!.amount.usedFraction).toBe(0.5);
	});
	it("parses 7d utilization header", () => {
		const result = parseClaudeRateLimitHeaders({ "anthropic-ratelimit-unified-7d-utilization": "0.8" }, 1000);
		expect(result).not.toBeNull();
		expect(result!.limits.length).toBe(1);
		expect(result!.limits[0]!.id).toBe("anthropic:7d");
	});
	it("parses 7d_oi utilization header", () => {
		const result = parseClaudeRateLimitHeaders({ "anthropic-ratelimit-unified-7d_oi-utilization": "0.3" }, 1000);
		expect(result).not.toBeNull();
		expect(result!.limits.length).toBe(1);
		expect(result!.limits[0]!.id).toBe("anthropic:7d:fable");
	});
	it("parses all three windows simultaneously", () => {
		const result = parseClaudeRateLimitHeaders(
			{
				"anthropic-ratelimit-unified-5h-utilization": "0.5",
				"anthropic-ratelimit-unified-7d-utilization": "0.8",
				"anthropic-ratelimit-unified-7d_oi-utilization": "0.3",
			},
			1000,
		);
		expect(result).not.toBeNull();
		expect(result!.limits.length).toBe(3);
	});
	it("parses reset header alongside utilization", () => {
		const result = parseClaudeRateLimitHeaders(
			{
				"anthropic-ratelimit-unified-5h-utilization": "0.5",
				"anthropic-ratelimit-unified-5h-reset": "3600",
			},
			1000,
		);
		expect(result).not.toBeNull();
		expect(result!.limits[0]!.window.resetsAt).toBe(3600000);
	});
	it("ignores reset of 0", () => {
		const result = parseClaudeRateLimitHeaders({ "anthropic-ratelimit-unified-5h-reset": "0" }, 1000);
		expect(result).toBeNull();
	});
	it("ignores reset of negative", () => {
		const result = parseClaudeRateLimitHeaders({ "anthropic-ratelimit-unified-5h-reset": "-1" }, 1000);
		expect(result).toBeNull();
	});
	it("sets fetchedAt to now", () => {
		const result = parseClaudeRateLimitHeaders({ "anthropic-ratelimit-unified-5h-utilization": "0.5" }, 12345);
		expect(result!.fetchedAt).toBe(12345);
	});
	it("sets provider to anthropic", () => {
		const result = parseClaudeRateLimitHeaders({ "anthropic-ratelimit-unified-5h-utilization": "0.5" }, 1000);
		expect(result!.provider).toBe("anthropic");
	});
	it("sets metadata source to ratelimit-headers", () => {
		const result = parseClaudeRateLimitHeaders({ "anthropic-ratelimit-unified-5h-utilization": "0.5" }, 1000);
		expect(result!.metadata?.source).toBe("ratelimit-headers");
	});
	it("sets status to ok for low utilization", () => {
		const result = parseClaudeRateLimitHeaders({ "anthropic-ratelimit-unified-5h-utilization": "0.1" }, 1000);
		expect(result!.limits[0]!.status).toBe("ok");
	});
	it("sets status to warning at 0.9", () => {
		const result = parseClaudeRateLimitHeaders({ "anthropic-ratelimit-unified-5h-utilization": "0.9" }, 1000);
		expect(result!.limits[0]!.status).toBe("warning");
	});
	it("sets status to exhausted at 1.0", () => {
		const result = parseClaudeRateLimitHeaders({ "anthropic-ratelimit-unified-5h-utilization": "1.0" }, 1000);
		expect(result!.limits[0]!.status).toBe("exhausted");
	});
	it("5h limit is shared", () => {
		const result = parseClaudeRateLimitHeaders({ "anthropic-ratelimit-unified-5h-utilization": "0.5" }, 1000);
		expect(result!.limits[0]!.scope.shared).toBe(true);
	});
	it("7d limit is shared", () => {
		const result = parseClaudeRateLimitHeaders({ "anthropic-ratelimit-unified-7d-utilization": "0.5" }, 1000);
		expect(result!.limits[0]!.scope.shared).toBe(true);
	});
	it("7d_oi limit has tier fable", () => {
		const result = parseClaudeRateLimitHeaders({ "anthropic-ratelimit-unified-7d_oi-utilization": "0.5" }, 1000);
		expect(result!.limits[0]!.scope.tier).toBe("fable");
	});
	it("7d_oi limit is not shared", () => {
		const result = parseClaudeRateLimitHeaders({ "anthropic-ratelimit-unified-7d_oi-utilization": "0.5" }, 1000);
		expect(result!.limits[0]!.scope.shared).toBeUndefined();
	});
	it("window durationMs is 5h for 5h window", () => {
		const result = parseClaudeRateLimitHeaders({ "anthropic-ratelimit-unified-5h-utilization": "0.5" }, 1000);
		expect(result!.limits[0]!.window.durationMs).toBe(5 * 60 * 60 * 1000);
	});
	it("window durationMs is 7d for 7d window", () => {
		const result = parseClaudeRateLimitHeaders({ "anthropic-ratelimit-unified-7d-utilization": "0.5" }, 1000);
		expect(result!.limits[0]!.window.durationMs).toBe(7 * 24 * 60 * 60 * 1000);
	});
});
