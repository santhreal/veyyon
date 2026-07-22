/**
 * The argot encode gate as veyyon composes it: settings map to an {@link ArgotGate}
 * through {@link buildArgotGate} (the one home for that mapping), and the SDK's
 * {@link shouldEncode} predicate decides whether this turn teaches shorthand.
 * Decoding is unconditional and never consults the gate, so every case here is
 * about ENCODING only: the worst outcome of a closed gate is that the model
 * writes full text, never a leaked handle.
 */

import { describe, expect, it } from "bun:test";
import { buildArgotGate } from "@veyyon/coding-agent/argot-wire";
import { EMPTY_GATE, shouldEncode } from "argot";

const MODEL = "anthropic/claude-opus-4";
const OTHER = "anthropic/claude-haiku-4";

// The default `argot.disableAboveTokens` setting is -1 (the "Off" sentinel):
// no cutoff, so encoding is governed purely by the model allowlist.
const NO_CUTOFF = -1;

describe("buildArgotGate", () => {
	it("is the inert EMPTY_GATE when the feature is off, whatever the other settings say", () => {
		const gate = buildArgotGate(false, [MODEL], 200_000);
		expect(gate).toBe(EMPTY_GATE);
		expect(shouldEncode(gate, { model: MODEL, contextTokens: 0 })).toBe(false);
	});

	it("carries the model allowlist and cutoff verbatim when the feature is on", () => {
		const gate = buildArgotGate(true, [MODEL, OTHER], 200_000);
		expect(gate.models).toEqual([MODEL, OTHER]);
		expect(gate.disableAboveTokens).toBe(200_000);
	});

	it("keeps an empty allowlist empty (no model encodes until one is added)", () => {
		const gate = buildArgotGate(true, [], NO_CUTOFF);
		expect(gate.models).toEqual([]);
		expect(shouldEncode(gate, { model: MODEL, contextTokens: 0 })).toBe(false);
	});
});

describe("the settings -> gate -> encode contract", () => {
	it("never encodes while the feature is off", () => {
		const gate = buildArgotGate(false, [MODEL], NO_CUTOFF);
		expect(shouldEncode(gate, { model: MODEL, contextTokens: 0 })).toBe(false);
		expect(shouldEncode(gate, { model: MODEL, contextTokens: 5_000_000 })).toBe(false);
	});

	it("never encodes with the feature on but an empty allowlist", () => {
		const gate = buildArgotGate(true, [], NO_CUTOFF);
		expect(shouldEncode(gate, { model: MODEL, contextTokens: 0 })).toBe(false);
	});

	it("encodes only for a listed model", () => {
		const gate = buildArgotGate(true, [MODEL], NO_CUTOFF);
		expect(shouldEncode(gate, { model: MODEL, contextTokens: 0 })).toBe(true);
		expect(shouldEncode(gate, { model: OTHER, contextTokens: 0 })).toBe(false);
	});

	it("matches model names exactly and case-sensitively", () => {
		const gate = buildArgotGate(true, [MODEL], NO_CUTOFF);
		expect(shouldEncode(gate, { model: MODEL.toUpperCase(), contextTokens: 0 })).toBe(false);
		expect(shouldEncode(gate, { model: `${MODEL}-20250101`, contextTokens: 0 })).toBe(false);
	});

	// The runtime model id is provider-qualified (`provider/model-id`), but an
	// operator naturally writes the bare model name in argot.models. Without this
	// the feature silently no-ops for the setting a user would actually type.
	it("encodes for a provider-qualified active id when the operator listed the bare model name", () => {
		const gate = buildArgotGate(true, ["gemini-2.5-flash"], NO_CUTOFF);
		expect(shouldEncode(gate, { model: "google-antigravity/gemini-2.5-flash", contextTokens: 0 })).toBe(true);
		expect(shouldEncode(gate, { model: "openrouter/gemini-2.5-flash", contextTokens: 0 })).toBe(true);
	});

	it("keeps a provider-qualified allowlist entry specific to its provider", () => {
		const gate = buildArgotGate(true, ["openrouter/gemini-2.5-flash"], NO_CUTOFF);
		expect(shouldEncode(gate, { model: "openrouter/gemini-2.5-flash", contextTokens: 0 })).toBe(true);
		expect(shouldEncode(gate, { model: "google-antigravity/gemini-2.5-flash", contextTokens: 0 })).toBe(false);
	});

	it("does not match on a substring of the model name", () => {
		const gate = buildArgotGate(true, ["flash"], NO_CUTOFF);
		expect(shouldEncode(gate, { model: "google-antigravity/gemini-2.5-flash", contextTokens: 0 })).toBe(false);
	});

	it("with the default -1 cutoff, a listed model encodes at any context size", () => {
		// -1 is the "Off" sentinel: shouldEncode treats a non-positive cutoff as no
		// cutoff, so gating is model-only. sdk.ts also skips the turn_end usage
		// subscription when disableAboveTokens is not > 0, so contextTokens stays 0.
		const gate = buildArgotGate(true, [MODEL], NO_CUTOFF);
		expect(gate.disableAboveTokens).toBe(-1);
		expect(shouldEncode(gate, { model: MODEL, contextTokens: 0 })).toBe(true);
		expect(shouldEncode(gate, { model: MODEL, contextTokens: 900_000 })).toBe(true);
	});

	it("with a positive cutoff, encoding stops at or above the threshold", () => {
		const gate = buildArgotGate(true, [MODEL], 200_000);
		expect(shouldEncode(gate, { model: MODEL, contextTokens: 0 })).toBe(true);
		expect(shouldEncode(gate, { model: MODEL, contextTokens: 199_999 })).toBe(true);
		expect(shouldEncode(gate, { model: MODEL, contextTokens: 200_000 })).toBe(false);
		expect(shouldEncode(gate, { model: MODEL, contextTokens: 200_001 })).toBe(false);
	});

	it("checks the model before the cutoff: an unlisted model never encodes, even in a small context", () => {
		const gate = buildArgotGate(true, [MODEL], 200_000);
		expect(shouldEncode(gate, { model: OTHER, contextTokens: 0 })).toBe(false);
	});
});
