import { describe, expect, it } from "bun:test";
import { resolveConfiguredModelPatterns } from "@veyyon/coding-agent/config/model-resolver";
import { Settings } from "@veyyon/coding-agent/config/settings";

/**
 * resolveConfiguredModelPatterns turns a user's `model = "..."` setting (a string or string[], possibly
 * comma-joined, possibly a role alias like "@smol") into the ordered list of concrete model-id patterns
 * the resolver matches against the registry. It had no direct test. Two layers of contract are pinned:
 *
 *   1. Normalization (the always-applied base): undefined/empty -> []; a comma-joined string and a
 *      string[] both split on commas; every entry is trimmed and blank entries dropped. A regression
 *      here would let stray whitespace or empty segments become bogus "patterns" that never match.
 *   2. Role-alias expansion: a role expands to the models the OPERATOR assigned it and to nothing
 *      else. An unset role contributes no pattern, so the caller applies inherit; a `:thinking`
 *      suffix is distributed onto every expanded pattern; a `@name` that matches no role expands to
 *      nothing rather than to a literal, since no model id starts with `@`.
 */
describe("resolveConfiguredModelPatterns", () => {
	describe("normalization (no role aliases)", () => {
		it("returns an empty list for undefined and empty input", () => {
			expect(resolveConfiguredModelPatterns(undefined)).toEqual([]);
			expect(resolveConfiguredModelPatterns("")).toEqual([]);
		});

		it("passes a single plain pattern through unchanged", () => {
			expect(resolveConfiguredModelPatterns("gpt-4o")).toEqual(["gpt-4o"]);
		});

		it("splits a comma-joined string, trimming each entry", () => {
			expect(resolveConfiguredModelPatterns("a, b ,c")).toEqual(["a", "b", "c"]);
		});

		it("splits every element of a string[] on commas and flattens", () => {
			expect(resolveConfiguredModelPatterns(["x , y", "z"])).toEqual(["x", "y", "z"]);
		});

		it("drops blank and whitespace-only segments", () => {
			expect(resolveConfiguredModelPatterns("a,,  ,b")).toEqual(["a", "b"]);
			expect(resolveConfiguredModelPatterns([" ", "keep"])).toEqual(["keep"]);
		});
	});

	describe("role-alias expansion", () => {
		/**
		 * An unset role names NO model of its own.
		 *
		 * It used to expand to `priority.json`, which is the defect the Subagents
		 * settings area was built to fix: agent frontmatter carried `@smol` / `@slow`
		 * / `@designer`, so a stock install ran its subagents on three different
		 * concrete models while every role picker said "inherit (follows main model)".
		 * Expansion must report "nothing here" and let the caller apply inherit.
		 */
		it("expands an unset role to nothing", () => {
			expect(resolveConfiguredModelPatterns("@smol")).toEqual([]);
			expect(resolveConfiguredModelPatterns("@slow")).toEqual([]);
			expect(resolveConfiguredModelPatterns("@designer")).toEqual([]);
		});

		it("expands a configured role to exactly the models assigned to it", () => {
			const settings = Settings.isolated({ modelRoles: { smol: "openai/gpt-4.1-mini, openai/gpt-4o-mini" } });

			expect(resolveConfiguredModelPatterns("@smol", settings)).toEqual([
				"openai/gpt-4.1-mini",
				"openai/gpt-4o-mini",
			]);
		});

		it("distributes a :thinking suffix onto every expanded pattern", () => {
			const settings = Settings.isolated({ modelRoles: { slow: "anthropic/claude-opus-4-5, openai/gpt-5" } });

			expect(resolveConfiguredModelPatterns("@slow:high", settings)).toEqual([
				"anthropic/claude-opus-4-5:high",
				"openai/gpt-5:high",
			]);
		});

		/**
		 * A `@name` that matches no role is not a model pattern either: no provider or
		 * model id starts with `@`. Passing it through literally only defers the
		 * failure to model matching, whose message says "no model matched" and never
		 * mentions the role that does not exist. This matters for the retired `@task`
		 * alias, which older agent files still carry.
		 */
		it("expands an unknown alias to nothing and leaves a bare pattern alone", () => {
			expect(resolveConfiguredModelPatterns("@notarole")).toEqual([]);
			expect(resolveConfiguredModelPatterns("@task")).toEqual([]);
			expect(resolveConfiguredModelPatterns("gpt-4o:low")).toEqual(["gpt-4o:low"]);
		});
	});
});
