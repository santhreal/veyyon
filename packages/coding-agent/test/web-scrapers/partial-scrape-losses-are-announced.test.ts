/**
 * A scraper that renders a PARTIAL page says which part it lost.
 *
 * WHY THIS SUITE EXISTS. The degrade contract in `scraper-degrade.test.ts` covers the whole-page
 * case: a handler that matched a URL and could not scrape it returns a loud `ScraperDegrade` and the
 * dispatcher surfaces the note. That contract says nothing about the other, quieter half — a handler
 * whose MAIN request succeeded and whose SECONDARY request failed. Four of them wrapped that second
 * request in a bare `catch {}` and rendered the page anyway:
 *
 *   - `wikidata.ts` resolves referenced entity ids to English labels in batches. With the batch lost,
 *     every entity-valued claim renders as the bare id, so a page describing Mercury says
 *     `**instance of:** Q3504248` and the model reading it learns nothing.
 *   - `openlibrary.ts` looks up author names one request per author. With a lookup lost, the book
 *     simply appears to have fewer authors than it has.
 *   - `w3c.ts` parses the editors payload. With it lost, the spec renders with no editors, which is
 *     indistinguishable from a spec that lists none.
 *   - `open-vsx.ts` fetches the extension readme. With it lost, the page carries metadata only, which
 *     is indistinguishable from an extension that ships no readme.
 *
 * In every one of those cases the tool returns success. Nothing in the output marks the difference
 * between "this field is empty" and "this field was dropped", so the loss is invisible to the reader
 * and to the operator both — a silent fallback in the sense Law 10 means it. The fix is not to fail
 * the scrape: a page with four of five authors is worth more than no page. The fix is that the loss
 * reaches the session log naming what is missing from the output.
 *
 * The other half of the contract is here too. A cancellation caught by one of these blanket catches
 * must be rethrown, not logged as a lost field, or the handler carries on building a page for a
 * request the user already stopped. And the healthy path must stay silent: a warning on every
 * successful scrape would bury the ones that matter.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { ToolAbortError } from "@veyyon/coding-agent/tools/tool-errors";
import { handleOpenVsx } from "@veyyon/coding-agent/web/scrapers/open-vsx";
import { handleOpenLibrary } from "@veyyon/coding-agent/web/scrapers/openlibrary";
import { isScraperDegrade } from "@veyyon/coding-agent/web/scrapers/types";
import { handleW3c } from "@veyyon/coding-agent/web/scrapers/w3c";
import { handleWikidata } from "@veyyon/coding-agent/web/scrapers/wikidata";
import { logger } from "@veyyon/utils";

const realFetch = globalThis.fetch;

/** Route each request by URL substring, so an unrouted request is an explicit test failure. */
function route(table: Array<[string, () => Response]>): void {
	globalThis.fetch = Object.assign(
		async (input: string | URL | Request) => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
			for (const [needle, make] of table) if (url.includes(needle)) return make();
			throw new Error(`unrouted request in test: ${url}`);
		},
		{ preconnect: realFetch.preconnect },
	) as typeof fetch;
}

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

let warnings: Array<{ message: string; fields: Record<string, unknown> }>;

beforeEach(() => {
	warnings = [];
	vi.spyOn(logger, "warn").mockImplementation((message: string, fields?: Record<string, unknown>) => {
		warnings.push({ message, fields: fields ?? {} });
	});
});

afterEach(() => {
	vi.restoreAllMocks();
	globalThis.fetch = realFetch;
});

/** The rendered markdown, asserting the handler actually produced a page rather than a degrade. */
function markdown(result: Awaited<ReturnType<typeof handleWikidata>>): string {
	expect(result).not.toBeNull();
	expect(isScraperDegrade(result)).toBe(false);
	return (result as { content: string }).content;
}

const WIKIDATA_ENTITY = {
	entities: {
		Q1: {
			labels: { en: { language: "en", value: "universe" } },
			claims: {
				P31: [
					{
						mainsnak: {
							snaktype: "value",
							datatype: "wikibase-item",
							datavalue: { type: "wikibase-entityid", value: { id: "Q36906466" } },
						},
					},
				],
			},
		},
	},
};

const WIKIDATA_LABEL_MESSAGE = "Wikidata label lookup failed; those entities render as raw Q-ids";

describe("wikidata entity-label batch", () => {
	it("renders the resolved label and says nothing when the batch succeeds", async () => {
		// The load-bearing silence: this is the ordinary path, and a warning here would make the
		// two below worthless.
		route([
			["Special:EntityData", () => json(WIKIDATA_ENTITY)],
			["wbgetentities", () => json({ entities: { Q36906466: { labels: { en: { value: "class of entity" } } } } })],
		]);

		const md = markdown(await handleWikidata("https://www.wikidata.org/wiki/Q1", 5));

		expect(md).toContain("class of entity");
		expect(md).not.toContain("Q36906466");
		expect(warnings).toEqual([]);
	});

	it("names the entity ids it could not resolve when the batch request fails", async () => {
		// The invisible loss. The page still renders, the tool still reports success, and the
		// only signal that a field was dropped is this warning.
		route([
			["Special:EntityData", () => json(WIKIDATA_ENTITY)],
			["wbgetentities", () => json({ error: "service unavailable" }, 500)],
		]);

		const md = markdown(await handleWikidata("https://www.wikidata.org/wiki/Q1", 5));

		expect(md).toContain("Q36906466");
		expect(warnings.length).toBe(1);
		expect(warnings[0]?.message).toBe(WIKIDATA_LABEL_MESSAGE);
		expect(warnings[0]?.fields).toEqual({ ids: "Q36906466", reason: "HTTP 500" });
	});

	it("reports a batch response that is not valid JSON, carrying the parser's own message", async () => {
		// A 200 with a proxy's HTML error page in it reaches `JSON.parse` and throws. Distinct
		// from the branch above: the failure is in the body, not the status, so the field it
		// reports is `error` rather than `reason`.
		route([
			["Special:EntityData", () => json(WIKIDATA_ENTITY)],
			["wbgetentities", () => new Response("<html>proxy error</html>", { status: 200 })],
		]);

		const md = markdown(await handleWikidata("https://www.wikidata.org/wiki/Q1", 5));

		expect(md).toContain("Q36906466");
		expect(warnings.length).toBe(1);
		expect(warnings[0]?.message).toBe(WIKIDATA_LABEL_MESSAGE);
		expect(String(warnings[0]?.fields.error)).toContain("JSON Parse error");
	});

	it("rethrows a cancellation raised during the batch instead of logging a lost label", async () => {
		// The other half. Swallowing this would have the handler go on to build and return a page
		// for a request the user already stopped, and the abort would never reach the tool layer.
		const controller = new AbortController();
		route([
			["Special:EntityData", () => json(WIKIDATA_ENTITY)],
			[
				"wbgetentities",
				() => {
					controller.abort();
					throw new DOMException("The operation was aborted.", "AbortError");
				},
			],
		]);

		await expect(handleWikidata("https://www.wikidata.org/wiki/Q1", 5, controller.signal)).rejects.toBeInstanceOf(
			ToolAbortError,
		);
		expect(warnings.filter(entry => entry.message === WIKIDATA_LABEL_MESSAGE)).toEqual([]);
	});
});

const OPENLIBRARY_WORK = {
	title: "Ada, the Enchantress of Numbers",
	authors: [{ author: { key: "/authors/OL1A" } }],
};

const OPENLIBRARY_AUTHOR_MESSAGE = "Open Library author lookup failed; the book renders without that author";

describe("open library author lookup", () => {
	it("renders the author name and says nothing when the lookup succeeds", async () => {
		route([
			["/works/OL1W.json", () => json(OPENLIBRARY_WORK)],
			["/authors/OL1A.json", () => json({ name: "Betty Alexandra Toole" })],
		]);

		const md = markdown(await handleOpenLibrary("https://openlibrary.org/works/OL1W", 5));

		expect(md).toContain("**Authors:** Betty Alexandra Toole");
		expect(warnings).toEqual([]);
	});

	it("names the author key it dropped when the lookup fails", async () => {
		// Without this, the book renders with an authors line that is simply absent, and a reader
		// concludes the record has no author rather than that one request failed.
		route([
			["/works/OL1W.json", () => json(OPENLIBRARY_WORK)],
			["/authors/OL1A.json", () => json({ error: "notfound" }, 404)],
		]);

		const md = markdown(await handleOpenLibrary("https://openlibrary.org/works/OL1W", 5));

		expect(md).toContain("Ada, the Enchantress of Numbers");
		expect(md).not.toContain("**Authors:**");
		expect(warnings.length).toBe(1);
		expect(warnings[0]?.message).toBe(OPENLIBRARY_AUTHOR_MESSAGE);
		expect(warnings[0]?.fields).toEqual({ author: "/authors/OL1A", reason: "HTTP 404" });
	});

	it("reports each dropped author separately when several lookups fail", async () => {
		// The lookups run in parallel and each has its own warning, so the operator can tell one
		// missing name from three.
		route([
			[
				"/works/OL1W.json",
				() =>
					json({
						title: "A collaboration",
						authors: [
							{ author: { key: "/authors/OL1A" } },
							{ author: { key: "/authors/OL2A" } },
							{ author: { key: "/authors/OL3A" } },
						],
					}),
			],
			["/authors/OL2A.json", () => json({ name: "the one that worked" })],
			["/authors/", () => json({ error: "gone" }, 410)],
		]);

		const md = markdown(await handleOpenLibrary("https://openlibrary.org/works/OL1W", 5));

		expect(md).toContain("**Authors:** the one that worked");
		expect(warnings.map(entry => entry.fields.author).sort()).toEqual(["/authors/OL1A", "/authors/OL3A"]);
	});
});

const W3C_SPEC = { title: "CSS Color Module Level 4", shortname: "css-color-4" };
const W3C_EDITORS_URL = "https://api.w3.org/specifications/css-color-4/versions/20220105/editors";
const W3C_LATEST = {
	uri: "https://www.w3.org/TR/css-color-4/",
	status: "CR",
	_links: { editors: { href: W3C_EDITORS_URL } },
};
const W3C_EDITORS_MESSAGE = "W3C editors list was not valid JSON; the spec renders without editors";

describe("w3c editors payload", () => {
	it("renders the editors and says nothing when the payload parses", async () => {
		route([
			["/versions/latest", () => json(W3C_LATEST)],
			["/editors", () => json({ _links: { editors: [{ title: "Tab Atkins Jr." }] } })],
			["/specifications/css-color-4", () => json(W3C_SPEC)],
		]);

		const md = markdown(await handleW3c("https://www.w3.org/TR/css-color-4/", 5));

		expect(md).toContain("Tab Atkins Jr.");
		expect(warnings).toEqual([]);
	});

	it("names the editors URL when its payload is not valid JSON", async () => {
		// A 200 carrying HTML lands in `JSON.parse`. The spec still renders — that is the right
		// call — and the warning is the only thing distinguishing it from a spec with no editors.
		route([
			["/versions/latest", () => json(W3C_LATEST)],
			["/editors", () => new Response("<html>gateway</html>", { status: 200 })],
			["/specifications/css-color-4", () => json(W3C_SPEC)],
		]);

		const md = markdown(await handleW3c("https://www.w3.org/TR/css-color-4/", 5));

		expect(md).toContain("CSS Color Module Level 4");
		expect(warnings.length).toBe(1);
		expect(warnings[0]?.message).toBe(W3C_EDITORS_MESSAGE);
		expect(warnings[0]?.fields.url).toBe(W3C_EDITORS_URL);
		expect(String(warnings[0]?.fields.error)).toContain("JSON Parse error");
	});
});

const OPEN_VSX_README_URL = "https://open-vsx.org/api/rust-lang/rust-analyzer/0.3/file/README.md";
const OPEN_VSX_EXTENSION = {
	name: "rust-analyzer",
	namespace: "rust-lang",
	displayName: "rust-analyzer",
	version: "0.3",
	files: { readme: OPEN_VSX_README_URL },
};
const OPEN_VSX_README_MESSAGE = "Open VSX readme could not be fetched; the extension renders without it";

describe("open vsx readme", () => {
	it("renders the readme and says nothing when it is fetched", async () => {
		route([
			["file/README.md", () => new Response("# rust-analyzer\n\nIt analyzes.", { status: 200 })],
			["/api/rust-lang/rust-analyzer", () => json(OPEN_VSX_EXTENSION)],
		]);

		const md = markdown(await handleOpenVsx("https://open-vsx.org/extension/rust-lang/rust-analyzer", 5));

		expect(md).toContain("It analyzes.");
		expect(warnings).toEqual([]);
	});

	it("names the readme URL when the readme request fails", async () => {
		// The readme is most of what a reader wants from an extension page, so losing it silently
		// is the largest of these four losses even though the page still looks complete.
		route([
			["file/README.md", () => new Response("nope", { status: 500 })],
			["/api/rust-lang/rust-analyzer", () => json(OPEN_VSX_EXTENSION)],
		]);

		const md = markdown(await handleOpenVsx("https://open-vsx.org/extension/rust-lang/rust-analyzer", 5));

		expect(md).toContain("rust-analyzer");
		expect(warnings.length).toBe(1);
		expect(warnings[0]?.message).toBe(OPEN_VSX_README_MESSAGE);
		expect(warnings[0]?.fields).toEqual({ url: OPEN_VSX_README_URL, reason: "HTTP 500" });
	});

	it("says nothing when the extension declares no readme at all", async () => {
		// The genuinely empty case, which must not be reported: there was nothing to lose.
		route([["/api/rust-lang/rust-analyzer", () => json({ ...OPEN_VSX_EXTENSION, files: {} })]]);

		const md = markdown(await handleOpenVsx("https://open-vsx.org/extension/rust-lang/rust-analyzer", 5));

		expect(md).toContain("rust-analyzer");
		expect(warnings).toEqual([]);
	});

	it("rethrows a cancellation raised during the readme fetch", async () => {
		const controller = new AbortController();
		route([
			[
				"file/README.md",
				() => {
					controller.abort();
					throw new DOMException("The operation was aborted.", "AbortError");
				},
			],
			["/api/rust-lang/rust-analyzer", () => json(OPEN_VSX_EXTENSION)],
		]);

		await expect(
			handleOpenVsx("https://open-vsx.org/extension/rust-lang/rust-analyzer", 5, controller.signal),
		).rejects.toBeInstanceOf(ToolAbortError);
		expect(warnings.filter(entry => entry.message === OPEN_VSX_README_MESSAGE)).toEqual([]);
	});
});
