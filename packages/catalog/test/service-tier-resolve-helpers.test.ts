import { describe, expect, it } from "bun:test";
import {
	getPriorityPremiumRequests,
	realizesPriorityServiceTier,
	resolveModelServiceTier,
	serviceTierFamily,
	shouldSendServiceTier,
} from "../src/provider-models/service-tier";
import type { Api, Model } from "../src/types";

function makeModel(provider: string, api: Api, id: string): Pick<Model, "provider" | "api" | "id"> {
	return { provider, api, id };
}

describe("serviceTierFamily", () => {
	it("returns anthropic for anthropic-messages api", () => {
		expect(serviceTierFamily(makeModel("anthropic", "anthropic-messages", "claude-sonnet"))).toBe("anthropic");
	});
	it("returns openai for openai relay model", () => {
		expect(serviceTierFamily(makeModel("openai", "openai-responses", "gpt-4o"))).toBe("openai");
	});
	it("returns undefined for unknown provider and api", () => {
		expect(serviceTierFamily(makeModel("unknown", "unknown", "some-model"))).toBeUndefined();
	});
	it("returns anthropic for namespaced anthropic model", () => {
		expect(serviceTierFamily(makeModel("openrouter", "anthropic-messages", "anthropic/claude-sonnet"))).toBe(
			"anthropic",
		);
	});
	it("returns openai for namespaced openai model", () => {
		expect(serviceTierFamily(makeModel("openrouter", "openai-responses", "openai/gpt-4o"))).toBe("openai");
	});
	it("returns google for namespaced google model", () => {
		expect(serviceTierFamily(makeModel("openrouter", "google-genai", "google/gemini-pro"))).toBe("google");
	});
});

describe("resolveModelServiceTier", () => {
	it("returns undefined for null tiers", () => {
		expect(resolveModelServiceTier(null, makeModel("anthropic", "anthropic-messages", "claude"))).toBeUndefined();
	});
	it("returns undefined for undefined tiers", () => {
		expect(
			resolveModelServiceTier(undefined, makeModel("anthropic", "anthropic-messages", "claude")),
		).toBeUndefined();
	});
	it("returns tier for matching family", () => {
		const model = makeModel("anthropic", "anthropic-messages", "claude");
		expect(resolveModelServiceTier({ anthropic: "priority" }, model)).toBe("priority");
	});
	it("returns undefined when family not in tiers", () => {
		const model = makeModel("anthropic", "anthropic-messages", "claude");
		expect(resolveModelServiceTier({ openai: "auto" }, model)).toBeUndefined();
	});
	it("returns tier for openai family", () => {
		const model = makeModel("openai", "openai-responses", "gpt-4o");
		expect(resolveModelServiceTier({ openai: "auto" }, model)).toBe("auto");
	});
});

describe("shouldSendServiceTier", () => {
	it("returns false for null service tier", () => {
		expect(shouldSendServiceTier(null, "anthropic")).toBe(false);
	});
	it("returns false for undefined service tier", () => {
		expect(shouldSendServiceTier(undefined, "anthropic")).toBe(false);
	});
	it("returns false for unknown provider string", () => {
		expect(shouldSendServiceTier("priority", "unknown-provider")).toBe(false);
	});
	it("returns false for unknown provider model", () => {
		expect(shouldSendServiceTier("priority", makeModel("unknown", "unknown", "model"))).toBe(false);
	});
});

describe("realizesPriorityServiceTier", () => {
	it("returns false for non-priority tier", () => {
		expect(realizesPriorityServiceTier("auto", makeModel("anthropic", "anthropic-messages", "claude"))).toBe(false);
	});
	it("returns false for null tier", () => {
		expect(realizesPriorityServiceTier(null, makeModel("anthropic", "anthropic-messages", "claude"))).toBe(false);
	});
	it("returns false for undefined tier", () => {
		expect(realizesPriorityServiceTier(undefined, makeModel("anthropic", "anthropic-messages", "claude"))).toBe(
			false,
		);
	});
});

describe("getPriorityPremiumRequests", () => {
	it("returns 0 for non-priority tier", () => {
		expect(getPriorityPremiumRequests("auto", makeModel("anthropic", "anthropic-messages", "claude"))).toBe(0);
	});
	it("returns 0 for null tier", () => {
		expect(getPriorityPremiumRequests(null, makeModel("anthropic", "anthropic-messages", "claude"))).toBe(0);
	});
	it("returns 0 for undefined tier", () => {
		expect(getPriorityPremiumRequests(undefined, makeModel("anthropic", "anthropic-messages", "claude"))).toBe(0);
	});
	it("returns 0 for unknown provider with priority", () => {
		expect(getPriorityPremiumRequests("priority", makeModel("unknown", "unknown", "model"))).toBe(0);
	});
});
