import { tryParseJson } from "@veyyon/utils";
import { markdownLink } from "../../utils/markdown-link";
import type { RenderResult, ScraperDegrade, SpecialHandler } from "./types";
import { buildResult, loadFailure, loadPage, scraperDegrade, tryParseUrl } from "./types";

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
	published?: string; // Journal DOI if published
	server?: string;
}

interface BiorxivResponse {
	collection?: BiorxivPaper[];
	messages?: { status: string; count: number }[];
}

export const handleBiorxiv: SpecialHandler = async (
	url: string,
	timeout: number,
	signal?: AbortSignal,
): Promise<RenderResult | ScraperDegrade | null> => {
	try {
		const parsed = tryParseUrl(url);
		if (!parsed) return null;
		const hostname = parsed.hostname.toLowerCase();

		const isBiorxiv = hostname === "www.biorxiv.org" || hostname === "biorxiv.org";
		const isMedrxiv = hostname === "www.medrxiv.org" || hostname === "medrxiv.org";

		if (!isBiorxiv && !isMedrxiv) return null;

		const match = parsed.pathname.match(/\/content\/(10\.\d{4,}\/[^\s?#]+)/);
		if (!match) return null;

		let doi = match[1];
		doi = doi.replace(/v\d+$/, "");
		doi = doi.replace(/\.full(\.pdf)?$/, "");

		const server = isBiorxiv ? "biorxiv" : "medrxiv";
		const apiUrl = `https://api.${server}.org/details/${server}/${doi}/na/json`;

		const result = await loadPage(apiUrl, {
			timeout,
			headers: { Accept: "application/json" },
			signal,
		});

		if (!result.ok) return scraperDegrade("biorxiv", loadFailure(result));

		const data = tryParseJson<BiorxivResponse>(result.content);
		if (!data) return scraperDegrade("biorxiv", "unexpected response shape");

		if (!data.collection || data.collection.length === 0) return null;

		const paper = data.collection[data.collection.length - 1];
		if (!paper) return null;

		const serverName = isBiorxiv ? "bioRxiv" : "medRxiv";
		const paperDoi = paper.biorxiv_doi || paper.medrxiv_doi || doi;

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

		return buildResult(md, {
			url,
			method: server,
			fetchedAt: new Date().toISOString(),
			notes: [`Fetched via ${serverName} API`],
		});
	} catch (error) {
		return scraperDegrade("biorxiv", error);
	}
};
