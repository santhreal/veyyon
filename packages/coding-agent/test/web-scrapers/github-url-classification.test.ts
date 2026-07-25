/**
 * What a GitHub URL is classified as, and what `null` is allowed to mean.
 *
 * WHY THIS SUITE EXISTS. `parseGitHubUrl` decides whether the GitHub scraper handles a URL at all, and
 * which of its readers gets it: an issue, a pull request, a commit, an Actions run, a single job. Get it
 * wrong and the page is fetched as anonymous HTML instead, so the reader silently gets a rendered web
 * page where they should have had the issue body, its comments, or a job's log. The existing coverage of
 * this function is gated behind `WEB_FETCH_INTEGRATION` and does not run in an ordinary test pass, which
 * left the whole classification table unpinned offline.
 *
 * It also locks what `null` means now. The classifier used to wrap its entire body in
 * `try { ... } catch { return null }`, even though the parse verdict already belongs to `tryParseUrl`.
 * That outer catch could only swallow a bug in the classifier itself, and it would surface as "this is
 * not a GitHub URL": the structured handling would vanish and the page would come back as plain HTML with
 * nothing to explain it. The catch is gone, so `null` now says exactly one thing, and the cases below are
 * the only inputs entitled to it.
 *
 * A throwing classifier is deliberately NOT tested here, because there is no input that reaches it: the
 * body only indexes arrays and runs regexes after `tryParseUrl` has already answered. That is the reason
 * the catch was removable, and it is stated rather than left as a gap someone else has to rediscover.
 */

import { describe, expect, it } from "bun:test";
import { parseGitHubUrl } from "@veyyon/coding-agent/web/scrapers/github";

describe("repository-level URLs", () => {
	/** The bare repository, which is what a `type: "repo"` reader expects and the shortest accepted shape. */
	it("classifies a repository root", () => {
		expect(parseGitHubUrl("https://github.com/facebook/react")).toEqual({
			type: "repo",
			owner: "facebook",
			repo: "react",
		});
	});

	/** A trailing slash is the same URL to a reader and must not change the classification. */
	it("ignores a trailing slash", () => {
		expect(parseGitHubUrl("https://github.com/facebook/react/")).toEqual({
			type: "repo",
			owner: "facebook",
			repo: "react",
		});
	});

	/** A query string and fragment belong to the page, not the identity of the repository. */
	it("ignores a query string and fragment", () => {
		expect(parseGitHubUrl("https://github.com/facebook/react?tab=readme#install")).toEqual({
			type: "repo",
			owner: "facebook",
			repo: "react",
		});
	});
});

describe("file and tree URLs", () => {
	/**
	 * `blob` carries the ref and the path separately, and the path must keep its slashes: a reader that
	 * received only the first segment would fetch the wrong file.
	 */
	it("splits a blob URL into ref and path", () => {
		expect(parseGitHubUrl("https://github.com/o/r/blob/main/src/deep/file.ts")).toEqual({
			type: "blob",
			owner: "o",
			repo: "r",
			ref: "main",
			path: "src/deep/file.ts",
		});
	});

	/** A tree URL is the same shape with a directory path, and keeps its own type so the reader lists it. */
	it("splits a tree URL the same way", () => {
		expect(parseGitHubUrl("https://github.com/o/r/tree/v1.2.3/src")).toEqual({
			type: "tree",
			owner: "o",
			repo: "r",
			ref: "v1.2.3",
			path: "src",
		});
	});

	/** A blob URL with a ref and no path is still a blob, with an empty path rather than a missing one. */
	it("gives a ref-only blob URL an empty path", () => {
		expect(parseGitHubUrl("https://github.com/o/r/blob/main")).toEqual({
			type: "blob",
			owner: "o",
			repo: "r",
			ref: "main",
			path: "",
		});
	});
});

describe("numbered URLs", () => {
	/**
	 * The number must come back as a NUMBER, since the reader puts it straight into an API path. `#1` and
	 * `#01` are different issues to nobody, but `parseInt` would make them the same, so the digit test that
	 * rejects the odd shapes matters as much as the parse.
	 */
	it("classifies an issue with its number", () => {
		expect(parseGitHubUrl("https://github.com/o/r/issues/1949")).toEqual({
			type: "issue",
			owner: "o",
			repo: "r",
			number: 1949,
		});
	});

	/** A pull request is `pull` in the URL and `pull` in the result, not `pulls`, which is the list. */
	it("classifies a pull request with its number", () => {
		expect(parseGitHubUrl("https://github.com/o/r/pull/1951")).toEqual({
			type: "pull",
			owner: "o",
			repo: "r",
			number: 1951,
		});
	});

	/** A discussion is numbered like an issue and must not fall through to the generic type. */
	it("classifies a discussion with its number", () => {
		expect(parseGitHubUrl("https://github.com/o/r/discussions/42")).toEqual({
			type: "discussion",
			owner: "o",
			repo: "r",
			number: 42,
		});
	});

	/**
	 * The LIST pages are their own types, and this is the distinction that decides which reader runs: an
	 * issue reader given the list URL would have no issue to read.
	 */
	it.each([
		["https://github.com/o/r/issues", "issues"],
		["https://github.com/o/r/pulls", "pulls"],
		["https://github.com/o/r/discussions", "discussions"],
	])("classifies %p as the %s list", (url, type) => {
		expect(parseGitHubUrl(url)).toEqual({ type, owner: "o", repo: "r" });
	});

	/**
	 * A non-numeric segment where a number belongs is the list, not a numbered item. `issues/new` is the
	 * real case: it is a form, and treating "new" as an issue number would send the reader to issue NaN.
	 */
	it.each([
		["https://github.com/o/r/issues/new", "issues"],
		["https://github.com/o/r/pull/new", "pulls"],
		["https://github.com/o/r/issues/12abc", "issues"],
	])("falls back to the list for %p", (url, type) => {
		expect(parseGitHubUrl(url)).toEqual({ type, owner: "o", repo: "r" });
	});
});

describe("commit URLs", () => {
	/** The ref is the sha, passed through verbatim so the reader can ask for exactly that commit. */
	it("classifies a commit with its sha as the ref", () => {
		expect(parseGitHubUrl("https://github.com/o/r/commit/9f0c1a2")).toEqual({
			type: "commit",
			owner: "o",
			repo: "r",
			ref: "9f0c1a2",
		});
	});

	/** `commit` with nothing after it identifies no commit, so it is the generic type rather than a bad read. */
	it("falls back to the generic type when no sha follows", () => {
		expect(parseGitHubUrl("https://github.com/o/r/commit")).toEqual({ type: "other", owner: "o", repo: "r" });
	});
});

describe("Actions URLs", () => {
	/** A run summary, whose id is numeric for the same reason an issue number is. */
	it("classifies a run", () => {
		expect(parseGitHubUrl("https://github.com/o/r/actions/runs/123456")).toEqual({
			type: "actions-run",
			owner: "o",
			repo: "r",
			runId: 123456,
		});
	});

	/**
	 * A single job, which GitHub writes with the SINGULAR `job` in web URLs and the plural `jobs` in
	 * API-shaped ones. Both are accepted, and both must produce the job type: matching only one spelling
	 * would send half of the job URLs to the run reader, which shows a job list instead of the log.
	 */
	it.each([
		["https://github.com/o/r/actions/runs/123/job/456", "the web spelling"],
		["https://github.com/o/r/actions/runs/123/jobs/456", "the API spelling"],
	])("classifies %p as a job (%s)", (url, _spelling) => {
		expect(parseGitHubUrl(url)).toEqual({
			type: "actions-job",
			owner: "o",
			repo: "r",
			runId: 123,
			jobId: 456,
		});
	});

	/** A run with a non-numeric job id is still the run, since there is no job to fetch. */
	it("falls back to the run when the job id is not numeric", () => {
		expect(parseGitHubUrl("https://github.com/o/r/actions/runs/123/job/latest")).toEqual({
			type: "actions-run",
			owner: "o",
			repo: "r",
			runId: 123,
		});
	});

	/** The Actions tab itself, and a workflow listing, identify no run: generic rather than a guessed run. */
	it.each(["https://github.com/o/r/actions", "https://github.com/o/r/actions/workflows/ci.yml"])(
		"classifies %p as the generic type",
		url => {
			expect(parseGitHubUrl(url)).toEqual({ type: "other", owner: "o", repo: "r" });
		},
	);
});

describe("URLs this scraper does not handle", () => {
	/**
	 * The complete list of inputs entitled to `null`, which is the contract the removed catch used to
	 * blur. Every one of them is a fact about the URL, never a failure inside the classifier.
	 */
	it.each([
		["https://gitlab.com/o/r", "another host"],
		["https://raw.githubusercontent.com/o/r/main/f.ts", "a GitHub subdomain that is not github.com"],
		["https://github.com", "no path at all"],
		["https://github.com/facebook", "an owner with no repository"],
		["not a url", "text that is not a URL"],
		["", "an empty string"],
		["javascript:void(0)", "a control rather than a link"],
	])("answers null for %p (%s)", (url, _why) => {
		expect(parseGitHubUrl(url)).toBeNull();
	});

	/**
	 * An unknown section under a real repository is NOT null: it is the generic repository type, so the
	 * scraper still handles the page as a GitHub repository. Pinned next to the null list because
	 * confusing the two is what sends a handled page to the anonymous HTML path.
	 */
	it.each(["https://github.com/o/r/wiki", "https://github.com/o/r/releases", "https://github.com/o/r/settings"])(
		"classifies the unknown section %p as the generic type rather than null",
		url => {
			expect(parseGitHubUrl(url)).toEqual({ type: "other", owner: "o", repo: "r" });
		},
	);
});
