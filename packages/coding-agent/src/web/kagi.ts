/** Kagi API Client Implements the Kagi V1 Search API (POST /api/v1/search), the public-preview */
import type { AuthStorage, FetchImpl } from "@veyyon/ai";
import { withAuth } from "@veyyon/ai/auth-retry";
import {
	type ProviderTextTransformResolver,
	resolveProviderTextTransform,
	transformProviderPayload,
} from "../provider-boundary";
import { withHardTimeout } from "./search/providers/utils";

const KAGI_SEARCH_URL = "https://kagi.com/api/v1/search";

/** V1 search request body. */
export interface KagiSearchRequest {
	query: string;
	/** Workflow mode: "search" | "research". */
	workflow?: string;
	/** Number of results (1-100). */
	limit?: number;
	/** Lens identifier (e.g. "news", "reddit"). */
	lens?: string;
	/** Time-based filters as ISO date strings (YYYY-MM-DD). */
	filters?: {
		after?: string;
		before?: string;
	};
}

/** Individual V1 result item. */
export interface KagiSearchResultItem {
	url: string;
	title: string;
	snippet?: string;
	/** ISO timestamp or relative string ("2h ago"). */
	time?: string;
	/** Thumbnail image. */
	image?: { url: string; height?: number; width?: number };
	/** Extra metadata key-value pairs. */
	props?: Record<string, unknown>;
}

/** V1 categorizes results into named buckets; only consumed buckets are typed. */
export interface KagiSearchData {
	search?: KagiSearchResultItem[];
	video?: KagiSearchResultItem[];
	news?: KagiSearchResultItem[];
	infobox?: KagiSearchResultItem[];
	adjacent_question?: KagiSearchResultItem[];
	related_search?: KagiSearchResultItem[];
	direct_answer?: KagiSearchResultItem[];
}

/** V1 error entry. */
export interface KagiErrorEntry {
	code?: number;
	url?: string;
	message?: string;
	msg?: string;
	location?: string;
}

/** V1 success response. */
export interface KagiSearchResponse {
	meta?: {
		trace?: string;
		id?: string;
		ms?: number;
	};
	data?: KagiSearchData;
	error?: KagiErrorEntry[];
}

/** V1 error response. */
export interface KagiErrorResponse {
	meta?: Record<string, unknown>;
	error?: string | KagiErrorEntry[];
	message?: string;
	detail?: string;
}

export class KagiApiError extends Error {
	readonly statusCode?: number;
	/** The upstream error body, kept so the caller can classify a quota or credit message that Kagi reports in prose under a status code that carries no such meaning on its own. Capped because a */
	readonly body: string;

	constructor(message: string, statusCode?: number, body?: string) {
		super(message);
		this.name = "KagiApiError";
		this.statusCode = statusCode;
		this.body = (body ?? "").slice(0, KAGI_ERROR_BODY_LIMIT);
	}
}

const KAGI_ERROR_BODY_LIMIT = 8192;

function createKagiApiError(statusCode: number, body?: string): KagiApiError {
	return new KagiApiError(`Kagi API error (${statusCode})`, statusCode, body);
}

function parseKagiErrorResponse(statusCode: number, responseText: string): KagiApiError {
	return createKagiApiError(statusCode, responseText);
}

export interface KagiSearchOptions {
	limit?: number;
	recency?: "day" | "week" | "month" | "year";
	sessionId?: string;
	signal?: AbortSignal;
	fetch?: FetchImpl;
	resolveProviderTextTransform?: ProviderTextTransformResolver;
}

export interface KagiSearchSource {
	title: string;
	url: string;
	snippet?: string;
	publishedDate?: string;
}

export interface KagiSearchResult {
	requestId: string;
	sources: KagiSearchSource[];
	relatedQuestions: string[];
	answer?: string;
}

/** Compute a YYYY-MM-DD date string `recency` units before now, in UTC. UTC keeps the recency window deterministic regardless of host timezone and */
function recencyToDate(recency: "day" | "week" | "month" | "year"): string {
	const d = new Date();
	switch (recency) {
		case "day":
			d.setUTCDate(d.getUTCDate() - 1);
			break;
		case "week":
			d.setUTCDate(d.getUTCDate() - 7);
			break;
		case "month":
			d.setUTCMonth(d.getUTCMonth() - 1);
			break;
		case "year":
			d.setUTCFullYear(d.getUTCFullYear() - 1);
			break;
	}
	const yyyy = d.getUTCFullYear();
	const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
	const dd = String(d.getUTCDate()).padStart(2, "0");
	return `${yyyy}-${mm}-${dd}`;
}

function buildRequestBody(query: string, options: KagiSearchOptions): KagiSearchRequest {
	const req: KagiSearchRequest = {
		query,
		workflow: "search",
		limit: options.limit,
	};

	if (options.recency) {
		req.filters = { after: recencyToDate(options.recency) };
	}

	return req;
}

/** Push every item in a result bucket as a source, with an optional title tag. */
function collectSources(sources: KagiSearchSource[], items: KagiSearchResultItem[] | undefined, tag?: string): void {
	if (!items) return;
	for (const item of items) {
		sources.push({
			title: tag ? `${tag} ${item.title}` : item.title,
			url: item.url,
			snippet: item.snippet,
			publishedDate: item.time,
		});
	}
}

/** Pull a related/adjacent question from an item's props or fall back to title. */
function questionOf(item: KagiSearchResultItem): string | undefined {
	const q = item.props?.question ?? item.props?.query ?? item.title;
	return typeof q === "string" && q.length > 0 ? q : undefined;
}

export async function searchWithKagi(
	query: string,
	options: KagiSearchOptions = {},
	authStorage: AuthStorage,
): Promise<KagiSearchResult> {
	const fetchImpl = options.fetch ?? fetch;

	return withHardTimeout(options.signal, async hardSignal => {
		const response = await withAuth(
			authStorage.resolver("kagi", { sessionId: options.sessionId }),
			async apiKey => {
				const transform = resolveProviderTextTransform(options.resolveProviderTextTransform, "Kagi search request");
				const body = JSON.stringify(
					transformProviderPayload(buildRequestBody(query, options), transform, "Kagi search request"),
				);
				const res = await fetchImpl(KAGI_SEARCH_URL, {
					method: "POST",
					headers: {
						Authorization: `Bearer ${apiKey}`,
						"Content-Type": "application/json",
						Accept: "application/json",
					},
					body,
					signal: hardSignal,
				});

				if (!res.ok) {
					throw parseKagiErrorResponse(res.status, await res.text());
				}

				return res;
			},
			{
				signal: options.signal,
				missingKeyMessage: "Kagi credentials not found. Set KAGI_API_KEY or login with 'veyyon /login kagi'.",
			},
		);

		const payload = (await response.json()) as KagiSearchResponse;
		if (payload.error && payload.error.length > 0) {
			const first = payload.error[0];
			throw createKagiApiError(first.code ?? response.status);
		}

		const data = payload.data;
		const sources: KagiSearchSource[] = [];
		const relatedQuestions: string[] = [];

		collectSources(sources, data?.search);
		collectSources(sources, data?.video, "[Video]");
		collectSources(sources, data?.news, "[News]");
		collectSources(sources, data?.infobox, "[Info]");

		for (const item of data?.adjacent_question ?? []) {
			const q = questionOf(item);
			if (q) relatedQuestions.push(q);
		}
		for (const item of data?.related_search ?? []) {
			const q = questionOf(item);
			if (q) relatedQuestions.push(q);
		}

		const directAnswer = data?.direct_answer?.[0];
		const answer = directAnswer ? (directAnswer.snippet ?? directAnswer.title) : undefined;

		return {
			requestId: payload.meta?.trace ?? payload.meta?.id ?? "",
			sources,
			relatedQuestions,
			answer,
		};
	});
}
