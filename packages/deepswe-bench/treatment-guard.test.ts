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
import { encodeArmModelMismatch, encodePreambleSilentlyDropped, isEncodeArm } from "./treatment-guard";

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

describe("isEncodeArm — which arms are held to the post-run preamble contract", () => {
	// The post-run check must fire ONLY for arms that assert an encode treatment, or
	// it would falsely fail the decode-only arm (which is designed never to teach the
	// preamble). This must key on the exact same shape encodeArmModelMismatch uses.

	test("true for argot.enabled with a non-empty allowlist (the full arm)", () => {
		expect(isEncodeArm({ argot: { enabled: true, models: ["gemini-3.5-flash"] } })).toBe(true);
	});

	test("false for the decode-only arm (enabled, empty allowlist) — never expected to encode", () => {
		// decode.yml is enabled:true, models:[]. It intentionally never teaches the
		// preamble, so holding it to the encode contract would fail every sound run.
		expect(isEncodeArm({ argot: { enabled: true, models: [] } })).toBe(false);
		expect(isEncodeArm({ argot: { enabled: true } })).toBe(false);
	});

	test("false when encoding is off (baseline) or there is no argot block", () => {
		expect(isEncodeArm({ argot: { enabled: false, models: ["gemini-3.5-flash"] } })).toBe(false);
		expect(isEncodeArm({ other: true })).toBe(false);
	});

	test("false for non-object configs, never throws", () => {
		expect(isEncodeArm(null)).toBe(false);
		expect(isEncodeArm("nope")).toBe(false);
		expect(isEncodeArm([1, 2])).toBe(false);
	});
});

describe("encodePreambleSilentlyDropped — the authoritative post-run fail-closed predicate", () => {
	// Reproduces the exact smoke defect: the full arm ran, produced OK trials, and the
	// encode preamble reached the model in NONE of them (requested 3.6 resolved to 3.5,
	// off the allowlist). Every known trial is false => the treatment silently dropped
	// and the run must fail closed.

	test("true when every known trial failed to teach the preamble (the silent degrade)", () => {
		expect(encodePreambleSilentlyDropped([false, false, false])).toBe(true);
	});

	test("true even when some trials are unknown, as long as no known trial taught it", () => {
		// An unreadable session (null) is not evidence of firing; if the readable ones
		// all show false, the treatment still dropped.
		expect(encodePreambleSilentlyDropped([null, false, null])).toBe(true);
	});

	test("false when at least one trial DID teach the preamble (treatment fired)", () => {
		expect(encodePreambleSilentlyDropped([false, true, false])).toBe(false);
		expect(encodePreambleSilentlyDropped([true])).toBe(false);
	});

	test("false when presence is entirely unknown — unreadable sessions are a separate problem", () => {
		// All null must NOT fail the run closed: we cannot claim the treatment dropped
		// without a single readable system prompt. This keeps the guard from firing on
		// an infra/parse failure that has nothing to do with the encode gate.
		expect(encodePreambleSilentlyDropped([null, null])).toBe(false);
	});

	test("false on an empty set (no trials to judge)", () => {
		expect(encodePreambleSilentlyDropped([])).toBe(false);
	});

	test("partial firing is NOT a failure here — argot's context cutoff can legitimately disable encode", () => {
		// A mix of taught/not-taught can be argot's disableAboveTokens cutoff kicking in
		// on longer trials, a real feature, not a broken arm. The report surfaces the
		// partial fraction; only a total miss fails the run closed.
		expect(encodePreambleSilentlyDropped([true, false, true, false])).toBe(false);
	});
});
