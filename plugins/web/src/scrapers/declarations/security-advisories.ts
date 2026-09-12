import { markdownLink } from "../../markdown-link";
import { loadJson } from "../engine/declarative";
import { renderKeyValues } from "../engine/markdown-assembly";
import type { SecurityAdvisoryDeclaration } from "../engine/security-advisory";
import { formatIsoDate, isScraperDegrade } from "../types";

// --- CISA KEV ---

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

export const cisaKevDeclaration: SecurityAdvisoryDeclaration = {
	site: "cisa-kev",
	method: "cisa-kev",
	hosts: ["cisa.gov", "www.cisa.gov"],
	canonicalUrls: ["https://www.cisa.gov/known-exploited-vulnerabilities-catalog?search=CVE-2023-34362"],
	match: parsed => {
		const path = parsed.pathname.toLowerCase();
		if (!path.includes("known-exploited-vulnerabilities")) return null;

		const cveMatch = parsed.pathname.match(CVE_PATTERN) ?? parsed.search.match(CVE_PATTERN);
		if (!cveMatch) return null;

		return { id: cveMatch[0].toUpperCase(), parsedUrl: parsed };
	},
	notes: ["Fetched via CISA KEV feed"],
	fetch: async (match, ctx) => {
		const cveId = match.id;
		const data = await loadJson<KevCatalog>(ctx, KEV_FEED_URL, "cisa-kev");
		if (isScraperDegrade(data)) return data;

		const entry = data.vulnerabilities?.find(item => item.cveID?.toUpperCase() === cveId);
		if (!entry) return null;

		let md = `# ${entry.cveID}\n\n`;
		if (entry.vulnerabilityName) md += `${entry.vulnerabilityName}\n\n`;

		md += "## Metadata\n\n";
		md += renderKeyValues([
			["Vendor", entry.vendorProject],
			["Product", entry.product],
			["Date Added", entry.dateAdded],
			["Due Date", entry.dueDate],
		]);
		md += "\n";

		if (entry.shortDescription) md += `## Description\n\n${entry.shortDescription}\n\n`;
		if (entry.requiredAction) md += `## Required Action\n\n${entry.requiredAction}\n\n`;

		return md;
	},
};

// --- NVD ---

interface CvssV31 {
	baseScore: number;
	baseSeverity: string;
	vectorString: string;
}

interface CvssV2 {
	baseScore: number;
	severity?: string;
	baseSeverity?: string;
	vectorString: string;
}

interface CvssMetric {
	cvssData: CvssV31 | CvssV2;
	baseSeverity?: string;
	severity?: string;
	exploitabilityScore?: number;
	impactScore?: number;
}

interface CpeMatch {
	criteria: string;
	vulnerable: boolean;
	versionStartIncluding?: string;
	versionEndExcluding?: string;
	versionEndIncluding?: string;
}

interface Configuration {
	nodes?: Array<{
		operator?: string;
		cpeMatch?: CpeMatch[];
	}>;
}

interface Reference {
	url: string;
	source?: string;
	tags?: string[];
}

interface Description {
	lang: string;
	value: string;
}

interface Weakness {
	description: Description[];
}

interface CveItem {
	id: string;
	sourceIdentifier?: string;
	published: string;
	lastModified: string;
	vulnStatus?: string;
	descriptions: Description[];
	metrics?: {
		cvssMetricV31?: CvssMetric[];
		cvssMetricV30?: CvssMetric[];
		cvssMetricV2?: CvssMetric[];
	};
	weaknesses?: Weakness[];
	configurations?: Configuration[];
	references?: Reference[];
}

interface NvdResponse {
	vulnerabilities?: Array<{ cve: CveItem }>;
}

function extractNvdCpes(configurations?: Configuration[]): string[] {
	if (!configurations) return [];

	const cpes = new Set<string>();
	for (const config of configurations) {
		for (const node of config.nodes ?? []) {
			for (const match of node.cpeMatch ?? []) {
				if (match.vulnerable && match.criteria) {
					cpes.add(match.criteria);
				}
			}
		}
	}
	return Array.from(cpes);
}

export const nvdDeclaration: SecurityAdvisoryDeclaration = {
	site: "nvd",
	method: "nvd",
	hosts: ["nvd.nist.gov"],
	canonicalUrls: ["https://nvd.nist.gov/vuln/detail/CVE-2021-44228"],
	match: parsed => {
		const match = parsed.pathname.match(/\/vuln\/detail\/(CVE-\d{4}-\d+)/i);
		if (!match) return null;
		return { id: match[1].toUpperCase(), parsedUrl: parsed };
	},
	notes: ["Fetched via NVD API"],
	fetch: async (match, ctx) => {
		const cveId = match.id;
		const apiUrl = `https://services.nvd.nist.gov/rest/json/cves/2.0?cveId=${cveId}`;
		const data = await loadJson<NvdResponse>(ctx, apiUrl, "nvd");
		if (isScraperDegrade(data)) return data;

		const vuln = data.vulnerabilities?.[0]?.cve;
		if (!vuln) return null;

		let md = `# ${vuln.id}\n\n`;

		if (vuln.vulnStatus) {
			md += `**Status:** ${vuln.vulnStatus}\n`;
		}
		md += `**Published:** ${formatIsoDate(vuln.published)}`;
		md += ` · **Modified:** ${formatIsoDate(vuln.lastModified)}\n\n`;

		const desc = vuln.descriptions.find(d => d.lang === "en")?.value;
		if (desc) {
			md += `## Description\n\n${desc}\n\n`;
		}

		const cvss31 = vuln.metrics?.cvssMetricV31?.[0];
		const cvss30 = vuln.metrics?.cvssMetricV30?.[0];
		const cvss2 = vuln.metrics?.cvssMetricV2?.[0];

		if (cvss31 || cvss30 || cvss2) {
			md += `## CVSS Scores\n\n`;

			if (cvss31) {
				const cvssData = cvss31.cvssData as CvssV31;
				md += `### CVSS 3.1\n\n`;
				md += `- **Base Score:** ${cvssData.baseScore} (${cvssData.baseSeverity})\n`;
				md += `- **Vector:** \`${cvssData.vectorString}\`\n`;
				if (cvss31.exploitabilityScore !== undefined) {
					md += `- **Exploitability:** ${cvss31.exploitabilityScore}\n`;
				}
				if (cvss31.impactScore !== undefined) {
					md += `- **Impact:** ${cvss31.impactScore}\n`;
				}
				md += "\n";
			}

			if (cvss30 && !cvss31) {
				const cvssData = cvss30.cvssData as CvssV31;
				md += `### CVSS 3.0\n\n`;
				md += `- **Base Score:** ${cvssData.baseScore} (${cvssData.baseSeverity})\n`;
				md += `- **Vector:** \`${cvssData.vectorString}\`\n`;
				md += "\n";
			}

			if (cvss2) {
				const cvssData = cvss2.cvssData as CvssV2;
				const severity = cvssData.severity || cvssData.baseSeverity || cvss2.severity || cvss2.baseSeverity;
				md += `### CVSS 2.0\n\n`;
				md += `- **Base Score:** ${cvssData.baseScore}`;
				if (severity) md += ` (${severity})`;
				md += `\n- **Vector:** \`${cvssData.vectorString}\`\n\n`;
			}
		}

		const cwes = vuln.weaknesses
			?.flatMap(w => w.description)
			.filter(d => d.lang === "en" && d.value !== "NVD-CWE-Other" && d.value !== "NVD-CWE-noinfo");

		if (cwes?.length) {
			md += `## Weaknesses\n\n`;
			for (const cwe of cwes) {
				md += `- ${cwe.value}\n`;
			}
			md += "\n";
		}

		const cpes = extractNvdCpes(vuln.configurations);
		if (cpes.length > 0) {
			md += `## Affected Products\n\n`;
			const shown = cpes.slice(0, 20);
			for (const cpe of shown) {
				md += `- \`${cpe}\`\n`;
			}
			if (cpes.length > 20) {
				md += `\n[…${cpes.length - 20} CPEs elided…]\n`;
			}
			md += "\n";
		}

		if (vuln.references?.length) {
			md += `## References\n\n`;
			for (const ref of vuln.references.slice(0, 15)) {
				const tags = ref.tags?.length ? ` (${ref.tags.join(", ")})` : "";
				md += `- ${ref.url}${tags}\n`;
			}
			if (vuln.references.length > 15) {
				md += `\n[…${vuln.references.length - 15} references elided…]\n`;
			}
		}

		return md;
	},
};

// --- OSV ---

interface OsvSeverity {
	type: string;
	score: string;
}

interface OsvAffectedRange {
	type: string;
	events?: Array<{ introduced?: string; fixed?: string; last_affected?: string; limit?: string }>;
}

interface OsvAffected {
	package?: {
		ecosystem: string;
		name: string;
		purl?: string;
	};
	ranges?: OsvAffectedRange[];
	versions?: string[];
	severity?: OsvSeverity[];
	database_specific?: Record<string, unknown>;
	ecosystem_specific?: Record<string, unknown>;
}

interface OsvReference {
	type: string;
	url: string;
}

interface OsvVulnerability {
	id: string;
	summary?: string;
	details?: string;
	aliases?: string[];
	modified?: string;
	published?: string;
	withdrawn?: string;
	severity?: OsvSeverity[];
	affected?: OsvAffected[];
	references?: OsvReference[];
	credits?: Array<{ name: string; contact?: string[]; type?: string }>;
	database_specific?: Record<string, unknown>;
}

export const osvDeclaration: SecurityAdvisoryDeclaration = {
	site: "osv",
	method: "osv",
	hosts: ["osv.dev"],
	canonicalUrls: ["https://osv.dev/vulnerability/GHSA-j954-5h4q-8xwp", "https://osv.dev/vulnerability/CVE-2021-44228"],
	match: parsed => {
		const match = parsed.pathname.match(/^\/vulnerability\/([A-Za-z0-9-]+)$/);
		if (!match) return null;
		return { id: match[1], parsedUrl: parsed };
	},
	notes: ["Fetched via OSV API"],
	fetch: async (match, ctx) => {
		const vulnId = match.id;
		const apiUrl = `https://api.osv.dev/v1/vulns/${encodeURIComponent(vulnId)}`;
		const vuln = await loadJson<OsvVulnerability>(ctx, apiUrl, "osv");
		if (isScraperDegrade(vuln)) return vuln;
		if (!vuln?.id) return ctx.scraperDegrade("osv", "unexpected response shape");
		let md = `# ${vuln.id}\n\n`;

		if (vuln.summary) {
			md += `${vuln.summary}\n\n`;
		}

		md += "## Metadata\n\n";
		if (vuln.aliases?.length) {
			md += `**Aliases:** ${vuln.aliases.join(", ")}\n`;
		}
		if (vuln.published) {
			md += `**Published:** ${formatIsoDate(vuln.published)}\n`;
		}
		if (vuln.modified) {
			md += `**Modified:** ${formatIsoDate(vuln.modified)}\n`;
		}
		if (vuln.withdrawn) {
			md += `**Withdrawn:** ${formatIsoDate(vuln.withdrawn)}\n`;
		}

		const severities = vuln.severity || vuln.affected?.flatMap(a => a.severity || []) || [];
		if (severities.length) {
			const formatted = severities.map(s => `${s.type}: ${s.score}`).join(", ");
			md += `**Severity:** ${formatted}\n`;
		}
		md += "\n";

		if (vuln.details) {
			md += `## Details\n\n${vuln.details}\n\n`;
		}

		if (vuln.affected?.length) {
			md += "## Affected Packages\n\n";
			for (const affected of vuln.affected) {
				const pkg = affected.package;
				if (!pkg) continue;

				md += `### ${pkg.ecosystem}: ${pkg.name}\n\n`;

				if (affected.ranges?.length) {
					for (const range of affected.ranges) {
						if (!range.events?.length) continue;
						const parts: string[] = [];
						for (const event of range.events) {
							if (event.introduced) parts.push(`introduced: ${event.introduced}`);
							if (event.fixed) parts.push(`fixed: ${event.fixed}`);
							if (event.last_affected) parts.push(`last_affected: ${event.last_affected}`);
							if (event.limit) parts.push(`limit: ${event.limit}`);
						}
						if (parts.length) {
							md += `- **${range.type}:** ${parts.join(" → ")}\n`;
						}
					}
				}

				if (affected.versions?.length) {
					const versions =
						affected.versions.length > 10
							? `${affected.versions.slice(0, 10).join(", ")}… (${affected.versions.length} total)`
							: affected.versions.join(", ");
					md += `- **Versions:** ${versions}\n`;
				}

				md += "\n";
			}
		}

		if (vuln.references?.length) {
			md += "## References\n\n";
			for (const ref of vuln.references) {
				md += `- ${markdownLink(ref.type, ref.url)}\n`;
			}
			md += "\n";
		}

		if (vuln.credits?.length) {
			md += "## Credits\n\n";
			for (const credit of vuln.credits) {
				const type = credit.type ? ` (${credit.type})` : "";
				md += `- ${credit.name}${type}\n`;
			}
		}

		return md;
	},
};

export const SECURITY_ADVISORY_DECLARATIONS = [cisaKevDeclaration, nvdDeclaration, osvDeclaration];
