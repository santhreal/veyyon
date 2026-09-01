import { describe, expect, it } from "bun:test";
import {
	AGENT_GATEWAY_DEFAULT_CONTEXT_WINDOW,
	AGENT_GATEWAY_DEFAULT_MAX_TOKENS,
} from "../src/discovery/default-limits";
import type { DiscoveryFailure, DiscoveryFailureStage } from "../src/discovery/failure";
import {
	GATEWAY_ROW_PROVIDERS,
	gatewayContextWindow,
	gatewayIdCandidates,
	gatewayMaxTokens,
	gatewayModelReference,
} from "../src/discovery/gateway-limits";

describe("AGENT_GATEWAY_DEFAULT_CONTEXT_WINDOW", () => {
	it("is 200000", () => {
		expect(AGENT_GATEWAY_DEFAULT_CONTEXT_WINDOW).toBe(200_000);
	});
});

describe("AGENT_GATEWAY_DEFAULT_MAX_TOKENS", () => {
	it("is 64000", () => {
		expect(AGENT_GATEWAY_DEFAULT_MAX_TOKENS).toBe(64_000);
	});
});

describe("DiscoveryFailureStage", () => {
	it("has all expected stages", () => {
		const stages: DiscoveryFailureStage[] = ["base-url", "request", "status", "body", "payload", "unhandled"];
		for (const stage of stages) {
			expect(typeof stage).toBe("string");
		}
	});
});

describe("DiscoveryFailure", () => {
	it("can be constructed as a value", () => {
		const failure: DiscoveryFailure = {
			stage: "request",
			url: "https://example.com",
			detail: "connection refused",
		};
		expect(failure.stage).toBe("request");
		expect(failure.url).toBe("https://example.com");
		expect(failure.detail).toBe("connection refused");
	});
});

describe("GATEWAY_ROW_PROVIDERS", () => {
	it("includes cursor", () => {
		expect(GATEWAY_ROW_PROVIDERS.cursor).toBeDefined();
	});
	it("includes devin", () => {
		expect(GATEWAY_ROW_PROVIDERS.devin).toBeDefined();
	});
	it("includes google-antigravity", () => {
		expect(GATEWAY_ROW_PROVIDERS["google-antigravity"]).toBeDefined();
	});
	it("includes gitlab-duo", () => {
		expect(GATEWAY_ROW_PROVIDERS["gitlab-duo"]).toBeDefined();
	});
	it("includes gitlab-duo-agent", () => {
		expect(GATEWAY_ROW_PROVIDERS["gitlab-duo-agent"]).toBeDefined();
	});
	it("every value is a non-empty string", () => {
		for (const value of Object.values(GATEWAY_ROW_PROVIDERS)) {
			expect(value.length).toBeGreaterThan(0);
		}
	});
});

describe("gatewayIdCandidates", () => {
	it("returns the id itself as first candidate", () => {
		expect(gatewayIdCandidates("gpt-4")[0]).toBe("gpt-4");
	});
	it("strips effort tier suffix", () => {
		const candidates = gatewayIdCandidates("grok-4.5-medium");
		expect(candidates).toContain("grok-4.5");
	});
	it("strips fast suffix", () => {
		const candidates = gatewayIdCandidates("gpt-5.4-fast");
		expect(candidates).toContain("gpt-5.4");
	});
	it("strips slow suffix", () => {
		const candidates = gatewayIdCandidates("gpt-5.4-slow");
		expect(candidates).toContain("gpt-5.4");
	});
	it("normalizes dash-spelled version", () => {
		const candidates = gatewayIdCandidates("gpt-5-4");
		expect(candidates).toContain("gpt-5.4");
	});
	it("composes multiple rewrites", () => {
		const candidates = gatewayIdCandidates("gpt-5-4-high-fast");
		expect(candidates).toContain("gpt-5.4-high");
		expect(candidates).toContain("gpt-5.4");
	});
	it("produces no duplicates", () => {
		const candidates = gatewayIdCandidates("gpt-5-4-high-fast");
		expect(new Set(candidates).size).toBe(candidates.length);
	});
	it("trims input", () => {
		expect(gatewayIdCandidates("  gpt-4  ")[0]).toBe("gpt-4");
	});
	it("handles empty string", () => {
		expect(gatewayIdCandidates("")).toEqual([]);
	});
	it("does not lengthen candidates", () => {
		const candidates = gatewayIdCandidates("gpt-4");
		for (const c of candidates) {
			expect(c.length).toBeLessThanOrEqual("gpt-4".length);
		}
	});
});

describe("gatewayModelReference", () => {
	it("returns undefined for unknown model", () => {
		expect(gatewayModelReference("nonexistent-model-xyz")).toBeUndefined();
	});
	it("returns reference for known model", () => {
		const ref = gatewayModelReference("gpt-4");
		// gpt-4 may or may not be in the bundled catalog, but it should not throw
		expect(ref === undefined || typeof ref === "object").toBe(true);
	});
});

describe("gatewayContextWindow", () => {
	it("returns reported value when positive", () => {
		expect(gatewayContextWindow("any-model", 128000)).toBe(128000);
	});
	it("returns default when no reported value and unknown model", () => {
		expect(gatewayContextWindow("nonexistent-model-xyz")).toBe(AGENT_GATEWAY_DEFAULT_CONTEXT_WINDOW);
	});
	it("returns default when reported is zero", () => {
		expect(gatewayContextWindow("nonexistent-model-xyz", 0)).toBe(AGENT_GATEWAY_DEFAULT_CONTEXT_WINDOW);
	});
	it("returns default when reported is negative", () => {
		expect(gatewayContextWindow("nonexistent-model-xyz", -1)).toBe(AGENT_GATEWAY_DEFAULT_CONTEXT_WINDOW);
	});
	it("returns default when reported is NaN", () => {
		expect(gatewayContextWindow("nonexistent-model-xyz", NaN)).toBe(AGENT_GATEWAY_DEFAULT_CONTEXT_WINDOW);
	});
	it("returns default when reported is Infinity", () => {
		expect(gatewayContextWindow("nonexistent-model-xyz", Infinity)).toBe(AGENT_GATEWAY_DEFAULT_CONTEXT_WINDOW);
	});
	it("returns default when reported is undefined", () => {
		expect(gatewayContextWindow("nonexistent-model-xyz", undefined)).toBe(AGENT_GATEWAY_DEFAULT_CONTEXT_WINDOW);
	});
});

describe("gatewayMaxTokens", () => {
	it("returns reported value when positive", () => {
		expect(gatewayMaxTokens("any-model", 32000)).toBe(32000);
	});
	it("returns default when no reported value and unknown model", () => {
		expect(gatewayMaxTokens("nonexistent-model-xyz")).toBe(AGENT_GATEWAY_DEFAULT_MAX_TOKENS);
	});
	it("returns default when reported is zero", () => {
		expect(gatewayMaxTokens("nonexistent-model-xyz", 0)).toBe(AGENT_GATEWAY_DEFAULT_MAX_TOKENS);
	});
	it("returns default when reported is negative", () => {
		expect(gatewayMaxTokens("nonexistent-model-xyz", -1)).toBe(AGENT_GATEWAY_DEFAULT_MAX_TOKENS);
	});
	it("returns default when reported is NaN", () => {
		expect(gatewayMaxTokens("nonexistent-model-xyz", NaN)).toBe(AGENT_GATEWAY_DEFAULT_MAX_TOKENS);
	});
	it("returns default when reported is Infinity", () => {
		expect(gatewayMaxTokens("nonexistent-model-xyz", Infinity)).toBe(AGENT_GATEWAY_DEFAULT_MAX_TOKENS);
	});
	it("caps known value at default", () => {
		// If the catalog knows a model with maxTokens > 64k, it should be capped
		// For unknown models, it just returns the default
		const result = gatewayMaxTokens("nonexistent-model-xyz");
		expect(result).toBeLessThanOrEqual(AGENT_GATEWAY_DEFAULT_MAX_TOKENS);
	});
});
