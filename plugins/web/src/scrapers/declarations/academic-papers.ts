import { formatNumber } from "@veyyon/utils";
import { parseHTML } from "linkedom";
import { markdownLink } from "../../markdown-link";
import { type AcademicPaperDeclaration, appendConvertedPdfSection } from "../engine/academic-paper";
import { loadJson } from "../engine/declarative";
import { buildResult, htmlToBasicMarkdown, isScraperDegrade } from "../types";
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
		const serverName = server === "biorxiv" ? "bioRxiv" : "medRxiv";
		const apiUrl = `https://api.${server}.org/details/${server}/${match.id}/na/json`;
		const result = await ctx.loadPage(apiUrl, {
			headers: { Accept: "application/json" },
			signal: ctx.signal,
		});

		if (!result.ok) return ctx.scraperDegrade("biorxiv", ctx.loadFailure(result));

		const data = ctx.tryParseJson<BiorxivResponse>(result.content);
		if (!data) return ctx.scraperDegrade("biorxiv", "unexpected response shape");

		if (!data.collection || data.collection.length === 0) return null;

		const paper = data.collection[data.collection.length - 1];
		if (!paper) return null;

		const paperDoi = paper.biorxiv_doi || paper.medrxiv_doi || match.id;

		let md = `# ${paper.title || "Untitled Preprint"}\n\n`;

		if (paper.authors) {
			md += `**Authors:** ${paper.authors}\n`;
		}
		if (paper.author_corresponding) {
			let correspondingLine = `**Corresponding Author:** ${paper.author_corresponding}`;
			if (paper.author_corresponding_institution) {
				correspondingLine += ` (${paper.author_corresponding_institution})`;
			}
			md += `${correspondingLine}\n`;
		}
		if (paper.date) {
			md += `**Posted:** ${paper.date}\n`;
		}
		if (paper.category) {
			md += `**Category:** ${paper.category}\n`;
		}
		if (paper.version) {
			md += `**Version:** ${paper.version}\n`;
		}
		if (paper.license) {
			md += `**License:** ${paper.license}\n`;
		}
		md += `**DOI:** ${markdownLink(paperDoi, `https://doi.org/${paperDoi}`)}\n`;
		md += `**Server:** ${serverName}\n`;

		if (paper.published) {
			md += `\n> **Published in journal:** ${markdownLink(paper.published, `https://doi.org/${paper.published}`)}\n`;
		}

		md += `\n---\n\n## Abstract\n\n${paper.abstract || "No abstract available."}\n`;

		md += `\n---\n\n## Links\n\n`;
		md += `- ${markdownLink(`View on ${serverName}`, `https://www.${server}.org/content/${paperDoi}`)}\n`;
		md += `- ${markdownLink("PDF", `https://www.${server}.org/content/${paperDoi}.full.pdf`)}\n`;
		if (paper.jatsxml) {
			md += `- ${markdownLink("JATS XML", paper.jatsxml)}\n`;
		}

		return md;
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
		if (!data) return ctx.scraperDegrade("crossref", "unexpected response shape");
		const message = data.message;
		if (!message) return null;

		const title = message.title?.[0]?.trim() || "CrossRef Record";
		const authors = formatCrossrefAuthors(message.author);
		const journal = message["container-title"]?.[0] || message["short-container-title"]?.[0];
		const publisher = message.publisher;
		const published =
			formatCrossrefDate(message.published) ||
			formatCrossrefDate(message["published-print"]) ||
			formatCrossrefDate(message["published-online"]) ||
			formatCrossrefDate(message.issued) ||
			formatCrossrefDate(message.created);
		const doiValue = message.DOI || match.id;
		let abstract: string | null = null;
		if (message.abstract) {
			const normalized = message.abstract.replace(/<\/?jats:p[^>]*>/g, m => (m.startsWith("</") ? "</p>" : "<p>"));
			const markdown = await htmlToBasicMarkdown(normalized);
			abstract = markdown.trim().length > 0 ? markdown : null;
		}
		const type = message.type?.replace(/-/g, " ");

		let md = `# ${title}\n\n`;
		if (authors) md += `**Authors:** ${authors}\n`;
		if (journal) md += `**Journal:** ${journal}\n`;
		if (publisher) md += `**Publisher:** ${publisher}\n`;
		if (published) md += `**Published:** ${published}\n`;
		md += `**DOI:** ${doiValue}\n`;
		if (type) md += `**Type:** ${type}\n`;
		md += "\n---\n\n";
		md += "## Abstract\n\n";
		md += abstract || "No abstract available.";
		md += "\n";

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

function formatOrcidAffiliation(summary: OrcidAffiliationSummary): string | null {
	const organization = summary.organization?.name?.trim();
	const role = summary["role-title"]?.trim();
	const department = summary["department-name"]?.trim();

	const address = summary.organization?.address;
	const locationParts = [address?.city, address?.region, address?.country].filter(Boolean) as string[];
	const location = locationParts.length > 0 ? locationParts.join(", ") : null;

	const start = partialIsoDate(
		summary["start-date"]?.year?.value,
		summary["start-date"]?.month?.value,
		summary["start-date"]?.day?.value,
	);
	const end = partialIsoDate(
		summary["end-date"]?.year?.value,
		summary["end-date"]?.month?.value,
		summary["end-date"]?.day?.value,
	);
	let dates: string | null = null;
	if (start && end) {
		dates = `${start} - ${end}`;
	} else if (start) {
		dates = `${start} - Present`;
	} else if (end) {
		dates = `Until ${end}`;
	}

	const label = organization || role || department;
	if (!label) return null;

	const details: string[] = [];
	if (organization && role) details.push(role);
	if (!organization && role && department) details.push(department);
	if (organization && department) details.push(`Dept: ${department}`);
	if (location) details.push(`Location: ${location}`);
	if (dates) details.push(`Dates: ${dates}`);

	if (details.length === 0) return label;
	return `${label} (${details.join("; ")})`;
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

		const nameObj = record.person?.name;
		const credit = nameObj?.["credit-name"]?.value?.trim();
		const given = nameObj?.["given-names"]?.value?.trim();
		const family = nameObj?.["family-name"]?.value?.trim();
		const personName = credit || (given && family ? `${given} ${family}` : given || family || null);

		const biography = record.person?.biography?.content?.trim();

		const activities = record["activities-summary"];
		const employments = collectOrcidAffiliations(activities?.employments, "employment-summary");
		const educations = collectOrcidAffiliations(activities?.educations, "education-summary");

		const works: string[] = [];
		const seenWorks = new Set<string>();
		const groups = activities?.works?.group || [];
		for (const group of groups) {
			const summaries = group["work-summary"] || [];
			for (const summary of summaries) {
				const title = summary.title?.title?.value?.trim();
				if (!title || seenWorks.has(title)) continue;
				seenWorks.add(title);
				works.push(title);
				if (works.length >= MAX_ORCID_WORKS) break;
			}
			if (works.length >= MAX_ORCID_WORKS) break;
		}

		let md = `# ${personName || "ORCID Profile"}\n\n`;
		md += `**ORCID:** ${match.id}\n`;
		md += `**ORCID Profile:** https://orcid.org/${match.id}\n\n`;

		md += "## Biography\n\n";
		md += biography ? `${biography}\n\n` : "No biography available.\n\n";

		md += "## Affiliations\n\n";
		let hasAffiliations = false;

		if (employments.length > 0) {
			hasAffiliations = true;
			md += "### Employment\n\n";
			for (const summary of employments) {
				const line = formatOrcidAffiliation(summary);
				if (line) md += `- ${line}\n`;
			}
			md += "\n";
		}

		if (educations.length > 0) {
			hasAffiliations = true;
			md += "### Education\n\n";
			for (const summary of educations) {
				const line = formatOrcidAffiliation(summary);
				if (line) md += `- ${line}\n`;
			}
			md += "\n";
		}

		if (!hasAffiliations) {
			md += "No affiliations available.\n\n";
		}

		md += "## Works\n\n";
		if (works.length > 0) {
			for (const title of works) {
				md += `- ${title}\n`;
			}
		} else {
			md += "No works available.\n";
		}

		return md;
	},
};

// 6. PubMed
const NCBI_HEADERS = {
	Accept: "application/json, text/plain;q=0.9, */*;q=0.8",
	"User-Agent": "CodingAgent/1.0 (web scraper)",
};

interface PubmedSummaryResponse {
	result?: {
		[pmid: string]: {
			title?: string;
			authors?: Array<{ name: string }>;
			fulljournalname?: string;
			pubdate?: string;
			volume?: string;
			issue?: string;
			pages?: string;
			elocationid?: string;
			articleids?: Array<{ idtype: string; value: string }>;
		};
	};
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

		const fetchWithRetry = async (requestUrl: string, acceptJson = true) => {
			const headers = {
				...NCBI_HEADERS,
				Accept: acceptJson ? "application/json" : "text/plain, */*;q=0.8",
			};
			let response = await ctx.loadPage(requestUrl, { timeout: ctx.timeout, signal: ctx.signal, headers });
			if (!response.ok) {
				response = await ctx.loadPage(requestUrl, { timeout: ctx.timeout, signal: ctx.signal, headers });
			}
			return response;
		};

		const summaryUrl = `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?db=pubmed&id=${pmid}&retmode=json`;
		const summaryResult = await fetchWithRetry(summaryUrl);

		if (!summaryResult.ok) {
			return ctx.scraperDegrade("pubmed", ctx.loadFailure(summaryResult));
		}

		const summaryData = ctx.tryParseJson<PubmedSummaryResponse>(summaryResult.content);
		if (!summaryData) {
			return ctx.scraperDegrade("pubmed", "unexpected response shape");
		}

		const article = summaryData.result?.[pmid];
		if (!article) {
			return null;
		}

		const abstractUrl = `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi?db=pubmed&id=${pmid}&rettype=abstract&retmode=text`;
		const abstractResult = await fetchWithRetry(abstractUrl, false);

		let abstractText = "";
		if (abstractResult.ok) {
			abstractText = abstractResult.content.trim();
			ctx.notes.push("Fetched abstract via NCBI E-utilities");
		}
		let doi = "";
		let pmcid = "";
		if (article.articleids) {
			for (const id of article.articleids) {
				if (id.idtype === "doi") doi = id.value;
				if (id.idtype === "pmc") pmcid = id.value;
			}
		}
		if (!doi && article.elocationid) {
			doi = article.elocationid;
		}

		let md = `# ${article.title || "PubMed Article"}\n\n`;

		if (article.authors && article.authors.length > 0) {
			const authorNames = article.authors.map(a => a.name).join(", ");
			md += `**Authors:** ${authorNames}\n`;
		}

		if (article.fulljournalname) {
			md += `**Journal:** ${article.fulljournalname}`;
			if (article.pubdate) md += ` (${article.pubdate})`;
			md += "\n";
		}

		const citation: string[] = [];
		if (article.volume) citation.push(`Vol ${article.volume}`);
		if (article.issue) citation.push(`Issue ${article.issue}`);
		if (article.pages) citation.push(`pp ${article.pages}`);
		if (citation.length > 0) {
			md += `**Citation:** ${citation.join(", ")}\n`;
		}

		md += `**PMID:** ${pmid}\n`;
		if (doi) md += `**DOI:** ${doi}\n`;
		if (pmcid) md += `**PMCID:** ${pmcid}\n`;

		md += "\n---\n\n";

		if (abstractText) {
			md += `## Abstract\n\n${abstractText}\n`;
		} else {
			md += `## Abstract\n\nNo abstract available.\n`;
		}

		try {
			const meshUrl = `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi?db=pubmed&id=${pmid}&rettype=medline&retmode=text`;
			const meshResult = await ctx.loadPage(meshUrl, {
				timeout: Math.min(ctx.timeout, 5),
				signal: ctx.signal,
				headers: { ...NCBI_HEADERS, Accept: "text/plain, */*;q=0.8" },
			});

			if (meshResult.ok) {
				const meshTerms: string[] = [];
				const lines = meshResult.content.split("\n");
				for (const line of lines) {
					if (line.startsWith("MH  - ")) {
						const term = line.slice(6).trim();
						meshTerms.push(term);
					}
				}

				if (meshTerms.length > 0) {
					md += `\n## MeSH Terms\n\n`;
					for (const term of meshTerms) {
						md += `- ${term}\n`;
					}
					ctx.notes.push("Fetched MeSH terms via NCBI E-utilities");
				}
			}
		} catch {
			// MeSH terms are optional
		}

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

export const rfcDeclaration: AcademicPaperDeclaration = {
	site: "rfc",
	method: "rfc",
	hosts: ["datatracker.ietf.org", "rfc-editor.org", "www.rfc-editor.org", "tools.ietf.org"],
	canonicalUrls: ["https://datatracker.ietf.org/doc/html/rfc9110", "https://www.rfc-editor.org/rfc/rfc9110.txt"],
	match: parsed => {
		let rfcNumber: string | null = null;
		if (parsed.hostname === "www.rfc-editor.org" || parsed.hostname === "rfc-editor.org") {
			const match = parsed.pathname.match(/\/rfc\/rfc(\d+)(?:\.(?:html|txt|pdf))?$/i);
			if (match) rfcNumber = match[1];
		} else if (parsed.hostname === "datatracker.ietf.org") {
			const match = parsed.pathname.match(/\/doc\/(?:html\/)?rfc(\d+)\/?$/i);
			if (match) rfcNumber = match[1];
		} else if (parsed.hostname === "tools.ietf.org") {
			const match = parsed.pathname.match(/\/html\/rfc(\d+)$/i);
			if (match) rfcNumber = match[1];
		}
		return rfcNumber ? { id: rfcNumber, rfcNumber, parsedUrl: parsed } : null;
	},
	fetch: async (match, ctx) => {
		const rfcNumber = match.rfcNumber || match.id;
		const notes: string[] = [];

		const metadataUrl = `https://www.rfc-editor.org/rfc/rfc${rfcNumber}.json`;
		const textUrl = `https://www.rfc-editor.org/rfc/rfc${rfcNumber}.txt`;

		const [metaResult, textResult] = await Promise.all([
			ctx.loadPage(metadataUrl, { timeout: Math.min(ctx.timeout, 10), signal: ctx.signal }),
			ctx.loadPage(textUrl, { timeout: ctx.timeout, signal: ctx.signal }),
		]);

		if (!textResult.ok) return ctx.scraperDegrade("rfc", ctx.loadFailure(textResult));

		let metadata: RfcMetadata | null = null;
		if (metaResult.ok) {
			metadata = ctx.tryParseJson<RfcMetadata>(metaResult.content);
			if (metadata) notes.push("Metadata from RFC Editor JSON API");
		}

		let md = "";

		if (metadata) {
			md += `# RFC ${rfcNumber}: ${metadata.title}\n\n`;

			if (metadata.authors?.length) {
				const authorList = metadata.authors
					.map(a => (a.affiliation ? `${a.name} (${a.affiliation})` : a.name))
					.join(", ");
				md += `**Authors:** ${authorList}\n`;
			}

			if (metadata.pub_date) md += `**Published:** ${metadata.pub_date}\n`;
			if (metadata.current_status) md += `**Status:** ${metadata.current_status}\n`;
			if (metadata.stream) md += `**Stream:** ${metadata.stream}\n`;
			if (metadata.area) md += `**Area:** ${metadata.area}\n`;
			if (metadata.wg_acronym) md += `**Working Group:** ${metadata.wg_acronym}\n`;
			if (metadata.page_count) md += `**Pages:** ${metadata.page_count}\n`;

			if (metadata.obsoletes?.length) {
				md += `**Obsoletes:** ${metadata.obsoletes.join(", ")}\n`;
			}
			if (metadata.obsoleted_by?.length) {
				md += `**Obsoleted by:** ${metadata.obsoleted_by.join(", ")}\n`;
			}
			if (metadata.updates?.length) {
				md += `**Updates:** ${metadata.updates.join(", ")}\n`;
			}
			if (metadata.updated_by?.length) {
				md += `**Updated by:** ${metadata.updated_by.join(", ")}\n`;
			}

			if (metadata.keywords?.length) {
				md += `**Keywords:** ${metadata.keywords.join(", ")}\n`;
			}

			if (metadata.errata_url) {
				md += `**Errata:** ${metadata.errata_url}\n`;
			}

			md += "\n";

			if (metadata.abstract) {
				md += `## Abstract\n\n${metadata.abstract}\n\n`;
			}

			md += "---\n\n";
		} else {
			md += `# RFC ${rfcNumber}\n\n`;
			notes.push("Metadata not available, showing plain text only");
		}

		const lines = textResult.content.split("\n");
		const cleaned: string[] = [];
		let skipNext = 0;
		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];
			if (skipNext > 0) {
				skipNext--;
				continue;
			}
			if (line.includes("\f")) {
				skipNext = 3;
				continue;
			}
			if (/^\s*\[Page \d+\]\s*$/.test(line)) {
				continue;
			}
			cleaned.push(line);
		}
		const cleanedText = cleaned.join("\n").replace(/\n{4,}/g, "\n\n\n");

		md += "## Full Text\n\n";
		md += "```\n";
		md += cleanedText;
		md += "\n```\n";

		return buildResult(md, {
			url: ctx.url,
			finalUrl: `https://www.rfc-editor.org/rfc/rfc${rfcNumber}`,
			method: "rfc",
			fetchedAt: ctx.fetchedAt,
			notes: notes.length ? notes : ["Fetched from RFC Editor"],
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
		const paperId = match.id;
		const fields = [
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

		const apiUrl = `https://api.semanticscholar.org/graph/v1/paper/${paperId}?fields=${fields}`;

		const result = await ctx.loadPage(apiUrl, { timeout: ctx.timeout, signal: ctx.signal });

		if (!result.ok || !result.content) {
			return ctx.scraperDegrade("semantic-scholar", ctx.loadFailure(result));
		}

		const paper = ctx.tryParseJson<SemanticScholarPaper>(result.content);
		if (!paper) {
			return ctx.scraperDegrade("semantic-scholar", "unexpected response shape");
		}

		const sections: string[] = [];

		sections.push(`# ${paper.title || "Untitled"}`);
		sections.push("");

		if (paper.authors && paper.authors.length > 0) {
			const authorList = paper.authors.map(a => a.name).join(", ");
			sections.push(`**Authors:** ${authorList}`);
			sections.push("");
		}

		const metadata: string[] = [];
		if (paper.year) metadata.push(`Year: ${paper.year}`);
		if (paper.journal?.name) metadata.push(`Venue: ${paper.journal.name}`);
		if (paper.citationCount !== undefined) {
			metadata.push(`Citations: ${formatNumber(paper.citationCount)}`);
		}
		if (paper.referenceCount !== undefined) {
			metadata.push(`References: ${formatNumber(paper.referenceCount)}`);
		}
		if (metadata.length > 0) {
			sections.push(metadata.join(" • "));
			sections.push("");
		}

		if (paper.fieldsOfStudy && paper.fieldsOfStudy.length > 0) {
			sections.push(`**Fields:** ${paper.fieldsOfStudy.join(", ")}`);
			sections.push("");
		}

		if (paper.tldr?.text) {
			sections.push("## TL;DR");
			sections.push("");
			sections.push(paper.tldr.text);
			sections.push("");
		}

		if (paper.abstract) {
			sections.push("## Abstract");
			sections.push("");
			sections.push(paper.abstract);
			sections.push("");
		}

		const links: string[] = [];
		if (paper.openAccessPdf?.url) {
			links.push(markdownLink("PDF", paper.openAccessPdf.url));
		}
		if (paper.externalIds?.ArXiv) {
			links.push(markdownLink("arXiv", `https://arxiv.org/abs/${paper.externalIds.ArXiv}`));
		}
		if (paper.externalIds?.DOI) {
			links.push(markdownLink("DOI", `https://doi.org/${paper.externalIds.DOI}`));
		}
		if (paper.externalIds?.PubMed) {
			links.push(markdownLink("PubMed", `https://pubmed.ncbi.nlm.nih.gov/${paper.externalIds.PubMed}/`));
		}
		links.push(markdownLink("Semantic Scholar", `https://www.semanticscholar.org/paper/${paper.paperId}`));

		if (links.length > 0) {
			sections.push("## Links");
			sections.push("");
			sections.push(links.join(" • "));
			sections.push("");
		}
		return sections.join("\n");
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
