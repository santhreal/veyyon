import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { handleSourcegraph } from "../../src/scrapers/sourcegraph";
import * as scraperTypes from "../../src/scrapers/types";

/**
 * WHY: a sourcegraph.com URL renders through one GraphQL endpoint, and the URL shape selects the
 * query: `/search?q=` a code search, `<repo>[@rev]` a repository, `<repo>[@rev]/-/blob/<path>` a
 * file at a revision (HEAD when none is given). This suite pins the variables each shape sends and
 * the markdown each answer renders: a file match with at most five collapsed line previews, a
 * repository hit, an unknown result kind rendered as nothing, at most ten results with the rest
 * counted, and the match count and limit flag only when the API reports them. It also pins the
 * non-matches and the degrade when the API answers with errors.
 *
 * It does not pin the GraphQL query text, which the live endpoint owns.
 */

interface GraphqlRequest {
	readonly query: string;
	readonly variables: Record<string, unknown>;
}

const requests: GraphqlRequest[] = [];
let loadPageSpy: { mockRestore: () => void } | null = null;

function answer(respond: (variables: Record<string, unknown>) => unknown): void {
	loadPageSpy = spyOn(scraperTypes, "loadPage").mockImplementation(async (url, options) => {
		const request = JSON.parse(options?.body ?? "{}") as GraphqlRequest;
		requests.push(request);
		const content = JSON.stringify(respond(request.variables));
		return { content, contentType: "application/json", finalUrl: url, ok: true, status: 200 };
	});
}

function render(result: scraperTypes.RenderResult | scraperTypes.ScraperDegrade | null): scraperTypes.RenderResult {
	if (result === null || scraperTypes.isScraperDegrade(result)) {
		throw new Error(`expected a render, got ${JSON.stringify(result)}`);
	}
	return result;
}

const REPO = {
	name: "github.com/a/b",
	url: "/github.com/a/b",
	description: "A library.",
	defaultBranch: { name: "main" },
};
const REPO_MARKDOWN = "# github.com/a/b\n\nA library.\n\n**URL:** /github.com/a/b\n**Default branch:** main\n";

afterEach(() => {
	loadPageSpy?.mockRestore();
	loadPageSpy = null;
	requests.length = 0;
});

describe("a Sourcegraph search URL renders its results", () => {
	it("renders file matches, repositories and the counts, skipping unknown kinds and eliding past ten", async () => {
		const lineMatches = [
			{ preview: "  one\ntwo  ", lineNumber: 3 },
			{ preview: null, lineNumber: null },
			...[5, 6, 7, 8].map(n => ({ preview: `line ${n}`, lineNumber: n })),
		];
		const results = [
			{
				__typename: "FileMatch",
				repository: { name: "github.com/a/b", url: "/github.com/a/b" },
				file: { path: "src/x.ts", url: "/github.com/a/b/-/blob/src/x.ts" },
				lineMatches,
			},
			{ __typename: "FileMatch" },
			{ __typename: "Repository", name: "github.com/c/d", url: "/github.com/c/d" },
			{ __typename: "Repository" },
			{ __typename: "CommitSearchResult" },
			...[1, 2, 3, 4, 5, 6, 7].map(n => ({ __typename: "Repository", name: `r${n}`, url: `/r${n}` })),
		];
		answer(() => ({ data: { search: { results: { results, matchCount: 42, limitHit: true } } } }));

		const result = render(await handleSourcegraph("https://sourcegraph.com/search?q=repo%3Aa+foo", 10));

		expect(requests.map(r => r.variables)).toEqual([{ query: "repo:a foo" }]);
		expect(result.method).toBe("sourcegraph-search");
		expect(result.content).toBe(
			[
				"# Sourcegraph Search\n\n**Query:** `repo:a foo`\n**Matches:** 42\n**Limit hit:** yes\n\n## Results\n\n",
				"### github.com/a/b/src/x.ts\n\n**Repository:** /github.com/a/b\n**File:** /github.com/a/b/-/blob/src/x.ts\n",
				"\n```text\nL3: one two\nL0: \nL5: line 5\nL6: line 6\nL7: line 7\n```\n\n",
				"### unknown/unknown\n\n",
				"### github.com/c/d\n\n**Repository:** /github.com/c/d\n\n",
				"### unknown\n\n",
				...[1, 2, 3, 4, 5].map(n => `### r${n}\n\n**Repository:** /r${n}\n\n`),
				"[…2 results elided…]",
			].join(""),
		);
	});

	it("renders a zero count and a false limit flag, omits the counts the API leaves out, and says there are no results", async () => {
		answer(({ query }) => {
			const reported = query === "zero" ? { matchCount: 0, limitHit: false } : { matchCount: null, limitHit: null };
			return { data: { search: { results: { results: query === "zero" ? [] : null, ...reported } } } };
		});

		const zero = render(await handleSourcegraph("https://sourcegraph.com/search?q=zero", 10));
		const absent = render(await handleSourcegraph("https://sourcegraph.com/search?q=nothing", 10));

		expect(zero.content).toBe(
			"# Sourcegraph Search\n\n**Query:** `zero`\n**Matches:** 0\n**Limit hit:** no\n\n_No results._",
		);
		expect(absent.content).toBe("# Sourcegraph Search\n\n**Query:** `nothing`\n\n_No results._");
	});

	it("declines a search URL with no query", async () => {
		answer(() => ({}));

		expect(await handleSourcegraph("https://sourcegraph.com/search?q=%20", 10)).toBeNull();
		expect(requests).toEqual([]);
	});
});

describe("a Sourcegraph repository or file URL renders that repository", () => {
	it("renders a repository by its name, dropping the revision", async () => {
		answer(() => ({ data: { repository: REPO } }));

		const result = render(await handleSourcegraph("https://sourcegraph.com/github.com/a/b@v1", 10));

		expect(requests.map(r => r.variables)).toEqual([{ name: "github.com/a/b" }]);
		expect(result.method).toBe("sourcegraph-repo");
		expect(result.content).toBe(REPO_MARKDOWN.trimEnd());
	});

	it("renders a file at the URL's revision, or at HEAD when the URL names none", async () => {
		const blob = { ...REPO, commit: { blob: { content: "export const x = 1;" } } };
		answer(() => ({ data: { repository: blob } }));

		const pinned = render(await handleSourcegraph("https://sourcegraph.com/github.com/a/b@v2/-/blob/src/x.ts", 10));
		const head = render(await handleSourcegraph("https://sourcegraph.com/github.com/a/b/-/blob/src/x.ts", 10));

		expect(requests.map(r => r.variables)).toEqual([
			{ name: "github.com/a/b", path: "src/x.ts", rev: "v2" },
			{ name: "github.com/a/b", path: "src/x.ts", rev: "HEAD" },
		]);
		expect(pinned.method).toBe("sourcegraph-file");
		expect(pinned.content).toBe(
			`${REPO_MARKDOWN}\n**Path:** src/x.ts\n**Revision:** v2\n\n---\n\n## File\n\n\`\`\`text\nexport const x = 1;\n\`\`\``,
		);
		expect(head.content).toContain("**Revision:** HEAD");
	});

	it("degrades when the API answers with errors", async () => {
		answer(() => ({ data: { repository: REPO }, errors: [{ message: "rate limited" }] }));

		const result = await handleSourcegraph("https://sourcegraph.com/github.com/a/b", 10);

		expect(result !== null && scraperTypes.isScraperDegrade(result)).toBe(true);
	});

	it("declines another host and a path too short to name a repository", async () => {
		answer(() => ({}));

		expect(await handleSourcegraph("https://example.com/github.com/a/b", 10)).toBeNull();
		expect(await handleSourcegraph("https://sourcegraph.com/github.com/a", 10)).toBeNull();
		expect(requests).toEqual([]);
	});
});
