import { afterEach, describe, expect, it, spyOn, vi } from "bun:test";
import { handleGitHub } from "../../src/scrapers/github";
import * as scraperTypes from "../../src/scrapers/types";

/**
 * WHY: a github.com URL renders through the reader its classified type selects: a blob as raw text,
 * every other rendered type through the REST API under its own method, and the types no reader
 * covers (the pull list, discussions, any other section) as a degrade without a request. This
 * suite pins that dispatch and the markdown of the commit, tree and repository readers: the
 * commit's subject, author fallback, stats, parents, body and per-file diffs; the tree's
 * directories-first listing, file sizes and directory README; the repository's counts, first
 * hundred tree entries and base64 README.
 *
 * The URL classification table is pinned by `github-url-classification.test.ts`, the Actions step
 * table by `github-actions-steps-table.test.ts`. This suite does not pin the issue, issue list or
 * Actions markdown beyond the method each one answers with.
 */

const API_NOTES = ["Fetched via GitHub API"];
const { preconnect } = globalThis.fetch;

/** Serve REST endpoints (path and query after the API origin) and record each one requested; any other is a 404. */
function serveApi(routes: Record<string, unknown>): string[] {
	const requested: string[] = [];
	const serve = async (input: string | URL | Request) => {
		const endpoint = String(input instanceof Request ? input.url : input).replace("https://api.github.com", "");
		requested.push(endpoint);
		if (!Object.hasOwn(routes, endpoint)) return new Response("", { status: 404 });
		return Response.json(routes[endpoint]);
	};
	spyOn(globalThis, "fetch").mockImplementation(Object.assign(serve, { preconnect }));
	return requested;
}

/** Serve `loadPage` (raw files, READMEs, job logs) from `pages`; any other URL is a 404. */
function serveRaw(pages: Record<string, string>): string[] {
	const requested: string[] = [];
	spyOn(scraperTypes, "loadPage").mockImplementation(async url => {
		requested.push(url);
		if (!Object.hasOwn(pages, url))
			return { content: "", contentType: "text/plain", finalUrl: url, ok: false, status: 404 };
		return { content: pages[url] ?? "", contentType: "text/plain", finalUrl: url, ok: true, status: 200 };
	});
	return requested;
}

function render(result: scraperTypes.RenderResult | scraperTypes.ScraperDegrade | null): scraperTypes.RenderResult {
	if (result === null || scraperTypes.isScraperDegrade(result)) {
		throw new Error(`expected a render, got ${JSON.stringify(result)}`);
	}
	return result;
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("a GitHub commit URL renders the commit and its diff", () => {
	it("renders the subject, author, stats, parents, body, renamed and binary files", async () => {
		serveRaw({});
		serveApi({
			"/repos/o/r/commits/abc1234567890def": {
				sha: "abc1234567890def",
				html_url: "https://github.com/o/r/commit/abc1234567890def",
				commit: {
					author: { name: "Ada", date: "2024-01-02T00:00:00Z" },
					message: "Fix the loom\n\nLonger body.\n",
				},
				author: null,
				parents: [{ sha: "1111111111111111" }, { sha: "2222222222222222" }],
				stats: { additions: 3, deletions: 1 },
				files: [
					{
						filename: "src/new.ts",
						previous_filename: "src/old.ts",
						status: "renamed",
						additions: 3,
						deletions: 1,
						changes: 4,
						patch: "@@ -1 +1 @@\n-a\n+b",
					},
					{ filename: "img.png", status: "added", additions: 0, deletions: 0, changes: 0 },
				],
			},
		});

		const result = render(await handleGitHub("https://github.com/o/r/commit/abc1234567890def", 10));

		expect({ method: result.method, notes: result.notes }).toEqual({ method: "github-commit", notes: API_NOTES });
		expect(result.content).toBe(
			[
				"# Fix the loom",
				"",
				"**abc123456789** · authored by Ada · 2024-01-02T00:00:00Z",
				"2 files changed · +3 −1",
				"Parents: 111111111111, 222222222222",
				"",
				"Longer body.",
				"",
				"---",
				"",
				"## Files (2)",
				"",
				"### src/old.ts → src/new.ts",
				"",
				"renamed · +3 −1",
				"",
				"```diff\n@@ -1 +1 @@\n-a\n+b\n```",
				"",
				"### img.png",
				"",
				"added · +0 −0",
				"",
				"*No textual diff (binary or too large).*",
			].join("\n"),
		);
	});

	it("titles a commit with no message by its short SHA and names the login, else the git author, else unknown", async () => {
		serveRaw({});
		serveApi({
			"/repos/o/r/commits/login": {
				sha: "fedcba9876543210",
				commit: { author: { name: "Ada" }, message: "" },
				author: { login: "ada" },
			},
			"/repos/o/r/commits/nobody": {
				sha: "0123456789abcdef",
				commit: { author: null, message: "Tidy" },
				author: null,
			},
		});

		const login = render(await handleGitHub("https://github.com/o/r/commit/login", 10));
		const nobody = render(await handleGitHub("https://github.com/o/r/commit/nobody", 10));

		expect(login.content).toBe("# fedcba9\n\n**fedcba987654** · authored by @ada");
		expect(nobody.content).toBe("# Tidy\n\n**0123456789ab** · authored by unknown");
	});
});

describe("a GitHub tree URL renders the directory listing", () => {
	it("lists directories first, sizes only files, and appends the directory README", async () => {
		const raw = serveRaw({ "https://raw.githubusercontent.com/o/r/main/docs/README.md": "Docs readme\n" });
		serveApi({
			"/repos/o/r": { full_name: "o/r", default_branch: "trunk" },
			"/repos/o/r/contents/docs?ref=main": [
				{ name: "b.md", type: "file", size: 10, path: "docs/b.md" },
				{ name: "sub", type: "dir", path: "docs/sub" },
				{ name: "README.md", type: "file", size: 0, path: "docs/README.md" },
				{ name: "a-link", type: "symlink", size: 5, path: "docs/a-link" },
				{ name: "A-dir", type: "dir", path: "docs/A-dir" },
			],
		});

		const result = render(await handleGitHub("https://github.com/o/r/tree/main/docs", 10));

		expect({ method: result.method, notes: result.notes }).toEqual({ method: "github-tree", notes: API_NOTES });
		expect(raw).toEqual(["https://raw.githubusercontent.com/o/r/main/docs/README.md"]);
		expect(result.content).toBe(
			[
				"# o/r/docs",
				"",
				"**Branch:** main",
				"",
				"## Contents",
				"",
				"```",
				"[dir] A-dir",
				"[dir] sub",
				"      a-link",
				"      b.md (10 bytes)",
				"      README.md",
				"```",
				"",
				"---",
				"",
				"## README",
				"",
				"Docs readme",
			].join("\n"),
		);
	});

	it("lists the root at the default branch, reads a root readme, and keeps the header when the listing or README fails", async () => {
		serveRaw({ "https://raw.githubusercontent.com/o/r/trunk/readme.md": "Root readme" });
		const api = serveApi({
			"/repos/o/r": { full_name: "o/r", default_branch: "trunk" },
			"/repos/o/r/contents/?ref=trunk": [{ name: "readme.md", type: "file", size: 11, path: "readme.md" }],
			"/repos/o/empty": { full_name: "o/empty", default_branch: "main" },
			"/repos/o/lost": { full_name: "o/lost", default_branch: "main" },
			"/repos/o/lost/contents/?ref=main": [{ name: "README.md", type: "file", path: "README.md" }],
		});

		const root = render(await handleGitHub("https://github.com/o/r/tree", 10));
		const empty = render(await handleGitHub("https://github.com/o/empty/tree", 10));
		const lost = render(await handleGitHub("https://github.com/o/lost/tree", 10));

		expect(root.content).toBe(
			"# o/r/(root)\n\n**Branch:** trunk\n\n## Contents\n\n```\n      readme.md (11 bytes)\n```\n\n---\n\n## README\n\nRoot readme",
		);
		expect(empty.content).toBe("# o/empty/(root)\n\n**Branch:** main");
		expect(api).toContain("/repos/o/empty/contents/?ref=main");
		expect(lost.content).toBe("# o/lost/(root)\n\n**Branch:** main\n\n## Contents\n\n```\n      README.md\n```");
	});
});

describe("a GitHub repository URL renders its summary, files and README", () => {
	it("states the counts, language and license, lists the first hundred tree entries and decodes the README", async () => {
		serveRaw({});
		const tree = [
			{ path: "src", type: "tree" },
			...Array.from({ length: 100 }, (_, i) => ({ path: `f${i + 1}`, type: "blob" })),
		];
		serveApi({
			"/repos/o/r": {
				full_name: "o/r",
				description: "A loom.",
				stargazers_count: 5,
				forks_count: 2,
				open_issues_count: 1,
				default_branch: "main",
				language: "TypeScript",
				license: { name: "MIT License" },
			},
			"/repos/o/r/git/trees/main?recursive=1": { tree },
			"/repos/o/r/readme": { content: Buffer.from("# Hello\n").toString("base64"), encoding: "base64" },
		});

		const result = render(await handleGitHub("https://github.com/o/r", 10));

		const listed = Array.from({ length: 99 }, (_, i) => `      f${i + 1}`);
		expect({ method: result.method, notes: result.notes }).toEqual({ method: "github-repo", notes: API_NOTES });
		expect(result.content).toBe(
			[
				"# o/r",
				"",
				"A loom.",
				"",
				"Stars: 5 · Forks: 2 · Issues: 1",
				"Language: TypeScript",
				"License: MIT License",
				"",
				"---",
				"",
				"## Files",
				"",
				"```",
				"[dir] src",
				...listed,
				"[…1 files elided…]",
				"```",
				"",
				"## README",
				"",
				"# Hello",
			].join("\n"),
		);
	});

	it("omits the description, language, license, tree and a README that is not base64", async () => {
		serveRaw({});
		serveApi({
			"/repos/o/bare": {
				full_name: "o/bare",
				description: null,
				stargazers_count: 0,
				forks_count: 0,
				open_issues_count: 0,
				default_branch: "main",
				language: null,
				license: null,
			},
			"/repos/o/bare/readme": { content: "plain", encoding: "utf-8" },
		});

		const result = render(await handleGitHub("https://github.com/o/bare", 10));

		expect(result.content).toBe("# o/bare\n\nStars: 0 · Forks: 0 · Issues: 0\n\n---");
	});
});

describe("a GitHub URL is read by the reader its type selects", () => {
	const ISSUE = {
		title: "Bug",
		state: "open",
		user: { login: "ada" },
		created_at: "c",
		updated_at: "u",
		body: null,
		labels: [],
		comments: 0,
	};

	it("reads a blob as raw text from raw.githubusercontent.com", async () => {
		const rawUrl = "https://raw.githubusercontent.com/o/r/main/src/a.ts";
		serveRaw({ [rawUrl]: "export {};" });
		const api = serveApi({});

		const result = render(await handleGitHub("https://github.com/o/r/blob/main/src/a.ts", 10));

		expect(result).toMatchObject({
			method: "github-raw",
			content: "export {};",
			contentType: "text/plain",
			finalUrl: rawUrl,
			notes: [`Fetched raw: ${rawUrl}`],
		});
		expect(api).toEqual([]);
	});

	it("answers each API type under its own method", async () => {
		serveRaw({});
		serveApi({
			"/repos/o/r/issues/7": { ...ISSUE, number: 7 },
			"/repos/o/r/pulls/8": { ...ISSUE, number: 8 },
			"/repos/o/r/issues?state=open&per_page=30": [],
			"/repos/o/r/actions/runs/9": {
				id: 9,
				run_number: 3,
				event: "push",
				status: "completed",
				conclusion: "success",
				html_url: "https://github.com/o/r/actions/runs/9",
				created_at: "2024-01-01T00:00:00Z",
				updated_at: "2024-01-01T00:01:00Z",
			},
			"/repos/o/r/actions/jobs/10": {
				id: 10,
				run_id: 9,
				name: "build",
				status: "completed",
				conclusion: "success",
				started_at: null,
				completed_at: null,
				html_url: null,
			},
		});

		const methods: Record<string, string> = {};
		for (const url of [
			"https://github.com/o/r/issues/7",
			"https://github.com/o/r/pull/8",
			"https://github.com/o/r/issues",
			"https://github.com/o/r/actions/runs/9",
			"https://github.com/o/r/actions/runs/9/job/10",
		]) {
			const result = render(await handleGitHub(url, 10));
			expect({ url, notes: result.notes }).toEqual({ url, notes: API_NOTES });
			methods[url] = result.method;
		}

		expect(methods).toEqual({
			"https://github.com/o/r/issues/7": "github-issue",
			"https://github.com/o/r/pull/8": "github-pr",
			"https://github.com/o/r/issues": "github-issues",
			"https://github.com/o/r/actions/runs/9": "github-actions-run",
			"https://github.com/o/r/actions/runs/9/job/10": "github-actions-job",
		});
	});

	it("degrades without a request for a type no reader covers", async () => {
		const raw = serveRaw({});
		const api = serveApi({});

		for (const url of [
			"https://github.com/o/r/pulls",
			"https://github.com/o/r/discussions/1",
			"https://github.com/o/r/discussions",
			"https://github.com/o/r/wiki",
		]) {
			const result = await handleGitHub(url, 10);
			expect({ url, degraded: result !== null && scraperTypes.isScraperDegrade(result) }).toEqual({
				url,
				degraded: true,
			});
		}
		expect({ raw, api }).toEqual({ raw: [], api: [] });
	});

	it("degrades when the raw file or the API cannot be read, and declines another host", async () => {
		serveRaw({});
		serveApi({});

		const blob = await handleGitHub("https://github.com/o/r/blob/main/missing.ts", 10);
		const repo = await handleGitHub("https://github.com/o/gone", 10);

		for (const result of [blob, repo]) {
			expect(result !== null && scraperTypes.isScraperDegrade(result)).toBe(true);
			if (result === null || !scraperTypes.isScraperDegrade(result)) continue;
			expect(result.note).toBe("github scraper failed (GitHub API requests failed); fell back to a generic fetch");
		}
		expect(await handleGitHub("https://gitlab.com/o/r", 10)).toBeNull();
	});
});
