import { describe, expect, it, mock } from "bun:test";

/**
 * createRecentCommitsTool reports style statistics over recent commit subjects so the
 * commit agent can match a repo's conventions. The statistics math was untested. This
 * suite mocks git.log.subjects and pins every derived number against a hand-verified
 * dataset: scopeUsagePercent (share of subjects carrying a conventional scope, rounded),
 * commonVerbs (first summary word, lowercased), summaryLength min/max/average (average
 * rounded to one decimal), lowercaseSummaryPercent (share whose summary starts
 * lowercase), and topScopes. It also locks two subtle behaviors: the conventional-commit
 * prefix is parsed case-insensitively (FIX(...) is recognized), but scope AGGREGATION in
 * topScopes is case-SENSITIVE (`api` and `API` are distinct buckets), and an empty log
 * yields all-zero stats rather than NaN from dividing by zero.
 */

const withSubjects = async (subjects: string[]) => {
	mock.module("@veyyon/coding-agent/utils/git", () => ({ log: { subjects: async () => subjects } }));
	const { createRecentCommitsTool } = await import("@veyyon/coding-agent/commit/agentic/tools/recent-commits");
	// The tool's execute only reads `params`; onUpdate and ctx are unused here.
	const result = await createRecentCommitsTool("/cwd").execute("id", {}, undefined, undefined as never);
	return (result as { details: { commits: string[]; stats: Record<string, unknown> } }).details;
};

describe("createRecentCommitsTool statistics", () => {
	it("computes every stat for a mixed conventional/non-conventional set", async () => {
		const details = await withSubjects([
			"feat(api): Add thing", // scope api, summary "Add thing" (9), verb "add", uppercase first
			"fix(api): patch it", // scope api, summary "patch it" (8), verb "patch", lowercase
			"chore: bump deps", // no scope, summary "bump deps" (9), verb "bump", lowercase
			"no conventional prefix", // no scope, summary is whole subject (22), verb "no", lowercase
		]);
		expect(details.stats).toEqual({
			scopeUsagePercent: 50,
			commonVerbs: { add: 1, patch: 1, bump: 1, no: 1 },
			summaryLength: { min: 8, max: 22, average: 12 },
			lowercaseSummaryPercent: 75,
			topScopes: { api: 2 },
		});
	});

	it("recognizes the conventional prefix case-insensitively but keeps scope buckets case-sensitive", async () => {
		const details = await withSubjects(["FIX(API): x", "feat(api): y"]);
		expect(details.stats).toMatchObject({
			scopeUsagePercent: 100,
			topScopes: { API: 1, api: 1 },
		});
	});

	it("rounds the average summary length to one decimal place", async () => {
		// Summaries "ab" (2) and "abcde" (5) average to 3.5.
		const details = await withSubjects(["ab", "abcde"]);
		expect(details.stats).toMatchObject({ summaryLength: { min: 2, max: 5, average: 3.5 } });
	});

	it("returns all-zero stats for an empty log instead of NaN", async () => {
		const details = await withSubjects([]);
		expect(details.commits).toEqual([]);
		expect(details.stats).toEqual({
			scopeUsagePercent: 0,
			commonVerbs: {},
			summaryLength: { min: 0, max: 0, average: 0 },
			lowercaseSummaryPercent: 0,
			topScopes: {},
		});
	});
});
