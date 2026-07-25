/**
 * The key-parser benchmark's samples, checked without running a benchmark.
 *
 * WHY THIS SUITE EXISTS. `bench/parse-key.ts` is what says whether replacing the TypeScript key
 * parser with the native one was worth it, and it had been unable to run at all. `bench/_jskey.ts`
 * holds the frozen pre-native parser and exported only its two TYPE aliases, so the bench's third
 * statement threw `js.setKittyProtocolActive is not a function` and no timing was ever produced.
 * Nothing caught it: no test imported either file, and the benchmarks are not part of any gate.
 *
 * Once it ran, three of its expectations turned out to have fallen behind the shipped parser, and
 * one of the three was a real behaviour change rather than a typo (Kitty base-layout keys), which
 * is the kind of thing a stale bench is supposed to surface and could not.
 *
 * So this suite asserts the two things that let it rot: that the baseline module still exposes the
 * functions the bench calls, and that every sample's expectation still matches what the parsers
 * actually return. It deliberately does NOT time anything, so it stays fast and stable in CI while
 * still failing the moment the bench would break.
 */

import { describe, expect, it } from "bun:test";
import { parseKey as nativeParseKey } from "@veyyon/natives";
import * as js from "../bench/_jskey";
import { samples } from "../bench/_key-samples";
import * as native from "../src/keys";

/** Kitty protocol on, matching the mode the bench measures in: half the samples are Kitty sequences. */
const KITTY_ACTIVE = true;

js.setKittyProtocolActive(KITTY_ACTIVE);
native.setKittyProtocolActive(KITTY_ACTIVE);

describe("the frozen baseline module", () => {
	/**
	 * The exact breakage. `_jskey.ts` is a copy of the parser as it was before the native one, and
	 * the copy kept `function foo()` where the original had `export function foo()`, so every value
	 * the bench imports was undefined while the file still typechecked and still looked complete.
	 */
	it("exports the four functions the bench calls", () => {
		expect(typeof js.setKittyProtocolActive).toBe("function");
		expect(typeof js.isKittyProtocolActive).toBe("function");
		expect(typeof js.parseKey).toBe("function");
		expect(typeof js.matchesKey).toBe("function");
	});

	/** The bench sets protocol state on both parsers; a write that does not stick makes the modes diverge. */
	it("keeps its own protocol state, independent of the shipped parser", () => {
		js.setKittyProtocolActive(false);
		expect(js.isKittyProtocolActive()).toBe(false);
		expect(native.isKittyProtocolActive()).toBe(KITTY_ACTIVE);

		js.setKittyProtocolActive(KITTY_ACTIVE);
		expect(js.isKittyProtocolActive()).toBe(KITTY_ACTIVE);
	});
});

describe("every sample", () => {
	/**
	 * `expected` is the shipped contract: these ids are what keybindings are spelled with, so a
	 * sample whose expectation drifts from the parser is either a stale bench or a regression, and
	 * the bench cannot tell you which if it never runs.
	 */
	it.each(samples.map(sample => [sample.name, sample] as const))(
		"resolves %s to its expected key",
		(_name, sample) => {
			expect(native.parseKey(sample.data)).toBe(sample.expected);
			expect(nativeParseKey(sample.data, KITTY_ACTIVE) ?? undefined).toBe(sample.expected);
		},
	);

	/**
	 * The baseline is allowed to differ, and does on three samples, but only where the difference is
	 * WRITTEN DOWN as `legacyJs`. An undeclared difference means the two parsers being timed against
	 * each other are answering different questions, which makes the speedup a comparison of two
	 * behaviours rather than two implementations.
	 */
	it.each(samples.map(sample => [sample.name, sample] as const))(
		"has a declared baseline answer for %s",
		(_name, sample) => {
			expect(js.parseKey(sample.data)).toBe(sample.legacyJs ?? sample.expected);
		},
	);
});

describe("the sample table itself", () => {
	it("has no duplicate inputs and no empty expectation", () => {
		const inputs = samples.map(sample => sample.data);

		expect(new Set(inputs).size).toBe(inputs.length);
		for (const sample of samples) {
			expect(sample.expected.length).toBeGreaterThan(0);
			expect(sample.name.length).toBeGreaterThan(0);
		}
	});

	/**
	 * A `legacyJs` equal to `expected` records a difference that does not exist, which is how a
	 * table of exceptions grows until it excuses everything.
	 */
	it("never declares a baseline difference that is not one", () => {
		for (const sample of samples) {
			if (sample.legacyJs !== undefined) expect(sample.legacyJs).not.toBe(sample.expected);
		}
	});

	/** The three known supersessions, named so that a fourth appearing is a deliberate decision. */
	it("declares exactly the three superseded behaviours", () => {
		const superseded = samples.filter(sample => sample.legacyJs !== undefined).map(sample => sample.name);

		expect(superseded).toEqual(["kitty base-layout", "alt+left", "alt+right"]);
	});
});
