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
import type { DocContext, DocDeclaration } from "../engine/documentation";
import { renderDescriptionSection, renderStringList } from "../engine/markdown-assembly";
import type { RenderResult } from "../types";
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

async function convertMDNBody(sections: MDNSection[]): Promise<string> {
	const parts: string[] = [];

	for (const section of sections) {
		const { type, value } = section;

		switch (type) {
			case "prose":
				if (value.content) {
					const markdown = await htmlToBasicMarkdown(value.content);
					if (value.title) {
						const level = value.isH3 ? "###" : "##";
						parts.push(`${level} ${value.title}\n\n${markdown}`);
					} else {
						parts.push(markdown);
					}
				}
				break;

			case "browser_compatibility":
				if (value.title) {
					parts.push(`## ${value.title}\n\n(See browser compatibility data at MDN)`);
				}
				break;

			case "specifications":
				if (value.title) {
					parts.push(`## ${value.title}\n\n(See specifications at MDN)`);
				}
				break;

			case "code_example":
				if (value.title) {
					parts.push(`### ${value.title}`);
				}
				if (value.code) {
					const lang = value.language || "";
					parts.push(`\`\`\`${lang}\n${value.code}\n\`\`\``);
				}
				break;

			case "definition_list":
				if (value.items) {
					for (const item of value.items) {
						parts.push(`**${item.term}**`);
						const desc = await htmlToBasicMarkdown(item.description);
						parts.push(desc);
					}
				}
				break;

			case "table":
				if (value.rows && value.rows.length > 0) {
					parts.push(...(await buildMarkdownTableFromHtmlRows(value.rows)));
				}
				break;
			default:
				break;
		}
	}

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
function buildOpenLibraryUnavailableResult(isbn: string, sourceLabel: string, ctx: DocContext): RenderResult {
	return buildResult(
		`# Open Library Book\n\n**ISBN:** ${isbn}\n\nBook details are currently unavailable ${sourceLabel}.\n`,
		{
			url: ctx.url,
			method: "openlibrary",
			fetchedAt: ctx.fetchedAt,
			notes: ["Fetched via Open Library API"],
		},
	);
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
		let md: string | null = null;
		if (match.topic === "work") {
			const apiUrl = `https://openlibrary.org/works/${match.id}.json`;
			const result = await ctx.loadPage(apiUrl, { timeout: ctx.timeout, signal: ctx.signal });
			if (!result.ok) return ctx.scraperDegrade("openlibrary", ctx.loadFailure(result));
			const work = ctx.tryParseJson<OpenLibraryWork>(result.content);
			if (!work) return ctx.scraperDegrade("openlibrary", "unexpected response shape");

			let out = `# ${work.title}\n\n`;
			if (work.authors?.length) {
				const authorNames = await fetchAuthorNames(
					work.authors.map(a => a.author.key),
					ctx,
				);
				if (authorNames.length) {
					out += `**Authors:** ${authorNames.join(", ")}\n`;
				}
			}
			if (work.first_publish_date) {
				out += `**First Published:** ${work.first_publish_date}\n`;
			}
			if (work.covers?.length) {
				const coverId = work.covers[0];
				out += `**Cover:** https://covers.openlibrary.org/b/id/${coverId}-L.jpg\n`;
			}
			out += `**Open Library:** https://openlibrary.org/works/${match.id}\n\n`;

			const description = extractOpenLibraryDescription(work.description);
			if (description) {
				out += `## Description\n\n${description}\n\n`;
			}
			if (work.subjects?.length) {
				out += `## Subjects\n\n${work.subjects.slice(0, 20).join(", ")}\n`;
			}
			md = out;
		} else if (match.topic === "book") {
			const apiUrl = `https://openlibrary.org/books/${match.id}.json`;
			const result = await ctx.loadPage(apiUrl, { timeout: ctx.timeout, signal: ctx.signal });
			if (!result.ok) return ctx.scraperDegrade("openlibrary", ctx.loadFailure(result));
			const edition = ctx.tryParseJson<OpenLibraryEdition>(result.content);
			if (!edition) return ctx.scraperDegrade("openlibrary", "unexpected response shape");

			let out = `# ${edition.title}\n\n`;
			if (edition.authors?.length) {
				const authorNames = await fetchAuthorNames(
					edition.authors.map(a => a.key),
					ctx,
				);
				if (authorNames.length) {
					out += `**Authors:** ${authorNames.join(", ")}\n`;
				}
			}
			if (edition.publishers?.length) {
				out += `**Publishers:** ${edition.publishers.join(", ")}\n`;
			}
			if (edition.publish_date) {
				out += `**Published:** ${edition.publish_date}\n`;
			}
			if (edition.number_of_pages) {
				out += `**Pages:** ${edition.number_of_pages}\n`;
			}
			const isbns = [...(edition.isbn_13 || []), ...(edition.isbn_10 || [])];
			if (isbns.length) {
				out += `**ISBN:** ${isbns[0]}\n`;
			}
			if (edition.covers?.length) {
				const coverId = edition.covers[0];
				out += `**Cover:** https://covers.openlibrary.org/b/id/${coverId}-L.jpg\n`;
			}
			out += `**Open Library:** https://openlibrary.org/books/${match.id}\n`;
			if (edition.works?.length) {
				const workKey = edition.works[0].key.replace("/works/", "");
				out += `**Work:** https://openlibrary.org/works/${workKey}\n`;
			}
			out += "\n";

			const description = extractOpenLibraryDescription(edition.description);
			if (description) {
				out += `## Description\n\n${description}\n\n`;
			}
			if (edition.subjects?.length) {
				out += `## Subjects\n\n${edition.subjects.slice(0, 20).join(", ")}\n`;
			}
			md = out;
		} else if (match.topic === "isbn") {
			const apiUrl = `https://openlibrary.org/api/books?bibkeys=ISBN:${match.id}&format=json&jscmd=data`;
			let result = await ctx.loadPage(apiUrl, { timeout: ctx.timeout, signal: ctx.signal });
			if (!result.ok) {
				result = await ctx.loadPage(apiUrl, { timeout: ctx.timeout, signal: ctx.signal });
			}
			if (!result.ok) {
				return buildOpenLibraryUnavailableResult(match.id, "from the Open Library books API", ctx);
			}

			const data = ctx.tryParseJson<OpenLibraryBooksApiResponse>(result.content);
			const key = `ISBN:${match.id}`;
			const book = data?.[key];
			if (!book) {
				const searchUrl = `https://openlibrary.org/search.json?isbn=${encodeURIComponent(match.id)}&limit=1`;
				const searchResult = await ctx.loadPage(searchUrl, { timeout: ctx.timeout, signal: ctx.signal });
				if (!searchResult.ok) {
					return buildOpenLibraryUnavailableResult(match.id, "from the Open Library search API", ctx);
				}
				const searchData = ctx.tryParseJson<{
					docs?: Array<{
						title?: string;
						author_name?: string[];
						first_publish_year?: number;
						key?: string;
					}>;
				}>(searchResult.content);
				const doc = searchData?.docs?.[0];
				if (!doc?.title) {
					return buildOpenLibraryUnavailableResult(match.id, "from Open Library", ctx);
				}

				let fallbackMd = `# ${doc.title}\n\n`;
				if (doc.author_name?.length) {
					fallbackMd += `**Authors:** ${doc.author_name.join(", ")}\n`;
				}
				if (doc.first_publish_year) {
					fallbackMd += `**First Published:** ${doc.first_publish_year}\n`;
				}
				fallbackMd += `**ISBN:** ${match.id}\n`;
				if (doc.key) {
					fallbackMd += `**Open Library:** https://openlibrary.org${doc.key}\n`;
				}
				md = fallbackMd;
			} else {
				let out = `# ${book.title}\n\n`;
				if (book.authors?.length) {
					out += `**Authors:** ${book.authors
						.map(a => a.name)
						.filter((n): n is string => typeof n === "string")
						.join(", ")}\n`;
				}
				if (book.publishers?.length) {
					out += `**Publishers:** ${book.publishers
						.map(p => p.name)
						.filter((p): p is string => typeof p === "string")
						.join(", ")}\n`;
				}
				if (book.publish_date) {
					out += `**Published:** ${book.publish_date}\n`;
				}
				if (book.number_of_pages) {
					out += `**Pages:** ${book.number_of_pages}\n`;
				}
				out += `**ISBN:** ${match.id}\n`;
				if (book.cover?.large || book.cover?.medium) {
					out += `**Cover:** ${book.cover.large || book.cover.medium}\n`;
				}
				if (book.url) {
					out += `**Open Library:** ${book.url}\n`;
				}
				out += "\n";
				if (book.subjects?.length) {
					out += `## Subjects\n\n${book.subjects
						.slice(0, 20)
						.map(s => s.name)
						.filter((s): s is string => typeof s === "string")
						.join(", ")}\n`;
				}
				md = out;
			}
		}

		if (!md) return null;
		return buildResult(md, {
			url: ctx.url,
			method: "openlibrary",
			fetchedAt: ctx.fetchedAt,
			notes: ["Fetched via Open Library API"],
		});
	},
};

// --- Read the Docs ---
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
		if (!result.ok) {
			return ctx.scraperDegrade("readthedocs", ctx.loadFailure(result));
		}

		const root = parseHTML(result.content).document;

		let mainContent =
			root.querySelector(".document") ||
			root.querySelector('[role="main"]') ||
			root.querySelector("main") ||
			root.querySelector(".rst-content") ||
			root.querySelector(".body");

		if (!mainContent) {
			mainContent = root.querySelector("body");
			notes.push("Using full body content (no main content div found)");
		}

		mainContent
			?.querySelectorAll(
				".headerlink, .viewcode-link, nav, .sidebar, footer, .related, .sphinxsidebar, .toctree-wrapper",
			)
			.forEach((el: { remove: () => void }) => {
				el.remove();
			});

		const editLinks = root.querySelectorAll('a[href*="github.com"], a[href*="gitlab.com"]');
		let sourceUrl: string | null = null;

		for (const link of editLinks) {
			const href = link.getAttribute("href");
			const text = link.textContent?.toLowerCase() || "";

			if (href && (text.includes("edit") || text.includes("source"))) {
				if (href.includes("github.com")) {
					sourceUrl = href.replace("/blob/", "/raw/").replace("/edit/", "/raw/");
				} else if (href.includes("gitlab.com")) {
					sourceUrl = href.replace("/blob/", "/raw/").replace("/edit/", "/raw/");
				}
				break;
			}
		}

		let content = "";

		if (sourceUrl) {
			try {
				const sourceResult = await ctx.loadPage(sourceUrl, {
					timeout: Math.min(ctx.timeout, 10),
					signal: ctx.signal,
				});
				if (sourceResult.ok && sourceResult.content.length > 0 && sourceResult.content.length < 1_000_000) {
					content = sourceResult.content;
					notes.push(`Fetched raw source from ${sourceUrl}`);
				} else {
					notes.push(
						`Raw source at ${sourceUrl} was unusable (${ctx.loadFailure(sourceResult)}); converted the HTML instead`,
					);
				}
			} catch (error) {
				if (isCancellation(error)) throw error;
				notes.push(
					`Raw source at ${sourceUrl} could not be fetched (${errorMessage(error)}); converted the HTML instead`,
				);
			}
		}

		if (!content && mainContent) {
			const html = mainContent.innerHTML;
			content = await htmlToBasicMarkdown(html);
		}

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
			contentType: sourceUrl && content ? "text/plain" : "text/html",
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

function normalizeStatus(status?: string): { code?: string; label?: string } {
	if (!status) return {};
	const lower = status.toLowerCase();

	if (lower.includes("working draft")) return { code: "WD", label: status };
	if (lower.includes("candidate recommendation")) return { code: "CR", label: status };
	if (lower.includes("proposed recommendation")) return { code: "PR", label: status };
	if (lower.includes("recommendation")) return { code: "REC", label: status };

	return { label: status };
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
		const shortname = match.id;
		const specUrl = `https://api.w3.org/specifications/${encodeURIComponent(shortname)}`;
		const latestUrl = `https://api.w3.org/specifications/${encodeURIComponent(shortname)}/versions/latest`;

		const [specResult, latestResult] = await Promise.all([
			ctx.loadPage(specUrl, {
				timeout: ctx.timeout,
				signal: ctx.signal,
				headers: { Accept: "application/json" },
			}),
			ctx.loadPage(latestUrl, {
				timeout: ctx.timeout,
				signal: ctx.signal,
				headers: { Accept: "application/json" },
			}),
		]);

		if (!specResult.ok || !latestResult.ok) return null;

		const specPayload = ctx.tryParseJson<Record<string, unknown>>(specResult.content);
		const latestPayload = ctx.tryParseJson<Record<string, unknown>>(latestResult.content);
		if (!specPayload || !latestPayload) return null;

		const title = getJsonString(specPayload, "title");
		const shortnameValue = getJsonString(specPayload, "shortname") ?? shortname;
		const description = getJsonString(specPayload, "description") ?? getJsonString(specPayload, "abstract");
		const abstract = description ? await htmlToBasicMarkdown(description) : undefined;

		const latestVersionUrl =
			getJsonString(latestPayload, "uri") ??
			getJsonString(latestPayload, "shortlink") ??
			getJsonString(specPayload, "shortlink");

		const latestStatus = getJsonString(latestPayload, "status");
		const normalizedStatus = normalizeStatus(latestStatus);

		const specLinks = getJsonRecord(specPayload, "_links");
		const historyUrl = getJsonString(getJsonRecord(specLinks, "version-history"), "href");

		const latestLinks = getJsonRecord(latestPayload, "_links");
		const editorsUrl = getJsonString(getJsonRecord(latestLinks, "editors"), "href");

		let editors: string[] = [];
		if (editorsUrl) {
			const editorsResult = await ctx.loadPage(editorsUrl, {
				timeout: Math.min(ctx.timeout, 10),
				signal: ctx.signal,
			});
			if (editorsResult.ok) {
				try {
					const editorsPayload = asRecord(JSON.parse(editorsResult.content));
					editors = editorsPayload ? extractEditors(editorsPayload) : [];
				} catch (error) {
					logger.warn("W3C editors list was not valid JSON; the spec renders without editors", {
						url: editorsUrl,
						error: errorMessage(error),
					});
				}
			}
		}

		let md = `# ${title ?? shortnameValue}\n\n`;
		if (abstract) md += `## Abstract\n\n${abstract}\n\n`;

		md += "## Metadata\n\n";
		md += `**Shortname:** ${shortnameValue}\n`;
		if (normalizedStatus.code) {
			md += `**Status:** ${normalizedStatus.code}`;
			if (normalizedStatus.label) md += ` (${normalizedStatus.label})`;
			md += "\n";
		} else if (normalizedStatus.label) {
			md += `**Status:** ${normalizedStatus.label}\n`;
		}
		if (editors.length) md += `**Editors:** ${editors.join(", ")}\n`;
		if (latestVersionUrl) md += `**Latest Version:** ${latestVersionUrl}\n`;
		if (historyUrl) md += `**History:** ${historyUrl}\n`;

		return buildResult(md, {
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
	sitelinks?: Record<string, { site: string; title: string }>;
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

async function resolveEntityLabels(entityIds: string[], ctx: DocContext): Promise<Record<string, string>> {
	if (entityIds.length === 0) return {};

	const labels: Record<string, string> = {};
	const batchSize = 50;
	for (let i = 0; i < entityIds.length; i += batchSize) {
		const batch = entityIds.slice(i, i + batchSize);
		const apiUrl = `https://www.wikidata.org/w/api.php?action=wbgetentities&ids=${batch.join("|")}&props=labels&languages=en&format=json`;

		try {
			const result = await ctx.loadPage(apiUrl, { timeout: Math.min(ctx.timeout, 10), signal: ctx.signal });
			if (result.ok) {
				const data = JSON.parse(result.content) as {
					entities: Record<string, { labels?: Record<string, { value: string }> }>;
				};
				for (const [id, entity] of Object.entries(data.entities)) {
					const label = entity.labels?.en?.value;
					if (label) labels[id] = label;
				}
			} else {
				logger.warn("Wikidata label lookup failed; those entities render as raw Q-ids", {
					ids: batch.join("|"),
					reason: ctx.loadFailure(result),
				});
			}
		} catch (error) {
			if (isCancellation(error)) throw error;
			logger.warn("Wikidata label lookup failed; those entities render as raw Q-ids", {
				ids: batch.join("|"),
				error: errorMessage(error),
			});
		}
	}

	return labels;
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

function formatClaimValue(claim: WikidataClaim, entityLabels: Record<string, string>): string | null {
	const snak = claim.mainsnak;
	if (snak.snaktype !== "value" || !snak.datavalue) return null;

	const { type, value } = snak.datavalue;

	switch (type) {
		case "wikibase-entityid": {
			if (typeof value === "object" && value !== null && "id" in value && typeof value.id === "string") {
				return entityLabels[value.id] || value.id;
			}
			return null;
		}
		case "string":
			return typeof value === "string" ? value : null;
		case "time": {
			if (
				typeof value === "object" &&
				value !== null &&
				"time" in value &&
				typeof value.time === "string" &&
				"precision" in value &&
				typeof value.precision === "number"
			) {
				return formatWikidataTime(value.time, value.precision);
			}
			return null;
		}
		case "quantity": {
			if (
				typeof value === "object" &&
				value !== null &&
				"amount" in value &&
				typeof value.amount === "string" &&
				"unit" in value &&
				typeof value.unit === "string"
			) {
				const amount = value.amount.replace(/^\+/, "");
				const unitMatch = value.unit.match(/Q\d+$/);
				const unit = unitMatch ? entityLabels[unitMatch[0]] || "" : "";
				return unit ? `${amount} ${unit}` : amount;
			}
			return null;
		}
		case "monolingualtext": {
			if (typeof value === "object" && value !== null && "text" in value && typeof value.text === "string") {
				return value.text;
			}
			return null;
		}
		case "globecoordinate": {
			if (
				typeof value === "object" &&
				value !== null &&
				"latitude" in value &&
				typeof value.latitude === "number" &&
				"longitude" in value &&
				typeof value.longitude === "number"
			) {
				return `${value.latitude.toFixed(4)}, ${value.longitude.toFixed(4)}`;
			}
			return null;
		}
		default:
			return null;
	}
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

		const sitelinkCount = entity.sitelinks ? Object.keys(entity.sitelinks).length : 0;
		if (sitelinkCount > 0) {
			md += `**Wikipedia articles:** ${formatNumber(sitelinkCount)} languages\n\n`;
		}

		if (entity.claims && Object.keys(entity.claims).length > 0) {
			md += "## Properties\n\n";

			const entityIdsToResolve = new Set<string>();
			for (const claims of Object.values(entity.claims)) {
				for (const claim of claims) {
					if (claim.mainsnak.datavalue?.type === "wikibase-entityid") {
						const val = claim.mainsnak.datavalue.value;
						if (typeof val === "object" && val !== null && "id" in val && typeof val.id === "string") {
							entityIdsToResolve.add(val.id);
						}
					}
				}
			}

			const entityLabels = await resolveEntityLabels(Array.from(entityIdsToResolve).slice(0, 50), ctx);

			const processedProperties: string[] = [];
			for (const [propId, claims] of Object.entries(entity.claims)) {
				const propLabel = PROPERTY_LABELS[propId] || propId;
				const values: string[] = [];

				for (const claim of claims) {
					if (claim.rank === "deprecated") continue;
					const value = formatClaimValue(claim, entityLabels);
					if (value && !values.includes(value)) {
						values.push(value);
					}
				}

				if (values.length > 0) {
					const displayValues = values.slice(0, 10);
					const overflow = values.length > 10 ? ` […${values.length - 10} values elided…]` : "";
					processedProperties.push(`- **${propLabel}:** ${displayValues.join(", ")}${overflow}`);
				}
			}

			processedProperties.sort((a, b) => {
				const aKnown = Object.values(PROPERTY_LABELS).some(l => a.includes(`**${l}:**`));
				const bKnown = Object.values(PROPERTY_LABELS).some(l => b.includes(`**${l}:**`));
				if (aKnown && !bKnown) return -1;
				if (!aKnown && bKnown) return 1;
				return a.localeCompare(b);
			});

			const maxProps = 50;
			md += processedProperties.slice(0, maxProps).join("\n");
			if (processedProperties.length > maxProps) {
				md += `\n\n[…${processedProperties.length - maxProps} properties elided…]`;
			}
			md += "\n";
		}

		if (entity.sitelinks) {
			const notableSites = ["enwiki", "dewiki", "frwiki", "eswiki", "jawiki", "zhwiki"];
			const links: string[] = [];

			for (const site of notableSites) {
				const sitelink = entity.sitelinks[site];
				if (sitelink) {
					const lang = site.replace("wiki", "");
					const wikiUrl = `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(sitelink.title)}`;
					links.push(markdownLink(lang.toUpperCase(), wikiUrl));
				}
			}

			if (links.length > 0) {
				md += `\n## Wikipedia Links\n\n${links.join(" · ")}\n`;
			}
		}

		return md;
	},
};

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

		if (contentRes.ok) {
			const doc = parseHTML(contentRes.content).document;
			const sections = doc.querySelectorAll("section");
			for (const section of sections) {
				const heading = section.querySelector("h2, h3, h4");
				const headingText = heading?.textContent?.trim();
				if (
					headingText &&
					["References", "External links", "See also", "Notes", "Further reading"].includes(headingText)
				) {
					continue;
				}
				if (headingText) {
					const level = heading?.tagName === "H2" ? "##" : "###";
					md += `${level} ${headingText}\n\n`;
				}
				const paragraphs = section.querySelectorAll("p");
				for (const p of paragraphs) {
					const text = p.textContent?.trim();
					if (text && text.length > 20) {
						md += `${text}\n\n`;
					}
				}
			}
		}

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
