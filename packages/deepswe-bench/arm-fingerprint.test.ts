import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import YAML from "yaml";
import {
	ARM_ATTACHMENT_SUFFIXES,
	type ArmInputs,
	armNamesIn,
	armSelectionError,
	canonicalizeConfig,
	computeArmFingerprint,
	findZeroIvCollisions,
	isArmConfigFile,
} from "./arm-fingerprint";

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
		const a = computeArmFingerprint({
			config: {},
			sections: { role: "ROLE\n====\nR\n", runtime: "RUNTIME\n====\nX\n" },
		});
		const b = computeArmFingerprint({
			config: {},
			sections: { runtime: "RUNTIME\n====\nX\n", role: "ROLE\n====\nR\n" },
		});
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

describe("shipped arms are pairwise distinct (single-IV coherence)", () => {
	// The zero-IV guard runs inside run.ts, which means a duplicated arm is only
	// caught after pier is resolved, assets are staged, and a run is attempted.
	// That is late and expensive, and the defect it guards against is a copy-paste:
	// `candidate-vN.yml` duplicated from `baseline.yml` with nothing actually
	// changed, which produced result-shaped tables whose deltas were pure noise.
	// This checks the arms ON DISK, so the mistake fails in the test suite instead.
	// It deliberately reuses computeArmFingerprint and the same input assembly as
	// run.ts, so it cannot drift from the guard that runs for real.

	const ARMS_DIR = path.join(import.meta.dir, "arms");

	function shippedArmInputs(arm: string): ArmInputs {
		const config = YAML.parse(fs.readFileSync(path.join(ARMS_DIR, `${arm}.yml`), "utf8")) ?? {};
		const sectionsPath = path.join(ARMS_DIR, `${arm}.sections.yml`);
		// Every attachment run.ts stages has to be read here too, and the statements file is the newest
		// one. When it was added and this reader was not updated, the shipped ablation arm fingerprinted
		// identically to `baseline` (same config, no attachment seen) and the pairwise check below failed
		// by name, which is the guard working: an attachment the fingerprint cannot see is an arm the
		// single-IV floor cannot distinguish.
		const statementsPath = path.join(ARMS_DIR, `${arm}.statements.yml`);
		const rulePath = path.join(ARMS_DIR, `${arm}.rule.md`);
		return {
			config,
			...(fs.existsSync(sectionsPath) ? { sections: YAML.parse(fs.readFileSync(sectionsPath, "utf8")) ?? {} } : {}),
			...(fs.existsSync(statementsPath)
				? { statements: YAML.parse(fs.readFileSync(statementsPath, "utf8")) ?? {} }
				: {}),
			...(fs.existsSync(rulePath) ? { rule: fs.readFileSync(rulePath) } : {}),
		};
	}

	const shippedArms = fs
		.readdirSync(ARMS_DIR)
		.filter(isArmConfigFile)
		.map(f => f.slice(0, -".yml".length))
		.sort();

	it("every shipped arm pair varies at least one input", () => {
		// A collision here means two arms in the repository are the same experiment
		// under two names, so any comparison between them measures nothing.
		const fingerprints = new Map<string, string>();
		for (const arm of shippedArms) fingerprints.set(arm, computeArmFingerprint(shippedArmInputs(arm)));
		expect(findZeroIvCollisions(fingerprints)).toEqual([]);
	});

	it("the arms directory is not empty, so the check cannot pass vacuously", () => {
		// Guards the guard: a rename or a moved directory would otherwise leave the
		// collision test scanning nothing and reporting success forever.
		expect(shippedArms.length).toBeGreaterThanOrEqual(5);
		expect(shippedArms).toContain("baseline");
		expect(shippedArms).toContain("full");
	});

	it("full and full-budget16k differ only by the dictionary budget", () => {
		// The budget pair is the single-IV comparison that makes argot's output-token
		// claim measurable at all, so its two arms must be identical apart from
		// argot.tokenBudget. If anything else drifts, the comparison silently stops
		// isolating the budget and its result becomes unattributable.
		const full = shippedArmInputs("full").config as Record<string, Record<string, unknown>>;
		const big = shippedArmInputs("full-budget16k").config as Record<string, Record<string, unknown>>;
		expect(big.argot?.tokenBudget).toBe(16000);
		expect(full.argot?.tokenBudget).toBeUndefined();
		// Every other argot key matches, and no other top-level domain is introduced.
		expect(big.argot?.enabled).toEqual(full.argot?.enabled);
		expect(big.argot?.models).toEqual(full.argot?.models);
		expect(Object.keys(big).sort()).toEqual(Object.keys(full).sort());
		const budgetless = { ...big.argot };
		delete budgetless.tokenBudget;
		expect(budgetless).toEqual(full.argot ?? {});
	});
});

/**
 * WHICH FILES IN `arms/` ARE ARMS, answered once.
 *
 * It used to be answered in three places and one was wrong: `docs-coherence.test.ts` took every
 * `*.yml`, so `candidate-delivery-terse.sections.yml` became a phantom arm named
 * `candidate-delivery-terse.sections` and every coherence check quantified over an arm nobody can run.
 * Adding `.statements.yml` would have meant a second phantom in the same place.
 */
describe("arm files and attachments", () => {
	it("counts a plain .yml as an arm and every attachment suffix as not one", () => {
		expect(isArmConfigFile("baseline.yml")).toBe(true);
		for (const suffix of ARM_ATTACHMENT_SUFFIXES) {
			expect(isArmConfigFile(`baseline${suffix}`), `${suffix} should not be an arm`).toBe(false);
		}
	});

	it("ignores files that are not YAML at all", () => {
		// `.rule.md` is an attachment too, and it is excluded by not being `.yml` rather than by being
		// listed, which is why the suffix list does not mention it.
		expect(isArmConfigFile("baseline.rule.md")).toBe(false);
		expect(isArmConfigFile("README.md")).toBe(false);
		expect(isArmConfigFile("notes.txt")).toBe(false);
	});

	it("names the arms in a listing, sorted, without their attachments", () => {
		const listing = [
			"full.yml",
			"baseline.yml",
			"baseline.rule.md",
			"candidate.sections.yml",
			"candidate.statements.yml",
			"candidate.yml",
		];

		expect(armNamesIn(listing)).toEqual(["baseline", "candidate", "full"]);
	});

	it("lists every shipped arm exactly once, with no attachment among them", () => {
		const shipped = armNamesIn(fs.readdirSync(path.join(import.meta.dir, "arms")));

		expect(new Set(shipped).size).toBe(shipped.length);
		expect(shipped).toContain("baseline");
		for (const name of shipped) {
			for (const suffix of ARM_ATTACHMENT_SUFFIXES) {
				expect(name.endsWith(suffix.slice(0, -".yml".length)), `${name} is an attachment`).toBe(false);
			}
		}
	});
});

/**
 * A REQUESTED ARM IS REFUSED BEFORE ANYTHING IS STAGED, and the attachment case is the dangerous one.
 *
 * A typo used to reach `readFileSync` and die with a raw ENOENT stack, which reads as a broken runner
 * and hides the only useful fact, what the arms are called. An attachment name does not fail at all:
 * `--arms candidate-delivery-terse.sections` finds that file, parses a section-override map as a config
 * overlay, merges keys veyyon has never heard of, and benches the control under a treatment's name.
 * That is the most expensive way to be wrong, because it reads as a real measurement.
 */
describe("refusing an arm that cannot be benched", () => {
	const available = ["baseline", "candidate-delivery-terse", "full"];

	it("accepts an arm that exists", () => {
		expect(armSelectionError("baseline", available)).toBeNull();
	});

	it("names the available arms when the arm does not exist", () => {
		const problem = armSelectionError("baselien", available);

		expect(problem).toContain('no arm "baselien"');
		expect(problem).toContain("baseline, candidate-delivery-terse, full");
	});

	it("says an attachment is an attachment, and names the arm it belongs to", () => {
		for (const suffix of ARM_ATTACHMENT_SUFFIXES) {
			const bare = suffix.slice(0, -".yml".length);
			const problem = armSelectionError(`candidate-delivery-terse${bare}`, available);

			expect(problem, `${suffix} was not refused`).toContain("is not an arm");
			expect(problem).toContain(suffix);
			expect(problem).toContain("--arms candidate-delivery-terse");
		}
	});

	it("refuses an attachment even when its arm is not in the available list", () => {
		// The attachment check must not depend on the arm existing: a stale `--arms` line naming an
		// attachment of a deleted arm should still say what it is, not just that it is missing.
		expect(armSelectionError("gone.statements", [])).toContain("is not an arm");
	});
});

/**
 * THE PER-STATEMENT OVERRIDE IS PART OF WHAT AN ARM IS, and an empty one is not.
 *
 * Two properties, and both were written into the code before either was asserted, which is how a
 * mutation that made an empty override count as DISTINCT survived: nothing tested the case.
 *
 * 1. An arm carrying a statements file must not fingerprint as its control. That is the whole point of
 *    the vehicle: without it, an ablation arm and its baseline reduce to the same inputs, the zero-IV
 *    guard passes, and the report compares the control against a second copy of the control.
 * 2. An EMPTY override must count as absent. It changes no rule, so an arm carrying an empty file IS
 *    its control, and letting it look distinct would smuggle a no-op arm past the guard, which is the
 *    exact defect the guard exists for (`candidate-vN` copied from `baseline` with nothing changed).
 *
 * And a third, quieter one: an arm with NO statements file fingerprints exactly as it did before this
 * field existed, so the fingerprints already recorded in past results stay comparable and a
 * longitudinal diff does not report every arm as changed.
 */
describe("the per-statement override in the fingerprint", () => {
	const config = { argot: { enabled: false } };

	it("distinguishes an ablation arm from its control", () => {
		const control = computeArmFingerprint({ config });
		const ablated = computeArmFingerprint({ config, statements: { "tool-policy/delegation-gates": null } });

		expect(ablated).not.toBe(control);
	});

	it("distinguishes ablating one rule from ablating another", () => {
		const first = computeArmFingerprint({ config, statements: { "tool-policy/lsp": null } });
		const second = computeArmFingerprint({ config, statements: { "tool-policy/delegation-gates": null } });

		expect(first).not.toBe(second);
	});

	it("distinguishes removing a rule from rewording it, since they are different experiments", () => {
		const removed = computeArmFingerprint({ config, statements: { "tool-policy/lsp": null } });
		const reworded = computeArmFingerprint({ config, statements: { "tool-policy/lsp": "Prefer lsp." } });

		expect(removed).not.toBe(reworded);
	});

	it("treats an empty override as absent, so an empty file cannot smuggle a no-op arm past the guard", () => {
		expect(computeArmFingerprint({ config, statements: {} })).toBe(computeArmFingerprint({ config }));
	});

	it("treats an absent override and an explicitly undefined one identically", () => {
		expect(computeArmFingerprint({ config, statements: undefined })).toBe(computeArmFingerprint({ config }));
	});

	/**
	 * A RECORDED digest, which is the only thing that can pin backwards compatibility.
	 *
	 * Fingerprints are written into each run's results and compared longitudinally, so an arm whose
	 * inputs did not change must keep its value across releases; otherwise a diff reports every arm as
	 * changed and is indistinguishable from every arm actually changing. Comparing two calls of the same
	 * function cannot detect that, because both move together: a mutation that folded the statements
	 * field in unconditionally passed every other test here while changing the value of every arm.
	 *
	 * This value predates the statements field, which is why it is the one worth recording. If it
	 * fails, the ENCODING changed. That may be intended, and updating this line is how you say so, with
	 * the understanding that comparisons against older runs become meaningless at that point.
	 */
	it("still fingerprints a plain arm to the value recorded before the statements field existed", () => {
		expect(computeArmFingerprint({ config })).toBe(
			"cac97fc4ffb83a5f73b413c5c8999bfc125ceaa8545da1c29d279b68d4f1b39f",
		);
	});

	it("ignores key order in the override, as it does everywhere else", () => {
		const one = computeArmFingerprint({
			config,
			statements: { "tool-policy/lsp": null, "role/mermaid-diagrams": "x" },
		});
		const other = computeArmFingerprint({
			config,
			statements: { "role/mermaid-diagrams": "x", "tool-policy/lsp": null },
		});

		expect(one).toBe(other);
	});

	it("does not confuse a statements override with a sections one carrying the same text", () => {
		// The fields are length-prefixed and labelled precisely so one cannot be mistaken for the other:
		// two arms overriding different THINGS with the same text are different experiments.
		const asStatements = computeArmFingerprint({ config, statements: { "role/mermaid-diagrams": "x" } });
		const asSections = computeArmFingerprint({ config, sections: { "role/mermaid-diagrams": "x" } });

		expect(asStatements).not.toBe(asSections);
	});
});
