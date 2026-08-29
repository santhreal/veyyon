export const KAGI_SEARCH_URL = "https://kagi.com/api/v1/search";

export interface KagiSearchRequest {
	query: string;
	workflow?: string;
	limit?: number;
	lens?: string;
	filters?: {
		after?: string;
		before?: string;
	};
}

export interface KagiSearchResultItem {
	url: string;
	title: string;
	snippet?: string;
	time?: string;
	image?: { url: string; height?: number; width?: number };
	props?: Record<string, unknown>;
}

export interface KagiSearchData {
	search?: KagiSearchResultItem[];
	video?: KagiSearchResultItem[];
	news?: KagiSearchResultItem[];
	infobox?: KagiSearchResultItem[];
	adjacent_question?: KagiSearchResultItem[];
	related_search?: KagiSearchResultItem[];
	direct_answer?: KagiSearchResultItem[];
}

export interface KagiErrorEntry {
	code?: number;
	url?: string;
	message?: string;
	msg?: string;
	location?: string;
}

export interface KagiSearchResponse {
	meta?: {
		trace?: string;
		id?: string;
		ms?: number;
	};
	data?: KagiSearchData;
	error?: KagiErrorEntry[];
}
