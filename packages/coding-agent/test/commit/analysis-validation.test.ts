import { describe, expect, it } from "bun:test";
import { validateAnalysis, validateScope, validateSummary } from "@veyyon/coding-agent/commit/analysis/validation";
import type { ConventionalAnalysis } from "@veyyon/coding-agent/commit/types";

/**
 * The low-level conventional-commit validators had no direct tests. They define
 * the concrete rules the agentic and single-pass commit paths enforce: a summary
 * is non-empty, within a length budget, single-line, and has no trailing period;
 * a scope is at most two lowercase slash segments of a restricted alphabet; and
 * a detail is a non-empty sentence ending in a period under 120 characters.
 * These tests pin each message so the rules cannot drift unnoticed.
 */

function analysis(overrides: Partial<ConventionalAnalysis>): ConventionalAnalysis {
	return { type: "feat", scope: null, details: [], issueRefs: [], ...overrides };
}

describe("validateSummary", () => {
	it("accepts a well-formed summary", () => {
		expect(validateSummary("added retries to the client", 72)).toEqual({ valid: true, errors: [] });
	});

	it("rejects an empty or whitespace-only summary", () => {
		expect(validateSummary("   ", 72).errors).toContain("Summary is empty");
	});

	it("rejects a summary past the character budget", () => {
		expect(validateSummary("x".repeat(73), 72).errors).toContain("Summary exceeds 72 characters");
	});

	it("rejects a trailing period", () => {
		expect(validateSummary("fixed the bug.", 72).errors).toContain("Summary must not end with a period");
	});

	it("rejects a multi-line summary", () => {
		expect(validateSummary("fixed the bug\nand another", 72).errors).toContain("Summary must be a single line");
	});
});

describe("validateScope", () => {
	it("treats a null or empty scope as valid", () => {
		expect(validateScope(null)).toEqual({ valid: true, errors: [] });
		expect(validateScope("")).toEqual({ valid: true, errors: [] });
	});

	it("accepts one or two lowercase segments", () => {
		expect(validateScope("api")).toEqual({ valid: true, errors: [] });
		expect(validateScope("api/client")).toEqual({ valid: true, errors: [] });
		expect(validateScope("a-b_c/d0")).toEqual({ valid: true, errors: [] });
	});

	it("rejects more than two segments", () => {
		expect(validateScope("a/b/c").errors).toContain("Scope may contain at most two segments");
	});

	it("rejects an empty segment from a trailing slash", () => {
		expect(validateScope("api/").errors).toContain("Scope segments cannot be empty");
	});

	it("rejects an uppercase scope", () => {
		expect(validateScope("API").errors).toContain("Scope must be lowercase");
	});

	it("rejects a segment with invalid characters", () => {
		expect(validateScope("a.b").errors).toContain("Scope segment has invalid characters: a.b");
	});
});

describe("validateAnalysis", () => {
	it("accepts an analysis whose details are period-terminated sentences", () => {
		const result = validateAnalysis(
			analysis({ scope: "api", details: [{ text: "Added a retry path.", userVisible: true }] }),
		);
		expect(result).toEqual({ valid: true, errors: [] });
	});

	it("flags a detail that is missing its terminating period", () => {
		const result = validateAnalysis(analysis({ details: [{ text: "Added a retry path", userVisible: true }] }));
		expect(result.errors).toContain("Detail must end with a period: Added a retry path");
	});

	it("flags an empty detail", () => {
		expect(validateAnalysis(analysis({ details: [{ text: "   ", userVisible: false }] })).errors).toContain(
			"Detail text is empty",
		);
	});

	it("flags a detail over 120 characters", () => {
		const long = `${"a".repeat(121)}.`;
		expect(validateAnalysis(analysis({ details: [{ text: long, userVisible: false }] })).errors).toContain(
			`Detail exceeds 120 characters: ${long}`,
		);
	});

	it("propagates scope errors", () => {
		expect(validateAnalysis(analysis({ scope: "a/b/c" })).errors).toContain("Scope may contain at most two segments");
	});
});
