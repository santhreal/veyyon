/**
 * `generateDict` admits a candidate and charges a dictionary at stated
 * boundaries: the default 8-character floor, the `MAX_EXPANSION_BYTES` cap
 * measured in UTF-8 bytes, a handle that saves zero tokens, line structure
 * seen in one file, the coverage target reached exactly, an oversized entry
 * that leaves room for a smaller one, and pinned entries that are charged in
 * full and never score below zero.
 *
 * Every case runs on a character-count tokenizer and a `|`-split extractor so
 * each boundary is reached by arithmetic rather than by the default heuristics.
 * Gap: the default extractor and tokenizer are covered by generate.test.ts and
 * generate-property.test.ts, not here.
 */
import { describe, expect, it } from "bun:test";
import { DEFAULT_SIGIL, MAX_EXPANSION_BYTES, SUPPORTED_VERSION } from "../src/constants.js";
import { type GenerateOptions, generateDict } from "../src/generate.js";
import type { Vocabulary } from "../src/types.js";

/** One token per UTF-16 code unit; `§abcd`, the mnemonic scoring probe, costs 5. */
const charTokens = (text: string): number => text.length;

const BASE: GenerateOptions = {
	countTokens: charTokens,
	extract: text => text.split("|"),
	savingsCoverage: 1,
	tokenBudget: 1_000_000,
};

/** Two files that each contain every string once: frequency 2, document frequency 2. */
function inTwoFiles(...strings: string[]): string[] {
	return [strings.join("|"), strings.join("|")];
}

function expansions(corpus: string[], options: GenerateOptions = {}): string[] {
	return generateDict(corpus, { ...BASE, ...options })
		.handles.map(handle => handle.expansion)
		.sort();
}

function pinned(sigil: string, entries: Array<[string, string]>): Vocabulary {
	return { version: SUPPORTED_VERSION, sigil, handles: new Map(entries), meta: new Map() };
}

describe("candidate admission", () => {
	it("admits 8 characters and rejects 7 under the default length floor", () => {
		expect(expansions(inTwoFiles("abcdefg", "abcdefgh"))).toEqual(["abcdefgh"]);
	});

	it("caps an expansion in UTF-8 bytes, not characters", () => {
		const atCap = "é".repeat(MAX_EXPANSION_BYTES / 2);
		const overCap = "ü".repeat(MAX_EXPANSION_BYTES / 2 + 1);
		expect(overCap.length).toBeLessThan(MAX_EXPANSION_BYTES);
		expect(expansions(inTwoFiles(atCap, overCap))).toEqual([atCap]);
	});

	it("rejects a handle that costs as many tokens as the string it replaces", () => {
		expect(expansions(inTwoFiles("vwxyz", "uvwxyz"), { minExpansionLength: 1 })).toEqual(["uvwxyz"]);
	});

	it("rejects line structure repeated inside one file and admits it across two", () => {
		const structure = "\n\tif (";
		const oneFile = [Array.from({ length: 20 }, () => structure).join("|")];
		expect(expansions(oneFile)).toEqual([]);
		expect(expansions(inTwoFiles(structure))).toEqual([structure]);
	});
});

describe("filling the budget", () => {
	const small = "pkg/run.sh";
	const large = "/workspace/longer/directory/structure.ts";

	it("skips an entry that does not fit and keeps filling with a smaller one", () => {
		const smallOnly = generateDict(inTwoFiles(small), BASE);
		expect(smallOnly.handles.map(handle => handle.expansion)).toEqual([small]);

		const both = generateDict(inTwoFiles(large, small), { ...BASE, tokenBudget: smallOnly.dictTokens });
		expect(both.handles.map(handle => handle.expansion)).toEqual([small]);
		expect(both.candidatesConsidered).toBe(2);
	});

	it("stops at the handle whose savings reach the coverage target exactly", () => {
		const result = generateDict(inTwoFiles("first/a.ts", "other/b.ts"), { ...BASE, savingsCoverage: 0.5 });
		expect(result.handles).toHaveLength(1);
		expect(result.handles[0]!.expansion).toBe("first/a.ts");
		expect(generateDict(inTwoFiles("first/a.ts", "other/b.ts"), BASE).handles).toHaveLength(2);
	});
});

describe("pinned entries", () => {
	const fresh = "pkg/run.sh";

	it("charges pinned entries like new ones: the dictionary is the header plus every entry", () => {
		const unpinned = generateDict(inTwoFiles(fresh), BASE);
		const header = unpinned.dictTokens - unpinned.handles[0]!.dictTokens;

		const vocab = pinned(DEFAULT_SIGIL, [["kept", "keep/this/path.ts"]]);
		const pinnedOnly = generateDict(["", ""], { ...BASE, pinned: vocab });
		expect(pinnedOnly.handles.map(handle => handle.name)).toEqual(["kept"]);
		expect(pinnedOnly.dictTokens).toBe(header + pinnedOnly.handles[0]!.dictTokens);
	});

	it("leaves no room for a new entry the pinned entries already used up", () => {
		const budget = generateDict(inTwoFiles(fresh), BASE).dictTokens;
		const result = generateDict(inTwoFiles(fresh), {
			...BASE,
			tokenBudget: budget,
			pinned: pinned(DEFAULT_SIGIL, [["kept", "keep/this/path.ts"]]),
		});
		expect(result.handles.map(handle => handle.name)).toEqual(["kept"]);
	});

	it("scores a pinned handle longer than its expansion at zero, never below", () => {
		const result = generateDict(inTwoFiles("xyz"), {
			...BASE,
			minExpansionLength: 1,
			pinned: pinned(DEFAULT_SIGIL, [["abcdefgh", "xyz"]]),
		});
		expect(result.handles).toEqual([
			expect.objectContaining({ name: "abcdefgh", expansion: "xyz", frequency: 2, savedTokens: 0 }),
		]);
		expect(result.estimatedSavings).toBe(0);
	});

	it("takes the sigil option when the pinned vocabulary holds no handles", () => {
		expect(generateDict(inTwoFiles(fresh), { ...BASE, sigil: "~", pinned: pinned("@", []) }).vocab.sigil).toBe("~");
		expect(
			generateDict(inTwoFiles(fresh), { ...BASE, sigil: "~", pinned: pinned("@", [["kept", "keep/this/path.ts"]]) })
				.vocab.sigil,
		).toBe("@");
	});
});
