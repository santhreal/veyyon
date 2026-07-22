import { describe, expect, it } from "bun:test";
import { stripTypePrefix } from "../../src/commit/analysis/summary";

/**
 * stripTypePrefix removes a redundant conventional-commit header ("feat(api): ",
 * "fix: ") that a model sometimes prepends to the summary line, so the header is
 * not doubled when the commit message is assembled. It is used by both the
 * summary generator and the agentic validation path, yet had no direct test.
 *
 * The behavior has several sharp edges worth pinning:
 *   - the scoped form is stripped only when a scope is supplied AND present;
 *     with scope=null a "type(scope): " prefix is left intact (only "type: " is
 *     considered);
 *   - a single space after the colon is required ("feat:add" is not a prefix);
 *   - matching is CASE-SENSITIVE ("FEAT: " is not stripped for type "feat");
 *   - the input is trimmed BEFORE the prefix check, so a summary that is only
 *     the prefix plus trailing space is not stripped (the trailing space is gone
 *     by the time the check runs);
 *   - only the outermost prefix is removed, never recursively.
 */

describe("stripTypePrefix", () => {
	it("strips a scoped header when the scope is supplied and present", () => {
		expect(stripTypePrefix("feat(api): add pagination", "feat", "api")).toBe("add pagination");
	});

	it("strips an unscoped header when scope is null", () => {
		expect(stripTypePrefix("feat: add pagination", "feat", null)).toBe("add pagination");
	});

	it("leaves a scoped header intact when scope is null (only 'type: ' is considered)", () => {
		expect(stripTypePrefix("feat(api): add pagination", "feat", null)).toBe("feat(api): add pagination");
	});

	it("trims surrounding whitespace before and after stripping", () => {
		expect(stripTypePrefix("  feat: add pagination  ", "feat", null)).toBe("add pagination");
	});

	it("requires a space after the colon to treat it as a header", () => {
		expect(stripTypePrefix("feat:add pagination", "feat", null)).toBe("feat:add pagination");
	});

	it("is case-sensitive: an upper-case type is not stripped", () => {
		expect(stripTypePrefix("FEAT: add", "feat", null)).toBe("FEAT: add");
	});

	it("does not strip when the summary carries no header", () => {
		expect(stripTypePrefix("add pagination", "feat", "api")).toBe("add pagination");
	});

	it("removes only the outer header, not a second one embedded in the text", () => {
		expect(stripTypePrefix("fix(ui): feat: nested phrasing", "fix", "ui")).toBe("feat: nested phrasing");
	});

	it("does not strip a prefix-only summary once its trailing space is trimmed away", () => {
		// "feat(api): ".trim() === "feat(api):", which does not start with the
		// "feat(api): " prefix (that has a trailing space), so it is returned as-is.
		expect(stripTypePrefix("feat(api): ", "feat", "api")).toBe("feat(api):");
	});
});
