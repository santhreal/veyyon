import { tryParseJson } from "@veyyon/utils";
import type { RenderResult, ScraperDegrade, SpecialHandler } from "./types";
import { buildResult, loadFailure, loadPage, scraperDegrade, tryParseUrl } from "./types";

interface KevEntry {
	cveID: string;
	vendorProject?: string;
	product?: string;
	vulnerabilityName?: string;
	shortDescription?: string;
	requiredAction?: string;
	dateAdded?: string;
	dueDate?: string;
}

interface KevCatalog {
	title?: string;
	catalogVersion?: string;
	dateReleased?: string;
	count?: number;
	vulnerabilities?: KevEntry[];
}

const CVE_PATTERN = /CVE-\d{4}-\d{4,7}/i;
const KEV_FEED_URL = "https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json";

/**
 * Handle CISA Known Exploited Vulnerabilities (KEV) URLs
 */
export const handleCisaKev: SpecialHandler = async (
	url: string,
	timeout: number,
	signal?: AbortSignal,
): Promise<RenderResult | ScraperDegrade | null> => {
	try {
		const parsed = tryParseUrl(url);
		if (!parsed) return null;
		const hostname = parsed.hostname.toLowerCase();
		if (!hostname.endsWith("cisa.gov")) return null;

		const path = parsed.pathname.toLowerCase();
		if (!path.includes("known-exploited-vulnerabilities")) return null;

		const cveMatch = parsed.pathname.match(CVE_PATTERN) ?? parsed.search.match(CVE_PATTERN);
		if (!cveMatch) return null;

		const cveId = cveMatch[0].toUpperCase();
		const fetchedAt = new Date().toISOString();

		const result = await loadPage(KEV_FEED_URL, {
			timeout,
			headers: { Accept: "application/json" },
			signal,
		});

		if (!result.ok) return scraperDegrade("cisa-kev", loadFailure(result));

		const data = tryParseJson<KevCatalog>(result.content);
		if (!data) return scraperDegrade("cisa-kev", "unexpected response shape");

		const entry = data.vulnerabilities?.find(item => item.cveID?.toUpperCase() === cveId);
		if (!entry) return null;

		let md = `# ${entry.cveID}\n\n`;
		if (entry.vulnerabilityName) {
			md += `${entry.vulnerabilityName}\n\n`;
		}

		md += "## Metadata\n\n";
		if (entry.vendorProject) md += `**Vendor:** ${entry.vendorProject}\n`;
		if (entry.product) md += `**Product:** ${entry.product}\n`;
		if (entry.dateAdded) md += `**Date Added:** ${entry.dateAdded}\n`;
		if (entry.dueDate) md += `**Due Date:** ${entry.dueDate}\n`;
		md += "\n";

		if (entry.shortDescription) {
			md += `## Description\n\n${entry.shortDescription}\n\n`;
		}

		if (entry.requiredAction) {
			md += `## Required Action\n\n${entry.requiredAction}\n\n`;
		}

		return buildResult(md, { url, method: "cisa-kev", fetchedAt, notes: ["Fetched via CISA KEV feed"] });
	} catch (error) {
		return scraperDegrade("cisa-kev", error);
	}
};
