/**
 * SPEC-ONE-PLACE-AUDIT F5: `gh.ts` and `gh-cache-invalidation.ts` used to
 * carry two divergent issue/PR URL regexes (case sensitivity, query/fragment
 * tolerance), so a URL like `…/issues/5?notification_referrer_id=…` or a
 * mixed-case host parsed one way in the fetch path and another in the
 * cache-invalidation path. Both now import the same parsers from `gh-url.ts`.
 */
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { invalidateGithubCacheForBashCommand } from "@veyyon/pi-coding-agent/tools/gh-cache-invalidation";
import { parseIssueUrl, parsePrUrl } from "@veyyon/pi-coding-agent/tools/gh-url";
import { getCached, putCached, resetForTests } from "@veyyon/pi-coding-agent/tools/github-cache";
import { removeWithRetries } from "@veyyon/pi-utils";

describe("parseIssueUrl / parsePrUrl (F5)", () => {
	it("parses a query-string-suffixed issue URL", () => {
		expect(parseIssueUrl("https://github.com/o/r/issues/5?notification_referrer_id=abc")).toEqual({
			repo: "o/r",
			issueNumber: 5,
		});
	});

	it("parses a mixed-case host issue URL", () => {
		expect(parseIssueUrl("https://GitHub.com/o/r/issues/5")).toEqual({ repo: "o/r", issueNumber: 5 });
	});

	it("parses a query-string-suffixed PR URL", () => {
		expect(parsePrUrl("https://github.com/o/r/pull/9?diff=unified")).toEqual({ repo: "o/r", prNumber: 9 });
	});

	it("parses a mixed-case host PR URL", () => {
		expect(parsePrUrl("https://GitHub.COM/o/r/pull/9")).toEqual({ repo: "o/r", prNumber: 9 });
	});

	it("parses a fragment-suffixed issue URL", () => {
		expect(parseIssueUrl("https://github.com/o/r/issues/5#issuecomment-1")).toEqual({
			repo: "o/r",
			issueNumber: 5,
		});
	});

	it("rejects whitespace inside owner/repo", () => {
		expect(parseIssueUrl("https://github.com/o r/issues/5")).toEqual({});
		expect(parsePrUrl("https://github.com/o r/pull/5")).toEqual({});
	});

	it("returns {} for non-matching input", () => {
		expect(parseIssueUrl(undefined)).toEqual({});
		expect(parseIssueUrl("not a url")).toEqual({});
		expect(parsePrUrl("https://gitlab.com/o/r/pull/5")).toEqual({});
	});
});

describe("gh.ts and gh-cache-invalidation.ts key the same URL identically (F5)", () => {
	let tempDir: string;
	let originalEnv: string | undefined;

	async function withCache(fn: () => Promise<void> | void): Promise<void> {
		originalEnv = process.env.OMP_GITHUB_CACHE_DB;
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "gh-url-f5-"));
		process.env.OMP_GITHUB_CACHE_DB = path.join(tempDir, "github-cache.db");
		resetForTests();
		try {
			await fn();
		} finally {
			resetForTests();
			if (originalEnv === undefined) delete process.env.OMP_GITHUB_CACHE_DB;
			else process.env.OMP_GITHUB_CACHE_DB = originalEnv;
			await removeWithRetries(tempDir);
		}
	}

	it("invalidates via a query-string issue URL the same way parseIssueUrl parses it", async () => {
		await withCache(() => {
			const repo = "query-string/repo";
			putCached({
				repo,
				kind: "issue",
				number: 5,
				includeComments: true,
				payload: { number: 5 },
				rendered: `issue-${repo}-5`,
				fetchedAt: 1_000,
			});
			const url = "https://github.com/query-string/repo/issues/5?notification_referrer_id=abc";
			expect(parseIssueUrl(url)).toEqual({ repo, issueNumber: 5 });
			invalidateGithubCacheForBashCommand(`gh issue close ${url}`);
			expect(getCached(repo, "issue", 5, true)).toBeNull();
		});
	});

	it("invalidates via a mixed-case host PR URL the same way parsePrUrl parses it", async () => {
		await withCache(() => {
			const repo = "mixed-case/repo";
			putCached({
				repo,
				kind: "pr",
				number: 9,
				includeComments: true,
				payload: { number: 9 },
				rendered: `pr-${repo}-9`,
				fetchedAt: 1_000,
			});
			const url = "https://GitHub.com/mixed-case/repo/pull/9";
			expect(parsePrUrl(url)).toEqual({ repo, prNumber: 9 });
			invalidateGithubCacheForBashCommand(`gh pr close ${url}`);
			expect(getCached(repo, "pr", 9, true)).toBeNull();
		});
	});
});
