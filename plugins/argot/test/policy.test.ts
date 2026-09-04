import { describe, expect, test } from "bun:test";
import { type ArgotGate, EMPTY_GATE, makeGate, shouldEncode } from "../src/policy.js";

const OPUS = "anthropic/claude-opus-4";
const HAIKU = "anthropic/claude-haiku-4";

function gate(over: Partial<ArgotGate> = {}): ArgotGate {
	return { models: [OPUS], disableAboveTokens: 0, ...over };
}

describe("shouldEncode", () => {
	test("EMPTY_GATE encodes for nothing", () => {
		expect(shouldEncode(EMPTY_GATE, { model: OPUS, contextTokens: 0 })).toBe(false);
	});

	test("an empty model list never encodes, even for a small context", () => {
		expect(shouldEncode(gate({ models: [] }), { model: OPUS, contextTokens: 0 })).toBe(false);
	});

	test("encodes when the active model is on the allowlist", () => {
		expect(shouldEncode(gate(), { model: OPUS, contextTokens: 1000 })).toBe(true);
	});

	test("does not encode when the active model is off the allowlist", () => {
		expect(shouldEncode(gate(), { model: HAIKU, contextTokens: 1000 })).toBe(false);
	});

	test("model matching is exact and case-sensitive", () => {
		expect(
			shouldEncode(gate({ models: [OPUS.toUpperCase()] }), {
				model: OPUS,
				contextTokens: 0,
			}),
		).toBe(false);
	});

	test("a listed model among several encodes", () => {
		expect(
			shouldEncode(gate({ models: [HAIKU, OPUS] }), {
				model: OPUS,
				contextTokens: 0,
			}),
		).toBe(true);
	});

	describe("provider-qualified id matching", () => {
		// Runtime ids are `provider/model-id`; operators list either form.
		const QUALIFIED = "google-antigravity/gemini-2.5-flash";
		const BARE = "gemini-2.5-flash";

		test("a bare model name encodes for the provider-qualified active id", () => {
			expect(
				shouldEncode(gate({ models: [BARE] }), {
					model: QUALIFIED,
					contextTokens: 0,
				}),
			).toBe(true);
		});

		test("a bare name matches the same model under any provider", () => {
			expect(
				shouldEncode(gate({ models: [BARE] }), {
					model: "openrouter/gemini-2.5-flash",
					contextTokens: 0,
				}),
			).toBe(true);
		});

		test("a provider-qualified entry requires the provider: a bare active id does not satisfy it", () => {
			// The runtime active id is always provider-qualified; a qualified entry is
			// exact, so a provider-stripped id cannot confirm the provider and stays off.
			expect(
				shouldEncode(gate({ models: [QUALIFIED] }), {
					model: BARE,
					contextTokens: 0,
				}),
			).toBe(false);
		});

		test("an exact provider-qualified entry still encodes", () => {
			expect(
				shouldEncode(gate({ models: [QUALIFIED] }), {
					model: QUALIFIED,
					contextTokens: 0,
				}),
			).toBe(true);
		});

		test("a provider-qualified entry stays specific to its provider", () => {
			expect(
				shouldEncode(gate({ models: ["openrouter/gemini-2.5-flash"] }), {
					model: QUALIFIED,
					contextTokens: 0,
				}),
			).toBe(false);
		});

		test("a genuinely different model never encodes", () => {
			expect(
				shouldEncode(gate({ models: [BARE] }), {
					model: "google-antigravity/gemini-2.5-pro",
					contextTokens: 0,
				}),
			).toBe(false);
		});

		test("matching is not substring: a fragment never matches a longer id", () => {
			expect(
				shouldEncode(gate({ models: ["flash"] }), {
					model: QUALIFIED,
					contextTokens: 0,
				}),
			).toBe(false);
			expect(
				shouldEncode(gate({ models: ["2.5-flash"] }), {
					model: QUALIFIED,
					contextTokens: 0,
				}),
			).toBe(false);
		});
	});

	describe("context cutoff", () => {
		test("stops encoding at or above the cutoff", () => {
			const g = gate({ disableAboveTokens: 100_000 });
			expect(shouldEncode(g, { model: OPUS, contextTokens: 99_999 })).toBe(true);
			expect(shouldEncode(g, { model: OPUS, contextTokens: 100_000 })).toBe(false);
			expect(shouldEncode(g, { model: OPUS, contextTokens: 250_000 })).toBe(false);
		});

		test("a zero or negative cutoff disables the limit", () => {
			expect(
				shouldEncode(gate({ disableAboveTokens: 0 }), {
					model: OPUS,
					contextTokens: 9_000_000,
				}),
			).toBe(true);
			expect(
				shouldEncode(gate({ disableAboveTokens: -1 }), {
					model: OPUS,
					contextTokens: 9_000_000,
				}),
			).toBe(true);
		});

		test("the model gate is checked before the cutoff", () => {
			// A disallowed model never encodes regardless of a generous cutoff.
			expect(
				shouldEncode(gate({ disableAboveTokens: 1_000_000 }), {
					model: HAIKU,
					contextTokens: 0,
				}),
			).toBe(false);
		});
	});
});

// makeGate is the ONE constructor for a gate: every harness maps its on/off flag +
// settings through here rather than hand-building the {models, disableAboveTokens}
// literal, so a future gate field is added in one place instead of silently
// diverging across harnesses. These lock the mapping in both directions.
describe("makeGate", () => {
	test("disabled returns the shared inert EMPTY_GATE, ignoring any options", () => {
		// Even with a full allowlist and a cutoff, disabled is inert — and it is the
		// same object identity as EMPTY_GATE, so callers can compare against it.
		const gateOff = makeGate(false, { models: [OPUS], disableAboveTokens: 999 });
		expect(gateOff).toBe(EMPTY_GATE);
		expect(shouldEncode(gateOff, { model: OPUS, contextTokens: 0 })).toBe(false);
	});

	test("enabled carries the allowlist and cutoff through verbatim", () => {
		const built = makeGate(true, { models: [OPUS, HAIKU], disableAboveTokens: 50_000 });
		expect(built).toEqual({ models: [OPUS, HAIKU], disableAboveTokens: 50_000 });
	});

	test("enabled defaults omitted fields to their inert values", () => {
		// No models named -> empty allowlist -> still encodes nothing until one is set.
		const bare = makeGate(true);
		expect(bare).toEqual({ models: [], disableAboveTokens: 0 });
		expect(shouldEncode(bare, { model: OPUS, contextTokens: 0 })).toBe(false);
	});

	test("enabled with only models leaves the cutoff disabled (0)", () => {
		const built = makeGate(true, { models: [OPUS] });
		expect(built.disableAboveTokens).toBe(0);
		expect(shouldEncode(built, { model: OPUS, contextTokens: 10_000_000 })).toBe(true);
	});

	test("a built enabled gate feeds shouldEncode identically to a hand-built one", () => {
		const built = makeGate(true, { models: [OPUS], disableAboveTokens: 1000 });
		expect(shouldEncode(built, { model: OPUS, contextTokens: 999 })).toBe(true);
		expect(shouldEncode(built, { model: OPUS, contextTokens: 1000 })).toBe(false);
		expect(shouldEncode(built, { model: HAIKU, contextTokens: 0 })).toBe(false);
	});
});
