import { describe, expect, it } from "bun:test";
import { parseRuleConditionAndScope, type RuleFrontmatter } from "@veyyon/coding-agent/capability/rule";

/**
 * parseRuleConditionAndScope turns raw rule frontmatter into the condition/scope a rule matches
 * on. It had no direct test, yet it encodes several load-bearing behaviors that quietly change
 * which rules fire: the legacy ttsr_trigger/ttsrTrigger fallback, the file-glob shorthand that
 * rewrites `*.rs` into edit/write tool scopes plus a catch-all `.*` condition, the astCondition
 * verbatim passthrough, and a quote/paren/bracket/brace-aware comma split for scope lists. These
 * pin each so a refactor cannot silently drop a legacy alias, mis-split a nested-comma scope, or
 * stop inferring glob scopes.
 */

const parse = (frontmatter: RuleFrontmatter) => parseRuleConditionAndScope(frontmatter);

describe("condition normalization", () => {
	it("keeps a plain condition and dedupes an array condition", () => {
		expect(parse({ condition: "big diff" })).toEqual({
			condition: ["big diff"],
			astCondition: undefined,
			scope: undefined,
		});
		expect(parse({ condition: ["a", "a", "b"] }).condition).toEqual(["a", "b"]);
	});

	it("treats a token with a regex metachar or no glob char as a plain condition", () => {
		expect(parse({ condition: "foo|bar" }).condition).toEqual(["foo|bar"]);
		expect(parse({ condition: "plainword" }).condition).toEqual(["plainword"]);
	});

	it("drops a blank condition and an empty frontmatter to all-undefined", () => {
		expect(parse({ condition: "   " })).toEqual({ condition: undefined, astCondition: undefined, scope: undefined });
		expect(parse({})).toEqual({ condition: undefined, astCondition: undefined, scope: undefined });
	});
});

describe("legacy ttsr trigger fallback", () => {
	it("accepts ttsr_trigger and ttsrTrigger as a condition source", () => {
		expect(parse({ ttsr_trigger: "trig" }).condition).toEqual(["trig"]);
		expect(parse({ ttsrTrigger: "trig2" }).condition).toEqual(["trig2"]);
	});

	it("prefers an explicit condition over the legacy trigger", () => {
		expect(parse({ condition: "primary", ttsr_trigger: "legacy" }).condition).toEqual(["primary"]);
	});
});

describe("file-glob shorthand inference", () => {
	it("rewrites a bare *.ext glob into edit/write tool scopes and a catch-all condition", () => {
		expect(parse({ condition: "*.rs" })).toEqual({
			condition: [".*"],
			astCondition: undefined,
			scope: ["tool:edit(*.rs)", "tool:write(*.rs)"],
		});
	});

	it("infers a path glob and keeps a non-glob token as the real condition", () => {
		expect(parse({ condition: "src/**/*.ts" }).scope).toEqual(["tool:edit(src/**/*.ts)", "tool:write(src/**/*.ts)"]);
		expect(parse({ condition: ["*.rs", "big change"] })).toEqual({
			condition: ["big change"],
			astCondition: undefined,
			scope: ["tool:edit(*.rs)", "tool:write(*.rs)"],
		});
	});
});

describe("astCondition and scope splitting", () => {
	it("keeps astCondition verbatim without glob inference", () => {
		expect(parse({ astCondition: "console.log($A)" }).astCondition).toEqual(["console.log($A)"]);
	});

	it("splits a scope CSV only on top-level commas, respecting parens and quotes", () => {
		expect(parse({ scope: "tool:edit, tool:write" }).scope).toEqual(["tool:edit", "tool:write"]);
		expect(parse({ scope: "tool:edit(a,b), tool:write" }).scope).toEqual(["tool:edit(a,b)", "tool:write"]);
		expect(parse({ scope: 'tool:x("a,b"), tool:y' }).scope).toEqual(['tool:x("a,b")', "tool:y"]);
	});
});
