import { describe, expect, it } from "bun:test";
import { resolveConfiguredModelPatterns } from "@veyyon/coding-agent/config/model-resolver";

/**
 * resolveConfiguredModelPatterns turns a user's `model = "..."` setting (a string or string[], possibly
 * comma-joined, possibly a role alias like "@smol") into the ordered list of concrete model-id patterns
 * the resolver matches against the registry. It had no direct test. Two layers of contract are pinned:
 *
 *   1. Normalization (the always-applied base): undefined/empty -> []; a comma-joined string and a
 *      string[] both split on commas; every entry is trimmed and blank entries dropped. A regression
 *      here would let stray whitespace or empty segments become bogus "patterns" that never match.
 *   2. Role-alias expansion (with no Settings, so built-in priority defaults apply): a known role alias
 *      expands to a non-empty ordered list; two aliases of the same role ("@smol"/"@tiny") expand
 *      identically; a `:thinking` suffix is distributed onto every expanded pattern; an unknown alias
 *      (or a bare non-alias) passes through literally. The exact model-id lists live in priority.json
 *      and change over time, so these tests assert the STABLE relationships, not the volatile ids.
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

	describe("role-alias expansion (built-in priority defaults, no Settings)", () => {
		it("expands a known role alias to a non-empty ordered list", () => {
			const expanded = resolveConfiguredModelPatterns("@smol");
			expect(expanded.length).toBeGreaterThan(0);
			// It is an expansion, not a literal pass-through of the alias.
			expect(expanded).not.toContain("@smol");
		});

		it("expands two aliases of the same role identically", () => {
			// "@tiny" aliases to the same "smol" priority group as "@smol".
			expect(resolveConfiguredModelPatterns("@tiny")).toEqual(resolveConfiguredModelPatterns("@smol"));
		});

		it("distributes a :thinking suffix onto every expanded pattern", () => {
			const base = resolveConfiguredModelPatterns("@smol");
			const suffixed = resolveConfiguredModelPatterns("@smol:high");
			expect(suffixed).toEqual(base.map(pattern => `${pattern}:high`));
		});

		it("passes an unknown alias and a bare non-alias through literally", () => {
			expect(resolveConfiguredModelPatterns("@notarole")).toEqual(["@notarole"]);
			expect(resolveConfiguredModelPatterns("gpt-4o:low")).toEqual(["gpt-4o:low"]);
		});
	});
});
