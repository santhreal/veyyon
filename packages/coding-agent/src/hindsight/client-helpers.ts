export const USER_AGENT = "veyyon-coding-agent";
export const DEFAULT_USER_AGENT = USER_AGENT;

export type Budget = "low" | "mid" | "high" | string;
export type TagsMatch = "any" | "all" | "any_strict" | "all_strict";
export type UpdateMode = "replace" | "append";
export type ConsolidationState = "failed" | "pending" | "done";

export type HindsightProviderTextTransform = (text: string) => string;

export interface HindsightApiOptions {
	baseUrl: string;
	apiKey?: string;
	userAgent?: string;
	obfuscateProviderText?: HindsightProviderTextTransform;
	timeouts?: {
		request?: number;
		reflect?: number;
		recall?: number;
		retain?: number;
	};
}

export interface HindsightRequestOptions {
	signal?: AbortSignal;
}

export interface HindsightRecallResult {
	id?: string;
	text: string;
	type?: string | null;
	mentioned_at?: string | null;
	[key: string]: unknown;
}

export interface RecallResponse {
	results: HindsightRecallResult[];
	[key: string]: unknown;
}

export interface ReflectResponse {
	text?: string;
	[key: string]: unknown;
}

export interface RetainResponse {
	[key: string]: unknown;
}

export interface BankProfileResponse {
	[key: string]: unknown;
}

export interface ListMemoriesResponse {
	[key: string]: unknown;
}

export interface DocumentResponse {
	[key: string]: unknown;
}

export interface ListDocumentsResponse {
	[key: string]: unknown;
}

export interface MemoryItemInput {
	content: string;
	timestamp?: Date | string;
	context?: string;
	metadata?: Record<string, string>;
	documentId?: string;
	tags?: string[];
	observationScopes?: "per_tag" | "combined" | "all_combinations" | string[][];
	strategy?: string;
	updateMode?: UpdateMode;
}

export interface RetainOptions extends HindsightRequestOptions {
	timestamp?: Date | string;
	context?: string;
	metadata?: Record<string, string>;
	documentId?: string;
	async?: boolean;
	tags?: string[];
	updateMode?: UpdateMode;
}

export interface RetainBatchOptions extends HindsightRequestOptions {
	documentId?: string;
	documentTags?: string[];
	async?: boolean;
}

export interface RecallOptions extends HindsightRequestOptions {
	types?: string[];
	maxTokens?: number;
	budget?: Budget;
	tags?: string[];
	tagsMatch?: TagsMatch;
}

export interface ReflectOptions extends HindsightRequestOptions {
	context?: string;
	budget?: Budget;
	tags?: string[];
	tagsMatch?: TagsMatch;
}

export interface CreateBankOptions extends HindsightRequestOptions {
	reflectMission?: string;
	retainMission?: string;
}

export interface ListMemoriesOptions extends HindsightRequestOptions {
	limit?: number;
	offset?: number;
	type?: string;
	q?: string;
	consolidationState?: ConsolidationState;
}

export interface ListDocumentsOptions extends HindsightRequestOptions {
	limit?: number;
	offset?: number;
}

export interface UpdateDocumentOptions extends HindsightRequestOptions {
	tags?: string[];
}

export type MentalModelDetail = "metadata" | "content" | "full";
export type MentalModelMode = "full" | "delta";

export interface MentalModelTrigger {
	mode?: MentalModelMode;
	refresh_after_consolidation?: boolean;
}

export interface MentalModelSummary {
	id: string;
	bank_id: string;
	name: string;
	tags?: string[];
	last_refreshed_at?: string | null;
	created_at?: string | null;
	source_query?: string;
	content?: string;
	max_tokens?: number;
	trigger?: MentalModelTrigger;
	[key: string]: unknown;
}

export interface MentalModelListResponse {
	items: MentalModelSummary[];
	[key: string]: unknown;
}

export interface MentalModelHistoryEntry {
	previous_content: string | null;
	changed_at: string;
	[key: string]: unknown;
}

export interface CreateMentalModelOptions extends HindsightRequestOptions {
	id?: string;
	tags?: string[];
	maxTokens?: number;
	trigger?: MentalModelTrigger;
}

export interface CreateMentalModelResponse {
	operation_id?: string;
	[key: string]: unknown;
}

export interface RefreshMentalModelResponse {
	operation_id?: string;
	[key: string]: unknown;
}

export interface ListMentalModelsOptions extends HindsightRequestOptions {
	detail?: MentalModelDetail;
}

export interface GetMentalModelOptions extends HindsightRequestOptions {
	detail?: MentalModelDetail;
}
