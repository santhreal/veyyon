import { tryParseJson } from "@veyyon/utils";
import type { LoadPageResult, ScraperDegrade, SpecialHandler } from "./types";
import {
	buildResult,
	formatNumber,
	isScraperDegrade,
	loadFailure,
	loadPage,
	scraperDegrade,
	tryParseUrl,
} from "./types";

interface HfModelData {
	modelId: string;
	pipeline_tag?: string;
	library_name?: string;
	tags?: string[];
	downloads?: number;
	likes?: number;
	private?: boolean;
	gated?: boolean | string;
	cardData?: {
		license?: string;
		language?: string | string[];
		datasets?: string[];
		metrics?: string[];
	};
}

interface HfDatasetData {
	id: string;
	tags?: string[];
	downloads?: number;
	likes?: number;
	private?: boolean;
	gated?: boolean | string;
	cardData?: {
		license?: string;
		language?: string | string[];
		task_categories?: string[];
		size_categories?: string[];
	};
	description?: string;
}

interface HfSpaceData {
	id: string;
	author?: string;
	title?: string;
	sdk?: string;
	tags?: string[];
	likes?: number;
	private?: boolean;
	cardData?: {
		license?: string;
		sdk?: string;
		app_file?: string;
	};
}

interface HfUserData {
	avatarUrl?: string;
	fullname?: string;
	user?: string;
	orgs?: Array<{ name: string }>;
	numModels?: number;
	numDatasets?: number;
	numSpaces?: number;
}

/** A Hub resource's API record with the README fetched beside it; `readme` is empty when absent or blank. */
interface HfResourcePage<T> {
	record: T;
	finalUrl: string;
	readme: string;
}

/**
 * Fetch a Hub resource's API record and its README together. The README gets a
 * shorter budget: it is optional, the record is not.
 */
async function loadHfResource<T>(
	apiUrl: string,
	readmeUrl: string,
	timeout: number,
	signal: AbortSignal | undefined,
): Promise<HfResourcePage<T> | ScraperDegrade> {
	const [apiResult, readmeResult] = await Promise.all([
		loadPage(apiUrl, { timeout, signal }),
		loadPage(readmeUrl, { timeout: Math.min(timeout, 5), signal }),
	]);

	if (!apiResult.ok) return scraperDegrade("huggingface", loadFailure(apiResult));

	const record = tryParseJson<T>(apiResult.content);
	if (!record) return scraperDegrade("huggingface", "unexpected response shape");

	return { record, finalUrl: apiResult.finalUrl, readme: readmeText(readmeResult) };
}

/** A README page's text, or empty when it failed to load or holds only whitespace. */
function readmeText(result: LoadPageResult): string {
	return result.ok && result.content.trim() ? result.content : "";
}

/** What a Hub URL path names; a single segment is a model or a user until the model API answers. */
type HfResourceType = "model" | "dataset" | "space" | "model_or_user";

/**
 * Parse Hugging Face URL and determine type
 */
function parseHuggingFaceUrl(url: string): {
	type: HfResourceType;
	id: string; // Full ID (org/name or just name)
} | null {
	const parsed = tryParseUrl(url);
	if (!parsed) return null;
	if (parsed.hostname !== "huggingface.co") return null;

	const parts = parsed.pathname.split("/").filter(Boolean);
	if (parts.length === 0) return null;

	// huggingface.co/datasets/{org}/{dataset} or huggingface.co/datasets/{dataset}
	if (parts[0] === "datasets" && parts.length >= 2) {
		const id = parts.slice(1).join("/");
		return { type: "dataset", id };
	}

	// huggingface.co/spaces/{org}/{space}
	if (parts[0] === "spaces" && parts.length >= 3) {
		return { type: "space", id: `${parts[1]}/${parts[2]}` };
	}

	// Skip non-resource paths
	const reservedPaths = ["docs", "blog", "pricing", "enterprise", "join", "login", "settings"];
	if (reservedPaths.includes(parts[0])) {
		return null;
	}

	// huggingface.co/{org}/{model} (two parts = definitely a model)
	if (parts.length >= 2) {
		return { type: "model", id: `${parts[0]}/${parts[1]}` };
	}

	// huggingface.co/{id} (single part = could be model or user, try model first)
	if (parts.length === 1) {
		return { type: "model_or_user", id: parts[0] };
	}

	return null;
}

export const handleHuggingFace: SpecialHandler = async (url: string, timeout: number, signal?: AbortSignal) => {
	const parsed = parseHuggingFaceUrl(url);
	if (!parsed) return null;

	const fetchedAt = new Date().toISOString();
	try {
		const page = await loadHfMarkdown(parsed.type, parsed.id, timeout, signal);
		if (isScraperDegrade(page)) return page;
		return buildResult(page.markdown, { url, finalUrl: page.finalUrl, method: "huggingface", fetchedAt, notes: [] });
	} catch (error) {
		return scraperDegrade("huggingface", error);
	}
};

/** A rendered Hub page and the API URL its record came from. */
interface HfMarkdown {
	markdown: string;
	finalUrl: string;
}

async function loadHfMarkdown(
	type: HfResourceType,
	id: string,
	timeout: number,
	signal: AbortSignal | undefined,
): Promise<HfMarkdown | ScraperDegrade> {
	switch (type) {
		case "model": {
			const page = await loadHfResource<HfModelData>(
				`https://huggingface.co/api/models/${id}`,
				`https://huggingface.co/${id}/raw/main/README.md`,
				timeout,
				signal,
			);
			return isScraperDegrade(page)
				? page
				: { markdown: renderHfModel(page.record, page.readme), finalUrl: page.finalUrl };
		}
		case "dataset": {
			const page = await loadHfResource<HfDatasetData>(
				`https://huggingface.co/api/datasets/${id}`,
				`https://huggingface.co/datasets/${id}/raw/main/README.md`,
				timeout,
				signal,
			);
			return isScraperDegrade(page)
				? page
				: { markdown: renderHfDataset(page.record, page.readme), finalUrl: page.finalUrl };
		}
		case "space": {
			const page = await loadHfResource<HfSpaceData>(
				`https://huggingface.co/api/spaces/${id}`,
				`https://huggingface.co/spaces/${id}/raw/main/README.md`,
				timeout,
				signal,
			);
			return isScraperDegrade(page)
				? page
				: { markdown: renderHfSpace(page.record, page.readme), finalUrl: page.finalUrl };
		}
		case "model_or_user":
			return loadHfModelOrUser(id, timeout, signal);
	}
}

/**
 * A single-segment path names a model or a user. The model API is tried
 * first, and its README is fetched only once the model record parses; any
 * other answer falls back to the user API.
 */
async function loadHfModelOrUser(
	id: string,
	timeout: number,
	signal: AbortSignal | undefined,
): Promise<HfMarkdown | ScraperDegrade> {
	const modelResult = await loadPage(`https://huggingface.co/api/models/${id}`, { timeout, signal });
	const model = modelResult.ok ? tryParseJson<HfModelData>(modelResult.content) : null;
	if (model) {
		const readmeResult = await loadPage(`https://huggingface.co/${id}/raw/main/README.md`, {
			timeout: Math.min(timeout, 5),
			signal,
		});
		return { markdown: renderHfModel(model, readmeText(readmeResult)), finalUrl: modelResult.finalUrl };
	}

	const userResult = await loadPage(`https://huggingface.co/api/users/${id}`, { timeout, signal });
	if (!userResult.ok) return scraperDegrade("huggingface", loadFailure(userResult));
	const user = tryParseJson<HfUserData>(userResult.content);
	if (!user) return scraperDegrade("huggingface", "unexpected response shape");
	const fields: HfField[] = [
		["Name", user.fullname],
		["Models", user.numModels],
		["Datasets", user.numDatasets],
		["Spaces", user.numSpaces],
		["Organizations", user.orgs?.map(org => org.name)],
	];
	return { markdown: hfHeader(user.user || id, undefined, fields), finalUrl: userResult.finalUrl };
}

function renderHfModel(model: HfModelData, readme: string): string {
	const card = model.cardData;
	const fields: HfField[] = [
		["Task", model.pipeline_tag],
		["Library", model.library_name],
		["Downloads", model.downloads],
		["Likes", model.likes],
		["Visibility", model.private ? "Private" : undefined],
		["Access", model.gated ? "Gated" : undefined],
		["License", card?.license],
		["Language", card?.language],
		["Datasets", card?.datasets],
		["Metrics", card?.metrics],
		["Tags", model.tags],
	];
	return hfHeader(model.modelId, undefined, fields) + (readme ? `## Model Card\n\n${readme}` : "");
}

function renderHfDataset(dataset: HfDatasetData, readme: string): string {
	const card = dataset.cardData;
	const fields: HfField[] = [
		["Downloads", dataset.downloads],
		["Likes", dataset.likes],
		["Visibility", dataset.private ? "Private" : undefined],
		["Access", dataset.gated ? "Gated" : undefined],
		["License", card?.license],
		["Language", card?.language],
		["Tasks", card?.task_categories],
		["Size", card?.size_categories],
		["Tags", dataset.tags],
	];
	return hfHeader(dataset.id, dataset.description, fields) + (readme ? `## Dataset Card\n\n${readme}` : "");
}

function renderHfSpace(space: HfSpaceData, readme: string): string {
	const card = space.cardData;
	const fields: HfField[] = [
		["Author", space.author],
		["SDK", space.sdk],
		["Likes", space.likes],
		["Visibility", space.private ? "Private" : undefined],
		["License", card?.license],
		["App File", card?.app_file],
		["Tags", space.tags],
	];
	return hfHeader(space.id, space.title, fields) + (readme ? `## Space Info\n\n${readme}` : "");
}

/** A record field rendered as one `**label:** value` line when it holds a value. */
type HfField = readonly [label: string, value: string | number | readonly string[] | undefined];

/**
 * `# title`, the lead paragraph when there is one, then one `**label:** value`
 * line per field that holds a value: a count formatted, a list comma-joined.
 * An empty string or list is skipped, and so is a `null`, which the untyped
 * API record can carry in any field.
 */
function hfHeader(title: string, lead: string | undefined, fields: readonly HfField[]): string {
	let md = `# ${title}\n\n`;
	if (lead) md += `${lead}\n\n`;
	for (const [label, value] of fields) {
		if (value == null || value === "") continue;
		if (typeof value === "number") md += `**${label}:** ${formatNumber(value)}\n`;
		else if (typeof value === "string") md += `**${label}:** ${value}\n`;
		else if (value.length > 0) md += `**${label}:** ${value.join(", ")}\n`;
	}
	return `${md}\n`;
}
