/**
 * A models config that still sets `remoteCompaction` is refused, not ignored.
 *
 * `remoteCompaction` configured provider-native compaction. That feature was
 * removed, and the config key outlived it: it was still declared on every model,
 * still merged through the provider to model override chain, and still shipped
 * in the generated catalog, while nothing read it. A user who set it got a
 * session whose compaction was not what their config said, with no way to tell.
 *
 * Deleting the key alone would not have fixed that. An undeclared key is dropped
 * before validation, so removing it outright turns a wrong config into a silent
 * no-op, which is the same defect wearing different clothes (Law 10). The key is
 * therefore still declared in the schema as opaque data, for the sole purpose of
 * surviving long enough to be refused here, by name, with the replacement named
 * too.
 *
 * These tests hold all three levels a config can carry it, the exact wording a
 * user has to act on, and — just as important — that a config without it still
 * loads, so the refusal cannot creep into the normal path.
 */
import { describe, expect, it } from "bun:test";
import {
	type ProviderValidationConfig,
	validateProviderConfiguration,
} from "@veyyon/coding-agent/config/models-config";

/** Otherwise valid, so only the retired key is ever under test. */
function providerWith(overrides: Partial<ProviderValidationConfig>): ProviderValidationConfig {
	return {
		baseUrl: "https://api.example.com/v1",
		apiKey: "sk-test",
		models: [{ id: "m1", api: "openai-completions" }],
		...overrides,
	};
}

const RETIRED = { enabled: true, endpoint: "https://api.example.com/v1/compact" };

describe("a provider-level remoteCompaction", () => {
	it("is refused at config load", () => {
		expect(() =>
			validateProviderConfiguration("acme", providerWith({ remoteCompaction: RETIRED }), "models-config"),
		).toThrow(/"remoteCompaction" is retired and does nothing/);
	});

	it("names the provider, so a multi-provider config says which one to edit", () => {
		expect(() =>
			validateProviderConfiguration("acme", providerWith({ remoteCompaction: RETIRED }), "models-config"),
		).toThrow(/Provider acme:/);
	});

	it("names what to use instead, so the message is actionable", () => {
		// An error that only says "this is gone" leaves the user stuck. Both
		// replacements are named: the per-model key and the setting.
		expect(() =>
			validateProviderConfiguration("acme", providerWith({ remoteCompaction: RETIRED }), "models-config"),
		).toThrow(/compactionModel/);
		expect(() =>
			validateProviderConfiguration("acme", providerWith({ remoteCompaction: RETIRED }), "models-config"),
		).toThrow(/compaction\.model/);
	});

	it("is refused for a runtime provider registration too", () => {
		// An extension registering a provider goes through the same validator, and
		// the same dead key would be just as invisible there.
		expect(() =>
			validateProviderConfiguration("acme", providerWith({ remoteCompaction: RETIRED }), "runtime-register"),
		).toThrow(/retired/);
	});

	it("is refused even when it is the only thing the provider declares", () => {
		// The shape that used to be accepted as sufficient configuration on its own:
		// `remoteCompaction` was one of the keys that satisfied "a provider must
		// specify something". It no longer counts, and the message must be the
		// retirement rather than the generic "must specify" complaint.
		expect(() =>
			validateProviderConfiguration(
				"acme",
				{ models: [], remoteCompaction: RETIRED } as ProviderValidationConfig,
				"models-config",
			),
		).toThrow(/retired/);
	});
});

describe("a model-level remoteCompaction", () => {
	it("is refused and names the model", () => {
		expect(() =>
			validateProviderConfiguration(
				"acme",
				providerWith({ models: [{ id: "gpt-5.5", api: "openai-responses", remoteCompaction: RETIRED }] }),
				"models-config",
			),
		).toThrow(/Provider acme, model gpt-5\.5:/);
	});

	it("is refused even when other models are clean", () => {
		// The loop must not stop at the first clean model.
		expect(() =>
			validateProviderConfiguration(
				"acme",
				providerWith({
					models: [
						{ id: "clean", api: "openai-responses" },
						{ id: "dirty", api: "openai-responses", remoteCompaction: RETIRED },
					],
				}),
				"models-config",
			),
		).toThrow(/model dirty/);
	});
});

describe("a modelOverrides remoteCompaction", () => {
	it("is refused and names the override key", () => {
		expect(() =>
			validateProviderConfiguration(
				"acme",
				providerWith({ modelOverrides: { "gpt-5.5": { remoteCompaction: RETIRED } } }),
				"models-config",
			),
		).toThrow(/modelOverrides\.gpt-5\.5:/);
	});

	// KEPT as an absence-of-throw contract: the modelOverrides loop reads one key
	// out of an opaque object, so a refusal keyed on the object being present
	// rather than on the key would reject every override anyone has ever written.
	it("accepts an override that carries anything else", () => {
		expect(() =>
			validateProviderConfiguration(
				"acme",
				providerWith({ modelOverrides: { "gpt-5.5": { contextWindow: 200_000 } } }),
				"models-config",
			),
		).not.toThrow();
	});
});

describe("a config without the retired key", () => {
	/**
	 * KEPT, both of them, as absence-of-throw contracts. This is the config-load
	 * path: a refusal that fired on everything would satisfy every test above
	 * while refusing every real config, so the session would not start at all.
	 */
	it("still validates", () => {
		expect(() => validateProviderConfiguration("acme", providerWith({}), "models-config")).not.toThrow();
	});

	it("still validates when the key is present but undefined", () => {
		// YAML round-trips and spread merges both produce this shape, and it carries
		// no user intent, so it must not be treated as the retired key being set.
		expect(() =>
			validateProviderConfiguration("acme", providerWith({ remoteCompaction: undefined }), "models-config"),
		).not.toThrow();
	});
});
