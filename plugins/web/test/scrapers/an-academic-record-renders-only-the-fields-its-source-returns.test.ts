import { afterEach, describe, expect, it, spyOn, vi } from "bun:test";
import { ACADEMIC_PAPER_DECLARATIONS } from "../../src/scrapers/declarations/academic-papers";
import { type AcademicPaperDeclaration, createAcademicPaperHandler } from "../../src/scrapers/engine/academic-paper";
import * as scraperTypes from "../../src/scrapers/types";
import {
	isScraperDegrade,
	type LoadPageOptions,
	type LoadPageResult,
	type RenderResult,
	type ScraperDegrade,
} from "../../src/scrapers/types";

/**
 * WHY: the ORCID, PubMed, RFC and Semantic Scholar handlers render a record whose every field is
 * optional. The defect class is a field rendered when the source lacks it (an empty label, an
 * `undefined`, a heading over nothing), a fallback missing when it lacks it, and a failed side
 * request taking the whole page down or leaking its error body into the output. Each case serves
 * a sparse or failing record through the real handler and pins the exact markdown, the notes and
 * the requests made.
 *
 * Gap: the fixtures follow the field names each handler reads. A field the upstream API renames
 * reads as absent here and renders as absent, which this suite cannot tell from a sparse record.
 */

type Reply = LoadPageResult | Error;

interface Request {
	url: string;
	options?: LoadPageOptions;
}

function ok(content: unknown): LoadPageResult {
	const body = typeof content === "string" ? content : JSON.stringify(content);
	return { content: body, contentType: "application/json", finalUrl: "", ok: true, status: 200 };
}

function failed(status: number, content = ""): LoadPageResult {
	return { content, contentType: "text/plain", finalUrl: "", ok: false, status };
}

/** Answers each request with the next reply queued on the first route its URL contains, and records it. */
function serve(routes: Record<string, Reply[]>): Request[] {
	const requests: Request[] = [];
	spyOn(scraperTypes, "loadPage").mockImplementation(async (url, options) => {
		requests.push({ url, options });
		const route = Object.keys(routes).find(key => url.includes(key));
		const reply = route ? routes[route].shift() : undefined;
		if (reply instanceof Error) throw reply;
		return reply ?? failed(404);
	});
	return requests;
}

function declaration(site: string): AcademicPaperDeclaration {
	const decl = ACADEMIC_PAPER_DECLARATIONS.find(candidate => candidate.site === site);
	if (!decl) throw new Error(`no ${site} declaration`);
	return decl;
}

async function scrape(site: string, url: string): Promise<RenderResult | ScraperDegrade | null> {
	return createAcademicPaperHandler(declaration(site))(url, 10);
}

async function render(site: string, url: string): Promise<RenderResult> {
	const result = await scrape(site, url);
	if (!result || isScraperDegrade(result)) throw new Error(`${site} did not render: ${JSON.stringify(result)}`);
	return result;
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("ORCID", () => {
	const ORCID_URL = "https://orcid.org/0000-0002-1825-0097";
	const RECORD = "pub.orcid.org";
	const employments = (...summaries: object[]) => ({
		"affiliation-group": [{ summaries: summaries.map(summary => ({ "employment-summary": summary })) }],
	});

	it("renders each affiliation with the dates, role, department and location it has", async () => {
		serve({
			[RECORD]: [
				ok({
					"activities-summary": {
						employments: employments(
							{ organization: { name: "Org A" }, "end-date": { year: { value: "2014" } } },
							{ "role-title": "Visiting Fellow", "department-name": "Physics" },
							{ organization: { name: "Org C" } },
							{},
							{ organization: { address: { city: "Nowhere" } } },
							{ organization: { name: "Org E" }, "start-date": { year: { value: "2020" } } },
						),
						educations: { "affiliation-group": [] },
					},
				}),
			],
		});

		const result = await render("orcid", ORCID_URL);

		expect(result.content).toContain(
			"## Affiliations\n\n### Employment\n\n- Org A (Dates: Until 2014)\n- Visiting Fellow (Physics)\n- Org C\n- Org E (Dates: 2020 - Present)\n\n## Works",
		);
		expect(result.content).not.toContain("### Education");
		expect(result.content).not.toContain("undefined");
	});

	it.each([
		[{ "given-names": { value: "Ada" }, "family-name": { value: "Lovelace" } }, "# Ada Lovelace\n"],
		[{ "family-name": { value: "Lovelace" } }, "# Lovelace\n"],
		[{ "given-names": { value: "Ada" } }, "# Ada\n"],
		[{}, "# ORCID Profile\n"],
	])("titles a record without a credit name by the names it has (%j)", async (name, title) => {
		serve({ [RECORD]: [ok({ person: { name } })] });

		const result = await render("orcid", ORCID_URL);

		expect(result.content.startsWith(title)).toBe(true);
	});

	it("renders each section's fallback for an empty record", async () => {
		serve({ [RECORD]: [ok({})] });

		const result = await render("orcid", ORCID_URL);

		expect(result.content).toEndWith(
			"## Biography\n\nNo biography available.\n\n## Affiliations\n\nNo affiliations available.\n\n## Works\n\nNo works available.",
		);
	});

	it("lists each distinct work title once, in record order, and at most 50 of them", async () => {
		const titles = Array.from({ length: 60 }, (_, index) => `Work ${index + 1}`);
		const group = titles.map(title => ({ "work-summary": [{ title: { title: { value: title } } }] }));
		group.splice(1, 0, { "work-summary": [{ title: { title: { value: "Work 1" } } }] });
		serve({ [RECORD]: [ok({ "activities-summary": { works: { group } } })] });

		const result = await render("orcid", ORCID_URL);

		const works = result.content.split("## Works\n\n")[1];
		expect(works).toBe(
			titles
				.slice(0, 50)
				.map(title => `- ${title}`)
				.join("\n"),
		);
	});
});

describe("PubMed", () => {
	const PUBMED_URL = "https://pubmed.ncbi.nlm.nih.gov/31882512/";
	const summary = (article: object) => ok({ result: { "31882512": article } });
	const TEXT_ACCEPT = "text/plain, */*;q=0.8";

	it("renders the identifiers and citation parts the summary has, and the abstract fallback", async () => {
		serve({
			"esummary.fcgi": [
				summary({ title: "T", fulljournalname: "J", pages: "1-2", elocationid: "doi: 10.1/x", articleids: [] }),
			],
			"rettype=abstract": [failed(404), failed(404)],
			"rettype=medline": [ok("PMID- 31882512\nMHDA- 2020/01/01 06:00\nMH  - Humans\n")],
		});

		const result = await render("pubmed", PUBMED_URL);

		expect(result.content).toBe(
			"# T\n\n**Journal:** J\n**Citation:** pp 1-2\n**PMID:** 31882512\n**DOI:** 10.1/x\n\n---\n\n## Abstract\n\nNo abstract available.\n\n## MeSH Terms\n\n- Humans",
		);
		expect(result.notes).toEqual(["Fetched MeSH terms via NCBI E-utilities"]);
	});

	it.each([
		["doi: 10.21873/invivo.11794", "10.21873/invivo.11794"],
		["pii: S0140-6736(20)30183-5. doi: 10.1016/S0140-6736(20)30183-5", "10.1016/S0140-6736(20)30183-5"],
		["doi: 10.1016/j.cell.2020.01.001. pii: S0092-8674(20)30001-1", "10.1016/j.cell.2020.01.001"],
		["pii: e2021", undefined],
		["", undefined],
	])("reads the DOI of the electronic location ids %j", async (elocationid, doi) => {
		serve({
			"esummary.fcgi": [summary({ title: "T", elocationid, articleids: [{ idtype: "pubmed", value: "31882512" }] })],
			"rettype=abstract": [ok("Abstract text")],
		});

		const result = await render("pubmed", PUBMED_URL);

		const fields = result.content.split("\n---\n")[0];
		expect(fields).toBe(`# T\n\n**PMID:** 31882512\n${doi ? `**DOI:** ${doi}\n` : ""}`);
	});

	it("retries each E-utilities request once and asks the text endpoints for text", async () => {
		const requests = serve({
			"esummary.fcgi": [failed(503), summary({ title: "T" })],
			"rettype=abstract": [failed(503), ok("Abstract text")],
			"rettype=medline": [failed(503)],
		});

		const result = await render("pubmed", PUBMED_URL);

		expect(result.content).toEndWith("## Abstract\n\nAbstract text");
		const sent = requests.map(request => [
			request.url.match(/esummary|abstract|medline/)?.[0],
			request.options?.timeout,
			request.options?.headers?.Accept,
		]);
		expect(sent).toEqual([
			["esummary", 10, "application/json"],
			["esummary", 10, "application/json"],
			["abstract", 10, TEXT_ACCEPT],
			["abstract", 10, TEXT_ACCEPT],
			["medline", 5, TEXT_ACCEPT],
		]);
	});

	it("degrades after the second failed summary request", async () => {
		const requests = serve({ "esummary.fcgi": [failed(503), failed(503), ok({})] });

		const result = await scrape("pubmed", PUBMED_URL);

		expect(isScraperDegrade(result)).toBe(true);
		expect(requests).toHaveLength(2);
	});

	it.each([
		["throws", new Error("socket hang up")],
		["fails with a MEDLINE-shaped error body", failed(500, "MH  - Leaked")],
		["lists no terms", ok("PMID- 31882512\nTI  - T\n")],
	])("renders without MeSH terms when the MEDLINE request %s", async (_, medline) => {
		serve({
			"esummary.fcgi": [summary({ title: "T" })],
			"rettype=abstract": [ok("Abstract text")],
			"rettype=medline": [medline],
		});

		const result = await render("pubmed", PUBMED_URL);

		expect(result.content).toEndWith("## Abstract\n\nAbstract text");
		expect(result.notes).toEqual(["Fetched abstract via NCBI E-utilities"]);
	});

	it("renders nothing for an id the summary does not list", async () => {
		serve({ "esummary.fcgi": [ok({ result: {} })] });

		expect(await scrape("pubmed", PUBMED_URL)).toBeNull();
	});
});

describe("RFC", () => {
	const RFC_URL = "https://www.rfc-editor.org/rfc/rfc9110";

	it.each([
		["https://www.rfc-editor.org/rfc/rfc9110", "9110"],
		["https://www.rfc-editor.org/rfc/rfc9110.html", "9110"],
		["https://rfc-editor.org/rfc/rfc9110.txt", "9110"],
		["https://www.rfc-editor.org/rfc/rfc9110.pdf", "9110"],
		["https://datatracker.ietf.org/doc/rfc9110/", "9110"],
		["https://datatracker.ietf.org/doc/html/rfc9110", "9110"],
		["https://tools.ietf.org/html/rfc2616", "2616"],
		["https://www.rfc-editor.org/info/rfc9110", undefined],
		["https://datatracker.ietf.org/doc/draft-ietf-httpbis-semantics/", undefined],
		["https://constructor/rfc/rfc9110", undefined],
		["https://__proto__/rfc/rfc9110", undefined],
	])("reads the RFC number of %s", (url, rfcNumber) => {
		expect(declaration("rfc").match(new URL(url))?.rfcNumber).toBe(rfcNumber);
	});

	it("drops each page break with its page header lines and each page footer", async () => {
		serve({
			"rfc9110.json": [failed(404)],
			"rfc9110.txt": [
				ok("Line A\n\n\n\n\nLine B\n   [Page 3]\n\f\nRFC 9110   HTTP Semantics   June 2022\n\n\nLine C"),
			],
		});

		const result = await render("rfc", RFC_URL);

		expect(result.content).toBe("# RFC 9110\n\n## Full Text\n\n```\nLine A\n\nLine B\nLine C\n```");
	});

	it.each([
		["fails", failed(404, '{"title":"Not Found"}')],
		["is not JSON", ok("<html>maintenance</html>")],
	])("renders the plain text when the metadata request %s", async (_, metadata) => {
		serve({ "rfc9110.json": [metadata], "rfc9110.txt": [ok("Body")] });

		const result = await render("rfc", RFC_URL);

		expect(result.content).toBe("# RFC 9110\n\n## Full Text\n\n```\nBody\n```");
		expect(result.notes).toEqual(["Metadata not available, showing plain text only"]);
	});

	it("degrades when the text does not load", async () => {
		serve({ "rfc9110.json": [ok({ title: "HTTP Semantics" })], "rfc9110.txt": [failed(404)] });

		expect(isScraperDegrade(await scrape("rfc", RFC_URL))).toBe(true);
	});

	it("renders a metadata record without a title, errata link or related documents", async () => {
		serve({
			"rfc9110.json": [
				ok({
					doc_id: "RFC9110",
					status: "INTERNET STANDARD",
					authors: [],
					obsoletes: [],
					obsoleted_by: [],
					updates: [],
					updated_by: [],
					keywords: [],
					errata_url: null,
				}),
			],
			"rfc9110.txt": [ok("Body")],
		});

		const result = await render("rfc", RFC_URL);

		expect(result.content).toBe(
			"# RFC 9110\n\n**Status:** INTERNET STANDARD\n\n---\n\n## Full Text\n\n```\nBody\n```",
		);
		expect(result.notes).toEqual(["Metadata from RFC Editor JSON API"]);
	});
});

describe("Semantic Scholar", () => {
	const PAPER_ID = "204e3073870fae3d05bcbc2f6a8e263c9b72e776";
	const PAPER_URL = `https://www.semanticscholar.org/paper/${PAPER_ID}`;
	const PAGE_LINK = `[Semantic Scholar](https://www.semanticscholar.org/paper/${PAPER_ID})`;

	it("renders a bare paper as its fallback title and its own page link", async () => {
		serve({ "api.semanticscholar.org": [ok({ paperId: PAPER_ID })] });

		const result = await render("semantic-scholar", PAPER_URL);

		expect(result.content).toBe(`# Untitled\n\n## Links\n\n${PAGE_LINK}`);
	});

	it("renders zero citation and reference counts", async () => {
		serve({
			"api.semanticscholar.org": [ok({ paperId: PAPER_ID, title: "T", citationCount: 0, referenceCount: 0 })],
		});

		const result = await render("semantic-scholar", PAPER_URL);

		expect(result.content).toBe(`# T\n\nCitations: 0 • References: 0\n\n## Links\n\n${PAGE_LINK}`);
	});
});
