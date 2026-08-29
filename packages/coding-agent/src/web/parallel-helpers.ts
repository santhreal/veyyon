import type { FetchImpl } from "@veyyon/ai";

export const PARALLEL_API_URL = "https://api.parallel.ai";
export const PARALLEL_SEARCH_URL = `${PARALLEL_API_URL}/v1beta/search`;
export const PARALLEL_EXTRACT_URL = `${PARALLEL_API_URL}/v1beta/extract`;
export const PARALLEL_BETA_HEADER = "search-extract-2025-10-10";

export interface ParallelUsageItem {
	name?: string;
	count?: number;
}

export interface ParallelSearchSource {
	title: string;
	url: string;
	snippet?: string;
	publishedDate?: string;
	excerpts: string[];
}

export interface ParallelSearchResult {
	requestId: string;
	sources: ParallelSearchSource[];
	warnings: string[];
	usage: ParallelUsageItem[];
}

export interface ParallelExtractDocument {
	url: string;
	title?: string;
	publishedDate?: string;
	excerpts: string[];
	fullContent?: string;
}

export interface ParallelExtractErrorEntry {
	url: string;
	errorType?: string;
	httpStatusCode?: number;
	content?: string;
}

export interface ParallelExtractResult {
	requestId: string;
	results: ParallelExtractDocument[];
	errors: ParallelExtractErrorEntry[];
	warnings: string[];
	usage: ParallelUsageItem[];
}

export interface ParallelSearchOptions {
	mode?: "fast" | "research";
	maxCharsPerResult?: number;
	signal?: AbortSignal;
	fetch?: FetchImpl;
}

export interface ParallelExtractOptions {
	objective?: string;
	searchQueries?: string[];
	excerpts?: boolean;
	fullContent?: boolean;
	signal?: AbortSignal;
	fetch?: FetchImpl;
}
