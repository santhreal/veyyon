import { describe, expect, it } from "bun:test";
import { canonicalizeConfig, computeArmFingerprint, findZeroIvCollisions } from "./arm-fingerprint";

const bytes = (s: string): Uint8Array => new TextEncoder().encode(s);

/**
 * These tests lock the single-independent-variable guard: the bench must never
 * report a "comparison" between two arms that reduce to the same input, because
 * such a comparison varies ZERO independent variables and every delta is noise.
 * That was the exact defect behind the invalid `candidate-vN` runs — arms copied
 * from baseline with only their comment header changed, silently benched as if
 * they differed. The comparison is SEMANTIC (parsed config), so a comment- or
 * formatting-only difference cannot disguise two identical arms as distinct.
 */
describe("canonicalizeConfig", () => {
	it("is invariant to object key order", () => {
		expect(canonicalizeConfig({ argot: { enabled: true }, model: "x" })).toBe(
			canonicalizeConfig({ model: "x", argot: { enabled: true } }),
		);
	});

	it("preserves array order (arrays are semantically ordered)", () => {
		expect(canonicalizeConfig({ chain: ["a", "b"] })).not.toBe(canonicalizeConfig({ chain: ["b", "a"] }));
	});

	it("distinguishes different values", () => {
		expect(canonicalizeConfig({ argot: { enabled: false } })).not.toBe(
			canonicalizeConfig({ argot: { enabled: true } }),
		);
	});

	it("treats an empty config and an empty object as equal", () => {
		expect(canonicalizeConfig({})).toBe(canonicalizeConfig({}));
	});
});

describe("computeArmFingerprint", () => {
	it("gives configs that differ only in key order the same fingerprint", () => {
		// Two arms whose overlays parse to the same config with keys written in a
		// different order are the SAME input — they must collide.
		const a = computeArmFingerprint({ config: { argot: { enabled: false }, jobs: 2 } });
		const b = computeArmFingerprint({ config: { jobs: 2, argot: { enabled: false } } });
		expect(a).toBe(b);
	});

	it("gives configs with different values different fingerprints", () => {
		// The valid feature-flag comparison: one setting flips. These MUST differ.
		const off = computeArmFingerprint({ config: { argot: { enabled: false } } });
		const on = computeArmFingerprint({ config: { argot: { enabled: true } } });
		expect(off).not.toBe(on);
	});

	it("distinguishes an arm with a section override from the same overlay without one", () => {
		// A per-section prompt experiment rides in the separate `sections` field
		// (eval-only, not config). The candidate overrides one section; its control
		// does not. Same config, different sections — valid single IV — differ.
		const control = computeArmFingerprint({ config: { argot: { enabled: true } } });
		const withOverride = computeArmFingerprint({
			config: { argot: { enabled: true } },
			sections: { role: "ROLE\n====\nR\n" },
		});
		expect(control).not.toBe(withOverride);
	});

	it("treats a missing section override and an empty-object override as identical", () => {
		// Neither changes any prompt section, so they must not read as a variable.
		const none = computeArmFingerprint({ config: { argot: { enabled: true } } });
		const empty = computeArmFingerprint({ config: { argot: { enabled: true } }, sections: {} });
		expect(none).toBe(empty);
	});

	it("gives section overrides that differ only in key order the same fingerprint", () => {
		// The override object is canonicalized like config: key order is not an IV.
		const a = computeArmFingerprint({ config: {}, sections: { role: "ROLE\n====\nR\n", runtime: "RUNTIME\n====\nX\n" } });
		const b = computeArmFingerprint({ config: {}, sections: { runtime: "RUNTIME\n====\nX\n", role: "ROLE\n====\nR\n" } });
		expect(a).toBe(b);
	});

	it("distinguishes an arm with a rule from the same config without one", () => {
		const control = computeArmFingerprint({ config: { argot: { enabled: true } } });
		const withRule = computeArmFingerprint({ config: { argot: { enabled: true } }, rule: bytes("Prefer X.\n") });
		expect(control).not.toBe(withRule);
	});

	it("separates the rule contribution from the config via length-prefixing", () => {
		// Length-prefixed fields make the (config, rule) encoding injective: a
		// config whose canonical JSON ends with the rule's bytes can never collide
		// with a separate rule. These two MUST differ.
		const withRule = computeArmFingerprint({ config: { x: 1 }, rule: bytes("HINT\n") });
		const configEatsRule = computeArmFingerprint({ config: { x: 1, note: "\0rule\0HINT\n" } });
		expect(withRule).not.toBe(configEatsRule);
	});

	it("is deterministic across calls for identical input", () => {
		const mod = { config: { a: 1 }, rule: bytes("hint\n") };
		expect(computeArmFingerprint(mod)).toBe(computeArmFingerprint(mod));
	});
});

describe("findZeroIvCollisions", () => {
	it("returns the colliding arm group when two arms reduce to the same input", () => {
		// baseline and candidate-v2 both fingerprint 'aaa': the guard must name
		// them together so the operator fixes or drops the redundant arm.
		const groups = findZeroIvCollisions(
			new Map([
				["baseline", "aaa"],
				["candidate-v2", "aaa"],
				["real-candidate", "bbb"],
			]),
		);
		expect(groups).toEqual([["baseline", "candidate-v2"]]);
	});

	it("returns no collisions when every arm differs (the required single-IV floor)", () => {
		const groups = findZeroIvCollisions(
			new Map([
				["baseline", "aaa"],
				["argot-on", "bbb"],
				["argot-nudge", "ccc"],
			]),
		);
		expect(groups).toEqual([]);
	});

	it("groups every member of a >2-way collision together", () => {
		// candidate-v2..v4 all copied from baseline: one group of four, so the
		// error message enumerates all of them, not just the first pair.
		const groups = findZeroIvCollisions(
			new Map([
				["baseline", "same"],
				["candidate-v2", "same"],
				["candidate-v3", "same"],
				["candidate-v4", "same"],
				["genuine", "other"],
			]),
		);
		expect(groups).toEqual([["baseline", "candidate-v2", "candidate-v3", "candidate-v4"]]);
	});

	it("reports multiple independent collision groups separately", () => {
		const groups = findZeroIvCollisions(
			new Map([
				["a1", "x"],
				["a2", "x"],
				["b1", "y"],
				["b2", "y"],
				["solo", "z"],
			]),
		);
		expect(groups).toEqual([
			["a1", "a2"],
			["b1", "b2"],
		]);
	});

	it("returns no collisions for a single-arm or empty run", () => {
		expect(findZeroIvCollisions(new Map([["only", "aaa"]]))).toEqual([]);
		expect(findZeroIvCollisions(new Map())).toEqual([]);
	});
});
