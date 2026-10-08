import { escapeMarkdownTableCell } from "@veyyon/utils/markdown-table";
import { markdownLink } from "../../markdown-link";
import type { BusinessContext, BusinessDeclaration } from "../engine/business";
import { loadJson } from "../engine/declarative";
import { renderKeyValues } from "../engine/markdown-assembly";
import { buildResult, formatNumber, isScraperDegrade, type ScraperDegrade } from "../types";
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

interface CoinGeckoMarket {
	current_price?: { usd?: number | null };
	market_cap?: { usd?: number | null };
	total_volume?: { usd?: number | null };
	price_change_percentage_24h?: number | null;
	ath?: { usd?: number | null };
	ath_date?: { usd?: string | null };
	circulating_supply?: number | null;
	total_supply?: number | null;
	max_supply?: number | null;
}

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
	market_data?: CoinGeckoMarket;
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

/**
 * The price with its 24h change, market cap, 24h volume and all-time high with its date. CoinGecko
 * writes `null` for a figure it lacks, as it does for a new coin's 24h change.
 */
function renderCoinMarket(market: CoinGeckoMarket): string {
	const price = market.current_price?.usd;
	const change = market.price_change_percentage_24h;
	const changeText = typeof change === "number" ? ` (${change >= 0 ? "+" : ""}${change.toFixed(2)}% 24h)` : "";
	const ath = market.ath?.usd;
	const athDate = market.ath_date?.usd;
	const athDateText = athDate
		? ` (${new Date(athDate).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" })})`
		: "";
	return renderKeyValues([
		["Price", typeof price === "number" ? `$${formatCoinGeckoPrice(price)}${changeText}` : undefined],
		["Market Cap", market.market_cap?.usd ? `$${formatNumber(market.market_cap.usd)}` : undefined],
		["24h Volume", market.total_volume?.usd ? `$${formatNumber(market.total_volume.usd)}` : undefined],
		["All-Time High", typeof ath === "number" ? `$${formatCoinGeckoPrice(ath)}${athDateText}` : undefined],
	]);
}

/** The circulating supply against the maximum supply, or else the total supply. */
function coinSupply(market: CoinGeckoMarket | undefined): string | undefined {
	if (!market?.circulating_supply) return undefined;
	const circulating = market.circulating_supply;
	const text = formatNumber(Math.round(circulating));
	if (market.max_supply) {
		const percent = ((circulating / market.max_supply) * 100).toFixed(1);
		return `${text} / ${formatNumber(Math.round(market.max_supply))} (${percent}%)`;
	}
	return market.total_supply ? `${text} / ${formatNumber(Math.round(market.total_supply))} total` : text;
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
		if (market) md += renderCoinMarket(market);
		md += "\n";

		const links: Array<[label: string, url: string | undefined]> = [
			["Website", coin.links?.homepage?.[0]],
			["Explorer", coin.links?.blockchain_site?.[0]],
			["GitHub", coin.links?.repos_url?.github?.[0]],
		];
		md += renderKeyValues([
			["Circulating Supply", coinSupply(market)],
			["Launch Date", coin.genesis_date],
			["Categories", coin.categories?.filter(Boolean).join(", ")],
			["Links", links.flatMap(([label, url]) => (url ? [markdownLink(label, url)] : [])).join(" · ")],
		]);

		const desc = coin.description?.en
			?.replace(/<[^>]+>/g, "")
			.replace(/\r\n/g, "\n")
			.trim();
		if (desc) md += `\n## About\n\n${desc}\n`;
		return md;
	},
};

// --- OpenCorporates ---

/** A `## title` section of bullet lines, or nothing when there are none. */
function bulletSection(title: string, lines: string[]): string {
	return lines.length ? `## ${title}\n\n${lines.map(line => `- ${line}\n`).join("")}\n` : "";
}

/** The full registered address, or else the parts of the structured one joined. */
function registeredAddress(company: CompanyData): string {
	if (company.registered_address_in_full) return company.registered_address_in_full;
	const addr = company.registered_address;
	if (!addr) return "";
	return [addr.street_address, addr.locality, addr.region, addr.postal_code, addr.country].filter(Boolean).join(", ");
}

function currentOfficerLine(officer: Officer): string {
	let line = `**${officer.name}**`;
	if (officer.position) line += ` - ${officer.position}`;
	if (officer.start_date) line += ` (since ${officer.start_date})`;
	if (officer.occupation) line += ` [${officer.occupation}]`;
	if (officer.nationality) line += ` (${officer.nationality})`;
	return line;
}

function formerOfficerLine(officer: Officer): string {
	const head = `**${officer.name}**${officer.position ? ` - ${officer.position}` : ""}`;
	if (officer.start_date && officer.end_date) return `${head} (${officer.start_date} to ${officer.end_date})`;
	return officer.end_date ? `${head} (until ${officer.end_date})` : head;
}

const FORMER_OFFICERS_SHOWN = 10;

/** Current officers in full, then the first {@link FORMER_OFFICERS_SHOWN} former officers and a count of the rest. */
function renderOfficers(entries: Array<{ officer: Officer }>): string {
	const officers = entries.map(entry => entry.officer);
	const current = officers.filter(officer => !officer.inactive && !officer.end_date);
	const former = officers.filter(officer => officer.inactive || officer.end_date);
	let md = bulletSection(`Current Officers (${current.length})`, current.map(currentOfficerLine));
	md += bulletSection(
		`Former Officers (${former.length})`,
		former.slice(0, FORMER_OFFICERS_SHOWN).map(formerOfficerLine),
	);
	const elided = former.length - FORMER_OFFICERS_SHOWN;
	if (elided > 0) md += `[…${elided} former officers elided…]\n\n`;
	return md;
}

/** The industry codes, identifiers, previous names and alternative names sections. */
function renderCompanyLists(company: CompanyData): string {
	const codes = (company.industry_codes ?? []).map(
		ic =>
			`**${ic.code}**${ic.description ? `: ${ic.description}` : ""}${ic.code_scheme_name ? ` (${ic.code_scheme_name})` : ""}`,
	);
	const identifiers = (company.identifiers ?? []).map(
		id => `**${id.identifier_system_name || id.identifier_system_code}**: ${id.identifier_uid}`,
	);
	const previous = (company.previous_names ?? []).map(
		pn => `${pn.company_name}${pn.con_date ? ` (until ${pn.con_date})` : ""}`,
	);
	const alternative = (company.alternative_names ?? []).map(
		an => `${an.company_name}${an.type ? ` (${an.type})` : ""}`,
	);
	return (
		bulletSection("Industry Codes", codes) +
		bulletSection("Identifiers", identifiers) +
		bulletSection("Previous Names", previous) +
		bulletSection("Alternative Names", alternative)
	);
}

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
		let md = `# ${company.name}\n\n${renderCompanyInfoTable(company)}\n`;
		const address = registeredAddress(company);
		if (address) md += `## Registered Address\n\n${address}\n\n`;
		if (company.agent_name) {
			const agentAddress = company.agent_address ? `\n${company.agent_address}` : "";
			md += `## Registered Agent\n\n**${company.agent_name}**${agentAddress}\n\n`;
		}
		md += renderOfficers(company.officers ?? []);
		md += renderCompanyLists(company);

		const source = company.source;
		const registryLink = source?.url ? ` (${markdownLink("registry", source.url)})` : "";
		md += "---\n\n";
		md += renderKeyValues([
			["Source", source?.publisher ? `${source.publisher}${registryLink}` : undefined],
			["Official Registry", company.registry_url],
			["Data Retrieved", company.retrieved_at],
		]);

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

const SEARCHCODE_RESULTS_SHOWN = 10;

/** One search hit: its file heading, metadata and snippet. */
function renderSearchcodeHit(hit: SearchcodeResult): string {
	const id = hit.id !== undefined ? String(hit.id) : null;
	const lineNumbers = parseSearchcodeLineNumbers(hit.lines);
	const snippetBlock = formatSearchcodeCodeBlock(hit.code, hit.language, lineNumbers);
	let md = `### ${hit.filename || hit.location || "Result"}\n\n`;
	md += renderKeyValues([
		["Repository", hit.repo],
		["Language", hit.language],
		["File", hit.filename],
		["Location", hit.location],
		["Lines", formatSearchcodeLineNumbers(lineNumbers)],
		["URL", hit.url || (id ? `https://searchcode.com/codesearch/view/${id}` : null)],
	]);
	if (snippetBlock) md += `${snippetBlock}\n`;
	return `${md}\n`;
}

/** The page for one searchcode result: its metadata and its snippet. */
async function fetchSearchcodeResult(id: string, ctx: BusinessContext): Promise<string | ScraperDegrade> {
	const apiUrl = `https://searchcode.com/api/result/${encodeURIComponent(id)}/`;
	const data = await loadJson<SearchcodeResult>(ctx, apiUrl, "searchcode");
	if (isScraperDegrade(data)) return data;
	if (!data) return ctx.scraperDegrade("searchcode", "unexpected response shape");
	const lineNumbers = parseSearchcodeLineNumbers(data.lines);
	const snippetBlock = formatSearchcodeCodeBlock(data.code, data.language, lineNumbers);

	let md = `# ${data.filename || data.location || `Result ${id}`}\n\n`;
	md += `## Description\n\n`;
	md += "Code snippet from searchcode.com.\n\n";
	md += `## Metadata\n\n`;
	md += renderKeyValues([
		["Repository", data.repo],
		["Language", data.language],
		["File", data.filename],
		["Location", data.location],
		["Lines", formatSearchcodeLineNumbers(lineNumbers)],
		["Result ID", id],
		["URL", data.url || `https://searchcode.com/codesearch/view/${id}`],
	]);
	md += `\n## Snippet`;
	md += snippetBlock ?? "\n\n_No snippet available._\n";
	return md;
}

/** The page number a search URL asks for under `p` or `page`; 0 when absent or not a non-negative integer. */
function searchcodePage(url: URL): number {
	const pageRaw = url.searchParams.get("p") ?? url.searchParams.get("page");
	const pageNumber = pageRaw ? Number.parseInt(pageRaw, 10) : 0;
	return Number.isFinite(pageNumber) && pageNumber >= 0 ? pageNumber : 0;
}

/** One page of searchcode results for a query: the query's metadata, then the first hits. */
async function fetchSearchcodeSearch(query: string, url: URL, ctx: BusinessContext): Promise<string | ScraperDegrade> {
	const page = searchcodePage(url);
	const apiUrl = `https://searchcode.com/api/codesearch_I/?q=${encodeURIComponent(query)}&p=${page}`;
	const data = await loadJson<SearchcodeSearchResponse>(ctx, apiUrl, "searchcode");
	if (isScraperDegrade(data)) return data;
	if (!data) return ctx.scraperDegrade("searchcode", "unexpected response shape");
	const results = Array.isArray(data.results) ? data.results : [];
	const total = typeof data.total === "number" ? data.total : data.total_results;

	let md = `# Searchcode Results\n\n`;
	md += `## Description\n\n`;
	md += `Search results for \`${query}\` on searchcode.com.\n\n`;
	md += `## Metadata\n\n`;
	md += renderKeyValues([
		["Query", `\`${query}\``],
		["Page", page],
		["Total Results", typeof total === "number" ? formatNumber(total) : null],
		["Result Count", results.length],
		["Next Page", typeof data.nextpage === "number" ? data.nextpage : null],
	]);
	md += `\n## Results\n\n`;
	if (results.length === 0) return `${md}_No results found._\n`;
	md += results.slice(0, SEARCHCODE_RESULTS_SHOWN).map(renderSearchcodeHit).join("");
	if (results.length > SEARCHCODE_RESULTS_SHOWN) {
		md += `\n_Only showing first ${SEARCHCODE_RESULTS_SHOWN} results._\n`;
	}
	return md;
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
	fetch: (match, ctx) =>
		match.kind === "result"
			? fetchSearchcodeResult(match.id, ctx)
			: fetchSearchcodeSearch(match.query!, match.parsedUrl, ctx),
};

export const BUSINESS_DECLARATIONS = [
	coingeckoDeclaration,
	opencorporatesDeclaration,
	secEdgarDeclaration,
	searchcodeDeclaration,
];
