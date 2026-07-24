/**
 * Proves the encode-arm treatment-applies guard. The bug it locks out is a
 * silent one: an arm labelled "full encode" (argot on, non-empty allowlist) run
 * against a `--model` its allowlist does not name. argot's gate then returns "do
 * not encode", so the arm quietly measures the decode-only condition while the
 * report calls it encode. A green benchmark that is secretly comparing a
 * condition to itself is worse than a red one, so the runner must refuse to
 * launch the arm, and this suite is what keeps that refusal wired to argot's own
 * matching rule (never a re-implemented copy that could drift).
 */

import { describe, expect, test } from "bun:test";
import { encodeArmModelMismatch } from "./treatment-guard";

const MODEL = "google-antigravity/gemini-3.6-flash";

describe("encodeArmModelMismatch — arms that are sound (returns null)", () => {
	test("returns null when the config is not an object", () => {
		// A YAML file that parses to a scalar or array has no argot block to check;
		// the fingerprint/YAML-shape guards handle malformed configs, not this one.
		expect(encodeArmModelMismatch(null, MODEL)).toBeNull();
		expect(encodeArmModelMismatch("nope", MODEL)).toBeNull();
		expect(encodeArmModelMismatch([1, 2], MODEL)).toBeNull();
	});

	test("returns null when there is no argot block", () => {
		expect(encodeArmModelMismatch({ other: true }, MODEL)).toBeNull();
	});

	test("returns null when argot.enabled is not exactly true (encoding is off)", () => {
		// baseline.yml is `argot.enabled: false`. Encoding off means the allowlist,
		// if any, is inert, so there is no treatment to fail to apply.
		expect(encodeArmModelMismatch({ argot: { enabled: false } }, MODEL)).toBeNull();
		expect(encodeArmModelMismatch({ argot: { enabled: false, models: ["other-model"] } }, MODEL)).toBeNull();
		expect(encodeArmModelMismatch({ argot: {} }, MODEL)).toBeNull();
	});

	test("returns null for the decode-only arm (enabled, empty/absent allowlist)", () => {
		// decode.yml is `enabled: true, models: []` on purpose: the codec loads but
		// nothing encodes. That is a real, intended condition, NOT a silent degrade,
		// so the guard must let it through.
		expect(encodeArmModelMismatch({ argot: { enabled: true, models: [] } }, MODEL)).toBeNull();
		expect(encodeArmModelMismatch({ argot: { enabled: true } }, MODEL)).toBeNull();
	});

	test("returns null when a bare allowlist entry matches the model's last segment", () => {
		// full.yml lists bare names like `gemini-3.6-flash`; argot treats a bare
		// entry as a provider wildcard matching the id segment after the last slash,
		// so it DOES apply to `google-antigravity/gemini-3.6-flash`.
		const config = { argot: { enabled: true, models: ["gemini-2.5-flash", "gemini-3.6-flash"] } };
		expect(encodeArmModelMismatch(config, MODEL)).toBeNull();
	});

	test("returns null when a provider-qualified entry exactly matches the model", () => {
		const config = { argot: { enabled: true, models: ["google-antigravity/gemini-3.6-flash"] } };
		expect(encodeArmModelMismatch(config, MODEL)).toBeNull();
	});
});

describe("encodeArmModelMismatch — arms that silently degrade (returns the allowlist)", () => {
	test("flags an encode arm whose bare allowlist omits the model under test", () => {
		// The core bug: an operator lists the models they usually bench, then runs
		// --model against a different one. argot silently stops encoding; the guard
		// must surface the exact list so the error can explain why.
		const config = { argot: { enabled: true, models: ["gemini-2.5-flash", "claude-3-7-sonnet"] } };
		expect(encodeArmModelMismatch(config, MODEL)).toEqual(["gemini-2.5-flash", "claude-3-7-sonnet"]);
	});

	test("flags a provider-qualified entry that names a different provider", () => {
		// A bare name would match by segment, but a provider-qualified entry is
		// exact: `openai/gemini-3.6-flash` does NOT match the google-antigravity id,
		// even though the model segment is identical. This is the subtle case a
		// re-implemented matcher would most likely get wrong.
		const config = { argot: { enabled: true, models: ["openai/gemini-3.6-flash"] } };
		expect(encodeArmModelMismatch(config, MODEL)).toEqual(["openai/gemini-3.6-flash"]);
	});

	test("flags a non-string allowlist entry that cannot match (coerced then compared)", () => {
		// A malformed allowlist (a number leaked in) still must not be treated as a
		// silent match; coercion to string keeps the comparison total and the arm is
		// correctly flagged rather than passing by accident.
		const config = { argot: { enabled: true, models: [123] } };
		expect(encodeArmModelMismatch(config, MODEL)).toEqual(["123"]);
	});
});
