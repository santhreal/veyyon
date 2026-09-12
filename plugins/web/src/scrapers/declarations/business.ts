import { escapeMarkdownTableCell } from "@veyyon/utils/markdown-table";
import { markdownLink } from "../../markdown-link";
import type { BusinessDeclaration } from "../engine/business";
import { loadJson } from "../engine/declarative";
import { renderKeyValues } from "../engine/markdown-assembly";
import { buildResult, formatNumber, isScraperDegrade } from "../types";
export interface Officer {
	id: number;
	name: string;
	position?: string;
	start_date?: string;
	end_date?: string;
	occupation?: string;
	nationality?: string;
	inactive?: boolean;
}

export interface Address {
	street_address?: string;
	locality?: string;
	region?: string;
	postal_code?: string;
	country?: string;
}

export interface CompanyData {
	name: string;
	company_number: string;
	jurisdiction_code: string;
	incorporation_date?: string;
	dissolution_date?: string;
	company_type?: string;
	registry_url?: string;
	branch?: string;
	branch_status?: string;
	inactive?: boolean;
	current_status?: string;
	created_at?: string;
	updated_at?: string;
	retrieved_at?: string;
	opencorporates_url?: string;
	source?: {
		publisher?: string;
		url?: string;
		retrieved_at?: string;
	};
	registered_address?: Address;
	registered_address_in_full?: string;
	industry_codes?: Array<{
		code: string;
		description?: string;
		code_scheme_name?: string;
	}>;
	identifiers?: Array<{
		identifier_system_code: string;
		identifier_system_name?: string;
		identifier_uid: string;
	}>;
	previous_names?: Array<{
		company_name: string;
		con_date?: string;
	}>;
	alternative_names?: Array<{
		company_name: string;
		type?: string;
	}>;
	officers?: Array<{ officer: Officer }>;
	agent_name?: string;
	agent_address?: string;
	number_of_employees?: string;
	native_company_number?: string;
}

export function renderCompanyInfoTable(company: CompanyData): string {
	let md = "| Field | Value |\n|-------|-------|\n";
	md += `| **Company Number** | ${escapeMarkdownTableCell(company.company_number)} |\n`;
	md += `| **Jurisdiction** | ${escapeMarkdownTableCell(company.jurisdiction_code.toUpperCase())} |\n`;
	if (company.current_status) {
		md += `| **Status** | ${escapeMarkdownTableCell(company.current_status)} |\n`;
	}
	if (company.company_type) {
		md += `| **Company Type** | ${escapeMarkdownTableCell(company.company_type)} |\n`;
	}
	if (company.incorporation_date) {
		md += `| **Incorporated** | ${escapeMarkdownTableCell(company.incorporation_date)} |\n`;
	}
	if (company.dissolution_date) {
		md += `| **Dissolved** | ${escapeMarkdownTableCell(company.dissolution_date)} |\n`;
	}
	if (company.branch) {
		const branch = company.branch_status ? `${company.branch} (${company.branch_status})` : company.branch;
		md += `| **Branch** | ${escapeMarkdownTableCell(branch)} |\n`;
	}
	if (company.native_company_number && company.native_company_number !== company.company_number) {
		md += `| **Native Number** | ${escapeMarkdownTableCell(company.native_company_number)} |\n`;
	}
	return md;
}

// --- CoinGecko ---

interface CoinGeckoResponse {
	id: string;
	symbol: string;
	name: string;
	description?: { en?: string };
	links?: {
		homepage?: string[];
		blockchain_site?: string[];
		repos_url?: { github?: string[] };
	};
	market_data?: {
		current_price?: { usd?: number };
		market_cap?: { usd?: number };
		total_volume?: { usd?: number };
		price_change_percentage_24h?: number;
		ath?: { usd?: number };
		ath_date?: { usd?: string };
		circulating_supply?: number;
		total_supply?: number;
		max_supply?: number;
	};
	categories?: string[];
	genesis_date?: string;
}

function formatCoinGeckoPrice(price: number): string {
	if (price >= 1000) return price.toLocaleString("en-US", { maximumFractionDigits: 2 });
	if (price >= 1) return price.toFixed(2);
	if (price >= 0.01) return price.toFixed(4);
	if (price >= 0.0001) return price.toFixed(6);
	return price.toFixed(8);
}

export const coingeckoDeclaration: BusinessDeclaration = {
	site: "coingecko",
	method: "coingecko",
	hosts: ["coingecko.com", "www.coingecko.com"],
	canonicalUrls: ["https://www.coingecko.com/en/coins/bitcoin"],
	match: parsed => {
		const match = parsed.pathname.match(/^(?:\/[a-z]{2})?\/coins\/([^/?#]+)/);
		if (!match) return null;
		const coinId = decodeURIComponent(match[1]);
		return { id: coinId, parsedUrl: parsed };
	},
	notes: ["Fetched via CoinGecko API"],
	fetch: async (match, ctx) => {
		const coinId = match.id;
		const apiUrl = `https://api.coingecko.com/api/v3/coins/${encodeURIComponent(coinId)}?localization=false&tickers=false&community_data=false&developer_data=false`;
		const coin = await loadJson<CoinGeckoResponse>(ctx, apiUrl, "coingecko");
		if (isScraperDegrade(coin)) return coin;
		if (!coin?.name) return ctx.scraperDegrade("coingecko", "unexpected response shape");
		const market = coin.market_data;
		let md = `# ${coin.name} (${coin.symbol.toUpperCase()})\n\n`;

		if (market?.current_price?.usd !== undefined) {
			md += `**Price:** $${formatCoinGeckoPrice(market.current_price.usd)}`;
			if (market.price_change_percentage_24h !== undefined) {
				const change = market.price_change_percentage_24h;
				const sign = change >= 0 ? "+" : "";
				md += ` (${sign}${change.toFixed(2)}% 24h)`;
			}
			md += "\n";
		}

		if (market?.market_cap?.usd) {
			md += `**Market Cap:** $${formatNumber(market.market_cap.usd)}\n`;
		}

		if (market?.total_volume?.usd) {
			md += `**24h Volume:** $${formatNumber(market.total_volume.usd)}\n`;
		}

		if (market?.ath?.usd !== undefined) {
			md += `**All-Time High:** $${formatCoinGeckoPrice(market.ath.usd)}`;
			if (market.ath_date?.usd) {
				const athDate = new Date(market.ath_date.usd).toLocaleDateString("en-US", {
					year: "numeric",
					month: "short",
					day: "numeric",
				});
				md += ` (${athDate})`;
			}
			md += "\n";
		}

		md += "\n";

		if (market?.circulating_supply) {
			md += `**Circulating Supply:** ${formatNumber(Math.round(market.circulating_supply))}`;
			if (market.max_supply) {
				const percent = ((market.circulating_supply / market.max_supply) * 100).toFixed(1);
				md += ` / ${formatNumber(Math.round(market.max_supply))} (${percent}%)`;
			} else if (market.total_supply) {
				md += ` / ${formatNumber(Math.round(market.total_supply))} total`;
			}
			md += "\n";
		}

		if (coin.genesis_date) {
			md += `**Launch Date:** ${coin.genesis_date}\n`;
		}

		if (coin.categories?.length) {
			md += `**Categories:** ${coin.categories.join(", ")}\n`;
		}

		const links: string[] = [];
		if (coin.links?.homepage?.[0]) {
			links.push(markdownLink("Website", coin.links.homepage[0]));
		}
		if (coin.links?.blockchain_site?.[0]) {
			links.push(markdownLink("Explorer", coin.links.blockchain_site[0]));
		}
		if (coin.links?.repos_url?.github?.[0]) {
			links.push(markdownLink("GitHub", coin.links.repos_url.github[0]));
		}
		if (links.length) {
			md += `**Links:** ${links.join(" · ")}\n`;
		}

		if (coin.description?.en) {
			const desc = coin.description.en
				.replace(/<[^>]+>/g, "")
				.replace(/\r\n/g, "\n")
				.trim();
			if (desc) {
				md += `\n## About\n\n${desc}\n`;
			}
		}

		return md;
	},
};

// --- OpenCorporates ---

export const opencorporatesDeclaration: BusinessDeclaration = {
	site: "opencorporates",
	method: "opencorporates",
	hosts: ["opencorporates.com", "www.opencorporates.com"],
	canonicalUrls: ["https://opencorporates.com/companies/us_de/2144884"],
	match: parsed => {
		const match = parsed.pathname.match(/^\/companies\/([^/]+)\/([^/]+)/);
		if (!match) return null;
		const jurisdiction = decodeURIComponent(match[1]);
		const companyNumber = decodeURIComponent(match[2]);
		return {
			jurisdiction,
			companyNumber,
			id: `${jurisdiction}/${companyNumber}`,
			parsedUrl: parsed,
		};
	},
	notes: ["Fetched via OpenCorporates API"],
	fetch: async (match, ctx) => {
		const jurisdiction = match.jurisdiction!;
		const companyNumber = match.companyNumber!;
		const apiUrl = `https://api.opencorporates.com/v0.4/companies/${encodeURIComponent(jurisdiction)}/${encodeURIComponent(companyNumber)}`;
		const data = await loadJson<{ results?: { company?: CompanyData } }>(ctx, apiUrl, "opencorporates");
		if (isScraperDegrade(data)) return data;
		const company = data?.results?.company;
		if (!company) return ctx.scraperDegrade("opencorporates", "unexpected response shape");
		let md = `# ${company.name}\n\n`;
		md += renderCompanyInfoTable(company);
		md += "\n";

		if (company.registered_address_in_full) {
			md += `## Registered Address\n\n${company.registered_address_in_full}\n\n`;
		} else if (company.registered_address) {
			const addr = company.registered_address;
			const parts = [addr.street_address, addr.locality, addr.region, addr.postal_code, addr.country].filter(
				Boolean,
			);
			if (parts.length > 0) {
				md += `## Registered Address\n\n${parts.join(", ")}\n\n`;
			}
		}

		if (company.agent_name) {
			md += `## Registered Agent\n\n**${company.agent_name}**`;
			if (company.agent_address) {
				md += `\n${company.agent_address}`;
			}
			md += "\n\n";
		}

		if (company.officers && company.officers.length > 0) {
			const activeOfficers = company.officers.filter(o => !o.officer.inactive && !o.officer.end_date);
			const inactiveOfficers = company.officers.filter(o => o.officer.inactive || o.officer.end_date);

			if (activeOfficers.length > 0) {
				md += `## Current Officers (${activeOfficers.length})\n\n`;
				for (const { officer } of activeOfficers) {
					md += `- **${officer.name}**`;
					if (officer.position) md += ` - ${officer.position}`;
					if (officer.start_date) md += ` (since ${officer.start_date})`;
					if (officer.occupation) md += ` [${officer.occupation}]`;
					if (officer.nationality) md += ` (${officer.nationality})`;
					md += "\n";
				}
				md += "\n";
			}

			if (inactiveOfficers.length > 0) {
				md += `## Former Officers (${inactiveOfficers.length})\n\n`;
				for (const { officer } of inactiveOfficers.slice(0, 10)) {
					md += `- **${officer.name}**`;
					if (officer.position) md += ` - ${officer.position}`;
					if (officer.start_date && officer.end_date) {
						md += ` (${officer.start_date} to ${officer.end_date})`;
					} else if (officer.end_date) {
						md += ` (until ${officer.end_date})`;
					}
					md += "\n";
				}
				if (inactiveOfficers.length > 10) {
					md += `\n[…${inactiveOfficers.length - 10} former officers elided…]\n`;
				}
				md += "\n";
			}
		}

		if (company.industry_codes && company.industry_codes.length > 0) {
			md += `## Industry Codes\n\n`;
			for (const ic of company.industry_codes) {
				md += `- **${ic.code}**`;
				if (ic.description) md += `: ${ic.description}`;
				if (ic.code_scheme_name) md += ` (${ic.code_scheme_name})`;
				md += "\n";
			}
			md += "\n";
		}

		if (company.identifiers && company.identifiers.length > 0) {
			md += `## Identifiers\n\n`;
			for (const id of company.identifiers) {
				md += `- **${id.identifier_system_name || id.identifier_system_code}**: ${id.identifier_uid}\n`;
			}
			md += "\n";
		}

		if (company.previous_names && company.previous_names.length > 0) {
			md += `## Previous Names\n\n`;
			for (const pn of company.previous_names) {
				md += `- ${pn.company_name}`;
				if (pn.con_date) md += ` (until ${pn.con_date})`;
				md += "\n";
			}
			md += "\n";
		}

		if (company.alternative_names && company.alternative_names.length > 0) {
			md += `## Alternative Names\n\n`;
			for (const an of company.alternative_names) {
				md += `- ${an.company_name}`;
				if (an.type) md += ` (${an.type})`;
				md += "\n";
			}
			md += "\n";
		}

		md += "---\n\n";
		if (company.source?.publisher) {
			md += `**Source:** ${company.source.publisher}`;
			if (company.source.url) md += ` (${markdownLink("registry", company.source.url)})`;
			md += "\n";
		}
		if (company.registry_url) {
			md += `**Official Registry:** ${company.registry_url}\n`;
		}
		if (company.retrieved_at) {
			md += `**Data Retrieved:** ${company.retrieved_at}\n`;
		}

		return buildResult(md, {
			url: ctx.url,
			finalUrl: company.opencorporates_url || ctx.url,
			method: "opencorporates",
			fetchedAt: ctx.fetchedAt,
			notes: ["Fetched via OpenCorporates API"],
		});
	},
};

// --- SEC EDGAR ---

interface SecFiling {
	accessionNumber: string;
	filingDate: string;
	reportDate: string;
	acceptanceDateTime: string;
	form: string;
	primaryDocument: string;
	primaryDocDescription: string;
}

interface SecCompany {
	cik: string;
	entityType: string;
	sic: string;
	sicDescription: string;
	name: string;
	tickers: string[];
	exchanges: string[];
	ein: string;
	stateOfIncorporation: string;
	fiscalYearEnd: string;
	addresses: {
		business: {
			street1?: string;
			street2?: string;
			city?: string;
			stateOrCountry?: string;
			zipCode?: string;
		};
		mailing: {
			street1?: string;
			street2?: string;
			city?: string;
			stateOrCountry?: string;
			zipCode?: string;
		};
	};
	filings: {
		recent: {
			accessionNumber: string[];
			filingDate: string[];
			reportDate: string[];
			acceptanceDateTime: string[];
			form: string[];
			primaryDocument: string[];
			primaryDocDescription: string[];
		};
	};
}

function extractSecCik(url: URL): string | null {
	const { hostname, pathname, searchParams } = url;
	if (!hostname.includes("sec.gov")) return null;

	const cikParam = searchParams.get("CIK") || searchParams.get("cik");
	if (cikParam) {
		return cikParam.replace(/\D/g, "").padStart(10, "0");
	}

	const cikPathMatch = pathname.match(/\/cik\/(\d+)/i);
	if (cikPathMatch) {
		return cikPathMatch[1].replace(/\D/g, "").padStart(10, "0");
	}

	const submissionsMatch = pathname.match(/\/submissions\/CIK(\d+)\.json/i);
	if (submissionsMatch) {
		return submissionsMatch[1].replace(/\D/g, "").padStart(10, "0");
	}

	if (pathname.includes("/cgi-bin/browse-edgar") && searchParams.get("company")) {
		return null;
	}

	const archivesMatch = pathname.match(/\/Archives\/edgar\/data\/(\d+)/);
	if (archivesMatch) {
		return archivesMatch[1].replace(/\D/g, "").padStart(10, "0");
	}

	return null;
}

function formatSecAddress(addr: SecCompany["addresses"]["business"]): string {
	const parts: string[] = [];
	if (addr.street1) parts.push(addr.street1);
	if (addr.street2) parts.push(addr.street2);

	const cityLine: string[] = [];
	if (addr.city) cityLine.push(addr.city);
	if (addr.stateOrCountry) cityLine.push(addr.stateOrCountry);
	if (addr.zipCode) cityLine.push(addr.zipCode);
	if (cityLine.length) parts.push(cityLine.join(", "));

	return parts.join("\n");
}

function getSecRecentFilings(company: SecCompany, formTypes: string[], limit = 10): SecFiling[] {
	const { recent } = company.filings;
	const filings: SecFiling[] = [];

	for (let i = 0; i < recent.form.length && filings.length < limit; i++) {
		if (formTypes.length === 0 || formTypes.includes(recent.form[i])) {
			filings.push({
				accessionNumber: recent.accessionNumber[i],
				filingDate: recent.filingDate[i],
				reportDate: recent.reportDate[i],
				acceptanceDateTime: recent.acceptanceDateTime[i],
				form: recent.form[i],
				primaryDocument: recent.primaryDocument[i],
				primaryDocDescription: recent.primaryDocDescription[i],
			});
		}
	}

	return filings;
}

function buildSecFilingUrl(cik: string, accessionNumber: string, document: string): string {
	const accessionNoDashes = accessionNumber.replace(/-/g, "");
	return `https://www.sec.gov/Archives/edgar/data/${Number.parseInt(cik, 10)}/${accessionNoDashes}/${document}`;
}

export const secEdgarDeclaration: BusinessDeclaration = {
	site: "sec-edgar",
	method: "sec-edgar",
	hosts: ["sec.gov", "www.sec.gov", "data.sec.gov"],
	canonicalUrls: [
		"https://www.sec.gov/edgar/browse/?CIK=0000320193",
		"https://data.sec.gov/submissions/CIK0000320193.json",
		"https://www.sec.gov/Archives/edgar/data/320193/000032019324000123/aapl-20240928.htm",
	],
	match: parsed => {
		const cik = extractSecCik(parsed);
		return cik ? { id: cik, parsedUrl: parsed } : null;
	},
	notes: ["Fetched via SEC EDGAR API"],
	fetch: async (match, ctx) => {
		const cik = match.id;
		const apiUrl = `https://data.sec.gov/submissions/CIK${cik}.json`;
		const company = await loadJson<SecCompany>(ctx, apiUrl, "sec-edgar", {
			headers: { "User-Agent": "CodingAgent/1.0 (research tool)" },
		});
		if (isScraperDegrade(company)) return company;
		if (!company?.name) return ctx.scraperDegrade("sec-edgar", "unexpected response shape");
		let md = `# ${company.name}\n\n`;

		md += `**CIK:** ${company.cik}`;
		if (company.tickers?.length) {
			md += ` · **Ticker${company.tickers.length > 1 ? "s" : ""}:** ${company.tickers.join(", ")}`;
		}
		if (company.exchanges?.length) {
			md += ` (${company.exchanges.join(", ")})`;
		}
		md += "\n";

		if (company.entityType) md += `**Entity Type:** ${company.entityType}\n`;
		if (company.sic) md += `**SIC:** ${company.sic} - ${company.sicDescription}\n`;
		if (company.stateOfIncorporation) md += `**State of Incorporation:** ${company.stateOfIncorporation}\n`;
		if (company.ein) md += `**EIN:** ${company.ein}\n`;
		if (company.fiscalYearEnd) {
			const fy = company.fiscalYearEnd;
			md += `**Fiscal Year End:** ${fy.slice(0, 2)}/${fy.slice(2)}\n`;
		}
		md += "\n";

		if (company.addresses?.business) {
			const addr = formatSecAddress(company.addresses.business);
			if (addr) {
				md += `## Business Address\n\n${addr}\n\n`;
			}
		}

		const renderFilingsTable = (filings: SecFiling[], title: string) => {
			if (!filings.length) return "";
			let s = `## ${title}\n\n| Date | Form | Description |\n|------|------|-------------|\n`;
			for (const filing of filings) {
				const filingUrl = buildSecFilingUrl(cik, filing.accessionNumber, filing.primaryDocument);
				const desc = filing.primaryDocDescription || filing.form;
				s += `| ${filing.filingDate} | ${markdownLink(filing.form, filingUrl)} | ${escapeMarkdownTableCell(desc)} |\n`;
			}
			return `${s}\n`;
		};

		md += renderFilingsTable(
			getSecRecentFilings(company, ["10-K", "10-K/A", "10-Q", "10-Q/A", "8-K", "8-K/A"], 15),
			"Recent Filings (10-K, 10-Q, 8-K)",
		);
		md += renderFilingsTable(getSecRecentFilings(company, [], 20), "All Recent Filings");

		md += `## Links\n\n`;
		md += `- ${markdownLink("SEC EDGAR Filings", `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${cik}&type=&dateb=&owner=include&count=40`)}\n`;
		md += `- ${markdownLink("Company Search", `https://www.sec.gov/cgi-bin/browse-edgar?company=${encodeURIComponent(company.name)}&CIK=&type=&owner=include&count=40&action=getcompany`)}\n`;

		return md;
	},
};

// --- Searchcode ---

interface SearchcodeResult {
	id?: number | string;
	filename?: string;
	repo?: string;
	language?: string;
	code?: string;
	lines?: number | string | Array<number | string>;
	location?: string;
	url?: string;
}

interface SearchcodeSearchResponse {
	query?: string;
	results?: SearchcodeResult[];
	total?: number;
	total_results?: number;
	nextpage?: number;
}

function parseSearchcodeLineNumbers(lines: SearchcodeResult["lines"]): number[] | null {
	if (typeof lines === "number" && Number.isFinite(lines)) return [lines];

	if (typeof lines === "string") {
		const parts = lines.split(/[,\s]+/).filter(Boolean);
		const parsed = parts.map(part => Number.parseInt(part, 10)).filter(value => Number.isFinite(value));
		return parsed.length ? parsed : null;
	}

	if (Array.isArray(lines)) {
		const parsed = lines.map(part => Number.parseInt(String(part), 10)).filter(value => Number.isFinite(value));
		return parsed.length ? parsed : null;
	}

	return null;
}

function formatSearchcodeLineNumbers(lines: number[] | null): string | null {
	if (!lines || lines.length === 0) return null;
	if (lines.length <= 10) return lines.join(", ");
	const min = Math.min(...lines);
	const max = Math.max(...lines);
	return `${min}-${max} (${lines.length} lines)`;
}

function formatSearchcodeCodeBlock(
	code: string | undefined,
	language: string | undefined,
	lines: number[] | null,
): string | null {
	if (!code) return null;

	const codeLines = code.trimEnd().split(/\r?\n/);
	const languageTag = typeof language === "string" ? language.trim().toLowerCase() : "";

	let displayLines = codeLines;
	if (lines && lines.length === codeLines.length) {
		displayLines = codeLines.map((line, index) => `${lines[index]}: ${line}`);
	}

	const fence = languageTag ? languageTag : "";
	return `\n\n\`\`\`${fence}\n${displayLines.join("\n")}\n\`\`\`\n`;
}

export const searchcodeDeclaration: BusinessDeclaration = {
	site: "searchcode",
	method: "searchcode",
	hosts: ["searchcode.com", "www.searchcode.com"],
	canonicalUrls: ["https://searchcode.com/codesearch/view/12345678/", "https://searchcode.com/?q=quicksort"],
	match: parsed => {
		const viewMatch = parsed.pathname.match(/^\/codesearch\/view\/([^/?#]+)/);
		if (viewMatch) {
			return { id: viewMatch[1], kind: "result", parsedUrl: parsed };
		}
		const query = parsed.searchParams.get("q");
		const isSearchPage =
			parsed.pathname === "/" || parsed.pathname === "/codesearch" || parsed.pathname === "/codesearch/";
		if (query && isSearchPage) {
			return { id: query, query, kind: "search", parsedUrl: parsed };
		}
		return null;
	},
	notes: ["Fetched via searchcode API"],
	fetch: async (match, ctx) => {
		if (match.kind === "result") {
			const id = match.id;
			const apiUrl = `https://searchcode.com/api/result/${encodeURIComponent(id)}/`;
			const data = await loadJson<SearchcodeResult>(ctx, apiUrl, "searchcode");
			if (isScraperDegrade(data)) return data;
			if (!data) return ctx.scraperDegrade("searchcode", "unexpected response shape");
			const filename = data.filename || data.location || `Result ${id}`;
			const lineNumbers = parseSearchcodeLineNumbers(data.lines);
			const formattedLines = formatSearchcodeLineNumbers(lineNumbers);
			const viewUrl = data.url || `https://searchcode.com/codesearch/view/${id}`;
			const snippetBlock = formatSearchcodeCodeBlock(data.code, data.language, lineNumbers);

			let md = `# ${filename}\n\n`;
			md += `## Description\n\n`;
			md += "Code snippet from searchcode.com.\n\n";
			md += `## Metadata\n\n`;
			md += renderKeyValues([
				["Repository", data.repo],
				["Language", data.language],
				["File", data.filename],
				["Location", data.location],
				["Lines", formattedLines],
				["Result ID", id],
				["URL", viewUrl],
			]);
			md += `\n## Snippet`;
			if (snippetBlock) {
				md += snippetBlock;
			} else {
				md += "\n\n_No snippet available._\n";
			}

			return md;
		}

		const query = match.query!;
		const parsed = match.parsedUrl;
		const pageRaw = parsed.searchParams.get("p") ?? parsed.searchParams.get("page");
		const pageNumber = pageRaw ? Number.parseInt(pageRaw, 10) : 0;
		const page = Number.isFinite(pageNumber) && pageNumber >= 0 ? pageNumber : 0;
		const apiUrl = `https://searchcode.com/api/codesearch_I/?q=${encodeURIComponent(query)}&p=${page}`;
		const data = await loadJson<SearchcodeSearchResponse>(ctx, apiUrl, "searchcode");
		if (isScraperDegrade(data)) return data;
		if (!data) return ctx.scraperDegrade("searchcode", "unexpected response shape");
		const results = Array.isArray(data.results) ? data.results : [];
		const total =
			typeof data.total === "number"
				? data.total
				: typeof data.total_results === "number"
					? data.total_results
					: null;

		let md = `# Searchcode Results\n\n`;
		md += `## Description\n\n`;
		md += `Search results for \`${query}\` on searchcode.com.\n\n`;
		md += `## Metadata\n\n`;
		md += `**Query:** \`${query}\`\n`;
		md += `**Page:** ${page}\n`;
		if (total !== null) md += `**Total Results:** ${formatNumber(total)}\n`;
		md += `**Result Count:** ${results.length}\n`;
		if (typeof data.nextpage === "number") md += `**Next Page:** ${data.nextpage}\n`;

		md += `\n## Results\n\n`;

		if (results.length === 0) {
			md += "_No results found._\n";
		} else {
			const maxResults = 10;
			for (const resultItem of results.slice(0, maxResults)) {
				const id = resultItem.id !== undefined ? String(resultItem.id) : null;
				const filename = resultItem.filename || resultItem.location || "Result";
				const lineNumbers = parseSearchcodeLineNumbers(resultItem.lines);
				const formattedLines = formatSearchcodeLineNumbers(lineNumbers);
				const viewUrl = resultItem.url || (id ? `https://searchcode.com/codesearch/view/${id}` : null);
				const snippetBlock = formatSearchcodeCodeBlock(resultItem.code, resultItem.language, lineNumbers);

				md += `### ${filename}\n\n`;
				if (resultItem.repo) md += `**Repository:** ${resultItem.repo}\n`;
				if (resultItem.language) md += `**Language:** ${resultItem.language}\n`;
				if (resultItem.filename) md += `**File:** ${resultItem.filename}\n`;
				if (resultItem.location) md += `**Location:** ${resultItem.location}\n`;
				if (formattedLines) md += `**Lines:** ${formattedLines}\n`;
				if (viewUrl) md += `**URL:** ${viewUrl}\n`;

				if (snippetBlock) {
					md += `${snippetBlock}\n`;
				}

				md += "\n";
			}

			if (results.length > maxResults) {
				md += `\n_Only showing first ${maxResults} results._\n`;
			}
		}

		return md;
	},
};

export const BUSINESS_DECLARATIONS = [
	coingeckoDeclaration,
	opencorporatesDeclaration,
	secEdgarDeclaration,
	searchcodeDeclaration,
];
