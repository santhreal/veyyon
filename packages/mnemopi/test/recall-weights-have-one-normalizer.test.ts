/**
 * The three recall weights are normalized in one place, and that place survives `NaN`.
 *
 * WHY THIS EXISTS. Recall scores a memory by blending three signals: vector similarity,
 * full-text relevance, and stored importance. The blend needs the three weights
 * non-negative and summing to 1, and two functions did that job:
 *
 *   - `config.normalizedRecallWeights`, called by `core/beam/recall.ts`.
 *   - `core/beam/helpers.normalizeWeights`, called by nothing outside its own test.
 *
 * THEY DID NOT AGREE, AND THE LIVE ONE HAD THE WEAKER ANSWER. The dead twin mapped a
 * non-finite weight to 0 before summing. The live one did not, and `Math.max(0, NaN)` is
 * `NaN`, so a single `NaN` weight made the total `NaN`, made every ratio `NaN`, and made
 * every candidate's blended score `NaN`. Nothing throws on that. `NaN > best` is false for
 * every comparison, so recall keeps whatever order the candidates arrived in and returns a
 * confident-looking ranking that no weight influenced at all: a silent scoring failure of
 * exactly the kind a second implementation is supposed to prevent, sitting in the copy that
 * was actually running.
 *
 * `RecallOptions.vecWeight` is public and typed `number`, so a caller that computed it with
 * `Number(userInput)` reaches this. The guard is now on the surviving function.
 *
 * The default triple was also written four times: once per accessor default, once as the
 * zero-total fallback, and once more as `DEFAULT_WEIGHTS` in the helpers module. It is
 * `DEFAULT_RECALL_WEIGHTS` now, and the tests below read it rather than restating it, so
 * retuning recall cannot leave one of the four behind.
 */

import { describe, expect, it } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import * as path from "node:path";

import {
	DEFAULT_RECALL_WEIGHTS,
	ftsWeight,
	importanceWeight,
	normalizedRecallWeights,
	vectorWeight,
} from "@veyyon/mnemopi/config";

const SRC = path.join(import.meta.dir, "..", "src");

/** Every `.ts` file under `packages/mnemopi/src`. */
async function sourceFiles(dir: string = SRC): Promise<string[]> {
	const found: string[] = [];
	for (const entry of await readdir(dir, { withFileTypes: true, encoding: "utf8" })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) found.push(...(await sourceFiles(full)));
		else if (entry.name.endsWith(".ts")) found.push(full);
	}
	return found;
}

describe("the default recall weights", () => {
	/**
	 * Real values. Every other test here compares against `DEFAULT_RECALL_WEIGHTS`, which
	 * would keep passing if the constant itself were retuned by accident, so the numbers
	 * recall actually ships with are pinned once, here.
	 */
	it("are the triple recall ships with", () => {
		expect([...DEFAULT_RECALL_WEIGHTS]).toEqual([0.5, 0.3, 0.2]);
	});

	/** They already sum to 1, so the shipped default needs no normalizing to be valid. */
	it("already sum to one", () => {
		const total = DEFAULT_RECALL_WEIGHTS[0] + DEFAULT_RECALL_WEIGHTS[1] + DEFAULT_RECALL_WEIGHTS[2];

		expect(total).toBeCloseTo(1, 10);
	});

	/**
	 * Each accessor reads its own slot. A copy-paste that pointed two accessors at one slot
	 * would leave the triple summing to 1 and still score every recall wrongly.
	 */
	it("are what each accessor returns with nothing set", () => {
		expect(vectorWeight({})).toBe(DEFAULT_RECALL_WEIGHTS[0]);
		expect(ftsWeight({})).toBe(DEFAULT_RECALL_WEIGHTS[1]);
		expect(importanceWeight({})).toBe(DEFAULT_RECALL_WEIGHTS[2]);
	});

	/** And each reads the variable it is named for, so a rename cannot cross two of them. */
	it("are overridden by the variable each is named for", () => {
		expect(vectorWeight({ MNEMOPI_VEC_WEIGHT: "0.7" })).toBe(0.7);
		expect(ftsWeight({ MNEMOPI_FTS_WEIGHT: "0.25" })).toBe(0.25);
		expect(importanceWeight({ MNEMOPI_IMPORTANCE_WEIGHT: "0.15" })).toBe(0.15);
	});
});

describe("normalizing a weight triple", () => {
	/** The ordinary case: three weights that do not sum to 1 are scaled until they do. */
	it("scales an unnormalized triple to sum to one", () => {
		expect(normalizedRecallWeights(2, 1, 1)).toEqual([0.5, 0.25, 0.25]);
	});

	/**
	 * A triple that already sums to 1 comes back untouched rather than round-tripped
	 * through a division by 1, which can move a value by an ulp and make a stored weight
	 * stop comparing equal to the one it was set from.
	 */
	it("returns an already-normalized triple unchanged", () => {
		expect(normalizedRecallWeights(0.5, 0.3, 0.2)).toEqual([0.5, 0.3, 0.2]);
		expect(normalizedRecallWeights(0.1, 0.1, 0.8)).toEqual([0.1, 0.1, 0.8]);
	});

	/** A negative weight contributes nothing rather than subtracting from the total. */
	it("floors a negative weight at zero", () => {
		expect(normalizedRecallWeights(-1, 1, 1)).toEqual([0, 0.5, 0.5]);
	});

	/** Weights that all floor to zero fall back to the default rather than dividing by zero. */
	it("falls back to the default when nothing is left", () => {
		expect(normalizedRecallWeights(-1, 0, 0)).toEqual(DEFAULT_RECALL_WEIGHTS);
		expect(normalizedRecallWeights(0, 0, 0)).toEqual(DEFAULT_RECALL_WEIGHTS);
	});

	/** One weight carrying everything is normalized to exactly that, not merely close. */
	it("normalizes a single non-zero weight to one", () => {
		expect(normalizedRecallWeights(0, 4, 0)).toEqual([0, 1, 0]);
	});

	/** The result really does sum to 1 for an arbitrary triple, not only the tidy ones. */
	it("produces a triple summing to one", () => {
		const [vec, fts, importance] = normalizedRecallWeights(3, 7, 11);

		expect(vec + fts + importance).toBeCloseTo(1, 10);
		expect(vec).toBeCloseTo(3 / 21, 10);
		expect(fts).toBeCloseTo(7 / 21, 10);
		expect(importance).toBeCloseTo(11 / 21, 10);
	});
});

describe("a weight that is not a usable number", () => {
	/**
	 * THE regression, and the reason the two implementations had to be reconciled rather
	 * than one simply deleted. `NaN` used to propagate through the whole triple.
	 */
	it("does not poison the other two", () => {
		expect(normalizedRecallWeights(Number.NaN, 1, 1)).toEqual([0, 0.5, 0.5]);
	});

	/** From whichever slot it arrives in. */
	it("is neutralized in every slot", () => {
		expect(normalizedRecallWeights(1, Number.NaN, 1)).toEqual([0.5, 0, 0.5]);
		expect(normalizedRecallWeights(1, 1, Number.NaN)).toEqual([0.5, 0.5, 0]);
	});

	/** No slot of the result is ever `NaN`, which is the property recall depends on. */
	it("never yields a NaN weight", () => {
		for (const weights of [
			normalizedRecallWeights(Number.NaN, Number.NaN, Number.NaN),
			normalizedRecallWeights(Number.NaN, 0, 0),
			normalizedRecallWeights(Number.POSITIVE_INFINITY, 1, 1),
		]) {
			for (const weight of weights) expect(Number.isFinite(weight)).toBe(true);
		}
	});

	/** All three unusable is the same as all three empty: the default, not a `NaN` triple. */
	it("falls back to the default when all three are unusable", () => {
		expect(normalizedRecallWeights(Number.NaN, Number.NaN, Number.NaN)).toEqual(DEFAULT_RECALL_WEIGHTS);
	});

	/**
	 * An infinite weight is unusable too. Left in, it makes the total infinite and every
	 * ratio either 0 or `NaN`, so the finite weights would silently stop mattering.
	 */
	it("neutralizes an infinite weight", () => {
		expect(normalizedRecallWeights(Number.POSITIVE_INFINITY, 1, 1)).toEqual([0, 0.5, 0.5]);
		expect(normalizedRecallWeights(Number.NEGATIVE_INFINITY, 1, 1)).toEqual([0, 0.5, 0.5]);
	});
});

describe("an absent weight", () => {
	/**
	 * `null` and `undefined` both mean "use the configured weight". Recall reaches this
	 * through `options.vecWeight ?? beam.config.vecWeight`, and a caller holding an
	 * optional override should be able to pass it through without a second `??`.
	 */
	it("means the configured weight, whether null or undefined", () => {
		const configured = normalizedRecallWeights();

		expect(normalizedRecallWeights(null, null, null)).toEqual(configured);
		expect(normalizedRecallWeights(undefined, undefined, undefined)).toEqual(configured);
		expect(configured).toEqual(DEFAULT_RECALL_WEIGHTS);
	});

	/** A single absent weight leaves the two supplied ones alone. */
	it("does not disturb the weights that were supplied", () => {
		expect(normalizedRecallWeights(null, 0.3, 0.2)).toEqual([0.5, 0.3, 0.2]);
	});
});

describe("no module keeps a second normalizer", () => {
	/**
	 * The structural lock. The value assertions above prove the surviving function behaves;
	 * only a source check stops the deleted twin from being reintroduced, which is how the
	 * unguarded and the guarded implementation came to coexist in the first place.
	 */
	it("nothing declares normalizeWeights any more", async () => {
		const files = await sourceFiles();
		// NON-VACUITY: the walk really read the package.
		expect(files.length).toBeGreaterThan(20);

		const declaration = /^\s*(?:export )?function normalizeWeights\s*\(/m;
		const offenders: string[] = [];
		for (const file of files) {
			if (declaration.test(await readFile(file, "utf8"))) offenders.push(path.relative(SRC, file));
		}

		expect(offenders, "declares a second weight normalizer. Call config.normalizedRecallWeights").toEqual([]);
	});

	/**
	 * The helpers module no longer parses the weight variables itself either. Three
	 * `envFloat("MNEMOPI_..._WEIGHT", ...)` calls lived there, behind accessors that
	 * already existed, which is why those accessors looked unused.
	 */
	it("the helpers module no longer parses the weight variables", async () => {
		const text = await readFile(path.join(SRC, "core", "beam", "helpers.ts"), "utf8");

		expect(text).not.toMatch(/envFloat\(\s*"MNEMOPI_(?:VEC|FTS|IMPORTANCE)_WEIGHT"/);
	});

	/**
	 * The default triple is spelled once. A second `[0.5, 0.3, 0.2]` anywhere in the source
	 * is the copy this change removed, growing back.
	 */
	it("the default triple is written once", async () => {
		const files = await sourceFiles();
		const literal = /\[\s*0\.5\s*,\s*0\.3\s*,\s*0\.2\s*\]/;
		const offenders: string[] = [];
		for (const file of files) {
			const rel = path.relative(SRC, file);
			if (rel === "config.ts") continue;
			// Code only: the triple named in a doc comment documents the constant.
			const code = (await readFile(file, "utf8"))
				.split("\n")
				.filter(line => !/^\s*(\/\/|\*|\/\*)/.test(line))
				.join("\n");
			if (literal.test(code)) offenders.push(rel);
		}

		expect(offenders, "spells the default weight triple. Import DEFAULT_RECALL_WEIGHTS instead").toEqual([]);
	});

	/**
	 * The exemption above is only sound while `config.ts` really still declares the triple.
	 * An exemption for a file that stopped declaring it is a hole that opens quietly.
	 */
	it("and config.ts really still declares it", async () => {
		const text = await readFile(path.join(SRC, "config.ts"), "utf8");

		expect(text).toMatch(/DEFAULT_RECALL_WEIGHTS: HybridWeights = \[0\.5, 0\.3, 0\.2\]/);
	});
});
