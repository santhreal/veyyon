import { formatNumber } from "@veyyon/utils";
import { parseHTML } from "linkedom";
import { markdownLink } from "../../markdown-link";
import {
	type AcademicPaperContext,
	type AcademicPaperDeclaration,
	appendConvertedPdfSection,
} from "../engine/academic-paper";
import { loadJson } from "../engine/declarative";
import { renderKeyValues, renderStringList } from "../engine/markdown-assembly";
import { buildResult, htmlToBasicMarkdown, isScraperDegrade, type LoadPageResult } from "../types";
import { partialIsoDate } from "../utils";

// 1. arXiv
export const arxivDeclaration: AcademicPaperDeclaration = {
	site: "arxiv",
	method: "arxiv",
	hosts: ["arxiv.org"],
	canonicalUrls: ["https://arxiv.org/abs/1706.03762", "https://arxiv.org/pdf/1706.03762.pdf"],
	match: parsed => {
		const m = parsed.pathname.match(/\/(abs|pdf)\/(.+?)(?:\.pdf)?$/);
		return m ? { id: m[2], isPdf: m[1] === "pdf" || parsed.pathname.includes(".pdf"), parsedUrl: parsed } : null;
	},
	notes: ["Fetched via arXiv API"],
	fetch: async (match, ctx) => {
		const res = await ctx.loadPage(`https://export.arxiv.org/api/query?id_list=${match.id}`, {
			timeout: ctx.timeout,
			signal: ctx.signal,
		});
		if (!res.ok) return ctx.scraperDegrade("arxiv", ctx.loadFailure(res));
		const doc = parseHTML(res.content).document;
		const entry = doc.querySelector("entry");
		if (!entry) return null;

		const title = entry.querySelector("title")?.textContent?.trim()?.replace(/\s+/g, " ");
		const summary = entry.querySelector("summary")?.textContent?.trim();
		const authors = Array.from(entry.querySelectorAll("author name") as Iterable<{ textContent: string | null }>)
			.map(n => n.textContent?.trim())
			.filter((n): n is string => Boolean(n));
		const published = entry.querySelector("published")?.textContent?.trim()?.split("T")[0];
		const categories = Array.from(
			entry.querySelectorAll("category") as Iterable<{ getAttribute: (n: string) => string | null }>,
		)
			.map(c => c.getAttribute("term"))
			.filter((t): t is string => Boolean(t));
		const pdfLink = entry.querySelector('link[title="pdf"]')?.getAttribute("href");

		let md = `# ${title || "arXiv Paper"}\n\n`;
		if (authors.length) md += `**Authors:** ${authors.join(", ")}\n`;
		if (published) md += `**Published:** ${published}\n`;
		if (categories.length) md += `**Categories:** ${categories.join(", ")}\n`;
		md += `**arXiv:** ${match.id}\n\n`;
		md += `---\n\n## Abstract\n\n${summary || "No abstract available."}\n\n`;

		if (match.isPdf && pdfLink) {
			md += await appendConvertedPdfSection(pdfLink, ctx);
		}
		return md;
	},
};

// 2. bioRxiv & medRxiv
interface BiorxivPaper {
	biorxiv_doi?: string;
	medrxiv_doi?: string;
	title?: string;
	authors?: string;
	author_corresponding?: string;
	author_corresponding_institution?: string;
	abstract?: string;
	date?: string;
	category?: string;
	version?: string;
	type?: string;
	license?: string;
	jatsxml?: string;
	published?: string;
	server?: string;
}

interface BiorxivResponse {
	collection?: BiorxivPaper[];
	messages?: { status: string; count: number }[];
}

/** A preprint's record: authors, corresponding author, posting facts, DOI, journal publication, abstract and links. */
function renderBiorxivPaper(paper: BiorxivPaper, server: string, doi: string): string {
	const serverName = server === "biorxiv" ? "bioRxiv" : "medRxiv";
	const corresponding =
		paper.author_corresponding &&
		(paper.author_corresponding_institution
			? `${paper.author_corresponding} (${paper.author_corresponding_institution})`
			: paper.author_corresponding);
	let md = `# ${paper.title || "Untitled Preprint"}\n\n`;
	md += renderKeyValues([
		["Authors", paper.authors],
		["Corresponding Author", corresponding],
		["Posted", paper.date],
		["Category", paper.category],
		["Version", paper.version],
		["License", paper.license],
		["DOI", markdownLink(doi, `https://doi.org/${doi}`)],
		["Server", serverName],
	]);
	if (paper.published) {
		md += `\n> **Published in journal:** ${markdownLink(paper.published, `https://doi.org/${paper.published}`)}\n`;
	}
	md += `\n---\n\n## Abstract\n\n${paper.abstract || "No abstract available."}\n`;
	md += `\n---\n\n## Links\n\n`;
	md += `- ${markdownLink(`View on ${serverName}`, `https://www.${server}.org/content/${doi}`)}\n`;
	md += `- ${markdownLink("PDF", `https://www.${server}.org/content/${doi}.full.pdf`)}\n`;
	if (paper.jatsxml) md += `- ${markdownLink("JATS XML", paper.jatsxml)}\n`;
	return md;
}

export const biorxivDeclaration: AcademicPaperDeclaration = {
	site: "biorxiv",
	method: m => m.server || "biorxiv",
	hosts: ["biorxiv.org", "www.biorxiv.org", "medrxiv.org", "www.medrxiv.org"],
	canonicalUrls: [
		"https://www.biorxiv.org/content/10.1101/2023.01.01.522435v1",
		"https://www.medrxiv.org/content/10.1101/2023.01.01.522435v1",
	],
	match: parsed => {
		const isBio = parsed.hostname.toLowerCase().includes("biorxiv.org");
		const m = parsed.pathname.match(/\/content\/(10\.\d{4,}\/[^\s?#]+)/);
		if (!m) return null;
		const id = m[1].replace(/v\d+$/, "").replace(/\.full(\.pdf)?$/, "");
		return {
			id,
			server: isBio ? "biorxiv" : "medrxiv",
			parsedUrl: parsed,
		};
	},
	notes: m => [`Fetched via ${m.server === "medrxiv" ? "medRxiv" : "bioRxiv"} API`],
	fetch: async (match, ctx) => {
		const server = match.server || "biorxiv";
		const apiUrl = `https://api.${server}.org/details/${server}/${match.id}/na/json`;
		const result = await ctx.loadPage(apiUrl, {
			headers: { Accept: "application/json" },
			signal: ctx.signal,
		});

		if (!result.ok) return ctx.scraperDegrade("biorxiv", ctx.loadFailure(result));

		const data = ctx.tryParseJson<BiorxivResponse>(result.content);
		if (!data) return ctx.scraperDegrade("biorxiv", "unexpected response shape");

		const paper = data.collection?.at(-1);
		if (!paper) return null;
		return renderBiorxivPaper(paper, server, paper.biorxiv_doi || paper.medrxiv_doi || match.id);
	},
};

// 3. Crossref
interface CrossrefAuthor {
	given?: string;
	family?: string;
	name?: string;
}

interface CrossrefDate {
	"date-parts"?: number[][];
}

interface CrossrefMessage {
	title?: string[];
	author?: CrossrefAuthor[];
	"container-title"?: string[];
	"short-container-title"?: string[];
	publisher?: string;
	published?: CrossrefDate;
	"published-print"?: CrossrefDate;
	"published-online"?: CrossrefDate;
	issued?: CrossrefDate;
	created?: CrossrefDate;
	DOI?: string;
	abstract?: string;
	type?: string;
}

interface CrossrefResponse {
	message?: CrossrefMessage;
}

function formatCrossrefAuthors(authors?: CrossrefAuthor[]): string | null {
	if (!authors?.length) return null;
	const names = authors
		.map(author => {
			if (author.name) return author.name;
			const parts = [author.given, author.family].filter(Boolean);
			return parts.length > 0 ? parts.join(" ") : null;
		})
		.filter((name): name is string => Boolean(name));
	return names.length > 0 ? names.join(", ") : null;
}

function formatCrossrefDate(date?: CrossrefDate): string | null {
	const [year, month, day] = date?.["date-parts"]?.[0] ?? [];
	return partialIsoDate(year, month, day);
}

/** The date fields a record's publication date is read from, most specific first. */
const CROSSREF_DATE_FIELDS = ["published", "published-print", "published-online", "issued", "created"] as const;

function crossrefPublished(message: CrossrefMessage): string | null {
	for (const field of CROSSREF_DATE_FIELDS) {
		const date = formatCrossrefDate(message[field]);
		if (date) return date;
	}
	return null;
}

/** The JATS abstract as markdown, or `null` when it renders to nothing. */
async function crossrefAbstract(abstract: string | undefined): Promise<string | null> {
	if (!abstract) return null;
	const normalized = abstract.replace(/<\/?jats:p[^>]*>/g, m => (m.startsWith("</") ? "</p>" : "<p>"));
	const markdown = await htmlToBasicMarkdown(normalized);
	return markdown.trim().length > 0 ? markdown : null;
}

export const crossrefDeclaration: AcademicPaperDeclaration = {
	site: "crossref",
	method: "crossref",
	hosts: ["doi.org", "dx.doi.org", "www.doi.org", "crossref.org"],
	canonicalUrls: ["https://doi.org/10.1038/nature12373", "https://crossref.org/10.1038/nature12373"],
	match: parsed => {
		const raw = parsed.pathname.replace(/^\/+/, "");
		if (!raw) return null;
		const id = decodeURIComponent(raw);
		return { id, parsedUrl: parsed };
	},
	notes: ["Fetched via CrossRef API"],
	fetch: async (match, ctx) => {
		const apiUrl = `https://api.crossref.org/works/${encodeURIComponent(match.id)}`;
		const data = await loadJson<CrossrefResponse>(ctx, apiUrl, "crossref");
		if (isScraperDegrade(data)) return data;
		const message = data.message;
		if (!message) return null;

		const abstract = await crossrefAbstract(message.abstract);
		let md = `# ${message.title?.[0]?.trim() || "CrossRef Record"}\n\n`;
		md += renderKeyValues([
			["Authors", formatCrossrefAuthors(message.author)],
			["Journal", message["container-title"]?.[0] || message["short-container-title"]?.[0]],
			["Publisher", message.publisher],
			["Published", crossrefPublished(message)],
			["DOI", message.DOI || match.id],
			["Type", message.type?.replace(/-/g, " ")],
		]);
		md += `\n---\n\n## Abstract\n\n${abstract || "No abstract available."}\n`;
		return md;
	},
};

// 4. IACR Cryptology ePrint
export const iacrDeclaration: AcademicPaperDeclaration = {
	site: "iacr",
	method: "iacr",
	hosts: ["eprint.iacr.org"],
	canonicalUrls: ["https://eprint.iacr.org/2023/123"],
	match: parsed => {
		const m = parsed.pathname.match(/\/(\d{4})\/(\d+)(?:\.pdf)?$/);
		return m ? { id: `${m[1]}/${m[2]}`, isPdf: parsed.pathname.endsWith(".pdf"), parsedUrl: parsed } : null;
	},
	notes: ["Fetched from IACR ePrint Archive"],
	fetch: async (match, ctx) => {
		const pageUrl = `https://eprint.iacr.org/${match.id}`;
		const result = await ctx.loadPage(pageUrl, {
			timeout: ctx.timeout,
			signal: ctx.signal,
		});

		if (!result.ok) return ctx.scraperDegrade("iacr", ctx.loadFailure(result));

		const doc = parseHTML(result.content).document;

		const title =
			doc.querySelector("h3.mb-3")?.textContent?.trim() ||
			doc.querySelector('meta[name="citation_title"]')?.getAttribute("content");
		const authors = Array.from(
			doc.querySelectorAll('meta[name="citation_author"]') as Iterable<{
				getAttribute: (name: string) => string | null;
			}>,
		)
			.map(m => m.getAttribute("content"))
			.filter((author): author is string => Boolean(author));

		const abstractHeading = Array.from(
			doc.querySelectorAll("h5") as Iterable<{
				textContent: string | null;
				parentElement?: { querySelector: (selector: string) => { textContent: string | null } | null } | null;
			}>,
		).find(h => h.textContent?.includes("Abstract"));
		const abstract =
			abstractHeading?.parentElement?.querySelector("p")?.textContent?.trim() ||
			doc.querySelector('meta[name="description"]')?.getAttribute("content");
		const keywords = doc.querySelector(".keywords")?.textContent?.replace("Keywords:", "").trim();
		const pubDate = doc.querySelector('meta[name="citation_publication_date"]')?.getAttribute("content");

		let md = `# ${title || "IACR ePrint Paper"}\n\n`;
		if (authors.length) md += `**Authors:** ${authors.join(", ")}\n`;
		if (pubDate) md += `**Date:** ${pubDate}\n`;
		md += `**ePrint:** ${match.id}\n`;
		if (keywords) md += `**Keywords:** ${keywords}\n`;
		md += `\n---\n\n## Abstract\n\n${abstract || "No abstract available."}\n\n`;

		if (match.isPdf) {
			const pdfUrl = `https://eprint.iacr.org/${match.id}.pdf`;
			md += await appendConvertedPdfSection(pdfUrl, ctx);
		}

		return md;
	},
};

// 5. ORCID
const MAX_ORCID_WORKS = 50;

interface OrcidName {
	"given-names"?: { value?: string };
	"family-name"?: { value?: string };
	"credit-name"?: { value?: string };
}

interface OrcidBiography {
	content?: string;
}

interface OrcidPerson {
	name?: OrcidName;
	biography?: OrcidBiography;
}

interface OrcidSummaryDate {
	year?: { value?: string };
	month?: { value?: string };
	day?: { value?: string };
}

interface OrcidOrganizationAddress {
	city?: string;
	region?: string;
	country?: string;
}

interface OrcidOrganization {
	name?: string;
	address?: OrcidOrganizationAddress;
}

interface OrcidAffiliationSummary {
	organization?: OrcidOrganization;
	"role-title"?: string;
	"department-name"?: string;
	"start-date"?: OrcidSummaryDate;
	"end-date"?: OrcidSummaryDate;
}

interface OrcidAffiliationGroupSummary {
	"employment-summary"?: OrcidAffiliationSummary;
	"education-summary"?: OrcidAffiliationSummary;
}

interface OrcidAffiliationGroup {
	summaries?: OrcidAffiliationGroupSummary[];
}

interface OrcidAffiliationsContainer {
	"affiliation-group"?: OrcidAffiliationGroup[];
	"employment-summary"?: OrcidAffiliationSummary[];
	"education-summary"?: OrcidAffiliationSummary[];
}

interface OrcidWorkTitle {
	title?: { value?: string };
}

interface OrcidWorkSummary {
	title?: OrcidWorkTitle;
}

interface OrcidWorkGroup {
	"work-summary"?: OrcidWorkSummary[];
}

interface OrcidWorksContainer {
	group?: OrcidWorkGroup[];
}

interface OrcidActivitiesSummary {
	employments?: OrcidAffiliationsContainer;
	educations?: OrcidAffiliationsContainer;
	works?: OrcidWorksContainer;
}

interface OrcidRecord {
	"orcid-identifier"?: { path?: string; uri?: string };
	person?: OrcidPerson;
	"activities-summary"?: OrcidActivitiesSummary;
}

function collectOrcidAffiliations(
	container: OrcidAffiliationsContainer | undefined,
	key: "employment-summary" | "education-summary",
): OrcidAffiliationSummary[] {
	const summaries: OrcidAffiliationSummary[] = [];
	if (!container) return summaries;

	const direct = container[key];
	if (direct?.length) summaries.push(...direct);

	const groups = container["affiliation-group"];
	if (groups?.length) {
		for (const group of groups) {
			const groupSummaries = group.summaries || [];
			for (const summary of groupSummaries) {
				const entry = summary[key];
				if (entry) summaries.push(entry);
			}
		}
	}
	return summaries;
}

/** `start - end`, `start - Present`, `Until end`, or `null` when the affiliation has neither date. */
function orcidDateRange(summary: OrcidAffiliationSummary): string | null {
	const from = summary["start-date"];
	const to = summary["end-date"];
	const start = partialIsoDate(from?.year?.value, from?.month?.value, from?.day?.value);
	const end = partialIsoDate(to?.year?.value, to?.month?.value, to?.day?.value);
	if (start) return `${start} - ${end || "Present"}`;
	return end ? `Until ${end}` : null;
}

function formatOrcidAffiliation(summary: OrcidAffiliationSummary): string | null {
	const organization = summary.organization?.name?.trim();
	const role = summary["role-title"]?.trim();
	const department = summary["department-name"]?.trim();
	const label = organization || role || department;
	if (!label) return null;

	const address = summary.organization?.address;
	const location = [address?.city, address?.region, address?.country].filter(Boolean).join(", ");
	const dates = orcidDateRange(summary);

	const details: string[] = [];
	if (organization && role) details.push(role);
	if (!organization && role && department) details.push(department);
	if (organization && department) details.push(`Dept: ${department}`);
	if (location) details.push(`Location: ${location}`);
	if (dates) details.push(`Dates: ${dates}`);

	if (details.length === 0) return label;
	return `${label} (${details.join("; ")})`;
}

/** The credit name, else the given and family names, else whichever of them is set. */
function orcidPersonName(name: OrcidName | undefined): string | null {
	const credit = name?.["credit-name"]?.value?.trim();
	const given = name?.["given-names"]?.value?.trim();
	const family = name?.["family-name"]?.value?.trim();
	return credit || (given && family ? `${given} ${family}` : given || family || null);
}

/** The distinct work titles in record order, at most `MAX_ORCID_WORKS` of them. */
function orcidWorkTitles(groups: OrcidWorkGroup[]): string[] {
	const titles = new Set<string>();
	for (const group of groups) {
		for (const summary of group["work-summary"] || []) {
			const title = summary.title?.title?.value?.trim();
			if (title) titles.add(title);
			if (titles.size >= MAX_ORCID_WORKS) return Array.from(titles);
		}
	}
	return Array.from(titles);
}

/** A `### heading` list of the affiliations, or nothing when there are none. */
function renderOrcidAffiliations(heading: string, summaries: OrcidAffiliationSummary[]): string {
	if (summaries.length === 0) return "";
	let md = `### ${heading}\n\n`;
	for (const summary of summaries) {
		const line = formatOrcidAffiliation(summary);
		if (line) md += `- ${line}\n`;
	}
	return `${md}\n`;
}

export const orcidDeclaration: AcademicPaperDeclaration = {
	site: "orcid",
	method: "orcid-api",
	hosts: ["orcid.org", "www.orcid.org"],
	canonicalUrls: ["https://orcid.org/0000-0002-1825-0097"],
	match: parsed => {
		const m = parsed.pathname.match(/\/(\d{4}-\d{4}-\d{4}-\d{3}[\dXx])(?:\/|$)/);
		return m ? { id: m[1], parsedUrl: parsed } : null;
	},
	notes: ["Fetched via ORCID Public API"],
	fetch: async (match, ctx) => {
		const apiUrl = `https://pub.orcid.org/v3.0/${match.id}/record`;
		const result = await ctx.loadPage(apiUrl, {
			timeout: ctx.timeout,
			headers: { Accept: "application/json" },
			signal: ctx.signal,
		});

		if (!result.ok || !result.content) return null;

		const record = ctx.tryParseJson<OrcidRecord>(result.content);
		if (!record) return ctx.scraperDegrade("orcid", "unexpected response shape");

		const biography = record.person?.biography?.content?.trim();
		const activities = record["activities-summary"];
		const affiliations =
			renderOrcidAffiliations(
				"Employment",
				collectOrcidAffiliations(activities?.employments, "employment-summary"),
			) +
			renderOrcidAffiliations("Education", collectOrcidAffiliations(activities?.educations, "education-summary"));
		const works = orcidWorkTitles(activities?.works?.group || []);

		let md = `# ${orcidPersonName(record.person?.name) || "ORCID Profile"}\n\n`;
		md += `**ORCID:** ${match.id}\n`;
		md += `**ORCID Profile:** https://orcid.org/${match.id}\n\n`;
		md += `## Biography\n\n${biography ? `${biography}\n\n` : "No biography available.\n\n"}`;
		md += `## Affiliations\n\n${affiliations || "No affiliations available.\n\n"}`;
		md += "## Works\n\n";
		md += works.length > 0 ? works.map(title => `- ${title}\n`).join("") : "No works available.\n";
		return md;
	},
};

// 6. PubMed
const NCBI_HEADERS = {
	Accept: "application/json, text/plain;q=0.9, */*;q=0.8",
	"User-Agent": "CodingAgent/1.0 (web scraper)",
};

const NCBI_EUTILS = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils";

interface PubmedArticle {
	title?: string;
	authors?: Array<{ name: string }>;
	fulljournalname?: string;
	pubdate?: string;
	volume?: string;
	issue?: string;
	pages?: string;
	elocationid?: string;
	articleids?: Array<{ idtype: string; value: string }>;
}

interface PubmedSummaryResponse {
	result?: { [pmid: string]: PubmedArticle };
}

/** Loads an E-utilities URL, retrying once when the first attempt fails. */
async function loadNcbi(ctx: AcademicPaperContext, url: string, acceptJson: boolean): Promise<LoadPageResult> {
	const headers = { ...NCBI_HEADERS, Accept: acceptJson ? "application/json" : "text/plain, */*;q=0.8" };
	const response = await ctx.loadPage(url, { timeout: ctx.timeout, signal: ctx.signal, headers });
	if (response.ok) return response;
	return ctx.loadPage(url, { timeout: ctx.timeout, signal: ctx.signal, headers });
}

/** The last DOI and PMCID among the article ids, the DOI falling back to the electronic location id. */
function pubmedIdentifiers(article: PubmedArticle): { doi: string; pmcid: string } {
	let doi = "";
	let pmcid = "";
	for (const id of article.articleids ?? []) {
		if (id.idtype === "doi") doi = id.value;
		if (id.idtype === "pmc") pmcid = id.value;
	}
	return { doi: doi || article.elocationid || "", pmcid };
}

function renderPubmedFields(pmid: string, article: PubmedArticle): string {
	const journal = article.fulljournalname;
	const citation = [
		article.volume && `Vol ${article.volume}`,
		article.issue && `Issue ${article.issue}`,
		article.pages && `pp ${article.pages}`,
	]
		.filter(Boolean)
		.join(", ");
	const { doi, pmcid } = pubmedIdentifiers(article);
	return renderKeyValues([
		["Authors", article.authors?.map(author => author.name).join(", ")],
		["Journal", journal && article.pubdate ? `${journal} (${article.pubdate})` : journal],
		["Citation", citation],
		["PMID", pmid],
		["DOI", doi],
		["PMCID", pmcid],
	]);
}

/** A MeSH Terms section from the MEDLINE record, or nothing when it has no terms or does not load. */
async function pubmedMeshSection(pmid: string, ctx: AcademicPaperContext): Promise<string> {
	let result: LoadPageResult;
	try {
		result = await ctx.loadPage(`${NCBI_EUTILS}/efetch.fcgi?db=pubmed&id=${pmid}&rettype=medline&retmode=text`, {
			timeout: Math.min(ctx.timeout, 5),
			signal: ctx.signal,
			headers: { ...NCBI_HEADERS, Accept: "text/plain, */*;q=0.8" },
		});
	} catch {
		return "";
	}
	if (!result.ok) return "";
	const terms = result.content
		.split("\n")
		.filter(line => line.startsWith("MH  - "))
		.map(line => line.slice(6).trim());
	if (terms.length === 0) return "";
	ctx.notes.push("Fetched MeSH terms via NCBI E-utilities");
	return renderStringList("MeSH Terms", terms);
}

export const pubmedDeclaration: AcademicPaperDeclaration = {
	site: "pubmed",
	method: "pubmed",
	hosts: ["pubmed.ncbi.nlm.nih.gov", "ncbi.nlm.nih.gov"],
	canonicalUrls: ["https://pubmed.ncbi.nlm.nih.gov/31882512/"],
	match: parsed => {
		let pmid: string | null = null;
		if (parsed.hostname === "pubmed.ncbi.nlm.nih.gov") {
			const m = parsed.pathname.match(/\/(\d+)/);
			if (m) pmid = m[1];
		} else if (parsed.hostname === "ncbi.nlm.nih.gov" && parsed.pathname.startsWith("/pubmed")) {
			const m = parsed.pathname.match(/\/pubmed\/(\d+)/);
			if (m) pmid = m[1];
		}
		return pmid ? { id: pmid, pmid, parsedUrl: parsed } : null;
	},
	notes: ["Fetched via NCBI E-utilities"],
	fetch: async (match, ctx) => {
		const pmid = match.pmid || match.id;
		const summaryResult = await loadNcbi(ctx, `${NCBI_EUTILS}/esummary.fcgi?db=pubmed&id=${pmid}&retmode=json`, true);
		if (!summaryResult.ok) return ctx.scraperDegrade("pubmed", ctx.loadFailure(summaryResult));
		const summaryData = ctx.tryParseJson<PubmedSummaryResponse>(summaryResult.content);
		if (!summaryData) return ctx.scraperDegrade("pubmed", "unexpected response shape");
		const article = summaryData.result?.[pmid];
		if (!article) return null;

		const abstractResult = await loadNcbi(
			ctx,
			`${NCBI_EUTILS}/efetch.fcgi?db=pubmed&id=${pmid}&rettype=abstract&retmode=text`,
			false,
		);
		let abstractText = "";
		if (abstractResult.ok) {
			abstractText = abstractResult.content.trim();
			ctx.notes.push("Fetched abstract via NCBI E-utilities");
		}

		let md = `# ${article.title || "PubMed Article"}\n\n`;
		md += renderPubmedFields(pmid, article);
		md += `\n---\n\n## Abstract\n\n${abstractText || "No abstract available."}\n`;
		md += await pubmedMeshSection(pmid, ctx);
		return md;
	},
};

// 7. IETF RFC
interface RfcMetadata {
	doc_id: string;
	title: string;
	authors?: Array<{ name: string; affiliation?: string }>;
	pub_status?: string;
	current_status?: string;
	stream?: string;
	area?: string;
	wg_acronym?: string;
	pub_date?: string;
	page_count?: number;
	abstract?: string;
	keywords?: string[];
	obsoletes?: string[];
	obsoleted_by?: string[];
	updates?: string[];
	updated_by?: string[];
	see_also?: string[];
	errata_url?: string;
}

/** The pattern that reads the RFC number from a path on each RFC host. */
const RFC_PATH_PATTERNS: Record<string, RegExp> = {
	"www.rfc-editor.org": /\/rfc\/rfc(\d+)(?:\.(?:html|txt|pdf))?$/i,
	"rfc-editor.org": /\/rfc\/rfc(\d+)(?:\.(?:html|txt|pdf))?$/i,
	"datatracker.ietf.org": /\/doc\/(?:html\/)?rfc(\d+)\/?$/i,
	"tools.ietf.org": /\/html\/rfc(\d+)$/i,
};

function renderRfcHeader(rfcNumber: string, metadata: RfcMetadata): string {
	let md = `# RFC ${rfcNumber}: ${metadata.title}\n\n`;
	md += renderKeyValues([
		[
			"Authors",
			metadata.authors
				?.map(author => (author.affiliation ? `${author.name} (${author.affiliation})` : author.name))
				.join(", "),
		],
		["Published", metadata.pub_date],
		["Status", metadata.current_status],
		["Stream", metadata.stream],
		["Area", metadata.area],
		["Working Group", metadata.wg_acronym],
		["Pages", metadata.page_count || null],
		["Obsoletes", metadata.obsoletes?.join(", ")],
		["Obsoleted by", metadata.obsoleted_by?.join(", ")],
		["Updates", metadata.updates?.join(", ")],
		["Updated by", metadata.updated_by?.join(", ")],
		["Keywords", metadata.keywords?.join(", ")],
		["Errata", metadata.errata_url],
	]);
	md += "\n";
	if (metadata.abstract) md += `## Abstract\n\n${metadata.abstract}\n\n`;
	return `${md}---\n\n`;
}

/**
 * The RFC text without its page breaks: each form feed line goes with the three
 * page-header lines after it, and `[Page N]` footers go. `buildResult` collapses the
 * blank runs this leaves.
 */
function cleanRfcText(text: string): string {
	const cleaned: string[] = [];
	let skip = 0;
	for (const line of text.split("\n")) {
		if (skip > 0) {
			skip--;
		} else if (line.includes("\f")) {
			skip = 3;
		} else if (!/^\s*\[Page \d+\]\s*$/.test(line)) {
			cleaned.push(line);
		}
	}
	return cleaned.join("\n");
}

export const rfcDeclaration: AcademicPaperDeclaration = {
	site: "rfc",
	method: "rfc",
	hosts: ["datatracker.ietf.org", "rfc-editor.org", "www.rfc-editor.org", "tools.ietf.org"],
	canonicalUrls: ["https://datatracker.ietf.org/doc/html/rfc9110", "https://www.rfc-editor.org/rfc/rfc9110.txt"],
	match: parsed => {
		const pattern = Object.hasOwn(RFC_PATH_PATTERNS, parsed.hostname) ? RFC_PATH_PATTERNS[parsed.hostname] : null;
		const rfcNumber = pattern?.exec(parsed.pathname)?.[1];
		return rfcNumber ? { id: rfcNumber, rfcNumber, parsedUrl: parsed } : null;
	},
	fetch: async (match, ctx) => {
		const rfcNumber = match.rfcNumber || match.id;
		const [metaResult, textResult] = await Promise.all([
			ctx.loadPage(`https://www.rfc-editor.org/rfc/rfc${rfcNumber}.json`, {
				timeout: Math.min(ctx.timeout, 10),
				signal: ctx.signal,
			}),
			ctx.loadPage(`https://www.rfc-editor.org/rfc/rfc${rfcNumber}.txt`, {
				timeout: ctx.timeout,
				signal: ctx.signal,
			}),
		]);
		if (!textResult.ok) return ctx.scraperDegrade("rfc", ctx.loadFailure(textResult));

		const metadata = metaResult.ok ? ctx.tryParseJson<RfcMetadata>(metaResult.content) : null;
		const header = metadata ? renderRfcHeader(rfcNumber, metadata) : `# RFC ${rfcNumber}\n\n`;
		const md = `${header}## Full Text\n\n\`\`\`\n${cleanRfcText(textResult.content)}\n\`\`\`\n`;
		return buildResult(md, {
			url: ctx.url,
			finalUrl: `https://www.rfc-editor.org/rfc/rfc${rfcNumber}`,
			method: "rfc",
			fetchedAt: ctx.fetchedAt,
			notes: [metadata ? "Metadata from RFC Editor JSON API" : "Metadata not available, showing plain text only"],
		});
	},
};

// 8. Semantic Scholar
interface SemanticScholarAuthor {
	name: string;
	authorId?: string;
}

interface SemanticScholarPaper {
	paperId: string;
	title: string;
	abstract?: string;
	authors?: SemanticScholarAuthor[];
	year?: number;
	citationCount?: number;
	referenceCount?: number;
	fieldsOfStudy?: string[];
	publicationTypes?: string[];
	journal?: { name: string; volume?: string; pages?: string };
	externalIds?: {
		DOI?: string;
		ArXiv?: string;
		PubMed?: string;
		MAG?: string;
		CorpusId?: string;
	};
	tldr?: { text: string };
	openAccessPdf?: { url: string };
}

const SEMANTIC_SCHOLAR_FIELDS = [
	"title",
	"abstract",
	"authors",
	"year",
	"citationCount",
	"referenceCount",
	"fieldsOfStudy",
	"publicationTypes",
	"journal",
	"externalIds",
	"tldr",
	"openAccessPdf",
].join(",");

/** `Year: … • Venue: … • Citations: … • References: …` over the figures the paper has. */
function semanticScholarFigures(paper: SemanticScholarPaper): string {
	return [
		paper.year ? `Year: ${paper.year}` : "",
		paper.journal?.name ? `Venue: ${paper.journal.name}` : "",
		paper.citationCount !== undefined ? `Citations: ${formatNumber(paper.citationCount)}` : "",
		paper.referenceCount !== undefined ? `References: ${formatNumber(paper.referenceCount)}` : "",
	]
		.filter(Boolean)
		.join(" • ");
}

/** The open-access PDF, arXiv, DOI and PubMed links the paper has, then its Semantic Scholar page. */
function semanticScholarLinks(paper: SemanticScholarPaper): string {
	const ids = paper.externalIds;
	return [
		paper.openAccessPdf?.url && markdownLink("PDF", paper.openAccessPdf.url),
		ids?.ArXiv && markdownLink("arXiv", `https://arxiv.org/abs/${ids.ArXiv}`),
		ids?.DOI && markdownLink("DOI", `https://doi.org/${ids.DOI}`),
		ids?.PubMed && markdownLink("PubMed", `https://pubmed.ncbi.nlm.nih.gov/${ids.PubMed}/`),
		markdownLink("Semantic Scholar", `https://www.semanticscholar.org/paper/${paper.paperId}`),
	]
		.filter(Boolean)
		.join(" • ");
}

export const semanticScholarDeclaration: AcademicPaperDeclaration = {
	site: "semantic-scholar",
	method: "semantic-scholar",
	hosts: ["semanticscholar.org", "www.semanticscholar.org", "api.semanticscholar.org"],
	canonicalUrls: ["https://www.semanticscholar.org/paper/204e3073870fae3d05bcbc2f6a8e263c9b72e776"],
	match: parsed => {
		const patterns = [
			/semanticscholar\.org\/paper\/[^/]+\/([a-f0-9]{40})/i,
			/semanticscholar\.org\/paper\/([a-f0-9]{40})/i,
			/api\.semanticscholar\.org\/.*\/paper\/([a-f0-9]{40})/i,
		];

		const target = `${parsed.hostname}${parsed.pathname}`;
		for (const pattern of patterns) {
			const match = target.match(pattern);
			if (match?.[1]) return { id: match[1], parsedUrl: parsed };
		}
		return null;
	},
	notes: ["Fetched via Semantic Scholar API"],
	fetch: async (match, ctx) => {
		const apiUrl = `https://api.semanticscholar.org/graph/v1/paper/${match.id}?fields=${SEMANTIC_SCHOLAR_FIELDS}`;
		const result = await ctx.loadPage(apiUrl, { timeout: ctx.timeout, signal: ctx.signal });
		if (!result.ok || !result.content) return ctx.scraperDegrade("semantic-scholar", ctx.loadFailure(result));
		const paper = ctx.tryParseJson<SemanticScholarPaper>(result.content);
		if (!paper) return ctx.scraperDegrade("semantic-scholar", "unexpected response shape");

		const blocks = [
			`# ${paper.title || "Untitled"}`,
			paper.authors?.length ? `**Authors:** ${paper.authors.map(author => author.name).join(", ")}` : "",
			semanticScholarFigures(paper),
			paper.fieldsOfStudy?.length ? `**Fields:** ${paper.fieldsOfStudy.join(", ")}` : "",
			paper.tldr?.text ? `## TL;DR\n\n${paper.tldr.text}` : "",
			paper.abstract ? `## Abstract\n\n${paper.abstract}` : "",
			`## Links\n\n${semanticScholarLinks(paper)}`,
		];
		return `${blocks.filter(Boolean).join("\n\n")}\n`;
	},
};

export const ACADEMIC_PAPER_DECLARATIONS = [
	arxivDeclaration,
	biorxivDeclaration,
	crossrefDeclaration,
	iacrDeclaration,
	orcidDeclaration,
	pubmedDeclaration,
	rfcDeclaration,
	semanticScholarDeclaration,
];
