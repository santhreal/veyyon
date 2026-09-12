import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { ACADEMIC_PAPER_DECLARATIONS } from "../../src/scrapers/declarations/academic-papers";
import { type AcademicPaperDeclaration, createAcademicPaperHandler } from "../../src/scrapers/engine/academic-paper";
import type { RenderResult, SpecialHandler } from "../../src/scrapers/types";
import * as scraperTypes from "../../src/scrapers/types";

function asRender(result: unknown): RenderResult | null {
	if (result && typeof result === "object" && "content" in result) {
		return result as RenderResult;
	}
	return null;
}

interface SpyRestorer {
	mockRestore: () => void;
}

describe("academic paper field fidelity offline suite", () => {
	let loadPageSpy: SpyRestorer | null = null;

	afterEach(() => {
		if (loadPageSpy) {
			loadPageSpy.mockRestore();
			loadPageSpy = null;
		}
	});

	it("derives all 8 academic paper declarations dynamically from exported array", () => {
		const sites = ACADEMIC_PAPER_DECLARATIONS.map(d => d.site);
		expect(sites.sort()).toEqual(
			["arxiv", "biorxiv", "crossref", "iacr", "orcid", "pubmed", "rfc", "semantic-scholar"].sort(),
		);
	});

	const handlers = new Map<string, SpecialHandler>(
		ACADEMIC_PAPER_DECLARATIONS.map(decl => [decl.site, createAcademicPaperHandler(decl)]),
	);

	it("arxiv: renders title, multiple authors, published date, categories, arxiv ID, and abstract", async () => {
		const arxivXml = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <title>Sentinel Attention Is All You Need</title>
    <summary>This is a sentinel abstract explaining attention mechanisms in transformers.</summary>
    <author><name>Sentinel Ashish Vaswani</name></author>
    <author><name>Sentinel Noam Shazeer</name></author>
    <author><name>Sentinel Niki Parmar</name></author>
    <author><name>Sentinel Jakob Uszkoreit</name></author>
    <published>2017-06-12T17:00:00Z</published>
    <category term="cs.CL"/>
    <category term="cs.AI"/>
    <category term="cs.LG"/>
    <link title="pdf" href="https://arxiv.org/pdf/1706.03762.pdf"/>
  </entry>
</feed>`;

		loadPageSpy = spyOn(scraperTypes, "loadPage").mockImplementation(async () => ({
			content: arxivXml,
			contentType: "application/atom+xml",
			finalUrl: "https://export.arxiv.org/api/query?id_list=1706.03762",
			ok: true,
			status: 200,
		}));

		const handler = handlers.get("arxiv")!;
		const result = asRender(await handler("https://arxiv.org/abs/1706.03762", 10));

		expect(result).not.toBeNull();
		expect(result?.method).toBe("arxiv");
		expect(result?.content).toContain("# Sentinel Attention Is All You Need");
		expect(result?.content).toContain(
			"**Authors:** Sentinel Ashish Vaswani, Sentinel Noam Shazeer, Sentinel Niki Parmar, Sentinel Jakob Uszkoreit",
		);
		expect(result?.content).toContain("**Published:** 2017-06-12");
		expect(result?.content).toContain("**Categories:** cs.CL, cs.AI, cs.LG");
		expect(result?.content).toContain("**arXiv:** 1706.03762");
		expect(result?.content).toContain(
			"## Abstract\n\nThis is a sentinel abstract explaining attention mechanisms in transformers.",
		);
		expect(result?.notes).toEqual(["Fetched via arXiv API"]);
	});

	it("biorxiv: renders corresponding author, posted date, version, license, DOI link, journal, abstract, and links", async () => {
		const biorxivJson = {
			collection: [
				{
					biorxiv_doi: "10.1101/2023.01.01.522435",
					title: "Sentinel Deep Structure Discovery in Genomic Sequences",
					authors: "Sentinel Alice Smith, Sentinel Bob Jones, Sentinel Carol White",
					author_corresponding: "Sentinel Alice Smith",
					author_corresponding_institution: "Sentinel Institute of Genomics",
					abstract: "Sentinel abstract describing deep learning applications on eukaryotic genomic variation.",
					date: "2023-01-02",
					category: "Genomics",
					version: "1",
					license: "cc_by_nc_nd",
					published: "10.1038/s41586-023-00001-x",
					jatsxml: "https://www.biorxiv.org/content/early/2023/01/02/522435.source.xml",
				},
			],
		};

		loadPageSpy = spyOn(scraperTypes, "loadPage").mockImplementation(async () => ({
			content: JSON.stringify(biorxivJson),
			contentType: "application/json",
			finalUrl: "https://api.biorxiv.org/details/biorxiv/10.1101/2023.01.01.522435/na/json",
			ok: true,
			status: 200,
		}));

		const handler = handlers.get("biorxiv")!;
		const result = asRender(await handler("https://www.biorxiv.org/content/10.1101/2023.01.01.522435v1", 10));

		expect(result).not.toBeNull();
		expect(result?.method).toBe("biorxiv");
		expect(result?.content).toContain("# Sentinel Deep Structure Discovery in Genomic Sequences");
		expect(result?.content).toContain("**Authors:** Sentinel Alice Smith, Sentinel Bob Jones, Sentinel Carol White");
		expect(result?.content).toContain(
			"**Corresponding Author:** Sentinel Alice Smith (Sentinel Institute of Genomics)",
		);
		expect(result?.content).toContain("**Posted:** 2023-01-02");
		expect(result?.content).toContain("**Category:** Genomics");
		expect(result?.content).toContain("**Version:** 1");
		expect(result?.content).toContain("**License:** cc_by_nc_nd");
		expect(result?.content).toContain(
			"**DOI:** [10.1101/2023.01.01.522435](https://doi.org/10.1101/2023.01.01.522435)",
		);
		expect(result?.content).toContain("**Server:** bioRxiv");
		expect(result?.content).toContain(
			"> **Published in journal:** [10.1038/s41586-023-00001-x](https://doi.org/10.1038/s41586-023-00001-x)",
		);
		expect(result?.content).toContain(
			"## Abstract\n\nSentinel abstract describing deep learning applications on eukaryotic genomic variation.",
		);
		expect(result?.content).toContain("## Links");
		expect(result?.content).toContain(
			"- [View on bioRxiv](https://www.biorxiv.org/content/10.1101/2023.01.01.522435)",
		);
		expect(result?.content).toContain("- [PDF](https://www.biorxiv.org/content/10.1101/2023.01.01.522435.full.pdf)");
		expect(result?.content).toContain(
			"- [JATS XML](https://www.biorxiv.org/content/early/2023/01/02/522435.source.xml)",
		);
		expect(result?.notes).toEqual(["Fetched via bioRxiv API"]);
	});

	it("crossref: formats mixed author names, publisher, partial dates, XML abstract, and item type", async () => {
		const crossrefJson = {
			message: {
				title: ["Sentinel High-Resolution Cryo-EM Structure of Ribosome Complex"],
				author: [
					{ given: "Sentinel Ada", family: "Yonath" },
					{ name: "Sentinel Ribosome Structural Consortium" },
					{ given: "Sentinel Venki", family: "Ramakrishnan" },
				],
				"container-title": ["Nature Chemical Biology"],
				publisher: "Nature Publishing Group",
				published: {
					"date-parts": [[2023, 6, 14]],
				},
				DOI: "10.1038/s41589-023-0001-x",
				abstract:
					"<jats:p>Sentinel abstract with <jats:italic>molecular</jats:italic> details and <jats:bold>crystal</jats:bold> parameters.</jats:p>",
				type: "journal-article",
			},
		};

		loadPageSpy = spyOn(scraperTypes, "loadPage").mockImplementation(async () => ({
			content: JSON.stringify(crossrefJson),
			contentType: "application/json",
			finalUrl: "https://api.crossref.org/works/10.1038%2Fs41589-023-0001-x",
			ok: true,
			status: 200,
		}));

		const handler = handlers.get("crossref")!;
		const result = asRender(await handler("https://doi.org/10.1038/s41589-023-0001-x", 10));

		expect(result).not.toBeNull();
		expect(result?.method).toBe("crossref");
		expect(result?.content).toContain("# Sentinel High-Resolution Cryo-EM Structure of Ribosome Complex");
		expect(result?.content).toContain(
			"**Authors:** Sentinel Ada Yonath, Sentinel Ribosome Structural Consortium, Sentinel Venki Ramakrishnan",
		);
		expect(result?.content).toContain("**Journal:** Nature Chemical Biology");
		expect(result?.content).toContain("**Publisher:** Nature Publishing Group");
		expect(result?.content).toContain("**Published:** 2023-06-14");
		expect(result?.content).toContain("**DOI:** 10.1038/s41589-023-0001-x");
		expect(result?.content).toContain("**Type:** journal article");
		expect(result?.content).toContain(
			"## Abstract\n\nSentinel abstract with molecular details and crystal parameters.",
		);
		expect(result?.notes).toEqual(["Fetched via CrossRef API"]);
	});

	it("iacr: parses DOM and meta citation tags, date, ePrint number, keywords, and abstract", async () => {
		const iacrHtml = `<!DOCTYPE html>
<html>
  <head>
    <meta name="citation_title" content="Sentinel Post-Quantum Lattice Zero-Knowledge Protocols" />
    <meta name="citation_author" content="Sentinel Shafi Goldwasser" />
    <meta name="citation_author" content="Sentinel Silvio Micali" />
    <meta name="citation_publication_date" content="2023-03-01" />
  </head>
  <body>
    <h3 class="mb-3">Sentinel Post-Quantum Lattice Zero-Knowledge Protocols</h3>
    <div class="keywords">Keywords: post-quantum cryptography, lattice assumptions, zero knowledge</div>
    <div>
      <h5>Abstract</h5>
      <p>Sentinel IACR cryptology abstract demonstrating succinct zero-knowledge arguments based on standard Ring-LWE.</p>
    </div>
  </body>
</html>`;

		loadPageSpy = spyOn(scraperTypes, "loadPage").mockImplementation(async () => ({
			content: iacrHtml,
			contentType: "text/html",
			finalUrl: "https://eprint.iacr.org/2023/123",
			ok: true,
			status: 200,
		}));

		const handler = handlers.get("iacr")!;
		const result = asRender(await handler("https://eprint.iacr.org/2023/123", 10));

		expect(result).not.toBeNull();
		expect(result?.method).toBe("iacr");
		expect(result?.content).toContain("# Sentinel Post-Quantum Lattice Zero-Knowledge Protocols");
		expect(result?.content).toContain("**Authors:** Sentinel Shafi Goldwasser, Sentinel Silvio Micali");
		expect(result?.content).toContain("**Date:** 2023-03-01");
		expect(result?.content).toContain("**ePrint:** 2023/123");
		expect(result?.content).toContain("**Keywords:** post-quantum cryptography, lattice assumptions, zero knowledge");
		expect(result?.content).toContain(
			"## Abstract\n\nSentinel IACR cryptology abstract demonstrating succinct zero-knowledge arguments based on standard Ring-LWE.",
		);
		expect(result?.notes).toEqual(["Fetched from IACR ePrint Archive"]);
	});

	it("orcid: formats credit-name, biography, nested affiliations with locations/dates, and works list", async () => {
		const orcidJson = {
			"orcid-identifier": { path: "0000-0002-1825-0097" },
			person: {
				name: {
					"credit-name": { value: "Prof. Sentinel Turing" },
				},
				biography: {
					content:
						"Sentinel researcher pioneering computability theory, neural cryptography, and distributed systems.",
				},
			},
			"activities-summary": {
				employments: {
					"affiliation-group": [
						{
							summaries: [
								{
									"employment-summary": {
										organization: {
											name: "Sentinel Advanced Institute",
											address: { city: "Princeton", region: "NJ", country: "US" },
										},
										"role-title": "Distinguished Professor",
										"department-name": "Computer Science",
										"start-date": {
											year: { value: "2018" },
											month: { value: "09" },
											day: { value: "01" },
										},
									},
								},
							],
						},
					],
				},
				educations: {
					"affiliation-group": [
						{
							summaries: [
								{
									"education-summary": {
										organization: {
											name: "Sentinel King's College",
											address: { city: "Cambridge", country: "GB" },
										},
										"role-title": "Ph.D. in Mathematical Logic",
										"start-date": { year: { value: "2010" } },
										"end-date": { year: { value: "2014" } },
									},
								},
							],
						},
					],
				},
				works: {
					group: [
						{
							"work-summary": [
								{ title: { title: { value: "Sentinel On Computable Numbers and Cryptographic Machines" } } },
								{ title: { title: { value: "Sentinel Chemical Basis of Morphogenesis Simulations" } } },
							],
						},
					],
				},
			},
		};

		loadPageSpy = spyOn(scraperTypes, "loadPage").mockImplementation(async () => ({
			content: JSON.stringify(orcidJson),
			contentType: "application/json",
			finalUrl: "https://pub.orcid.org/v3.0/0000-0002-1825-0097/record",
			ok: true,
			status: 200,
		}));

		const handler = handlers.get("orcid")!;
		const result = asRender(await handler("https://orcid.org/0000-0002-1825-0097", 10));

		expect(result).not.toBeNull();
		expect(result?.method).toBe("orcid-api");
		expect(result?.content).toContain("# Prof. Sentinel Turing");
		expect(result?.content).toContain("**ORCID:** 0000-0002-1825-0097");
		expect(result?.content).toContain("**ORCID Profile:** https://orcid.org/0000-0002-1825-0097");
		expect(result?.content).toContain(
			"## Biography\n\nSentinel researcher pioneering computability theory, neural cryptography, and distributed systems.",
		);
		expect(result?.content).toContain("## Affiliations");
		expect(result?.content).toContain("### Employment");
		expect(result?.content).toContain(
			"- Sentinel Advanced Institute (Distinguished Professor; Dept: Computer Science; Location: Princeton, NJ, US; Dates: 2018-09-01 - Present)",
		);
		expect(result?.content).toContain("### Education");
		expect(result?.content).toContain(
			"- Sentinel King's College (Ph.D. in Mathematical Logic; Location: Cambridge, GB; Dates: 2010 - 2014)",
		);
		expect(result?.content).toContain("## Works");
		expect(result?.content).toContain("- Sentinel On Computable Numbers and Cryptographic Machines");
		expect(result?.content).toContain("- Sentinel Chemical Basis of Morphogenesis Simulations");
		expect(result?.notes).toEqual(["Fetched via ORCID Public API"]);
	});

	it("pubmed: fetches summary, abstract, and MeSH terms with full citation and identifiers", async () => {
		const pubmedSummary = {
			result: {
				"31882512": {
					title: "Sentinel Trial of Gene Editing for Sickle Cell Disease",
					authors: [{ name: "Sentinel Haydar Frangoul" }, { name: "Sentinel David Altshuler" }],
					fulljournalname: "The New England Journal of Medicine",
					pubdate: "2021 Jan 21",
					volume: "384",
					issue: "3",
					pages: "252-260",
					elocationid: "10.1056/NEJMoa2031054",
					articleids: [
						{ idtype: "doi", value: "10.1056/NEJMoa2031054" },
						{ idtype: "pmc", value: "PMC7890123" },
					],
				},
			},
		};
		const pubmedAbstract =
			"Sentinel abstract reporting successful non-viral CRISPR-Cas9 editing of BCL11A enhancer in human hematopoietic stem cells.";
		const pubmedMedline = `PMID- 31882512
MH  - Anemia, Sickle Cell/genetics
MH  - CRISPR-Cas Systems
MH  - Humans
MH  - Gene Editing`;

		loadPageSpy = spyOn(scraperTypes, "loadPage").mockImplementation(async (url: string) => {
			if (url.includes("esummary.fcgi")) {
				return {
					content: JSON.stringify(pubmedSummary),
					contentType: "application/json",
					finalUrl: url,
					ok: true,
					status: 200,
				};
			}
			if (url.includes("rettype=abstract")) {
				return {
					content: pubmedAbstract,
					contentType: "text/plain",
					finalUrl: url,
					ok: true,
					status: 200,
				};
			}
			if (url.includes("rettype=medline")) {
				return {
					content: pubmedMedline,
					contentType: "text/plain",
					finalUrl: url,
					ok: true,
					status: 200,
				};
			}
			return { content: "", contentType: "text/plain", finalUrl: url, ok: false, status: 404 };
		});

		const handler = handlers.get("pubmed")!;
		const result = asRender(await handler("https://pubmed.ncbi.nlm.nih.gov/31882512/", 10));

		expect(result).not.toBeNull();
		expect(result?.method).toBe("pubmed");
		expect(result?.content).toContain("# Sentinel Trial of Gene Editing for Sickle Cell Disease");
		expect(result?.content).toContain("**Authors:** Sentinel Haydar Frangoul, Sentinel David Altshuler");
		expect(result?.content).toContain("**Journal:** The New England Journal of Medicine (2021 Jan 21)");
		expect(result?.content).toContain("**Citation:** Vol 384, Issue 3, pp 252-260");
		expect(result?.content).toContain("**PMID:** 31882512");
		expect(result?.content).toContain("**DOI:** 10.1056/NEJMoa2031054");
		expect(result?.content).toContain("**PMCID:** PMC7890123");
		expect(result?.content).toContain(`## Abstract\n\n${pubmedAbstract}`);
		expect(result?.content).toContain("## MeSH Terms");
		expect(result?.content).toContain("- Anemia, Sickle Cell/genetics");
		expect(result?.content).toContain("- CRISPR-Cas Systems");
		expect(result?.content).toContain("- Gene Editing");
		expect(result?.notes).toContain("Fetched abstract via NCBI E-utilities");
		expect(result?.notes).toContain("Fetched MeSH terms via NCBI E-utilities");
	});

	it("rfc: parallel fetches metadata JSON and cleans plain text RFC formatting", async () => {
		const rfcJson = {
			doc_id: "RFC9110",
			title: "HTTP Semantics",
			authors: [
				{ name: "Roy T. Fielding", affiliation: "Adobe" },
				{ name: "Mark Nottingham", affiliation: "Fastly" },
				{ name: "Julian Reschke", affiliation: "greenbytes" },
			],
			pub_date: "June 2022",
			current_status: "PROPOSED STANDARD",
			stream: "IETF",
			area: "ART",
			wg_acronym: "httpbis",
			page_count: 194,
			obsoletes: ["RFC7230", "RFC7231", "RFC7232"],
			obsoleted_by: [],
			updates: ["RFC2818"],
			updated_by: [],
			keywords: ["HTTP", "Semantics", "Hypertext Transfer Protocol"],
			errata_url: "https://www.rfc-editor.org/errata/rfc9110",
			abstract:
				"Sentinel RFC abstract defining architecture, semantics, and method definitions of HTTP/1.1 and HTTP/2.",
		};

		const rfcRawText = `Internet Engineering Task Force (IETF)                      R. Fielding, Ed.
Request for Comments: 9110                                             Adobe
STD: 97                                                    M. Nottingham, Ed.
Obsoletes: 7230, 7231, 7232                                           Fastly
Category: Standards Track                                          greenbytes
ISSN: 2070-1721                                                    June 2022

                                HTTP Semantics

Abstract

   Sentinel RFC abstract defining architecture, semantics, and method definitions of HTTP/1.1 and HTTP/2.

   [Page 1]
\f
RFC 9110                     HTTP Semantics                    June 2022

1.  Introduction

   Sentinel body text for section 1.`;

		loadPageSpy = spyOn(scraperTypes, "loadPage").mockImplementation(async (url: string) => {
			if (url.endsWith(".json")) {
				return {
					content: JSON.stringify(rfcJson),
					contentType: "application/json",
					finalUrl: url,
					ok: true,
					status: 200,
				};
			}
			return {
				content: rfcRawText,
				contentType: "text/plain",
				finalUrl: url,
				ok: true,
				status: 200,
			};
		});

		const handler = handlers.get("rfc")!;
		const result = asRender(await handler("https://datatracker.ietf.org/doc/html/rfc9110", 10));

		expect(result).not.toBeNull();
		expect(result?.method).toBe("rfc");
		expect(result?.finalUrl).toBe("https://www.rfc-editor.org/rfc/rfc9110");
		expect(result?.content).toContain("# RFC 9110: HTTP Semantics");
		expect(result?.content).toContain(
			"**Authors:** Roy T. Fielding (Adobe), Mark Nottingham (Fastly), Julian Reschke (greenbytes)",
		);
		expect(result?.content).toContain("**Published:** June 2022");
		expect(result?.content).toContain("**Status:** PROPOSED STANDARD");
		expect(result?.content).toContain("**Stream:** IETF");
		expect(result?.content).toContain("**Area:** ART");
		expect(result?.content).toContain("**Working Group:** httpbis");
		expect(result?.content).toContain("**Pages:** 194");
		expect(result?.content).toContain("**Obsoletes:** RFC7230, RFC7231, RFC7232");
		expect(result?.content).toContain("**Updates:** RFC2818");
		expect(result?.content).toContain("**Keywords:** HTTP, Semantics, Hypertext Transfer Protocol");
		expect(result?.content).toContain("**Errata:** https://www.rfc-editor.org/errata/rfc9110");
		expect(result?.content).toContain(
			"## Abstract\n\nSentinel RFC abstract defining architecture, semantics, and method definitions of HTTP/1.1 and HTTP/2.",
		);
		expect(result?.content).toContain("## Full Text");
		expect(result?.content).not.toContain("\f");
		expect(result?.content).not.toContain("[Page 1]");
		expect(result?.content).toContain("Sentinel body text for section 1.");
		expect(result?.notes).toContain("Metadata from RFC Editor JSON API");
	});

	it("semantic-scholar: renders bullet metadata, citations, references, TL;DR, and external markdown links", async () => {
		const s2Json = {
			paperId: "204e3073870fae3d05bcbc2f6a8e263c9b72e776",
			title: "Sentinel Deep Residual Learning for Visual Recognition",
			abstract: "Sentinel abstract presenting residual learning framework to train substantially deeper networks.",
			authors: [
				{ name: "Sentinel Kaiming He" },
				{ name: "Sentinel Xiangyu Zhang" },
				{ name: "Sentinel Shaoqing Ren" },
				{ name: "Sentinel Jian Sun" },
			],
			year: 2016,
			citationCount: 185420,
			referenceCount: 42,
			fieldsOfStudy: ["Computer Science", "Artificial Intelligence"],
			journal: { name: "IEEE Conference on Computer Vision and Pattern Recognition (CVPR)" },
			externalIds: {
				DOI: "10.1109/CVPR.2016.90",
				ArXiv: "1512.03385",
				PubMed: "29876543",
			},
			tldr: {
				text: "We present a residual learning framework to ease the training of networks that are substantially deeper than those used previously.",
			},
			openAccessPdf: { url: "https://arxiv.org/pdf/1512.03385.pdf" },
		};

		loadPageSpy = spyOn(scraperTypes, "loadPage").mockImplementation(async () => ({
			content: JSON.stringify(s2Json),
			contentType: "application/json",
			finalUrl: "https://api.semanticscholar.org/graph/v1/paper/204e3073870fae3d05bcbc2f6a8e263c9b72e776",
			ok: true,
			status: 200,
		}));

		const handler = handlers.get("semantic-scholar")!;
		const result = asRender(
			await handler("https://www.semanticscholar.org/paper/204e3073870fae3d05bcbc2f6a8e263c9b72e776", 10),
		);

		expect(result).not.toBeNull();
		expect(result?.method).toBe("semantic-scholar");
		expect(result?.content).toContain("# Sentinel Deep Residual Learning for Visual Recognition");
		expect(result?.content).toContain(
			"**Authors:** Sentinel Kaiming He, Sentinel Xiangyu Zhang, Sentinel Shaoqing Ren, Sentinel Jian Sun",
		);
		expect(result?.content).toContain(
			"Year: 2016 • Venue: IEEE Conference on Computer Vision and Pattern Recognition (CVPR) • Citations: 185K • References: 42",
		);
		expect(result?.content).toContain("**Fields:** Computer Science, Artificial Intelligence");
		expect(result?.content).toContain(
			"## TL;DR\n\nWe present a residual learning framework to ease the training of networks that are substantially deeper than those used previously.",
		);
		expect(result?.content).toContain(
			"## Abstract\n\nSentinel abstract presenting residual learning framework to train substantially deeper networks.",
		);
		expect(result?.content).toContain("## Links");
		expect(result?.content).toContain(
			"[PDF](https://arxiv.org/pdf/1512.03385.pdf) • [arXiv](https://arxiv.org/abs/1512.03385) • [DOI](https://doi.org/10.1109/CVPR.2016.90) • [PubMed](https://pubmed.ncbi.nlm.nih.gov/29876543/) • [Semantic Scholar](https://www.semanticscholar.org/paper/204e3073870fae3d05bcbc2f6a8e263c9b72e776)",
		);
	});
	it("engine: preserves title-only default notes and empty-title semantics versus customMarkdown notes", async () => {
		const titleOnlyDecl: AcademicPaperDeclaration = {
			site: "test-title-only",
			method: "test-method",
			hosts: ["test-academic.org"],
			canonicalUrls: [],
			match: (p: URL) => ({ id: "123", parsedUrl: p }),
			notes: ["Custom Declared Notes Should Be Bypassed"],
			fetch: async () => ({ title: "" }),
		};
		const titleOnlyHandler = createAcademicPaperHandler(titleOnlyDecl);
		const titleResult = asRender(await titleOnlyHandler("https://test-academic.org/123", 10));
		expect(titleResult).not.toBeNull();
		expect(titleResult?.content).toBe("");
		expect(titleResult?.notes).toEqual(["Fetched via test-method API"]);

		const customMarkdownDecl: AcademicPaperDeclaration = {
			site: "test-custom-md",
			method: "test-method",
			hosts: ["test-academic.org"],
			canonicalUrls: [],
			match: (p: URL) => ({ id: "123", parsedUrl: p }),
			notes: (_m, meta) => [`Notes for ${meta?.customMarkdown}`],
			fetch: async () => ({ title: "Ignored", customMarkdown: "Custom Content" }),
		};
		const customHandler = createAcademicPaperHandler(customMarkdownDecl);
		const customResult = asRender(await customHandler("https://test-academic.org/123", 10));
		expect(customResult).not.toBeNull();
		expect(customResult?.content).toBe("Custom Content");
		expect(customResult?.notes).toEqual(["Notes for Custom Content"]);

		const stringReturnDecl: AcademicPaperDeclaration = {
			site: "test-string-return",
			method: "test-method",
			hosts: ["test-academic.org"],
			canonicalUrls: [],
			match: (p: URL) => ({ id: "123", parsedUrl: p }),
			notes: ["Declared Notes for String Return"],
			fetch: async () => "# String Content",
		};
		const stringHandler = createAcademicPaperHandler(stringReturnDecl);
		const stringResult = asRender(await stringHandler("https://test-academic.org/123", 10));
		expect(stringResult).not.toBeNull();
		expect(stringResult?.content).toBe("# String Content");
		expect(stringResult?.notes).toEqual(["Declared Notes for String Return"]);
	});

	it("engine: rejects foreign and invalid host URLs synchronously", async () => {
		for (const decl of ACADEMIC_PAPER_DECLARATIONS) {
			const handler = createAcademicPaperHandler(decl);
			expect(await handler("https://unrelated-domain.org/paper/123", 10)).toBeNull();
			expect(await handler("not-a-valid-url", 10)).toBeNull();
		}
	});

	it("engine: resolves dynamic method name from match server", async () => {
		const dynamicMethodDecl: AcademicPaperDeclaration = {
			site: "biorxiv",
			method: match => match.server || "biorxiv",
			hosts: ["www.biorxiv.org", "www.medrxiv.org"],
			canonicalUrls: ["https://www.biorxiv.org/content/10.1101/2023.01.01.522400v1"],
			match: p => ({ id: "10.1101/2023.01.01.522400v1", server: "medrxiv", parsedUrl: p }),
			fetch: async () => "# MedRxiv Paper\n",
		};
		const handler = createAcademicPaperHandler(dynamicMethodDecl);
		const res = asRender(await handler("https://www.medrxiv.org/content/10.1101/2023.01.01.522400v1", 10));
		expect(res).not.toBeNull();
		expect(res?.method).toBe("medrxiv");
	});

	it("engine: propagates cancellation without swallowing into ScraperDegrade", async () => {
		for (const decl of ACADEMIC_PAPER_DECLARATIONS) {
			const cancellingDecl = {
				...decl,
				fetch: async () => {
					throw new DOMException("The operation was aborted", "AbortError");
				},
			};
			const handler = createAcademicPaperHandler(cancellingDecl);
			const sampleUrl = decl.canonicalUrls[0];
			await expect(handler(sampleUrl, 10)).rejects.toMatchObject({ name: "AbortError" });
		}
	});
});
