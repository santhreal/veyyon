import { describe, expect, it } from "bun:test";
import { dedupeAlwaysApplyRules, dedupePromptSource, promptSourceContainsRule } from "../../src/system-prompt";

/**
 * Pure-function unit tests for prompt-source deduplication. (The end-to-end
 * assembly path is covered separately by test/system-prompt-dedup.test.ts; this
 * suite pins the matcher itself.) Prompt-source deduplication decides whether a rule or a prompt block is
 * already present in another prompt source and should therefore be dropped from
 * the assembled system prompt. Getting this wrong is a capability bug in both
 * directions: a false positive silently DROPS an instruction the model should
 * see, and a false negative repeats the same text (noise). The matcher is
 * deliberately conservative (exact block match, contiguous run), so these tests
 * pin that it drops ONLY on a verbatim contiguous match and keeps everything
 * else, including the block-boundary behavior inherited from prompt.format.
 */

describe("promptSourceContainsRule", () => {
	it("matches a single-block rule present verbatim in the source", () => {
		expect(promptSourceContainsRule("Rule A body", "Rule A body")).toBe(true);
	});

	it("does not match a rule absent from the source", () => {
		expect(promptSourceContainsRule("Something else entirely", "Rule A body")).toBe(false);
	});

	it("matches a multi-block rule that appears as a contiguous run of blocks", () => {
		expect(promptSourceContainsRule("intro\n\np1\n\np2\n\nend", "p1\n\np2")).toBe(true);
	});

	it("does not match multi-block rule content that is interrupted in the source", () => {
		// p1 and p2 both appear, but a MID block sits between them, so the rule is
		// not contiguously contained and must be kept (conservative direction).
		expect(promptSourceContainsRule("p1\n\nMID\n\np2", "p1\n\np2")).toBe(false);
	});

	it("does not match when the rule has more blocks than the source", () => {
		expect(promptSourceContainsRule("p1\n\np2", "p1\n\np2\n\np3")).toBe(false);
	});

	it("does not match when a block is reworded (exact block equality required)", () => {
		expect(promptSourceContainsRule("p1\n\np2-different", "p1\n\np2")).toBe(false);
	});

	it("is insensitive to trailing whitespace (prompt.format trims line ends before comparing)", () => {
		expect(promptSourceContainsRule("Rule A", "Rule A   ")).toBe(true);
	});

	it("collapses a rule's 2+ blank lines into one block (prompt.format removes blank runs)", () => {
		// "p1\n\n\np2" has a DOUBLE blank line. format collapses runs of 2+ blanks
		// entirely, so the two paragraphs become a single block "p1\np2". It then
		// matches a source that contains that merged block, but NOT a source where
		// the same paragraphs are separated by a single blank (two blocks).
		expect(promptSourceContainsRule("before\n\np1\np2\n\nafter", "p1\n\n\np2")).toBe(true);
		expect(promptSourceContainsRule("before\n\np1\n\np2\n\nafter", "p1\n\n\np2")).toBe(false);
	});

	it("returns false for an empty rule or an empty source", () => {
		expect(promptSourceContainsRule("anything", "")).toBe(false);
		expect(promptSourceContainsRule("", "anything")).toBe(false);
		expect(promptSourceContainsRule(null, "anything")).toBe(false);
		expect(promptSourceContainsRule(undefined, "anything")).toBe(false);
	});
});

describe("dedupeAlwaysApplyRules", () => {
	const rule = (name: string, content: string) => ({ name, content, path: `/${name}` });

	it("drops rules whose content is verbatim-present in any prompt source", () => {
		const kept = dedupeAlwaysApplyRules([rule("a", "Rule A body")], ["Rule A body"]);
		expect(kept).toEqual([]);
	});

	it("keeps rules that are not present in any source", () => {
		const rules = [rule("a", "Rule A body")];
		expect(dedupeAlwaysApplyRules(rules, ["unrelated content"])).toEqual(rules);
	});

	it("checks every prompt source, dropping a rule found in a later one", () => {
		const kept = dedupeAlwaysApplyRules([rule("a", "Rule A body")], ["first source", "wraps Rule A body inside", "Rule A body"]);
		expect(kept).toEqual([]);
	});

	it("keeps only the rules not covered, preserving order and identity", () => {
		const a = rule("a", "Alpha rule");
		const b = rule("b", "Beta rule");
		const c = rule("c", "Gamma rule");
		const kept = dedupeAlwaysApplyRules([a, b, c], ["Beta rule"]);
		expect(kept).toEqual([a, c]);
	});

	it("returns an empty array for undefined or empty rule input", () => {
		expect(dedupeAlwaysApplyRules(undefined, ["x"])).toEqual([]);
		expect(dedupeAlwaysApplyRules([], ["x"])).toEqual([]);
	});
});

describe("dedupePromptSource", () => {
	it("returns empty string when the source is contained in another source", () => {
		expect(dedupePromptSource("X", ["intro\n\nX"])).toBe("");
	});

	it("returns the source unchanged when it is not contained elsewhere", () => {
		expect(dedupePromptSource("X", ["unrelated"])).toBe("X");
	});

	it("returns empty string for an empty, null, or whitespace-only source", () => {
		expect(dedupePromptSource("", ["x"])).toBe("");
		expect(dedupePromptSource(null, ["x"])).toBe("");
		expect(dedupePromptSource("   ", ["x"])).toBe("");
	});

	it("trims the returned source (firstNonEmpty normalization)", () => {
		expect(dedupePromptSource("  keep me  ", ["unrelated"])).toBe("keep me");
	});
});
