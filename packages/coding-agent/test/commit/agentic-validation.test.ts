import { describe, expect, it } from "bun:test";
import {
	capDetails,
	MAX_DETAIL_ITEMS,
	normalizeSummary,
	SUMMARY_MAX_CHARS,
	validateSummaryRules,
	validateTypeConsistency,
} from "@veyyon/coding-agent/commit/agentic/validation";
import type { ConventionalDetail } from "@veyyon/coding-agent/commit/types";

/**
 * The agentic commit tools (propose_commit, split_commit) gate summaries and
 * details through this module, which had no tests. It enforces real contracts:
 * a 72-char summary limit, a past-tense-verb opener, filler/meta warnings, a
 * six-item detail cap that keeps the highest-priority items, and per-type file
 * consistency. These tests pin each rule so a change to the heuristics is a
 * deliberate, visible edit rather than a silent drift.
 */

function detail(text: string): ConventionalDetail {
	return { text, userVisible: false };
}

describe("normalizeSummary", () => {
	it("strips a type(scope) prefix and collapses internal whitespace", () => {
		expect(normalizeSummary("feat(api): added   the   thing", "feat", "api")).toBe("added the thing");
	});

	it("strips a bare type prefix when there is no scope", () => {
		expect(normalizeSummary("fix: resolved the bug", "fix", null)).toBe("resolved the bug");
	});

	it("leaves a summary without a matching prefix intact", () => {
		expect(normalizeSummary("added a thing", "feat", null)).toBe("added a thing");
	});
});

describe("validateSummaryRules past-tense gate", () => {
	it("accepts a known past-tense verb from the allow list", () => {
		expect(validateSummaryRules("Added support for retries").errors).not.toContain(
			"Summary must start with a past-tense verb",
		);
	});

	it("accepts an unknown -ed word as past tense", () => {
		expect(validateSummaryRules("Tweaked the parser").errors).not.toContain(
			"Summary must start with a past-tense verb",
		);
	});

	it("rejects an imperative opener", () => {
		expect(validateSummaryRules("Add support for retries").errors).toContain(
			"Summary must start with a past-tense verb",
		);
	});

	it("rejects an -ed exception word that is not a past-tense verb", () => {
		expect(validateSummaryRules("Red flags everywhere").errors).toContain(
			"Summary must start with a past-tense verb",
		);
	});
});

describe("validateSummaryRules basic-rule delegation", () => {
	it("flags a summary longer than SUMMARY_MAX_CHARS", () => {
		const summary = `Added ${"x".repeat(67)}`; // 6 + 67 = 73 chars
		expect(summary.length).toBe(73);
		expect(validateSummaryRules(summary).errors).toContain("Summary exceeds 72 characters");
	});

	it("flags a trailing period", () => {
		expect(validateSummaryRules("Fixed the bug.").errors).toContain("Summary must not end with a period");
	});
});

describe("validateSummaryRules style warnings", () => {
	it("warns on filler words and meta phrases without erroring", () => {
		const { warnings } = validateSummaryRules("Improved various parts of this commit");
		expect(warnings).toContain("Avoid filler word: improved");
		expect(warnings).toContain("Avoid filler word: various");
		expect(warnings).toContain("Avoid meta phrase: this commit");
	});
});

describe("capDetails", () => {
	it("returns the list unchanged when at or below the cap", () => {
		const details = [detail("a"), detail("b"), detail("c")];
		const result = capDetails(details);
		expect(result.details).toBe(details);
		expect(result.warnings).toEqual([]);
	});

	it("caps to MAX_DETAIL_ITEMS, keeping the highest-priority item and dropping the lowest", () => {
		const details = [
			detail("did thing 0"),
			detail("did thing 1"),
			detail("did thing 2"),
			detail("did thing 3"),
			detail("did thing 4"),
			detail("did thing 5"),
			detail("security fix for an exploit"), // score 100, must survive
		];
		const result = capDetails(details);
		const kept = result.details.map(d => d.text);
		expect(result.details).toHaveLength(MAX_DETAIL_ITEMS);
		expect(kept).toContain("security fix for an exploit");
		// index 5 is the lowest-priority tie and is the one dropped; original order
		// is preserved among the survivors.
		expect(kept).not.toContain("did thing 5");
		expect(kept).toEqual([
			"did thing 0",
			"did thing 1",
			"did thing 2",
			"did thing 3",
			"did thing 4",
			"security fix for an exploit",
		]);
		expect(result.warnings).toEqual(["Capped detail list to 6 items based on priority scoring."]);
	});
});

describe("validateTypeConsistency", () => {
	it("errors when a docs commit has no documentation files", () => {
		expect(validateTypeConsistency("docs", ["src/a.ts"]).errors).toContain(
			"Docs commit should include documentation file changes",
		);
	});

	it("passes a docs commit that touches a markdown file", () => {
		expect(validateTypeConsistency("docs", ["README.md"]).errors).toEqual([]);
	});

	it("recognizes a test file for a test commit", () => {
		expect(validateTypeConsistency("test", ["src/foo.test.ts"]).errors).toEqual([]);
		expect(validateTypeConsistency("test", ["src/foo.ts"]).errors).toContain(
			"Test commit should include test file changes",
		);
	});

	it("recognizes CI and build files by their conventional locations", () => {
		expect(validateTypeConsistency("ci", [".github/workflows/ci.yml"]).errors).toEqual([]);
		expect(validateTypeConsistency("build", ["package.json"]).errors).toEqual([]);
	});

	it("warns a perf commit that shows no benchmark or performance keyword", () => {
		expect(validateTypeConsistency("perf", ["src/a.ts"]).warnings).toContain(
			"Perf commit lacks benchmark or performance keywords",
		);
	});

	it("accepts a perf commit whose summary carries a performance keyword", () => {
		const result = validateTypeConsistency("perf", ["src/a.ts"], { summary: "optimized request latency" });
		expect(result.warnings).toEqual([]);
		expect(result.errors).toEqual([]);
	});

	it("warns a refactor commit that adds new files in its diff", () => {
		const result = validateTypeConsistency("refactor", ["src/a.ts"], {
			diffText: "diff --git a/x.ts b/x.ts\nnew file mode 100644\n",
		});
		expect(result.warnings).toContain("Refactor commit adds new files; consider feat if new functionality");
	});
});

describe("validation contract constants", () => {
	it("pins the summary length and detail-cap limits", () => {
		expect(SUMMARY_MAX_CHARS).toBe(72);
		expect(MAX_DETAIL_ITEMS).toBe(6);
	});
});
