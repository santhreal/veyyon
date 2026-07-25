/**
 * A generated dictionary stops when it has bought what there is to buy.
 *
 * WHY THIS SUITE EXISTS. The generator ranks candidates by value and then filled
 * its token budget to the brim, which sounds thorough and is the wrong trade.
 * The ranking is steep. Measured over three unrelated corpora in this repository
 * (`packages/coding-agent/src/tools`, `packages/argot/src`, `packages/tui/src`),
 * the top ten handles carried about two thirds of the estimated savings for
 * under a twentieth of the budget, and the top thirty carried roughly 86% for
 * about a sixth. Filling the rest spent around 83% of the dictionary on the last
 * 14% of the value. The direction matters: a dictionary is INPUT carried on
 * every turn, while its savings are OUTPUT produced once, so the tail is a
 * standing cost against a one-off gain.
 *
 * `savingsCoverage` cuts the ranked list at the point where the target fraction
 * of the achievable savings has been reached. It is a fraction rather than a
 * smaller token budget deliberately: a budget is absolute, so any number chosen
 * would bind differently on a small repository than a large one and would need
 * retuning whenever the corpus or the tokenizer moved. A ratio of savings to
 * savings means the same thing at every scale.
 *
 * The subtle part, and the reason for the achievable-set test below: coverage
 * has to be measured against what the budget can actually hold, not against
 * every candidate ever scored. On a large corpus the ranked tail sums to more
 * than the budget could ever fit, so a target taken over all candidates is
 * unreachable and the rule quietly does nothing -- precisely where the tail is
 * longest. The first implementation had that bug and it was invisible from the
 * small corpora: two of three shrank and the largest did not move at all.
 */
import { describe, expect, it } from "bun:test";
import { DEFAULT_SAVINGS_COVERAGE } from "../src/constants.js";
import { generateDict } from "../src/generate.js";

/**
 * A deterministic corpus of twelve near-identical TypeScript samples.
 *
 * Built in the test rather than read from the repository so the exact numbers
 * asserted below cannot drift when unrelated source files change. The samples
 * share their indentation structure and differ only in an index, which is the
 * shape real agent output has: heavily repeated line structure with a thin tail
 * of per-file identifiers.
 */
function sample(index: number): string {
	return [
		`import { helper${index} } from "./module-${index}/deep/nested/path.js";`,
		`export function processRecord${index}(input: string): string {`,
		`\tconst normalized = input.trim();`,
		`\tif (normalized.length === 0) {`,
		`\t\treturn "";`,
		`\t}`,
		`\tfor (const part of normalized.split(",")) {`,
		`\t\tif (part.startsWith("prefix")) {`,
		`\t\t\treturn helper${index}(part);`,
		`\t\t}`,
		`\t}`,
		`\treturn normalized;`,
		`}`,
	].join("\n");
}

const CORPUS = Array.from({ length: 12 }, (_, i) => sample(i));

describe("savingsCoverage", () => {
	it("cuts the ranked list at the configured fraction, with exact size and cost", () => {
		// Real numbers, not a "fewer than before" comparison: a size assertion that
		// only says "smaller" passes for a rule that drops one handle and for a rule
		// that drops all of them.
		const at85 = generateDict(CORPUS, { savingsCoverage: 0.85 });
		expect(at85.handles).toHaveLength(7);
		expect(at85.dictTokens).toBe(43);
		expect(at85.estimatedSavings).toBe(492);

		const at90 = generateDict(CORPUS, { savingsCoverage: 0.9 });
		expect(at90.handles).toHaveLength(8);
		expect(at90.dictTokens).toBe(49);
		expect(at90.estimatedSavings).toBe(528);
	});

	it("fills the budget when coverage is 1, which is the behaviour it replaced", () => {
		// The old behaviour stays reachable, so the change is a default and not a
		// capability removal. It is also the baseline the cut is measured against.
		const full = generateDict(CORPUS, { savingsCoverage: 1 });
		expect(full.handles).toHaveLength(10);
		expect(full.dictTokens).toBe(59);
		expect(full.estimatedSavings).toBe(576);
	});

	it("actually reaches the fraction it promises, and does not overshoot by more than one handle", () => {
		// The contract is a SHORTEST prefix meeting the target. Asserting only
		// "reached the target" would pass for a rule that never cut anything.
		const full = generateDict(CORPUS, { savingsCoverage: 1 });
		for (const coverage of [0.5, 0.6, 0.7, 0.8, 0.85, 0.9, 0.95]) {
			const cut = generateDict(CORPUS, { savingsCoverage: coverage });
			expect(cut.estimatedSavings).toBeGreaterThanOrEqual(full.estimatedSavings * coverage);
			const oneShorter = cut.handles.slice(0, -1).reduce((sum, h) => sum + h.savedTokens, 0);
			expect(oneShorter).toBeLessThan(full.estimatedSavings * coverage);
		}
	});

	it("selects a strict prefix of the full ranking, never a cheaper handle from further down", () => {
		// Reaching past the cut for a smaller entry that still fits the budget would
		// admit a strictly worse handle while claiming the same coverage, so the cut
		// must be a prefix and not a knapsack.
		const full = generateDict(CORPUS, { savingsCoverage: 1 });
		const cut = generateDict(CORPUS, { savingsCoverage: 0.85 });
		expect(cut.handles.map(h => h.name)).toEqual(full.handles.slice(0, cut.handles.length).map(h => h.name));
		expect(cut.handles.map(h => h.expansion)).toEqual(
			full.handles.slice(0, cut.handles.length).map(h => h.expansion),
		);
	});

	it("is monotonic: lowering coverage never adds a handle or a token", () => {
		// A non-monotonic knob is unusable — an operator lowering it to shrink the
		// dictionary would sometimes grow it.
		const steps = [0.5, 0.6, 0.7, 0.8, 0.85, 0.9, 0.95, 1];
		const results = steps.map(c => generateDict(CORPUS, { savingsCoverage: c }));
		for (let i = 1; i < results.length; i++) {
			expect(results[i]!.handles.length).toBeGreaterThanOrEqual(results[i - 1]!.handles.length);
			expect(results[i]!.dictTokens).toBeGreaterThanOrEqual(results[i - 1]!.dictTokens);
			expect(results[i]!.estimatedSavings).toBeGreaterThanOrEqual(results[i - 1]!.estimatedSavings);
		}
	});

	it("defaults to DEFAULT_SAVINGS_COVERAGE rather than to filling the budget", () => {
		// The default IS the fix. A version that shipped the option but left the
		// default at "fill the budget" would change nothing for anyone.
		const explicit = generateDict(CORPUS, { savingsCoverage: DEFAULT_SAVINGS_COVERAGE });
		const implicit = generateDict(CORPUS);
		expect(implicit.handles.map(h => h.name)).toEqual(explicit.handles.map(h => h.name));
		expect(implicit.dictTokens).toBe(explicit.dictTokens);
		expect(DEFAULT_SAVINGS_COVERAGE).toBeLessThan(1);
	});

	it("measures coverage against what the budget can hold, not against every candidate", () => {
		// The bug this locks out. When the ranked tail sums to more than the budget
		// can fit, a target taken over ALL scored candidates is unreachable and the
		// rule silently does nothing. A tiny budget makes the achievable set a small
		// fraction of the scored set, so a rule with that bug fills the budget
		// exactly and this fails.
		const tiny = generateDict(CORPUS, { tokenBudget: 50, savingsCoverage: 0.85 });
		const tinyFull = generateDict(CORPUS, { tokenBudget: 50, savingsCoverage: 1 });
		expect(tinyFull.handles).toHaveLength(8);
		expect(tinyFull.dictTokens).toBe(49);
		expect(tiny.handles).toHaveLength(6);
		expect(tiny.dictTokens).toBe(37);
		// And the budget is still a hard ceiling, whichever rule binds.
		expect(tinyFull.dictTokens).toBeLessThanOrEqual(50);
	});

	it("never drops a pinned handle to meet the target", () => {
		// Pinned bindings are what keeps already-written handles expandable, so
		// coverage must not be able to retire one. They count toward the target
		// instead.
		const full = generateDict(CORPUS, { savingsCoverage: 1 });
		const handles = new Map(full.handles.slice(0, 3).map(h => [h.name, h.expansion]));
		const pinned = { version: full.vocab.version, sigil: full.vocab.sigil, handles, meta: new Map() };
		const cut = generateDict(CORPUS, { savingsCoverage: 0.5, pinned });
		for (const [name, expansion] of handles) {
			expect(cut.vocab.handles.get(name)).toBe(expansion);
		}
	});

	it("emits a dictionary that still round-trips through the parser", () => {
		// Truncating the ranked list must not produce a file the loader rejects,
		// and an empty [handles] table is not a valid dictionary.
		const cut = generateDict(CORPUS, { savingsCoverage: 0.85 });
		expect(cut.toml).toContain("[handles]");
		expect(cut.vocab.handles.size).toBe(cut.handles.length);
		for (const handle of cut.handles) {
			expect(cut.vocab.handles.get(handle.name)).toBe(handle.expansion);
		}
	});
});
