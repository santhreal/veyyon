import { describe, expect, it } from "bun:test";
import { getProviderDetails } from "@veyyon/ai/provider-details";
import type { Api, Model } from "@veyyon/ai/types";
import { buildModel } from "@veyyon/catalog/build";

// getProviderDetails renders the model's baseUrl as an "Endpoint" field via the
// private formatEndpoint normalizer. That normalizer strips EVERY trailing slash
// (trimTrailingSlashes) so a doubled-slash baseUrl collapses to the same endpoint
// as its single-slash form — the divergence the shared owner exists to kill.
function endpointFor(baseUrl: string): string {
	const model = buildModel({
		id: "test-model",
		name: "Test Model",
		api: "anthropic-messages" as Api,
		provider: "anthropic",
		baseUrl,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200000,
		maxTokens: 8192,
	}) as Model<Api>;
	const field = getProviderDetails({ model }).fields.find(f => f.label === "Endpoint");
	if (!field) throw new Error("Endpoint field missing from provider details");
	return field.value;
}

describe("getProviderDetails endpoint normalization", () => {
	it("collapses a doubled trailing slash in the path to no trailing slash", () => {
		// The regression: strip-one left "/v1/" here; strip-all yields "/v1".
		expect(endpointFor("https://api.example.com/v1//")).toBe("https://api.example.com/v1");
		expect(endpointFor("https://api.example.com/v1///")).toBe("https://api.example.com/v1");
	});

	it("strips a single trailing slash from the path", () => {
		expect(endpointFor("https://api.example.com/v1/")).toBe("https://api.example.com/v1");
	});

	it("keeps a root-only baseUrl as a bare '/'", () => {
		// pathname is "/", which trims to "" and falls back to "/".
		expect(endpointFor("https://api.example.com/")).toBe("https://api.example.com/");
		expect(endpointFor("https://api.example.com//")).toBe("https://api.example.com/");
	});

	it("leaves interior slashes and a slashless path untouched", () => {
		expect(endpointFor("https://api.example.com/v1/models")).toBe("https://api.example.com/v1/models");
	});

	it("returns an unparseable baseUrl verbatim", () => {
		expect(endpointFor("not-a-url")).toBe("not-a-url");
	});
});
