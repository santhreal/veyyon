import {
	collapseWhitespace,
	errorMessage,
	formatNumber,
	isCancellation,
	logger,
	parseFrontmatter,
	trimTrailingSlashes,
} from "@veyyon/utils";
import { parseHTML } from "linkedom";
import { markdownLink } from "../../markdown-link";
import { loadJson } from "../engine/declarative";
import type { DocContext, DocDeclaration, DocMatch } from "../engine/documentation";
import { renderDescriptionSection, renderStringList } from "../engine/markdown-assembly";
import type { RenderResult, ScraperDegrade } from "../types";
import { buildResult, htmlToBasicMarkdown, isScraperDegrade } from "../types";
import { asRecord, renderMarkdownTable, trimmedString } from "../utils";

// --- MDN Helpers & Types ---
interface MDNSection {
	type: string;
	value: {
		id?: string;
		title?: string;
		content?: string;
		isH3?: boolean;
		code?: string;
		language?: string;
		items?: Array<{ term: string; description: string }>;
		rows?: string[][];
	};
}

interface MDNDoc {
	doc: {
		title: string;
		summary: string;
		mdn_url?: string;
		body: MDNSection[];
		browserCompat?: unknown;
	};
}

async function renderMDNProse(value: MDNSection["value"]): Promise<string[]> {
	if (!value.content) return [];
	const markdown = await htmlToBasicMarkdown(value.content);
	if (!value.title) return [markdown];
	return [`${value.isH3 ? "###" : "##"} ${value.title}\n\n${markdown}`];
}

function renderMDNCodeExample(value: MDNSection["value"]): string[] {
	const parts: string[] = [];
	if (value.title) parts.push(`### ${value.title}`);
	if (value.code) parts.push(`\`\`\`${value.language || ""}\n${value.code}\n\`\`\``);
	return parts;
}

async function renderMDNDefinitionList(items: MDNSection["value"]["items"]): Promise<string[]> {
	const parts: string[] = [];
	for (const item of items ?? []) {
		parts.push(`**${item.term}**`, await htmlToBasicMarkdown(item.description));
	}
	return parts;
}

/** One body section as Markdown blocks; empty for a section type the converter does not render. */
async function renderMDNSection({ type, value }: MDNSection): Promise<string[]> {
	switch (type) {
		case "prose":
			return renderMDNProse(value);
		case "browser_compatibility":
			return value.title ? [`## ${value.title}\n\n(See browser compatibility data at MDN)`] : [];
		case "specifications":
			return value.title ? [`## ${value.title}\n\n(See specifications at MDN)`] : [];
		case "code_example":
			return renderMDNCodeExample(value);
		case "definition_list":
			return renderMDNDefinitionList(value.items);
		case "table":
			return value.rows?.length ? buildMarkdownTableFromHtmlRows(value.rows) : [];
		default:
			return [];
	}
}

async function convertMDNBody(sections: MDNSection[]): Promise<string> {
	const parts: string[] = [];
	for (const section of sections) parts.push(...(await renderMDNSection(section)));
	return parts.join("\n\n");
}

export async function buildMarkdownTableFromHtmlRows(rows: string[][]): Promise<string[]> {
	const rendered = await Promise.all(rows.map(row => Promise.all(row.map(cell => htmlToBasicMarkdown(cell)))));
	const table = renderMarkdownTable(rendered);
	return table ? table.split("\n") : [];
}

// --- cheat.sh ---
export const cheatshDeclaration: DocDeclaration = {
	site: "cheatsh",
	method: "cheat.sh",
	hosts: ["cheat.sh", "cht.sh"],
	canonicalUrls: ["https://cheat.sh/tar", "https://cht.sh/python"],
	match: parsed => {
		const topic = parsed.pathname.slice(1);
		if (!topic || topic === "" || topic === "/") return null;
		return { id: topic, topic, parsedUrl: parsed };
	},
	notes: ["Fetched via cheat.sh"],
	fetch: async (match, ctx) => {
		const apiUrl = `https://cheat.sh/${encodeURIComponent(match.topic!)}?T`;
		const result = await ctx.loadPage(apiUrl, {
			timeout: ctx.timeout,
			signal: ctx.signal,
			headers: { Accept: "text/plain" },
		});
		if (!result.ok || !result.content.trim()) return null;

		const decodedTopic = decodeURIComponent(match.topic!);
		let md = `# cheat.sh/${decodedTopic}\n\n`;
		const content = result.content.trim();
		const lines = content.split("\n");
		const hasCodeIndicators = lines.some(
			line =>
				line.startsWith("$") ||
				line.startsWith("#") ||
				line.includes("()") ||
				line.includes("=>") ||
				/^\s*(if|for|while|def|func|fn|let|const|var)\b/.test(line),
		);

		if (hasCodeIndicators || decodedTopic.includes("/")) {
			const lang = decodedTopic.split("/")[0] || "bash";
			md += `\`\`\`${lang}\n${content}\n\`\`\`\n`;
		} else {
			md += `\`\`\`\n${content}\n\`\`\`\n`;
		}

		return md;
	},
};

// --- Choose a License ---
function formatLicenseLabel(val: string): string {
	const cleaned = collapseWhitespace(val.replace(/[-_]+/g, " "));
	return cleaned ? cleaned.charAt(0).toUpperCase() + cleaned.slice(1) : val;
}

function normalizeLicenseList(val: unknown): string[] {
	if (Array.isArray(val)) {
		return val
			.filter((x): x is string => typeof x === "string")
			.map(x => x.trim())
			.filter(x => x.length > 0);
	}
	if (typeof val === "string") {
		return val
			.split(",")
			.map(x => x.trim())
			.filter(x => x.length > 0);
	}
	return [];
}

function formatLicenseSection(secTitle: string, items: string[]): string {
	let s = `## ${secTitle}\n\n`;
	if (items.length === 0) return `${s}- None listed\n\n`;
	for (const item of items) s += `- ${formatLicenseLabel(item)}\n`;
	return `${s}\n`;
}

export const choosealicenseDeclaration: DocDeclaration = {
	site: "choosealicense",
	method: "choosealicense",
	hosts: ["choosealicense.com", "www.choosealicense.com"],
	canonicalUrls: ["https://choosealicense.com/licenses/mit/"],
	match: parsed => {
		const licMatch = parsed.pathname.match(/^\/licenses\/([^/]+)\/?$/i);
		const isApp = /^\/appendix\/?$/i.test(parsed.pathname);
		if (!licMatch && !isApp) return null;
		const slug = licMatch ? decodeURIComponent(licMatch[1]).toLowerCase() : "appendix";
		return { id: slug, topic: isApp ? "appendix" : "license", parsedUrl: parsed };
	},
	notes: ["Fetched via Choose a License"],
	fetch: async (match, ctx) => {
		const isApp = match.topic === "appendix";
		const rawUrl = isApp
			? "https://raw.githubusercontent.com/github/choosealicense.com/gh-pages/_pages/appendix.md"
			: `https://raw.githubusercontent.com/github/choosealicense.com/gh-pages/_licenses/${match.id}.txt`;

		const result = await ctx.loadPage(rawUrl, {
			timeout: ctx.timeout,
			headers: { Accept: "text/plain" },
			signal: ctx.signal,
		});
		if (!result.ok) return ctx.scraperDegrade("choosealicense", ctx.loadFailure(result));

		const { frontmatter, body } = parseFrontmatter(result.content, { source: rawUrl });
		const fm = asRecord(frontmatter) ?? {};
		const title = trimmedString(fm.title) ?? formatLicenseLabel(match.id);
		const spdxId = trimmedString(fm.spdxId) ?? "Unknown";
		const description = trimmedString(fm.description);

		let md = `# ${title}\n\n`;
		if (description) md += `${description}\n\n`;
		md += `**SPDX ID:** ${spdxId}\n`;
		md += `**Source:** https://choosealicense.com${isApp ? "/appendix" : `/licenses/${match.id}/`}\n\n`;

		md += formatLicenseSection("Permissions", normalizeLicenseList(fm.permissions));
		md += formatLicenseSection("Conditions", normalizeLicenseList(fm.conditions));
		md += formatLicenseSection("Limitations", normalizeLicenseList(fm.limitations));

		const licenseText = body.trim();
		if (licenseText.length > 0) {
			md += `---\n\n## License Text\n\n${licenseText}\n`;
		}

		return md;
	},
};

// --- MDN ---
export const mdnDeclaration: DocDeclaration = {
	site: "mdn",
	method: "mdn",
	hosts: ["developer.mozilla.org"],
	canonicalUrls: ["https://developer.mozilla.org/en-US/docs/Web/JavaScript"],
	match: parsed => {
		if (!parsed.pathname.includes("/docs/")) return null;
		return { id: parsed.pathname, parsedUrl: parsed };
	},
	notes: ["Fetched via MDN Content API"],
	fetch: async (_match, ctx) => {
		const jsonUrl = ctx.url.replace(/\/?$/, "/index.json");
		const result = await ctx.loadPage(jsonUrl, {
			timeout: ctx.timeout,
			signal: ctx.signal,
			headers: { Accept: "application/json" },
		});
		if (!result.ok) return ctx.scraperDegrade("mdn", ctx.loadFailure(result));
		const data = ctx.tryParseJson<MDNDoc>(result.content);
		if (!data?.doc?.title) return ctx.scraperDegrade("mdn", "unexpected response shape");

		const { doc } = data;
		const parts: string[] = [];
		parts.push(`# ${doc.title}`);

		if (doc.summary) {
			const summary = await htmlToBasicMarkdown(doc.summary);
			parts.push(summary);
		}

		if (doc.body && doc.body.length > 0) {
			const bodyMarkdown = await convertMDNBody(doc.body);
			parts.push(bodyMarkdown);
		}

		const rawContent = parts.join("\n\n");
		return buildResult(rawContent, {
			url: ctx.url,
			finalUrl: doc.mdn_url || result.finalUrl,
			method: "mdn",
			fetchedAt: ctx.fetchedAt,
			notes: ["Fetched via MDN Content API"],
		});
	},
};

// --- Open Library Helpers & Types ---
interface OpenLibraryAuthor {
	name?: string;
	url?: string;
}

interface OpenLibrarySubject {
	name: string;
	url?: string;
}

interface OpenLibraryPublisher {
	name: string;
}

interface OpenLibraryCover {
	small?: string;
	medium?: string;
	large?: string;
}

interface OpenLibraryWork {
	title: string;
	authors?: Array<{ author: { key: string } }>;
	description?: string | { value: string };
	subjects?: string[];
	subject_places?: string[];
	subject_times?: string[];
	covers?: number[];
	first_publish_date?: string;
}

interface OpenLibraryEdition {
	title: string;
	authors?: Array<{ key: string }>;
	publishers?: string[];
	publish_date?: string;
	number_of_pages?: number;
	isbn_10?: string[];
	isbn_13?: string[];
	covers?: number[];
	description?: string | { value: string };
	subjects?: string[];
	works?: Array<{ key: string }>;
}

interface OpenLibraryBooksApiResponse {
	[key: string]: {
		title: string;
		authors?: OpenLibraryAuthor[];
		publishers?: OpenLibraryPublisher[];
		publish_date?: string;
		number_of_pages?: number;
		subjects?: OpenLibrarySubject[];
		cover?: OpenLibraryCover;
		url?: string;
		identifiers?: {
			isbn_10?: string[];
			isbn_13?: string[];
			openlibrary?: string[];
		};
	};
}

function extractOpenLibraryDescription(desc: string | { value: string } | undefined): string | null {
	if (!desc) return null;
	if (typeof desc === "string") return desc;
	return desc.value || null;
}

async function fetchAuthorNames(authorKeys: string[], ctx: DocContext): Promise<string[]> {
	const names: string[] = [];
	const promises = authorKeys.slice(0, 5).map(async key => {
		const authorKey = key.startsWith("/authors/") ? key : `/authors/${key}`;
		const apiUrl = `https://openlibrary.org${authorKey}.json`;
		try {
			const result = await ctx.loadPage(apiUrl, { timeout: Math.min(ctx.timeout, 5), signal: ctx.signal });
			if (result.ok) {
				const author = ctx.tryParseJson<{ name?: string }>(result.content);
				return author?.name || null;
			}
			logger.warn("Open Library author lookup failed; the book renders without that author", {
				author: authorKey,
				reason: ctx.loadFailure(result),
			});
		} catch (error) {
			if (isCancellation(error)) throw error;
			logger.warn("Open Library author lookup failed; the book renders without that author", {
				author: authorKey,
				error: errorMessage(error),
			});
		}
		return null;
	});

	const results = await Promise.all(promises);
	for (const name of results) {
		if (name) names.push(name);
	}
	return names;
}

// --- Open Library ---
const OPEN_LIBRARY_SUBJECT_LIMIT = 20;

interface OpenLibrarySearchResponse {
	docs?: Array<{
		title?: string;
		author_name?: string[];
		first_publish_year?: number;
		key?: string;
	}>;
}

function openLibraryResult(md: string, ctx: DocContext): RenderResult {
	return buildResult(md, {
		url: ctx.url,
		method: "openlibrary",
		fetchedAt: ctx.fetchedAt,
		notes: ["Fetched via Open Library API"],
	});
}

function buildOpenLibraryUnavailableResult(isbn: string, sourceLabel: string, ctx: DocContext): RenderResult {
	return openLibraryResult(
		`# Open Library Book\n\n**ISBN:** ${isbn}\n\nBook details are currently unavailable ${sourceLabel}.\n`,
		ctx,
	);
}

/** A work or edition record; a failed request or a body that is not JSON degrades. */
async function loadOpenLibraryRecord<T>(apiUrl: string, ctx: DocContext): Promise<T | ScraperDegrade> {
	const result = await ctx.loadPage(apiUrl, { timeout: ctx.timeout, signal: ctx.signal });
	if (!result.ok) return ctx.scraperDegrade("openlibrary", ctx.loadFailure(result));
	return ctx.tryParseJson<T>(result.content) || ctx.scraperDegrade("openlibrary", "unexpected response shape");
}

async function renderOpenLibraryAuthors(authorKeys: string[], ctx: DocContext): Promise<string> {
	const authorNames = await fetchAuthorNames(authorKeys, ctx);
	return authorNames.length ? `**Authors:** ${authorNames.join(", ")}\n` : "";
}

function renderOpenLibraryCover(covers: number[] | undefined): string {
	return covers?.length ? `**Cover:** https://covers.openlibrary.org/b/id/${covers[0]}-L.jpg\n` : "";
}

/** The description and the first subjects of a work or an edition. */
function renderOpenLibraryAbout(description: OpenLibraryWork["description"], subjects: string[] | undefined): string {
	const text = extractOpenLibraryDescription(description);
	let md = text ? `## Description\n\n${text}\n\n` : "";
	if (subjects?.length) md += `## Subjects\n\n${subjects.slice(0, OPEN_LIBRARY_SUBJECT_LIMIT).join(", ")}\n`;
	return md;
}

async function renderOpenLibraryWork(id: string, ctx: DocContext): Promise<string | ScraperDegrade> {
	const work = await loadOpenLibraryRecord<OpenLibraryWork>(`https://openlibrary.org/works/${id}.json`, ctx);
	if (isScraperDegrade(work)) return work;
	let md = `# ${work.title}\n\n`;
	if (work.authors?.length)
		md += await renderOpenLibraryAuthors(
			work.authors.map(a => a.author.key),
			ctx,
		);
	if (work.first_publish_date) md += `**First Published:** ${work.first_publish_date}\n`;
	md += renderOpenLibraryCover(work.covers);
	md += `**Open Library:** https://openlibrary.org/works/${id}\n\n`;
	return md + renderOpenLibraryAbout(work.description, work.subjects);
}

/** The publishers, publication date, page count and first ISBN, ISBN-13 before ISBN-10. */
function renderOpenLibraryEditionFacts(edition: OpenLibraryEdition): string {
	let md = "";
	if (edition.publishers?.length) md += `**Publishers:** ${edition.publishers.join(", ")}\n`;
	if (edition.publish_date) md += `**Published:** ${edition.publish_date}\n`;
	if (edition.number_of_pages) md += `**Pages:** ${edition.number_of_pages}\n`;
	const isbns = [...(edition.isbn_13 || []), ...(edition.isbn_10 || [])];
	if (isbns.length) md += `**ISBN:** ${isbns[0]}\n`;
	return md;
}

async function renderOpenLibraryEdition(id: string, ctx: DocContext): Promise<string | ScraperDegrade> {
	const edition = await loadOpenLibraryRecord<OpenLibraryEdition>(`https://openlibrary.org/books/${id}.json`, ctx);
	if (isScraperDegrade(edition)) return edition;
	let md = `# ${edition.title}\n\n`;
	if (edition.authors?.length)
		md += await renderOpenLibraryAuthors(
			edition.authors.map(a => a.key),
			ctx,
		);
	md += renderOpenLibraryEditionFacts(edition);
	md += renderOpenLibraryCover(edition.covers);
	md += `**Open Library:** https://openlibrary.org/books/${id}\n`;
	if (edition.works?.length) {
		md += `**Work:** https://openlibrary.org/works/${edition.works[0].key.replace("/works/", "")}\n`;
	}
	return `${md}\n${renderOpenLibraryAbout(edition.description, edition.subjects)}`;
}

/** The string `name` of each entry, entries without one dropped. */
function openLibraryNames(entries: Array<{ name?: string }>): string {
	return entries
		.map(entry => entry.name)
		.filter((name): name is string => typeof name === "string")
		.join(", ");
}

function renderOpenLibraryBook(book: OpenLibraryBooksApiResponse[string], isbn: string): string {
	let md = `# ${book.title}\n\n`;
	if (book.authors?.length) md += `**Authors:** ${openLibraryNames(book.authors)}\n`;
	if (book.publishers?.length) md += `**Publishers:** ${openLibraryNames(book.publishers)}\n`;
	if (book.publish_date) md += `**Published:** ${book.publish_date}\n`;
	if (book.number_of_pages) md += `**Pages:** ${book.number_of_pages}\n`;
	md += `**ISBN:** ${isbn}\n`;
	const cover = book.cover?.large || book.cover?.medium;
	if (cover) md += `**Cover:** ${cover}\n`;
	if (book.url) md += `**Open Library:** ${book.url}\n`;
	md += "\n";
	if (book.subjects?.length) {
		md += `## Subjects\n\n${openLibraryNames(book.subjects.slice(0, OPEN_LIBRARY_SUBJECT_LIMIT))}\n`;
	}
	return md;
}

/** The first search hit for an ISBN the books API does not index. */
async function renderOpenLibrarySearchHit(isbn: string, ctx: DocContext): Promise<string | RenderResult> {
	const searchUrl = `https://openlibrary.org/search.json?isbn=${encodeURIComponent(isbn)}&limit=1`;
	const searchResult = await ctx.loadPage(searchUrl, { timeout: ctx.timeout, signal: ctx.signal });
	if (!searchResult.ok) return buildOpenLibraryUnavailableResult(isbn, "from the Open Library search API", ctx);
	const doc = ctx.tryParseJson<OpenLibrarySearchResponse>(searchResult.content)?.docs?.[0];
	if (!doc?.title) return buildOpenLibraryUnavailableResult(isbn, "from Open Library", ctx);
	let md = `# ${doc.title}\n\n`;
	if (doc.author_name?.length) md += `**Authors:** ${doc.author_name.join(", ")}\n`;
	if (doc.first_publish_year) md += `**First Published:** ${doc.first_publish_year}\n`;
	md += `**ISBN:** ${isbn}\n`;
	if (doc.key) md += `**Open Library:** https://openlibrary.org${doc.key}\n`;
	return md;
}

/** The books API record for an ISBN, retried once; the search API when the books API has no record. */
async function renderOpenLibraryIsbn(isbn: string, ctx: DocContext): Promise<string | RenderResult> {
	const apiUrl = `https://openlibrary.org/api/books?bibkeys=ISBN:${isbn}&format=json&jscmd=data`;
	let result = await ctx.loadPage(apiUrl, { timeout: ctx.timeout, signal: ctx.signal });
	if (!result.ok) result = await ctx.loadPage(apiUrl, { timeout: ctx.timeout, signal: ctx.signal });
	if (!result.ok) return buildOpenLibraryUnavailableResult(isbn, "from the Open Library books API", ctx);
	const book = ctx.tryParseJson<OpenLibraryBooksApiResponse>(result.content)?.[`ISBN:${isbn}`];
	return book ? renderOpenLibraryBook(book, isbn) : renderOpenLibrarySearchHit(isbn, ctx);
}

function renderOpenLibraryTopic(
	match: DocMatch,
	ctx: DocContext,
): Promise<string | RenderResult | ScraperDegrade> | null {
	switch (match.topic) {
		case "work":
			return renderOpenLibraryWork(match.id, ctx);
		case "book":
			return renderOpenLibraryEdition(match.id, ctx);
		case "isbn":
			return renderOpenLibraryIsbn(match.id, ctx);
		default:
			return null;
	}
}

export const openlibraryDeclaration: DocDeclaration = {
	site: "openlibrary",
	method: "openlibrary",
	hosts: ["openlibrary.org", "www.openlibrary.org"],
	canonicalUrls: ["https://openlibrary.org/works/OL45804W"],
	match: parsed => {
		const path = parsed.pathname;
		const workMatch = path.match(/^\/works\/(OL\d+W)/i);
		const editionMatch = path.match(/^\/books\/(OL\d+M)/i);
		const isbnMatch = path.match(/^\/isbn\/(\d{10}|\d{13})/i);
		if (workMatch) return { id: workMatch[1], topic: "work", parsedUrl: parsed };
		if (editionMatch) return { id: editionMatch[1], topic: "book", parsedUrl: parsed };
		if (isbnMatch) return { id: isbnMatch[1], topic: "isbn", parsedUrl: parsed };
		return null;
	},
	notes: ["Fetched via Open Library API"],
	fetch: async (match, ctx) => {
		const rendered = await renderOpenLibraryTopic(match, ctx);
		return typeof rendered === "string" ? openLibraryResult(rendered, ctx) : rendered;
	},
};

// --- Read the Docs ---
interface ReadTheDocsElement {
	readonly innerHTML: string;
	readonly textContent: string | null;
	getAttribute(name: string): string | null;
	remove(): void;
	querySelectorAll(selectors: string): Iterable<ReadTheDocsElement>;
}

interface ReadTheDocsDocument {
	querySelector(selectors: string): ReadTheDocsElement | null;
	querySelectorAll(selectors: string): Iterable<ReadTheDocsElement>;
}

const READ_THE_DOCS_MAIN_SELECTORS = [".document", '[role="main"]', "main", ".rst-content", ".body"];
const READ_THE_DOCS_CHROME =
	".headerlink, .viewcode-link, nav, .sidebar, footer, .related, .sphinxsidebar, .toctree-wrapper";
const MAX_RAW_SOURCE_LENGTH = 1_000_000;

/** The page's content element with the theme's navigation removed; the whole body when no content element matches. */
function readTheDocsMainContent(root: ReadTheDocsDocument, notes: string[]): ReadTheDocsElement | null {
	let main: ReadTheDocsElement | null = null;
	for (const selector of READ_THE_DOCS_MAIN_SELECTORS) {
		main = root.querySelector(selector);
		if (main) break;
	}
	if (!main) {
		main = root.querySelector("body");
		notes.push("Using full body content (no main content div found)");
	}
	if (main) for (const element of main.querySelectorAll(READ_THE_DOCS_CHROME)) element.remove();
	return main;
}

/** The raw URL behind the first GitHub or GitLab link whose text mentions editing or the source. */
function readTheDocsSourceUrl(root: ReadTheDocsDocument): string | null {
	for (const link of root.querySelectorAll('a[href*="github.com"], a[href*="gitlab.com"]')) {
		const href = link.getAttribute("href");
		const text = link.textContent?.toLowerCase() || "";
		if (href && (text.includes("edit") || text.includes("source"))) {
			return href.replace("/blob/", "/raw/").replace("/edit/", "/raw/");
		}
	}
	return null;
}

/** The raw source text; empty, with a note saying why, when it is unavailable, empty or too large. */
async function loadReadTheDocsSource(sourceUrl: string, ctx: DocContext, notes: string[]): Promise<string> {
	try {
		const sourceResult = await ctx.loadPage(sourceUrl, { timeout: Math.min(ctx.timeout, 10), signal: ctx.signal });
		const length = sourceResult.content.length;
		if (sourceResult.ok && length > 0 && length < MAX_RAW_SOURCE_LENGTH) {
			notes.push(`Fetched raw source from ${sourceUrl}`);
			return sourceResult.content;
		}
		notes.push(
			`Raw source at ${sourceUrl} was unusable (${ctx.loadFailure(sourceResult)}); converted the HTML instead`,
		);
	} catch (error) {
		if (isCancellation(error)) throw error;
		notes.push(
			`Raw source at ${sourceUrl} could not be fetched (${errorMessage(error)}); converted the HTML instead`,
		);
	}
	return "";
}

export const readthedocsDeclaration: DocDeclaration = {
	site: "readthedocs",
	method: "readthedocs",
	hosts: ["readthedocs.org", "www.readthedocs.org", "*.readthedocs.io"],
	canonicalUrls: ["https://requests.readthedocs.io/en/latest/"],
	match: parsed => ({ id: parsed.pathname, parsedUrl: parsed }),
	notes: ["Fetched via Read the Docs"],
	fetch: async (_match, ctx) => {
		const notes: string[] = [];
		const result = await ctx.loadPage(ctx.url, { timeout: ctx.timeout, signal: ctx.signal });
		if (!result.ok) return ctx.scraperDegrade("readthedocs", ctx.loadFailure(result));

		const root: ReadTheDocsDocument = parseHTML(result.content).document;
		const mainContent = readTheDocsMainContent(root, notes);
		const sourceUrl = readTheDocsSourceUrl(root);
		const source = sourceUrl ? await loadReadTheDocsSource(sourceUrl, ctx, notes) : "";
		let content = source || (mainContent ? await htmlToBasicMarkdown(mainContent.innerHTML) : "");
		if (!content) {
			content = "No content extracted from Read the Docs page";
			notes.push("Failed to extract content");
		}

		return buildResult(content, {
			url: ctx.url,
			finalUrl: result.finalUrl,
			method: "readthedocs",
			fetchedAt: ctx.fetchedAt,
			notes: notes.length ? notes : ["Fetched via Read the Docs"],
			contentType: source ? "text/plain" : "text/markdown",
		});
	},
};

// --- SPDX Helpers & Types ---
interface SpdxCrossRef {
	url?: string;
	isValid?: boolean;
	isLive?: boolean;
	match?: string;
	order?: number;
}

interface SpdxLicense {
	licenseId: string;
	name: string;
	isOsiApproved?: boolean;
	isFsfLibre?: boolean;
	licenseText?: string;
	licenseTextHtml?: string;
	seeAlso?: string[];
	crossRef?: SpdxCrossRef[];
	comment?: string;
	licenseComments?: string;
}

function formatYesNo(value?: boolean): string {
	if (value === true) return "Yes";
	if (value === false) return "No";
	return "Unknown";
}

function collectCrossReferences(license: SpdxLicense): string[] {
	const ordered = (license.crossRef ?? [])
		.filter(ref => ref.url)
		.sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
		.map(ref => ref.url as string);

	const seeAlso = (license.seeAlso ?? []).filter((url): url is string => Boolean(url));
	const combined = [...ordered, ...seeAlso];
	return combined.filter((url, index) => combined.indexOf(url) === index);
}

// --- SPDX ---
export const spdxDeclaration: DocDeclaration = {
	site: "spdx",
	method: "spdx-api",
	hosts: ["spdx.org", "www.spdx.org"],
	canonicalUrls: ["https://spdx.org/licenses/MIT.html"],
	match: parsed => {
		const match = parsed.pathname.match(/^\/licenses\/([^/]+?)(?:\.html)?\/?$/i);
		if (!match) return null;
		const licenseId = decodeURIComponent(match[1]);
		return licenseId ? { id: licenseId, parsedUrl: parsed } : null;
	},
	notes: ["Fetched via SPDX license API"],
	fetch: async (match, ctx) => {
		const apiUrl = `https://spdx.org/licenses/${encodeURIComponent(match.id)}.json`;
		const license = await loadJson<SpdxLicense>(ctx, apiUrl, "spdx");
		if (isScraperDegrade(license)) return license;
		if (!license) return ctx.scraperDegrade("spdx", "unexpected response shape");
		const title = license.name || license.licenseId || match.id;
		let md = `# ${title}\n\n`;

		md += `**License ID:** ${license.licenseId ? `\`${license.licenseId}\`` : `\`${match.id}\``}\n`;
		md += `**OSI Approved:** ${formatYesNo(license.isOsiApproved)}\n`;
		md += `**FSF Libre:** ${formatYesNo(license.isFsfLibre)}\n`;

		const description = license.licenseComments ?? license.comment;
		md += renderDescriptionSection(description);

		const crossReferences = collectCrossReferences(license);
		md += renderStringList("Cross References", crossReferences);

		const licenseText = license.licenseText
			? license.licenseText
			: license.licenseTextHtml
				? await htmlToBasicMarkdown(license.licenseTextHtml)
				: null;

		if (licenseText) {
			md += `\n## License Text\n\n\`\`\`\n${licenseText}\n\`\`\`\n`;
		}

		return md;
	},
};

// --- tldr-pages ---
export const tldrDeclaration: DocDeclaration = {
	site: "tldr",
	method: "tldr",
	hosts: ["tldr.sh", "tldr.ostera.io"],
	canonicalUrls: ["https://tldr.ostera.io/tar"],
	match: parsed => {
		const cmd = parsed.pathname.replace(/^\//, "").replace(/\.md$/, "");
		return cmd && !cmd.includes("/") ? { id: cmd, topic: cmd, parsedUrl: parsed } : null;
	},
	notes: ["Fetched from tldr-pages"],
	fetch: async (match, ctx) => {
		const platforms = ["common", "linux", "osx"] as const;
		for (const plat of platforms) {
			const rawUrl = `https://raw.githubusercontent.com/tldr-pages/tldr/main/pages/${plat}/${match.topic}.md`;
			const res = await ctx.loadPage(rawUrl, { timeout: ctx.timeout, signal: ctx.signal });
			if (res.ok && res.content.trim()) {
				return buildResult(res.content, {
					url: ctx.url,
					finalUrl: rawUrl,
					method: "tldr",
					fetchedAt: ctx.fetchedAt,
					notes: [`Fetched from tldr-pages (${plat})`],
				});
			}
		}
		return null;
	},
};

// --- W3C Helpers & Types ---
function getJsonString(record: Record<string, unknown> | null, key: string): string | undefined {
	return typeof record?.[key] === "string" ? (record[key] as string) : undefined;
}

function getJsonRecord(record: Record<string, unknown> | null, key: string): Record<string, unknown> | null {
	return asRecord(record?.[key]);
}

function getJsonArray(record: Record<string, unknown> | null, key: string): unknown[] | undefined {
	return Array.isArray(record?.[key]) ? (record[key] as unknown[]) : undefined;
}

function extractShortname(pathname: string): string | null {
	const trimmed = trimTrailingSlashes(pathname);
	const segments = trimmed.split("/").filter(Boolean);

	if (segments.length < 2 || segments[0] !== "TR") return null;

	if (segments.length === 2) {
		const shortname = segments[1];
		if (/^\d{4}$/.test(shortname)) return null;
		return decodeURIComponent(shortname);
	}

	if (segments.length >= 3 && /^\d{4}$/.test(segments[1])) {
		const version = segments[2];
		const match = version.match(/^[A-Za-z]+-(.+)-\d{8}$/);
		if (match?.[1]) return decodeURIComponent(match[1]);
	}

	return null;
}

/** Maturity codes keyed by the status phrase; the more specific phrases come first so "recommendation" matches last. */
const W3C_STATUS_CODES: ReadonlyArray<readonly [phrase: string, code: string]> = [
	["working draft", "WD"],
	["candidate recommendation", "CR"],
	["proposed recommendation", "PR"],
	["recommendation", "REC"],
];

/** The status line: the maturity code followed by the full status, or the status alone when no code applies. */
function w3cStatusLine(status: string | undefined): string {
	if (!status) return "";
	const lower = status.toLowerCase();
	const code = W3C_STATUS_CODES.find(([phrase]) => lower.includes(phrase))?.[1];
	return code ? `**Status:** ${code} (${status})\n` : `**Status:** ${status}\n`;
}

function extractEditors(editorsPayload: Record<string, unknown> | null): string[] {
	const links = getJsonRecord(editorsPayload, "_links");
	const editors = getJsonArray(links, "editors") ?? [];
	const names: string[] = [];

	for (const entry of editors) {
		const record = asRecord(entry);
		const title = getJsonString(record, "title");
		if (title) names.push(title);
	}

	return names;
}

/** The editors named at the latest version's editors link; empty when the link is absent or its list is unreadable. */
async function loadW3cEditors(latest: Record<string, unknown>, ctx: DocContext): Promise<string[]> {
	const editorsUrl = getJsonString(getJsonRecord(getJsonRecord(latest, "_links"), "editors"), "href");
	if (!editorsUrl) return [];
	const editorsResult = await ctx.loadPage(editorsUrl, { timeout: Math.min(ctx.timeout, 10), signal: ctx.signal });
	if (!editorsResult.ok) return [];
	try {
		const editorsPayload = asRecord(JSON.parse(editorsResult.content));
		return editorsPayload ? extractEditors(editorsPayload) : [];
	} catch (error) {
		logger.warn("W3C editors list was not valid JSON; the spec renders without editors", {
			url: editorsUrl,
			error: errorMessage(error),
		});
		return [];
	}
}

interface W3cSpecPage {
	spec: Record<string, unknown>;
	latest: Record<string, unknown>;
	shortname: string;
	abstract: string | undefined;
	editors: readonly string[];
	latestVersionUrl: string | undefined;
}

function renderW3cSpec(page: W3cSpecPage): string {
	const shortname = getJsonString(page.spec, "shortname") ?? page.shortname;
	const historyUrl = getJsonString(getJsonRecord(getJsonRecord(page.spec, "_links"), "version-history"), "href");
	let md = `# ${getJsonString(page.spec, "title") ?? shortname}\n\n`;
	if (page.abstract) md += `## Abstract\n\n${page.abstract}\n\n`;
	md += `## Metadata\n\n**Shortname:** ${shortname}\n`;
	md += w3cStatusLine(getJsonString(page.latest, "status"));
	if (page.editors.length) md += `**Editors:** ${page.editors.join(", ")}\n`;
	if (page.latestVersionUrl) md += `**Latest Version:** ${page.latestVersionUrl}\n`;
	if (historyUrl) md += `**History:** ${historyUrl}\n`;
	return md;
}

// --- W3C Specifications ---
export const w3cDeclaration: DocDeclaration = {
	site: "w3c",
	method: "w3c-api",
	hosts: ["w3.org", "www.w3.org"],
	canonicalUrls: ["https://www.w3.org/TR/css-color-4/"],
	match: parsed => {
		const shortname = extractShortname(parsed.pathname);
		return shortname ? { id: shortname, parsedUrl: parsed } : null;
	},
	notes: ["Fetched via W3C API"],
	fetch: async (match, ctx) => {
		const specUrl = `https://api.w3.org/specifications/${encodeURIComponent(match.id)}`;
		const loadSpecJson = (url: string) =>
			ctx.loadPage(url, { timeout: ctx.timeout, signal: ctx.signal, headers: { Accept: "application/json" } });
		const [specResult, latestResult] = await Promise.all([
			loadSpecJson(specUrl),
			loadSpecJson(`${specUrl}/versions/latest`),
		]);
		if (!specResult.ok || !latestResult.ok) return null;

		const spec = ctx.tryParseJson<Record<string, unknown>>(specResult.content);
		const latest = ctx.tryParseJson<Record<string, unknown>>(latestResult.content);
		if (!spec || !latest) return null;

		const description = getJsonString(spec, "description") ?? getJsonString(spec, "abstract");
		const abstract = description ? await htmlToBasicMarkdown(description) : undefined;
		const editors = await loadW3cEditors(latest, ctx);
		const latestVersionUrl =
			getJsonString(latest, "uri") ?? getJsonString(latest, "shortlink") ?? getJsonString(spec, "shortlink");

		return buildResult(renderW3cSpec({ spec, latest, shortname: match.id, abstract, editors, latestVersionUrl }), {
			url: ctx.url,
			finalUrl: latestVersionUrl ?? ctx.url,
			method: "w3c-api",
			fetchedAt: ctx.fetchedAt,
			notes: ["Fetched via W3C API"],
		});
	},
};

// --- Wikidata Helpers & Types ---
const PROPERTY_LABELS: Record<string, string> = {
	P31: "Instance of",
	P279: "Subclass of",
	P17: "Country",
	P131: "Located in",
	P625: "Coordinates",
	P18: "Image",
	P154: "Logo",
	P571: "Founded",
	P576: "Dissolved",
	P169: "CEO",
	P112: "Founded by",
	P159: "Headquarters",
	P452: "Industry",
	P1128: "Employees",
	P2139: "Revenue",
	P856: "Website",
	P21: "Sex/Gender",
	P27: "Citizenship",
	P569: "Born",
	P570: "Died",
	P19: "Birthplace",
	P20: "Death place",
	P106: "Occupation",
	P108: "Employer",
	P69: "Educated at",
	P22: "Father",
	P25: "Mother",
	P26: "Spouse",
	P40: "Child",
	P166: "Award",
	P136: "Genre",
	P495: "Country of origin",
	P577: "Publication date",
	P50: "Author",
	P123: "Publisher",
	P364: "Original language",
	P86: "Composer",
	P57: "Director",
	P161: "Cast member",
	P170: "Creator",
	P178: "Developer",
	P275: "License",
	P306: "Operating system",
	P277: "Programming language",
	P348: "Version",
	P1566: "GeoNames ID",
	P214: "VIAF ID",
	P227: "GND ID",
	P213: "ISNI",
	P496: "ORCID",
};

interface WikidataEntity {
	type: string;
	id: string;
	labels?: Record<string, { language: string; value: string }>;
	descriptions?: Record<string, { language: string; value: string }>;
	aliases?: Record<string, Array<{ language: string; value: string }>>;
	claims?: Record<string, WikidataClaim[]>;
	sitelinks?: Record<string, { site: string; title: string; url?: string }>;
}

interface WikidataClaim {
	mainsnak: {
		snaktype: string;
		property: string;
		datavalue?: {
			type: string;
			value: WikidataValue;
		};
	};
	rank: string;
}

type WikidataValue =
	| string
	| { "entity-type": string; id: string; "numeric-id": number }
	| { time: string; precision: number; calendarmodel: string }
	| { amount: string; unit: string }
	| { text: string; language: string }
	| { latitude: number; longitude: number; precision: number };

function getLocalizedValue(
	values: Record<string, { language: string; value: string }> | undefined,
	preferredLang: string,
): string | null {
	if (!values) return null;
	if (values[preferredLang]) return values[preferredLang].value;
	const first = Object.values(values)[0];
	return first?.value || null;
}

function getLocalizedAliases(
	aliases: Record<string, Array<{ language: string; value: string }>> | undefined,
	preferredLang: string,
): string[] {
	if (!aliases) return [];
	const langAliases = aliases[preferredLang];
	if (!langAliases) return [];
	return langAliases.map(a => a.value);
}

const WIKIDATA_LABEL_BATCH = 50;

/** English labels from one wbgetentities request; empty when the request or its JSON fails. */
async function loadWikidataLabelBatch(batch: string[], ctx: DocContext): Promise<Array<[string, string]>> {
	const ids = batch.join("|");
	const apiUrl = `https://www.wikidata.org/w/api.php?action=wbgetentities&ids=${ids}&props=labels&languages=en&format=json`;
	try {
		const result = await ctx.loadPage(apiUrl, { timeout: Math.min(ctx.timeout, 10), signal: ctx.signal });
		if (!result.ok) {
			logger.warn("Wikidata label lookup failed; those entities render as raw Q-ids", {
				ids,
				reason: ctx.loadFailure(result),
			});
			return [];
		}
		const data = JSON.parse(result.content) as {
			entities: Record<string, { labels?: Record<string, { value: string }> }>;
		};
		const labels: Array<[string, string]> = [];
		for (const [id, entity] of Object.entries(data.entities)) {
			const label = entity.labels?.en?.value;
			if (label) labels.push([id, label]);
		}
		return labels;
	} catch (error) {
		if (isCancellation(error)) throw error;
		logger.warn("Wikidata label lookup failed; those entities render as raw Q-ids", {
			ids,
			error: errorMessage(error),
		});
		return [];
	}
}

/** English labels for `entityIds`, requested in parallel batches; an id whose batch fails has no entry. */
async function resolveEntityLabels(entityIds: string[], ctx: DocContext): Promise<Map<string, string>> {
	const batches: string[][] = [];
	for (let i = 0; i < entityIds.length; i += WIKIDATA_LABEL_BATCH) {
		batches.push(entityIds.slice(i, i + WIKIDATA_LABEL_BATCH));
	}
	const results = await Promise.all(batches.map(batch => loadWikidataLabelBatch(batch, ctx)));
	return new Map(results.flat());
}

/** The Q-id a claim renders through a label: an entity value, or the unit of a quantity. */
function claimEntityId(claim: WikidataClaim): string | undefined {
	const datavalue = claim.mainsnak.datavalue;
	const value = datavalue?.value;
	if (typeof value !== "object" || value === null) return undefined;
	if (datavalue?.type === "wikibase-entityid" && "id" in value && typeof value.id === "string") return value.id;
	if (datavalue?.type === "quantity" && "unit" in value && typeof value.unit === "string") {
		return value.unit.match(/Q\d+$/)?.[0];
	}
	return undefined;
}

const WIKIPEDIA_ARTICLE_URL = /^https:\/\/[^/]+\.wikipedia\.org\//;

/** Sitelinks to a Wikipedia article; the rest point at Wikiquote, Wikisource, Commons and the other sister projects. */
function countWikipediaSitelinks(sitelinks: NonNullable<WikidataEntity["sitelinks"]>): number {
	let count = 0;
	for (const link of Object.values(sitelinks)) {
		if (link.url && WIKIPEDIA_ARTICLE_URL.test(link.url)) count++;
	}
	return count;
}

function formatWikidataTime(time: string, precision: number): string {
	const match = time.match(/^([+-]?\d+)-(\d{2})-(\d{2})/);
	if (!match) return time;

	const [, year, month, day] = match;
	const yearNum = Number.parseInt(year, 10);
	const absYear = Math.abs(yearNum);
	const era = yearNum < 0 ? " BCE" : "";

	if (precision >= 11) {
		return `${day}/${month}/${absYear}${era}`;
	}
	if (precision >= 10) {
		return `${month}/${absYear}${era}`;
	}
	return `${absYear}${era}`;
}

type ClaimFormatter = (value: Record<string, unknown>, entityLabels: ReadonlyMap<string, string>) => string | null;

/** Formatters for the object-valued datatypes, keyed by `datavalue.type`; each returns null for a malformed value. */
const CLAIM_FORMATTERS: Record<string, ClaimFormatter> = {
	"wikibase-entityid": (value, entityLabels) =>
		typeof value.id === "string" ? entityLabels.get(value.id) || value.id : null,
	time: value =>
		typeof value.time === "string" && typeof value.precision === "number"
			? formatWikidataTime(value.time, value.precision)
			: null,
	quantity: (value, entityLabels) => {
		if (typeof value.amount !== "string" || typeof value.unit !== "string") return null;
		const amount = value.amount.replace(/^\+/, "");
		const unitId = value.unit.match(/Q\d+$/)?.[0];
		const unit = unitId ? entityLabels.get(unitId) : undefined;
		return unit ? `${amount} ${unit}` : amount;
	},
	monolingualtext: value => (typeof value.text === "string" ? value.text : null),
	globecoordinate: value =>
		typeof value.latitude === "number" && typeof value.longitude === "number"
			? `${value.latitude.toFixed(4)}, ${value.longitude.toFixed(4)}`
			: null,
};

function formatClaimValue(claim: WikidataClaim, entityLabels: ReadonlyMap<string, string>): string | null {
	const snak = claim.mainsnak;
	if (snak.snaktype !== "value" || !snak.datavalue) return null;
	const { type, value } = snak.datavalue;
	if (type === "string") return typeof value === "string" ? value : null;
	const record = asRecord(value);
	if (!record || !Object.hasOwn(CLAIM_FORMATTERS, type)) return null;
	return CLAIM_FORMATTERS[type](record, entityLabels);
}

const MAX_WIKIDATA_PROPERTIES = 50;
const MAX_WIKIDATA_VALUES = 10;
const NO_LABELS: ReadonlyMap<string, string> = new Map();

/** A claim's value before labels are applied, with the Q-id it renders through; null for a value that renders empty. */
function claimKey(claim: WikidataClaim): string | null {
	const raw = formatClaimValue(claim, NO_LABELS);
	return raw ? `${raw}\u0000${claimEntityId(claim) ?? ""}` : null;
}

/** The claims that render a value, deprecated ones and repeats of an earlier value dropped. */
function distinctClaims(claims: WikidataClaim[]): WikidataClaim[] {
	const seen = new Set<string>();
	const distinct: WikidataClaim[] = [];
	for (const claim of claims) {
		if (claim.rank === "deprecated") continue;
		const key = claimKey(claim);
		if (key === null || seen.has(key)) continue;
		seen.add(key);
		distinct.push(claim);
	}
	return distinct;
}

interface WikidataPropertyRow {
	heading: string;
	known: boolean;
	claims: WikidataClaim[];
}

/** Properties with a value to render: those in {@link PROPERTY_LABELS} first, each group by its heading. */
function wikidataPropertyRows(claims: Record<string, WikidataClaim[]>): WikidataPropertyRow[] {
	const rows: WikidataPropertyRow[] = [];
	for (const [propId, propertyClaims] of Object.entries(claims)) {
		const distinct = distinctClaims(propertyClaims);
		if (distinct.length === 0) continue;
		const known = Object.hasOwn(PROPERTY_LABELS, propId);
		rows.push({ heading: `**${known ? PROPERTY_LABELS[propId] : propId}:**`, known, claims: distinct });
	}
	return rows.sort((a, b) => Number(b.known) - Number(a.known) || a.heading.localeCompare(b.heading));
}

/** The Q-ids of the values the shown rows render, so no label is requested for an elided value. */
function renderedEntityIds(rows: WikidataPropertyRow[]): string[] {
	const ids = new Set<string>();
	for (const row of rows) {
		for (const claim of row.claims.slice(0, MAX_WIKIDATA_VALUES)) {
			const id = claimEntityId(claim);
			if (id) ids.add(id);
		}
	}
	return Array.from(ids);
}

/**
 * The first {@link MAX_WIKIDATA_PROPERTIES} properties with their first {@link MAX_WIKIDATA_VALUES} values each, entity
 * values and units by their English labels.
 */
async function renderWikidataProperties(claims: Record<string, WikidataClaim[]>, ctx: DocContext): Promise<string> {
	const rows = wikidataPropertyRows(claims);
	const shown = rows.slice(0, MAX_WIKIDATA_PROPERTIES);
	const labels = await resolveEntityLabels(renderedEntityIds(shown), ctx);
	const lines = shown.map(row => {
		const values = row.claims.slice(0, MAX_WIKIDATA_VALUES).map(claim => formatClaimValue(claim, labels));
		const elided = row.claims.length - MAX_WIKIDATA_VALUES;
		const overflow = elided > 0 ? ` […${elided} values elided…]` : "";
		return `- ${row.heading} ${values.join(", ")}${overflow}`;
	});
	let md = `## Properties\n\n${lines.join("\n")}`;
	if (rows.length > MAX_WIKIDATA_PROPERTIES) {
		md += `\n\n[…${rows.length - MAX_WIKIDATA_PROPERTIES} properties elided…]`;
	}
	return `${md}\n`;
}

const NOTABLE_WIKIPEDIA_SITES = ["enwiki", "dewiki", "frwiki", "eswiki", "jawiki", "zhwiki"];

/** Links to the entity's article in each notable-language Wikipedia that has one; empty when none does. */
function renderWikipediaLinks(sitelinks: NonNullable<WikidataEntity["sitelinks"]>): string {
	const links: string[] = [];
	for (const site of NOTABLE_WIKIPEDIA_SITES) {
		const sitelink = sitelinks[site];
		if (!sitelink) continue;
		const lang = site.replace("wiki", "");
		const wikiUrl = `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(sitelink.title)}`;
		links.push(markdownLink(lang.toUpperCase(), wikiUrl));
	}
	return links.length > 0 ? `\n## Wikipedia Links\n\n${links.join(" · ")}\n` : "";
}

// --- Wikidata ---
export const wikidataDeclaration: DocDeclaration = {
	site: "wikidata",
	method: "wikidata",
	hosts: ["wikidata.org", "www.wikidata.org"],
	canonicalUrls: ["https://www.wikidata.org/wiki/Q42"],
	match: parsed => {
		const m = parsed.pathname.match(/\/(?:wiki|entity)\/(Q\d+)/i);
		return m ? { id: m[1].toUpperCase(), parsedUrl: parsed } : null;
	},
	notes: ["Fetched via Wikidata EntityData API"],
	fetch: async (match, ctx) => {
		const qid = match.id;
		const apiUrl = `https://www.wikidata.org/wiki/Special:EntityData/${qid}.json`;
		const data = await loadJson<{ entities: Record<string, WikidataEntity> }>(ctx, apiUrl, "wikidata");
		if (isScraperDegrade(data)) return data;
		if (!data) return ctx.scraperDegrade("wikidata", "unexpected response shape");

		const entity = data.entities[qid];
		if (!entity) return null;
		const label = getLocalizedValue(entity.labels, "en") || qid;
		const description = getLocalizedValue(entity.descriptions, "en");
		const aliases = getLocalizedAliases(entity.aliases, "en");

		let md = `# ${label} (${qid})\n\n`;
		if (description) md += `*${description}*\n\n`;
		if (aliases.length > 0) md += `**Also known as:** ${aliases.join(", ")}\n\n`;

		const wikipediaArticles = entity.sitelinks ? countWikipediaSitelinks(entity.sitelinks) : 0;
		if (wikipediaArticles > 0) {
			md += `**Wikipedia articles:** ${formatNumber(wikipediaArticles)} languages\n\n`;
		}

		if (entity.claims && Object.keys(entity.claims).length > 0) {
			md += await renderWikidataProperties(entity.claims, ctx);
		}

		if (entity.sitelinks) md += renderWikipediaLinks(entity.sitelinks);

		return md;
	},
};

// --- Wikipedia Helpers & Types ---
interface WikipediaElement {
	readonly tagName: string;
	readonly textContent: string | null;
	readonly parentElement: WikipediaElement | null;
	closest(selectors: string): WikipediaElement | null;
	querySelectorAll(selectors: string): Iterable<WikipediaElement>;
}

interface WikipediaDocument {
	querySelectorAll(selectors: string): Iterable<WikipediaElement>;
}

const WIKIPEDIA_SKIPPED_SECTIONS = new Set(["References", "External links", "See also", "Notes", "Further reading"]);

/** The first heading of `section` itself, not of a subsection nested in it. */
function ownHeading(section: WikipediaElement): WikipediaElement | undefined {
	for (const heading of section.querySelectorAll("h2, h3, h4")) {
		if (heading.closest("section") === section) return heading;
	}
	return undefined;
}

/** The section's own heading and its own paragraphs over 20 characters, excluding those of nested subsections. */
function renderWikipediaSection(
	section: WikipediaElement,
	heading: WikipediaElement | undefined,
	headingText: string | undefined,
): string {
	let md = heading && headingText ? `${heading.tagName === "H2" ? "##" : "###"} ${headingText}\n\n` : "";
	for (const paragraph of section.querySelectorAll("p")) {
		if (paragraph.closest("section") !== section) continue;
		const text = paragraph.textContent?.trim();
		if (text && text.length > 20) md += `${text}\n\n`;
	}
	return md;
}

/**
 * The mobile-html sections in document order, each with its own heading and paragraphs. Sections nest, so a
 * paragraph renders once, under the innermost section that holds it, and a subsection of a skipped section is skipped.
 */
function renderWikipediaSections(html: string): string {
	const doc: WikipediaDocument = parseHTML(html).document;
	const skipped = new Set<WikipediaElement>();
	let md = "";
	for (const section of doc.querySelectorAll("section")) {
		const heading = ownHeading(section);
		const headingText = heading?.textContent?.trim();
		const parent = section.parentElement?.closest("section");
		if ((parent && skipped.has(parent)) || (headingText && WIKIPEDIA_SKIPPED_SECTIONS.has(headingText))) {
			skipped.add(section);
			continue;
		}
		md += renderWikipediaSection(section, heading, headingText);
	}
	return md;
}

// --- Wikipedia ---
export const wikipediaDeclaration: DocDeclaration = {
	site: "wikipedia",
	method: "wikipedia",
	hosts: ["*.wikipedia.org"],
	canonicalUrls: ["https://en.wikipedia.org/wiki/Douglas_Adams"],
	match: parsed => {
		const wikiMatch = parsed.hostname.match(/^(\w+)\.wikipedia\.org$/);
		if (!wikiMatch) return null;
		const titleMatch = parsed.pathname.match(/\/wiki\/(.+)/);
		if (!titleMatch) return null;
		return { id: decodeURIComponent(titleMatch[1]), lang: wikiMatch[1], parsedUrl: parsed };
	},
	notes: ["Fetched via Wikipedia API"],
	fetch: async (match, ctx) => {
		const apiUrl = `https://${match.lang}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(match.id)}`;
		const contentUrl = `https://${match.lang}.wikipedia.org/api/rest_v1/page/mobile-html/${encodeURIComponent(match.id)}`;

		const [summaryRes, contentRes] = await Promise.all([
			ctx.loadPage(apiUrl, { timeout: ctx.timeout, signal: ctx.signal }),
			ctx.loadPage(contentUrl, { timeout: ctx.timeout, signal: ctx.signal }),
		]);

		let md = "";
		if (summaryRes.ok) {
			const summary = ctx.tryParseJson<{ title?: string; description?: string; extract?: string }>(
				summaryRes.content,
			);
			if (summary) {
				md = `# ${summary.title || match.id}\n\n`;
				if (summary.description) md += `*${summary.description}*\n\n`;
				if (summary.extract) md += `${summary.extract}\n\n---\n\n`;
			}
		}

		if (contentRes.ok) md += renderWikipediaSections(contentRes.content);

		return md || null;
	},
};

export const DOCUMENTATION_DECLARATIONS = [
	cheatshDeclaration,
	choosealicenseDeclaration,
	mdnDeclaration,
	openlibraryDeclaration,
	readthedocsDeclaration,
	spdxDeclaration,
	tldrDeclaration,
	w3cDeclaration,
	wikidataDeclaration,
	wikipediaDeclaration,
];
