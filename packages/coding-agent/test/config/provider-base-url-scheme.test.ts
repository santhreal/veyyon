/**
 * Config load rejects a scheme-less provider or model baseUrl.
 *
 * `validateProviderConfiguration` runs at config load for a `models.yaml`
 * provider and again when an extension registers a provider at runtime. A
 * `baseUrl` like `localhost:11434` or `192.168.1.5:8080` is exactly what a
 * person hand-writes, passes the schema's non-empty check, and is then unusable:
 * `new URL()` either throws or parses to an empty hostname, so the request fails
 * and prefix KV-cache reuse silently never engages. This suite pins that the
 * validator rejects such a value here, at load, naming the provider (and the
 * model, when the override is at model level) and the correction, rather than
 * letting it surface as an opaque failure much later (Law 10).
 *
 * The scheme rule itself lives in one place, `baseUrlSchemeError` in
 * `@veyyon/catalog/hosts`, and is unit-tested there. These tests prove the
 * validator actually calls it on both the provider baseUrl and each model
 * baseUrl, and that a well-formed URL still passes.
 */
import { describe, expect, it } from "bun:test";
import {
	type ProviderValidationConfig,
	validateProviderConfiguration,
} from "@veyyon/coding-agent/config/models-config";

/** A minimal otherwise-valid provider with one model, so only baseUrl is under test. */
function providerWith(overrides: Partial<ProviderValidationConfig>): ProviderValidationConfig {
	return {
		apiKey: "sk-test",
		models: [{ id: "m1", api: "openai-completions" }],
		...overrides,
	};
}

describe("validateProviderConfiguration rejects a scheme-less baseUrl", () => {
	describe("at provider level", () => {
		it("throws on a loopback host written without a scheme", () => {
			// The classic local-server line. It would silently disable prefix caching.
			expect(() =>
				validateProviderConfiguration("localllama", providerWith({ baseUrl: "localhost:11434" }), "models-config"),
			).toThrow(/localhost:11434/);
		});

		it("names the provider so the operator knows which config line to fix", () => {
			// The error is the only bridge from the failure to the config file.
			expect(() =>
				validateProviderConfiguration("localllama", providerWith({ baseUrl: "192.168.1.5:8080" }), "models-config"),
			).toThrow(/Provider localllama/);
		});

		it("spells out the correction rather than only saying it is wrong", () => {
			let message = "";
			try {
				validateProviderConfiguration("localllama", providerWith({ baseUrl: "localhost:11434" }), "models-config");
			} catch (error) {
				message = String(error);
			}

			expect(message).toContain("http://localhost:11434");
			expect(message).toContain("https://localhost:11434");
		});

		it("accepts a provider baseUrl that has a scheme", () => {
			// The premise: without this every rejection test could pass by rejecting
			// every provider.
			expect(() =>
				validateProviderConfiguration(
					"localllama",
					providerWith({ baseUrl: "http://localhost:11434" }),
					"models-config",
				),
			).not.toThrow();
		});

		it("rejects the same value on the runtime-register path too", () => {
			// An extension registering a provider hits the same validator, so the
			// guard must not be specific to the file-load mode.
			expect(() =>
				validateProviderConfiguration(
					"ext",
					{ baseUrl: "localhost:11434", oauthConfigured: true, models: [{ id: "m1", api: "openai-completions" }] },
					"runtime-register",
				),
			).toThrow(/localhost:11434/);
		});
	});

	describe("at model level", () => {
		it("throws on a model that overrides baseUrl without a scheme", () => {
			// A model may point at its own host; the same rule has to reach it, or the
			// override becomes a silent hole in the check.
			expect(() =>
				validateProviderConfiguration(
					"p",
					{
						baseUrl: "http://localhost:11434",
						apiKey: "sk-test",
						models: [{ id: "special", api: "openai-completions", baseUrl: "192.168.1.9:9000" }],
					},
					"models-config",
				),
			).toThrow(/model special/);
		});

		it("names both the provider and the model in the message", () => {
			let message = "";
			try {
				validateProviderConfiguration(
					"p",
					{
						baseUrl: "http://localhost:11434",
						apiKey: "sk-test",
						models: [{ id: "special", api: "openai-completions", baseUrl: "192.168.1.9:9000" }],
					},
					"models-config",
				);
			} catch (error) {
				message = String(error);
			}

			expect(message).toContain("Provider p");
			expect(message).toContain("model special");
			expect(message).toContain("http://192.168.1.9:9000");
		});

		it("accepts a model baseUrl override that has a scheme", () => {
			expect(() =>
				validateProviderConfiguration(
					"p",
					{
						baseUrl: "http://localhost:11434",
						apiKey: "sk-test",
						models: [{ id: "special", api: "openai-completions", baseUrl: "http://192.168.1.9:9000" }],
					},
					"models-config",
				),
			).not.toThrow();
		});
	});
});
