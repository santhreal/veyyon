import { describe, expect, it } from "bun:test";
import { ALNUM_RE, ALNUM_WORD_RE, hasAlphanumeric, NON_ALNUM_RUN_RE } from "../src/regex";
import { collectPackageSources } from "./support/package-sources";

// Repo-wide source lock: the plain alphanumeric character class
// `[\p{L}\p{N}]` (letters + numbers, nothing else) has exactly ONE owner,
// packages/utils/src/regex.ts, which exports ALNUM_RE / hasAlphanumeric /
// NON_ALNUM_RUN_RE / ALNUM_WORD_RE. Hand-rolled inline copies drift (a
// has-substantive-char predicate lived in two files, a word-split separator in
// five) — import the owner instead.
//
// The needle is `\p{L}\p{N}]` — a `]` immediately after `\p{N}` closes a class
// that holds ONLY letters and numbers. Tokenizers that add underscores or path
// punctuation (mnemopi's `[\p{L}\p{N}_]+`, the modes path-boundary classes)
// carry extra characters before the `]`, so they never contain this needle and
// are correctly left to their own owners — they are a different charset, not a
// copy of this one.
//
// GRANDFATHERED lists sites that still carry the plain inline class. Convert a
// file, remove its entry — a stale entry fails the lock so the list only shrinks.
const GRANDFATHERED = new Set<string>([
	// Empty: every plain-alnum inline class now imports the owner from
	// @veyyon/utils. The remaining raw occurrences are either a different charset
	// (mnemopi tokenizers with `_`) or the modes/ UI lane, both skipped below.
]);

// The plain-alnum class signature. A production file that literally contains
// this substring hard-codes the idiom the owner replaces.
const PLAIN_ALNUM_CLASS = "\\p{L}\\p{N}]";

// The monorepo walk + skip-set is shared with every other source-ownership lock
// (see ./support/package-sources). modes/ is scanned too (not skipped) since
// H1-12 repointed history-search onto the owner; its only remaining raw unicode
// classes (magic-keyword-boundary) use a wider charset the plain-class signature
// above deliberately does not match.

describe("alphanumeric class owner", () => {
	it("hasAlphanumeric is true only when a letter or number is present", () => {
		expect(hasAlphanumeric("abc")).toBe(true);
		expect(hasAlphanumeric("123")).toBe(true);
		expect(hasAlphanumeric("café")).toBe(true);
		expect(hasAlphanumeric("日本語")).toBe(true);
		expect(hasAlphanumeric("word ends here.")).toBe(true);
		expect(hasAlphanumeric("...")).toBe(false);
		expect(hasAlphanumeric("  \t\n ")).toBe(false);
		expect(hasAlphanumeric("—·—")).toBe(false);
		expect(hasAlphanumeric("")).toBe(false);
	});

	it("ALNUM_RE is non-global, so repeated .test() on the shared instance is stable", () => {
		expect(ALNUM_RE.test("a")).toBe(true);
		expect(ALNUM_RE.test("a")).toBe(true);
		expect(ALNUM_RE.test(".")).toBe(false);
		expect(ALNUM_RE.test(".")).toBe(false);
		expect(ALNUM_RE.global).toBe(false);
	});

	it("NON_ALNUM_RUN_RE collapses every run of separators to one boundary", () => {
		// Underscore is NOT in [\p{L}\p{N}] (unlike \w), so it counts as a separator.
		expect("a.b--c__d".replace(NON_ALNUM_RUN_RE, " ")).toBe("a b c d");
		expect("Stop.".replace(NON_ALNUM_RUN_RE, " ")).toBe("Stop ");
		expect("no issue; continue.".replace(NON_ALNUM_RUN_RE, " ")).toBe("no issue continue ");
		expect("  hi   there  ".split(NON_ALNUM_RUN_RE)).toEqual(["", "hi", "there", ""]);
		expect(NON_ALNUM_RUN_RE.global).toBe(true);
	});

	it("ALNUM_WORD_RE yields each maximal alphanumeric run", () => {
		expect("foo, bar! baz".match(ALNUM_WORD_RE)).toEqual(["foo", "bar", "baz"]);
		expect(Array.from("a1 b2".matchAll(ALNUM_WORD_RE), m => m[0])).toEqual(["a1", "b2"]);
		// matchAll spec-clones the regex, so the shared global instance carries no
		// lastIndex between calls — a second pass sees the same words.
		expect(Array.from("a1 b2".matchAll(ALNUM_WORD_RE), m => m[0])).toEqual(["a1", "b2"]);
		expect(ALNUM_WORD_RE.global).toBe(true);
	});
});

describe("plain-alnum class source lock", () => {
	it("no production source hard-codes [\\p{L}\\p{N}] outside the owner", async () => {
		const offenders: string[] = [];
		const cleared: string[] = [];
		const seen = new Set<string>();
		for (const { rel, text } of await collectPackageSources({ dirs: ["src"] })) {
			if (rel === "utils/src/regex.ts") continue;
			if (!text.includes(PLAIN_ALNUM_CLASS)) continue;
			seen.add(rel);
			if (!GRANDFATHERED.has(rel)) offenders.push(rel);
		}
		for (const rel of GRANDFATHERED) {
			if (!seen.has(rel)) cleared.push(rel);
		}
		expect(
			offenders,
			"inline [\\p{L}\\p{N}] class — import ALNUM_RE/NON_ALNUM_RUN_RE/ALNUM_WORD_RE from @veyyon/utils",
		).toEqual([]);
		expect(cleared, "grandfathered entries whose inline copy is gone — remove them from the list").toEqual([]);
	});
});
