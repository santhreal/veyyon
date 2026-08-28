import type { Effort } from "@veyyon/catalog/effort";
import type {
	AssistantMessage,
	AssistantMessageEventStream,
	CacheRetention,
	Context,
	ServiceTier,
	TokenTaskBudget,
} from "../types";

export const DEFAULT_AUTH_GATEWAY_BIND = "127.0.0.1:4000";

export type AuthGatewayToolChoice = "auto" | "none" | "required" | { name: string };

export interface AuthGatewayParsedRequestOptions {
	maxOutputTokens?: number;
	temperature?: number;
	topP?: number;
	topK?: number;
	minP?: number;
	stopSequences?: string[];
	presencePenalty?: number;
	frequencyPenalty?: number;
	repetitionPenalty?: number;
	seed?: number;
	logitBias?: Record<string, number>;
	responseFormat?: unknown;

	toolChoice?: AuthGatewayToolChoice;
	parallelToolCalls?: boolean;

	reasoning?: Effort;
	disableReasoning?: boolean;
	explicitThinkingBudgetTokens?: number;
	thinkingBudgets?: Partial<Record<Effort, number>>;
	hideThinkingSummary?: boolean;
	taskBudget?: TokenTaskBudget;

	serviceTier?: ServiceTier;
	cacheRetention?: CacheRetention;
	promptCacheKey?: string;
	previousResponseId?: string;
	user?: string;

	metadata?: Record<string, unknown>;
	headers?: Record<string, string>;
	extra?: Record<string, unknown>;
}

export interface AuthGatewayParsedRequest {
	modelId: string;
	context: Context;
	stream: boolean;
	options: AuthGatewayParsedRequestOptions;
}

export interface AuthGatewayStreamControl {
	signal?: AbortSignal;
	onCancel?: (reason?: unknown) => void;
}

export interface AuthGatewayFormatModule {
	parseRequest(body: unknown, headers?: Headers): AuthGatewayParsedRequest;
	encodeResponse(message: AssistantMessage, requestedModelId: string): Record<string, unknown>;
	encodeStream(
		events: AssistantMessageEventStream,
		requestedModelId: string,
		options?: AuthGatewayParsedRequestOptions,
		control?: AuthGatewayStreamControl,
	): ReadableStream<Uint8Array>;
	formatError(status: number, type: string, message: string): Response;
}

export interface AuthGatewayServerOptions {
	bind?: string;
	bearerTokens: string[];
	version?: string;
}

export interface AuthGatewayServerHandle {
	url: string;
	port: number;
	hostname: string;
	close(): Promise<void>;
}
