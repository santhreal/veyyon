/**
 * A query token typed twice needs two places to match.
 *
 * `normalizeForSearch` strips punctuation, so the version query `1.1` becomes
 * the two tokens `1` `1`. Each token was scored independently against the whole
 * candidate, so both were satisfied by the SINGLE `1` in `1.3.0`, and filtering
 * a version list by `1.1` kept every 1.x release. The user sees rows that
 * plainly do not contain what they typed and concludes the filter is broken.
 *
 * The rule is general, not a version special case: repeating a token in a query
 * is a request for that many of it. Queries whose tokens are all distinct — very
 * nearly every real query — are unaffected, which the last group here holds.
 */
import { describe, expect, it } from "bun:test";
import { fuzzyFilter, fuzzyMatch } from "@veyyon/tui/fuzzy";

const versions = ["1.3.0", "1.2.0", "1.1.0", "1.1.1", "2.1.0"];
const filter = (query: string) => fuzzyFilter(versions, query, v => v);

describe("a dotted numeric query", () => {
	it("keeps only the versions that really contain both parts", () => {
		// The regression, stated as the product behaviour: typing 1.1 in a version
		// picker shows the 1.1 releases.
		expect(filter("1.1")).toEqual(["1.1.0", "1.1.1"]);
	});

	it("does not match a version with a single 1", () => {
		expect(fuzzyMatch("1.1", "1.3.0").matches).toBe(false);
		expect(fuzzyMatch("1.1", "2.1.0").matches).toBe(false);
	});

	it("still matches when the repeats are spread across the value", () => {
		// `1.0.1` has its two 1s at opposite ends. Two distinct words is the whole
		// requirement; adjacency is not.
		expect(fuzzyMatch("1.1", "1.0.1").matches).toBe(true);
	});

	it("needs three when three are typed", () => {
		expect(fuzzyMatch("1.1.1", "1.1.0").matches).toBe(false);
		expect(fuzzyMatch("1.1.1", "1.1.1").matches).toBe(true);
	});

	it("matches a single-token query as before", () => {
		// One token has nothing to be distinct from, so this path is untouched.
		expect(filter("1")).toEqual(expect.arrayContaining(["1.3.0", "1.2.0"]));
	});
});

describe("a repeated word in prose", () => {
	it("wants the word twice", () => {
		expect(fuzzyMatch("test test", "run the test").matches).toBe(false);
		expect(fuzzyMatch("test test", "test the test runner").matches).toBe(true);
	});
});

describe("ordinary distinct-token queries", () => {
	it("are unaffected, in either order", () => {
		// The rule must not cost the common case anything: this is what every
		// settings search and autocomplete query looks like.
		expect(fuzzyMatch("auto update", "Automatic Updates").matches).toBe(true);
		expect(fuzzyMatch("update auto", "Automatic Updates").matches).toBe(true);
	});

	it("still reject a token that appears nowhere", () => {
		expect(fuzzyMatch("auto banana", "Automatic Updates").matches).toBe(false);
	});

	it("keep matching an empty query", () => {
		expect(fuzzyMatch("", "anything").matches).toBe(true);
	});
});
