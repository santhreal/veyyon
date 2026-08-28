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
					const mt = await buildMarkdownTableFromHtmlRows(value.rows);
					for (let pi = 0; pi < mt.length; pi++) parts.push(mt[pi]!);
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

export const handleMDN: SpecialHandler = async (url: string, timeout: number, signal?: AbortSignal) => {
	const urlObj = tryParseUrl(url);
	if (!urlObj) return null;

	if (!urlObj.hostname.includes("developer.mozilla.org")) {
		return null;
	}

	if (!urlObj.pathname.includes("/docs/")) {
		return null;
	}

	const notes: string[] = [];

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
