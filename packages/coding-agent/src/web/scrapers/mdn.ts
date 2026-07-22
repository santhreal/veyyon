import { tryParseJson } from "@veyyon/utils";
import { renderMarkdownTable } from "../../utils/markdown-table";
import type { SpecialHandler } from "./types";
import { buildResult, htmlToBasicMarkdown, loadPage, scraperDegrade, tryParseUrl } from "./types";

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
		mdn_url: string;
		body: MDNSection[];
		browserCompat?: unknown;
	};
}

/**
 * Convert MDN body sections to markdown
 */
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
				// Skip unknown types
				break;
		}
	}

	return parts.join("\n\n");
}

/**
 * Convert a table's rows (each cell a fragment of HTML) into the lines of a
 * GitHub-flavored Markdown table. Each cell's HTML is rendered to Markdown, then
 * the grid is laid out by the shared {@link renderMarkdownTable} owner, which
 * escapes every cell (so a `|` from an MDN code sample like `a | b`, or a
 * newline from a multi-paragraph cell, cannot break out of its cell) and squares
 * ragged rows off to the widest row (so a body row with more cells than the
 * header cannot overflow the delimiter row and have its surplus cells silently
 * dropped). The first row is the header. Returns one line per table row, ready
 * to push into the section list, and `[]` when there are no rows.
 */
export async function buildMarkdownTableFromHtmlRows(rows: string[][]): Promise<string[]> {
	const rendered = await Promise.all(rows.map(row => Promise.all(row.map(cell => htmlToBasicMarkdown(cell)))));
	const table = renderMarkdownTable(rendered);
	return table ? table.split("\n") : [];
}

export const handleMDN: SpecialHandler = async (url: string, timeout: number, signal?: AbortSignal) => {
	const urlObj = tryParseUrl(url);
	if (!urlObj) return null;

	// Only handle developer.mozilla.org
	if (!urlObj.hostname.includes("developer.mozilla.org")) {
		return null;
	}

	// Only handle docs paths
	if (!urlObj.pathname.includes("/docs/")) {
		return null;
	}

	const notes: string[] = [];

	// Construct JSON API URL
	const jsonUrl = url.replace(/\/?$/, "/index.json");

	try {
		const result = await loadPage(jsonUrl, { timeout, signal, headers: { Accept: "application/json" } });

		if (!result.ok) {
			notes.push(`Failed to fetch MDN JSON API (status ${result.status || "unknown"})`);
			return null;
		}

		const data = tryParseJson<MDNDoc>(result.content);
		if (!data?.doc?.title) {
			notes.push("Invalid MDN JSON structure");
			return null;
		}

		const { doc } = data;

		// Build markdown content
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
			url,
			finalUrl: doc.mdn_url || result.finalUrl,
			method: "mdn",
			fetchedAt: new Date().toISOString(),
			notes,
		});
	} catch (err) {
		return scraperDegrade("mdn", err);
	}
};
