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
import {
	type ArmSettingType,
	encodeArmModelMismatch,
	encodePreambleSilentlyDropped,
	isEncodeArm,
	type MistypedArmSetting,
	mistypedArmSettings,
	unknownArmSettings,
} from "./treatment-guard";

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

/**
 * An arm that names a setting veyyon does not have.
 *
 * WHY THIS SUITE EXISTS. An arm is a config overlay and nothing more. A key
 * veyyon does not recognise raises nothing: it merges, it is never read, and
 * the arm runs with default behaviour under a name that claims a treatment. The
 * report then compares the control against a second copy of the control, and a
 * null result is indistinguishable from a real one. That is the most expensive
 * possible way to be wrong, because it looks like a measurement.
 *
 * It is the same defect as the argot allowlist mismatch pinned above, one layer
 * up. There a real setting failed to apply; here the key was never a setting at
 * all. One typo, or one upstream rename that nobody propagated to `arms/`, voids
 * the experiment silently.
 */
describe("unknownArmSettings — an arm that sets nothing", () => {
	const KNOWN = new Set([
		"argot.enabled",
		"tools.discoveryMode",
		"tools.inlineOutputFloor",
		"tools.approval",
		"temperature",
	]);
	const isKnown = (p: string): boolean => KNOWN.has(p);
	const check = (config: unknown): string[] => unknownArmSettings(config, isKnown);

	/** The nested spelling, which is what every committed arm uses. */
	test("accepts a nested mapping that resolves to a real path", () => {
		expect(check({ argot: { enabled: false }, tools: { discoveryMode: "all" } })).toEqual([]);
	});

	/** The flat spelling. Both are valid YAML for the same overlay, so a guard
	 * that understood only one would reject working arms. */
	test("accepts the flat dotted spelling of the same keys", () => {
		expect(check({ "argot.enabled": false, "tools.discoveryMode": "all" })).toEqual([]);
	});

	/** The exact regression: a plausible misspelling of a real key. Reported by
	 * its full dotted path, because that is the string the operator has to fix. */
	test("reports a misspelled nested key by its full dotted path", () => {
		expect(check({ tools: { discoverymode: "all" } })).toEqual(["tools.discoverymode"]);
	});

	/** The same mistake in flat form. */
	test("reports a misspelled flat key", () => {
		expect(check({ "tools.inlineOutputFloo": 0.1 })).toEqual(["tools.inlineOutputFloo"]);
	});

	/** A wrong key beside a right one still fails. A partially applied arm is not
	 * a lesser problem: it measures a condition nobody described. */
	test("reports the bad key when a good one sits beside it", () => {
		expect(check({ argot: { enabled: false }, tools: { nope: 1 } })).toEqual(["tools.nope"]);
	});

	/**
	 * Descent must STOP at a known path. `tools.approval` is a record whose keys
	 * are tool names chosen by the user, so walking into it would report every
	 * single entry as an unknown setting and make the guard unusable.
	 */
	test("does not walk into the value of a record-valued setting", () => {
		expect(check({ tools: { approval: { bash: "allow", anything_at_all: "deny" } } })).toEqual([]);
	});

	/**
	 * An empty mapping has no leaf to name. Descending and finding nothing would
	 * let `nonsense: {}` through, so the prefix itself is reported.
	 */
	test("reports an unrecognised prefix that holds an empty mapping", () => {
		expect(check({ nonsense: {} })).toEqual(["nonsense"]);
	});

	/** A list value is a leaf: reported as the path, never walked into indices,
	 * which would produce `foo.0` and name nothing a human could fix. */
	test("treats a list value as a leaf", () => {
		expect(check({ argot: { models: ["a", "b"] } })).toEqual(["argot.models"]);
	});

	/** Deep nesting is reported at the leaf, not at the first unrecognised level,
	 * so the message quotes the whole key rather than its root. */
	test("reports the leaf of a deeply nested unknown key", () => {
		expect(check({ a: { b: { c: 1 } } })).toEqual(["a.b.c"]);
	});

	/** Several problems are reported together and in a stable order, so the error
	 * lists everything to fix in one pass instead of one per run. */
	test("reports every unknown key, sorted", () => {
		expect(check({ zeta: 1, alpha: 2, tools: { nope: 3 } })).toEqual(["alpha", "tools.nope", "zeta"]);
	});

	/** An arm with no overrides is legal: `baseline` is nearly one. */
	test("accepts an empty config", () => {
		expect(check({})).toEqual([]);
	});

	/** The injected sampling temperature is a real top-level setting and must not
	 * be reported. The runner adds it to every arm before staging, so a guard that
	 * rejected it would refuse every run. */
	test("accepts the injected temperature key", () => {
		expect(check({ argot: { enabled: false }, temperature: 0 })).toEqual([]);
	});
});

/**
 * An arm that names a real setting and gives it an unusable value.
 *
 * WHY THIS SUITE EXISTS, separately from the unknown-key one above. Checking
 * that a key exists is only half the question. `tools.discoveryMode: yes` names
 * a real setting, so the key check passes, and then YAML reads the bare word as
 * the boolean `true` while the schema wants one of four strings. The overlay
 * merges, the value is unusable, and the arm runs as the control under a
 * treatment's name: the same silent null result, reached a different way.
 *
 * YAML makes this easy rather than exotic. Bare `yes`/`no`/`on`/`off` are
 * booleans, `0.1` is a number but `.1` is a string, and a quoted `"0.1"` reads
 * identically to a human scanning a diff.
 */
describe("mistypedArmSettings — a real key with an unusable value", () => {
	const SCHEMA: Record<string, ArmSettingType> = {
		"argot.enabled": { kind: "boolean" },
		"tools.inlineOutputFloor": { kind: "number" },
		"tools.discoveryMode": { kind: "enum", values: ["auto", "off", "mcp-only", "all"] },
		"argot.models": { kind: "array" },
		"tools.approval": { kind: "record" },
		"model.name": { kind: "string" },
	};
	const typeOf = (p: string): ArmSettingType | undefined => SCHEMA[p];
	const check = (config: unknown): MistypedArmSetting[] => mistypedArmSettings(config, typeOf);

	/** Every committed arm shape must pass, or the guard blocks real work. */
	test("accepts correctly typed values", () => {
		expect(
			check({
				argot: { enabled: false, models: ["gemini-3.5-flash"] },
				tools: { discoveryMode: "all", inlineOutputFloor: 0.1, approval: { bash: "allow" } },
				model: { name: "gemini-3.5-flash" },
			}),
		).toEqual([]);
	});

	/**
	 * The exact regression, and the reason this is not paranoia: `discoveryMode:
	 * yes` is what a person writes when they mean "turn discovery on", and YAML
	 * hands the schema a boolean for an enum.
	 */
	test("reports a YAML bare-word boolean given to an enum", () => {
		expect(check({ tools: { discoveryMode: true } })).toEqual([
			{ path: "tools.discoveryMode", expected: "one of auto, off, mcp-only, all", actual: "boolean" },
		]);
	});

	/** A value outside the enum is named along with what was allowed, so the
	 * error is a fix rather than a rejection. */
	test("reports a string that is not one of the enum's values", () => {
		expect(check({ tools: { discoveryMode: "everything" } })).toEqual([
			{ path: "tools.discoveryMode", expected: "one of auto, off, mcp-only, all", actual: '"everything"' },
		]);
	});

	/** A quoted number is a string, and looks identical to the real thing in a
	 * diff. This is the one a reviewer cannot catch by eye. */
	test("reports a quoted number given to a number setting", () => {
		expect(check({ tools: { inlineOutputFloor: "0.1" } })).toEqual([
			{ path: "tools.inlineOutputFloor", expected: "number", actual: "string" },
		]);
	});

	/** `.inf` and `.nan` are valid YAML and parse to numbers that no setting can
	 * use. A non-finite value is as unusable as a string. */
	test("reports a non-finite number", () => {
		expect(check({ tools: { inlineOutputFloor: Number.POSITIVE_INFINITY } })).toMatchObject([
			{ path: "tools.inlineOutputFloor", expected: "number" },
		]);
		expect(check({ tools: { inlineOutputFloor: Number.NaN } })).toHaveLength(1);
	});

	/** The remaining kinds, each with the wrong shape. */
	test("reports the wrong shape for boolean, array, record and string settings", () => {
		expect(check({ argot: { enabled: "true" } })).toEqual([
			{ path: "argot.enabled", expected: "boolean", actual: "string" },
		]);
		expect(check({ argot: { models: "gemini-3.5-flash" } })).toEqual([
			{ path: "argot.models", expected: "array", actual: "string" },
		]);
		expect(check({ tools: { approval: ["bash"] } })).toEqual([
			{ path: "tools.approval", expected: "record", actual: "array" },
		]);
		expect(check({ model: { name: 3.5 } })).toEqual([{ path: "model.name", expected: "string", actual: "number" }]);
	});

	/** `null` is a real YAML value (a bare `key:` with nothing after it) and must
	 * be reported rather than treated as absent. */
	test("reports an empty YAML value", () => {
		expect(check({ argot: { enabled: null } })).toEqual([
			{ path: "argot.enabled", expected: "boolean", actual: "null" },
		]);
	});

	/**
	 * An unknown key is NOT reported here. `unknownArmSettings` already owns that
	 * message, and naming the same typo twice, once as unknown and once as
	 * mistyped, tells the reader nothing extra and implies two problems.
	 */
	test("says nothing about a key the schema does not know", () => {
		expect(check({ tools: { discoverymode: "all" }, nonsense: 1 })).toEqual([]);
	});

	/** Descent stops at a known path, so a record-valued setting's arbitrary keys
	 * are its own business rather than settings to type-check. */
	test("does not descend into a record-valued setting", () => {
		expect(check({ tools: { approval: { bash: "allow", anything: 42 } } })).toEqual([]);
	});

	/** Several problems are reported together, sorted, so one run fixes them all. */
	test("reports every mistyped key, sorted by path", () => {
		const result = check({ argot: { enabled: "yes" }, tools: { inlineOutputFloor: "0.1" } });
		expect(result.map(r => r.path)).toEqual(["argot.enabled", "tools.inlineOutputFloor"]);
	});

	/** A kind this guard has not been taught must not fail every arm that uses the
	 * setting. Adding a type to the schema should never break the bench. */
	test("ignores a schema kind it does not recognise", () => {
		expect(mistypedArmSettings({ some: { thing: 1 } }, () => ({ kind: "brand-new-kind" }))).toEqual([]);
	});
});
