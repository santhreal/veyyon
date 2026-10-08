import { afterEach, describe, expect, it, spyOn, vi } from "bun:test";
import { handleGitLab } from "../../src/scrapers/gitlab";
import * as scraperTypes from "../../src/scrapers/types";

/**
 * WHY: a gitlab.com URL renders through the reader its classified type selects, each addressing the
 * project by its URL-encoded path in one REST request rather than first resolving a numeric id. This
 * suite pins that classification (a project in a subgroup included), the request each type makes,
 * and the markdown of every reader: the repository summary with its README read as a raw file
 * rather than as the blob page's HTML, the tree listing, and the issue and merge request, whose
 * description the API returns as markdown and which renders verbatim rather than as the text of an
 * unawaited promise or a markdown-escaped single line.
 *
 * Gap: the live API shape is pinned by the network suite in `integration/dev-platforms.test.ts`, not
 * here; this suite serves the documented response fields.
 */

const API = "https://gitlab.com/api/v4/projects";

/** Serve `loadPage` from `pages`, recording each requested URL; any other URL is a 404 with GitLab's JSON error body. */
function servePages(pages: Record<string, unknown>): string[] {
	const requested: string[] = [];
	spyOn(scraperTypes, "loadPage").mockImplementation(async url => {
		requested.push(url);
		if (!Object.hasOwn(pages, url)) {
			return {
				content: '{"message":"404 Not Found"}',
				contentType: "application/json",
				finalUrl: url,
				ok: false,
				status: 404,
			};
		}
		const page = pages[url];
		const content = typeof page === "string" ? page : JSON.stringify(page);
		return { content, contentType: "text/plain", finalUrl: url, ok: true, status: 200 };
	});
	return requested;
}

function render(result: scraperTypes.RenderResult | scraperTypes.ScraperDegrade | null): scraperTypes.RenderResult {
	if (result === null || scraperTypes.isScraperDegrade(result)) {
		throw new Error(`expected a render, got ${JSON.stringify(result)}`);
	}
	return result;
}

const WORK_ITEM = {
	state: "opened",
	author: { name: "Ada", username: "ada" },
	created_at: "2024-01-02T03:04:05Z",
	updated_at: "2024-02-03T04:05:06Z",
	upvotes: 3,
	downvotes: 1,
	user_notes_count: 7,
};

afterEach(() => {
	vi.restoreAllMocks();
});

describe("a gitlab.com URL is classified by its project path and `/-/` route", () => {
	it.each([
		["https://example.com/g/p", "another host"],
		["https://gitlab.com/g", "a single segment"],
		["https://gitlab.com/g/s/p", "a deeper path with no `/-/` route"],
		["https://gitlab.com/g/-/issues/1", "a `/-/` route after one segment"],
		["https://gitlab.com/g/p/-/wikis/home", "a route no reader covers"],
		["https://gitlab.com/g/p/-/constructor/1", "a prototype key as the route"],
		["https://gitlab.com/g/p/-/issues/1/notes", "a numbered route with a trailing segment"],
		["https://gitlab.com/g/p/-/merge_requests/new", "a numbered route with no number"],
		["https://gitlab.com/g/p/-/blob/main", "a blob with no path"],
		["https://gitlab.com/g/p/-/tree", "a tree with no ref"],
		["https://gitlab.com/g/p/-", "a bare `/-/`"],
	])("leaves %s (%s) to the generic fetch without a request", async url => {
		const requested = servePages({});

		expect(await handleGitLab(url, 10)).toBeNull();
		expect(requested).toEqual([]);
	});

	it.each([
		["https://gitlab.com/g/p/-/blob/v1+2/src/a b.ts", `${API}/g%2Fp/repository/files/src%2Fa%20b.ts/raw?ref=v1%2B2`],
		[
			"https://gitlab.com/g/sub/p/-/tree/v1.0+rc/docs/api",
			`${API}/g%2Fsub%2Fp/repository/tree?ref=v1.0%2Brc&path=docs%2Fapi&per_page=100`,
		],
		["https://gitlab.com/g/p/-/tree/main", `${API}/g%2Fp/repository/tree?ref=main&path=&per_page=100`],
		["https://gitlab.com/g/sub/deeper/p/-/issues/42", `${API}/g%2Fsub%2Fdeeper%2Fp/issues/42`],
		["https://gitlab.com/g/p/-/merge_requests/9", `${API}/g%2Fp/merge_requests/9`],
		["https://gitlab.com/g/p", `${API}/g%2Fp`],
	])("reads %s with the one request %s", async (url, endpoint) => {
		const requested = servePages({});

		const result = await handleGitLab(url, 10);

		expect(requested).toEqual([endpoint]);
		expect(result).toEqual({
			scraperDegrade: true,
			note: "gitlab scraper failed (GitLab API requests failed); fell back to a generic fetch",
		});
	});
});

describe("a GitLab file and tree URL render the file and the listing", () => {
	it("returns a blob as plain text, an empty file included", async () => {
		servePages({
			[`${API}/g%2Fp/repository/files/a.ts/raw?ref=main`]: "export const a = 1;\n",
			[`${API}/g%2Fp/repository/files/empty.ts/raw?ref=main`]: "",
		});

		const result = render(await handleGitLab("https://gitlab.com/g/p/-/blob/main/a.ts", 10));

		expect(result).toMatchObject({
			method: "gitlab-raw",
			contentType: "text/plain",
			notes: ["Fetched raw file via GitLab API"],
			content: "export const a = 1;",
		});
		expect(render(await handleGitLab("https://gitlab.com/g/p/-/blob/main/empty.ts", 10))).toMatchObject({
			method: "gitlab-raw",
			content: "",
		});
	});

	it("lists directories before files and omits an empty section", async () => {
		servePages({
			[`${API}/g%2Fp/repository/tree?ref=main&path=src&per_page=100`]: [
				{ name: "b.ts", type: "blob", path: "src/b.ts", mode: "100644" },
				{ name: "lib", type: "tree", path: "src/lib", mode: "040000" },
				{ name: "a.ts", type: "blob", path: "src/a.ts", mode: "100644" },
			],
			[`${API}/g%2Fp/repository/tree?ref=main&path=&per_page=100`]: [
				{ name: "only.ts", type: "blob", path: "only.ts", mode: "100644" },
			],
			[`${API}/g%2Fp/repository/tree?ref=main&path=src%2Flib&per_page=100`]: [
				{ name: "deep", type: "tree", path: "src/lib/deep", mode: "040000" },
			],
		});

		const nested = render(await handleGitLab("https://gitlab.com/g/p/-/tree/main/src", 10));
		const root = render(await handleGitLab("https://gitlab.com/g/p/-/tree/main", 10));
		const dirsOnly = render(await handleGitLab("https://gitlab.com/g/p/-/tree/main/src/lib", 10));

		expect({ method: nested.method, notes: nested.notes }).toEqual({
			method: "gitlab-tree",
			notes: ["Fetched directory tree via GitLab API"],
		});
		expect(nested.content).toBe(
			"# Directory: src\n\n**Ref:** main\n\n## Directories (1)\n\n- 📁 lib/\n\n## Files (2)\n\n- 📄 b.ts\n- 📄 a.ts",
		);
		expect(root.content).toBe("# Directory: /\n\n**Ref:** main\n\n## Files (1)\n\n- 📄 only.ts");
		expect(dirsOnly.content).toBe("# Directory: src/lib\n\n**Ref:** main\n\n## Directories (1)\n\n- 📁 deep/");
	});
});

describe("a GitLab repository URL renders its summary and README", () => {
	const project = {
		name: "proj",
		description: "A project",
		star_count: 12,
		forks_count: 3,
		open_issues_count: 4,
		default_branch: "main",
		visibility: "public",
		created_at: "2020-05-06T00:00:00Z",
		last_activity_at: "2024-07-08T00:00:00Z",
		topics: ["cli", "tools"],
	};
	const summary = [
		"# proj",
		"",
		"A project",
		"",
		"**Stars:** 12 · **Forks:** 3 · **Issues:** 4",
		"**Visibility:** public · **Default Branch:** main",
		"**Topics:** cli, tools",
		"**Created:** 2020-05-06 · **Last Activity:** 2024-07-08",
	].join("\n");

	it("reads the README through its raw URL, not its blob page", async () => {
		const requested = servePages({
			[`${API}/g%2Fp`]: { ...project, readme_url: "https://gitlab.com/g/p/-/blob/main/README.md" },
			"https://gitlab.com/g/p/-/raw/main/README.md": "Read me.",
		});

		const result = render(await handleGitLab("https://gitlab.com/g/p", 10));

		expect(requested).toEqual([`${API}/g%2Fp`, "https://gitlab.com/g/p/-/raw/main/README.md"]);
		expect({ method: result.method, notes: result.notes }).toEqual({
			method: "gitlab-repo",
			notes: ["Fetched repository via GitLab API"],
		});
		expect(result.content).toBe(`${summary}\n\n---\n\n## README\n\nRead me.`);
	});

	it("renders the summary alone when the README is blank, missing, or not a blob page", async () => {
		const requested = servePages({
			[`${API}/g%2Fblank`]: { ...project, readme_url: "https://gitlab.com/g/blank/-/blob/main/README.md" },
			"https://gitlab.com/g/blank/-/raw/main/README.md": "  \n",
			[`${API}/g%2Fnone`]: project,
			[`${API}/g%2Fpage`]: { ...project, readme_url: "https://gitlab.com/g/page/README.md" },
		});

		for (const url of ["https://gitlab.com/g/blank", "https://gitlab.com/g/none", "https://gitlab.com/g/page"]) {
			expect(render(await handleGitLab(url, 10)).content).toBe(summary);
		}
		expect(requested).toEqual([
			`${API}/g%2Fblank`,
			"https://gitlab.com/g/blank/-/raw/main/README.md",
			`${API}/g%2Fnone`,
			`${API}/g%2Fpage`,
		]);
	});
});

describe("a GitLab issue and merge request render their markdown description verbatim", () => {
	const description = "## Steps\n\n1. Run `make`\n2. See *error*\n";

	it("renders an issue with its labels, assignees and description", async () => {
		servePages({
			[`${API}/g%2Fp/issues/5`]: {
				...WORK_ITEM,
				title: "It breaks",
				description,
				labels: ["bug", "p1"],
				assignees: [{ name: "Bo" }, { name: "Cy" }],
			},
		});

		const result = render(await handleGitLab("https://gitlab.com/g/p/-/issues/5", 10));

		expect({ method: result.method, notes: result.notes }).toEqual({
			method: "gitlab-issue",
			notes: ["Fetched issue via GitLab API"],
		});
		expect(result.content).toBe(
			[
				"# Issue #5: It breaks",
				"",
				"**State:** OPENED · **Author:** Ada (@ada)",
				"**Created:** 2024-01-02 · **Updated:** 2024-02-03",
				"**Upvotes:** 3 · **Downvotes:** 1 · **Comments:** 7",
				"**Labels:** bug, p1",
				"**Assignees:** Bo, Cy",
				"",
				"---",
				"",
				"## Description",
				"",
				"## Steps\n\n1. Run `make`\n2. See *error*",
			].join("\n"),
		);
	});

	it("renders a draft merge request with its branches and description", async () => {
		servePages({
			[`${API}/g%2Fp/merge_requests/8`]: {
				...WORK_ITEM,
				title: "Fix it",
				description,
				labels: [],
				assignees: [],
				source_branch: "fix",
				target_branch: "main",
				draft: true,
				merge_status: "can_be_merged",
			},
		});

		const result = render(await handleGitLab("https://gitlab.com/g/p/-/merge_requests/8", 10));

		expect({ method: result.method, notes: result.notes }).toEqual({
			method: "gitlab-mr",
			notes: ["Fetched merge request via GitLab API"],
		});
		expect(result.content).toBe(
			[
				"# MR !8: Fix it",
				"",
				"**[DRAFT]** **State:** OPENED · **Author:** Ada (@ada)",
				"**Branch:** fix → main",
				"**Created:** 2024-01-02 · **Updated:** 2024-02-03",
				"**Merge Status:** can_be_merged · **Upvotes:** 3 · **Downvotes:** 1 · **Comments:** 7",
				"",
				"---",
				"",
				"## Description",
				"",
				"## Steps\n\n1. Run `make`\n2. See *error*",
			].join("\n"),
		);
	});

	it("marks a missing or blank description", async () => {
		servePages({
			[`${API}/g%2Fp/issues/1`]: { ...WORK_ITEM, title: "Null", description: null, labels: [] },
			[`${API}/g%2Fp/merge_requests/2`]: {
				...WORK_ITEM,
				title: "Blank",
				description: " \n",
				labels: [],
				source_branch: "a",
				target_branch: "b",
				draft: false,
				merge_status: "checking",
			},
		});

		const issue = render(await handleGitLab("https://gitlab.com/g/p/-/issues/1", 10));
		const mr = render(await handleGitLab("https://gitlab.com/g/p/-/merge_requests/2", 10));

		expect(issue.content.endsWith("## Description\n\n*No description*")).toBe(true);
		expect(mr.content.startsWith("# MR !2: Blank\n\n**State:**")).toBe(true);
		expect(mr.content.endsWith("## Description\n\n*No description*")).toBe(true);
	});
});

describe("a GitLab URL whose API response is unusable degrades", () => {
	it("degrades on a response that is not JSON", async () => {
		servePages({ [`${API}/g%2Fp/issues/3`]: "<html>rate limited</html>" });

		expect(await handleGitLab("https://gitlab.com/g/p/-/issues/3", 10)).toEqual({
			scraperDegrade: true,
			note: "gitlab scraper failed (GitLab API requests failed); fell back to a generic fetch",
		});
	});
});
