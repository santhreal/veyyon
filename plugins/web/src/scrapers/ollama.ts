import { formatBytes, tryParseJson } from "@veyyon/utils";
import type { RenderResult, ScraperDegrade, SpecialHandler } from "./types";
import { buildResult, decodeHtmlEntities, loadPage, scraperDegrade, tryParseUrl } from "./types";

interface OllamaTagDetails {
	parent_model?: string;
	format?: string;
	family?: string;
	families?: string[] | null;
	parameter_size?: string;
	quantization_level?: string;
}

interface OllamaTagModel {
	name?: string;
	model?: string;
	modified_at?: string;
	size?: number;
	digest?: string;
	details?: OllamaTagDetails;
}

interface OllamaTagsResponse {
	models?: OllamaTagModel[];
}

const VALID_HOSTNAMES = new Set(["ollama.com", "www.ollama.com"]);
const RESERVED_ROOTS = new Set([
	"models",
	"blog",
	"docs",
	"download",
	"cloud",
	"signin",
	"signout",
	"search",
	"api",
	"terms",
	"privacy",
	"license",
	"settings",
]);

function extractMetaDescription(html: string): string | null {
	const patterns = [
		/<meta[^>]+name=["']description["'][^>]*content=["']([^"']+)["']/i,
		/<meta[^>]+property=["']og:description["'][^>]*content=["']([^"']+)["']/i,
		/<meta[^>]+property=["']twitter:description["'][^>]*content=["']([^"']+)["']/i,
	];

	for (const pattern of patterns) {
		const match = html.match(pattern);
		if (match?.[1]) {
			return decodeHtmlEntities(match[1].trim());
		}
	}

	return null;
}

function extractParameterSizes(html: string): string[] {
	const sizes = new Set<string>();
	const pattern = /x-test-size[^>]*>([^<]+)<\/span>/gi;
	let match = pattern.exec(html);
	while (match) {
		const raw = match[1]?.trim();
		if (raw) {
			sizes.add(raw.toUpperCase());
		}
		match = pattern.exec(html);
	}

	return Array.from(sizes);
}

function extractTagsFromHtml(html: string, baseRef: string): string[] {
	const tags = new Set<string>();
	const pattern = /href=["']\/library\/([^"']+)["']/gi;
	let match = pattern.exec(html);
	while (match) {
		const raw = match[1]?.trim();
		if (raw) {
			const decoded = decodeHtmlEntities(raw);
			if (decoded === baseRef || decoded.startsWith(`${baseRef}:`)) {
				tags.add(decoded);
			}
		}
		match = pattern.exec(html);
	}

	return Array.from(tags);
}

function buildModelPath(parts: string[]): string {
	return parts.map(part => encodeURIComponent(part)).join("/");
}

interface OllamaModelRef {
	modelRef: string;
	baseRef: string;
	pageUrl: string;
}

function parseOllamaUrl(url: string): OllamaModelRef | null {
	try {
		const parsed = tryParseUrl(url);
		if (!parsed) return null;
		if (!VALID_HOSTNAMES.has(parsed.hostname)) return null;

		const parts = parsed.pathname.split("/").filter(Boolean);
		if (parts.length === 0) return null;

		if (parts[0] === "library" && parts.length >= 2) {
			const modelRef = decodeURIComponent(parts[1]);
			const baseRef = modelRef.split(":")[0] ?? modelRef;
			const pageUrl = `${parsed.origin}/${buildModelPath(["library", baseRef])}`;
			return { modelRef, baseRef, pageUrl };
		}

		if (parts.length >= 2 && !RESERVED_ROOTS.has(parts[0])) {
			const namespace = decodeURIComponent(parts[0]);
			const model = decodeURIComponent(parts[1]);
			const modelBase = model.split(":")[0] ?? model;
			const modelRef = `${namespace}/${model}`;
			const baseRef = `${namespace}/${modelBase}`;
			const pageUrl = `${parsed.origin}/${buildModelPath([namespace, modelBase])}`;
			return { modelRef, baseRef, pageUrl };
		}
	} catch {
		// `new URL` / `decodeURIComponent` on operator-supplied text: a malformed
		// URL is simply not an Ollama model link, which is the `null` below.
	}

	return null;
}

function sortTags(tags: string[]): string[] {
	return tags.sort((a, b) => {
		const aLatest = a.endsWith(":latest");
		const bLatest = b.endsWith(":latest");
		if (aLatest && !bLatest) return -1;
		if (!aLatest && bLatest) return 1;
		return a.localeCompare(b);
	});
}

function formatTagList(tags: string[], maxItems: number): string {
	const limited = tags.slice(0, maxItems);
	const formatted = limited.map(tag => `\`${tag}\``).join(", ");
	if (tags.length > maxItems) {
		return `${formatted} […${tags.length - maxItems} tags elided…]`;
	}
	return formatted;
}

function collectParameterSizes(models: OllamaTagModel[], htmlSizes: string[]): string[] {
	const sizes = new Set<string>();
	for (const model of models) {
		const param = model.details?.parameter_size?.trim();
		if (param) sizes.add(param.toUpperCase());
	}
	for (const size of htmlSizes) {
		sizes.add(size);
	}
	return Array.from(sizes);
}

interface OllamaModelFacts {
	baseRef: string;
	tagRef: string | null;
	description: string | null;
	parameterSizes: string[];
	sizeLine: string | null;
	tags: string[];
}

/** The requested tag's size, else the smallest-to-largest span across the model's tags. */
function ollamaSizeLine(
	selectedTag: OllamaTagModel | null | undefined,
	matchingModels: OllamaTagModel[],
): string | null {
	if (selectedTag?.size) return formatBytes(selectedTag.size);
	const sizes = matchingModels.map(model => model.size).filter((size): size is number => typeof size === "number");
	if (sizes.length === 0) return null;
	const minSize = Math.min(...sizes);
	const maxSize = Math.max(...sizes);
	return minSize === maxSize ? formatBytes(minSize) : `${formatBytes(minSize)} - ${formatBytes(maxSize)}`;
}

/**
 * What the tags API and the model page report for one model reference. `html` is empty when the page failed; the
 * page's tag links stand in for the API's tags only when the API lists none.
 */
function collectOllamaFacts(
	{ modelRef, baseRef }: OllamaModelRef,
	models: OllamaTagModel[],
	html: string,
): OllamaModelFacts {
	const htmlTags = html ? extractTagsFromHtml(html, baseRef) : [];
	const baseLower = baseRef.toLowerCase();
	const matchingModels = models.filter(model => {
		const name = (model.model ?? model.name ?? "").toLowerCase();
		return name === baseLower || name.startsWith(`${baseLower}:`);
	});

	const tagRef = modelRef.includes(":") ? modelRef : null;
	const selectedTag = tagRef ? matchingModels.find(model => (model.model ?? model.name ?? "") === tagRef) : null;
	const availableTags = matchingModels.map(model => model.model ?? model.name ?? "").filter(tag => tag.length > 0);
	const tags = availableTags.length > 0 ? availableTags : htmlTags;

	return {
		baseRef,
		tagRef,
		description: html ? extractMetaDescription(html) : null,
		parameterSizes: collectParameterSizes(
			selectedTag ? [selectedTag] : matchingModels,
			html ? extractParameterSizes(html) : [],
		),
		sizeLine: ollamaSizeLine(selectedTag, matchingModels),
		tags: sortTags(Array.from(new Set(tags))),
	};
}

function renderOllamaModel(facts: OllamaModelFacts): string {
	let md = `# ${facts.baseRef}\n\n`;
	if (facts.description) md += `${facts.description}\n\n`;

	md += `**Model:** ${facts.baseRef}\n`;
	if (facts.tagRef) md += `**Tag:** ${facts.tagRef}\n`;
	if (facts.parameterSizes.length > 0) md += `**Parameters:** ${facts.parameterSizes.join(", ")}\n`;
	if (facts.sizeLine) {
		const label = facts.sizeLine.includes(" - ") ? "Size Range" : "Size";
		md += `**${label}:** ${facts.sizeLine}\n`;
	}
	if (facts.tags.length > 0) md += `**Available Tags:** ${formatTagList(facts.tags, 40)}\n`;
	return md;
}

export const handleOllama: SpecialHandler = async (
	url: string,
	timeout: number,
	signal?: AbortSignal,
): Promise<RenderResult | ScraperDegrade | null> => {
	try {
		const parsed = parseOllamaUrl(url);
		if (!parsed) return null;
		const fetchedAt = new Date().toISOString();

		const [tagsResult, pageResult] = await Promise.all([
			loadPage("https://ollama.com/api/tags", { timeout, signal, headers: { Accept: "application/json" } }),
			loadPage(parsed.pageUrl, { timeout, signal }),
		]);
		const tagsData = tagsResult.ok ? tryParseJson<OllamaTagsResponse>(tagsResult.content) : null;
		const html = pageResult.ok ? pageResult.content : "";
		const md = renderOllamaModel(collectOllamaFacts(parsed, tagsData?.models ?? [], html));

		return buildResult(md, {
			url,
			finalUrl: pageResult.ok ? pageResult.finalUrl : url,
			method: "ollama",
			fetchedAt,
			notes: ["Fetched via Ollama API"],
		});
	} catch (error) {
		return scraperDegrade("ollama", error);
	}
};
