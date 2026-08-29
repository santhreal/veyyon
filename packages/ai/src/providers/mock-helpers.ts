import type { Context, Model, SimpleStreamOptions, StopDetails, StopReason, Usage } from "../types";

export const MOCK_API = "mock" as const;
export type MockApi = typeof MOCK_API;

export type MockContent =
	| string
	| { type: "text"; text: string }
	| { type: "thinking"; thinking: string }
	| {
			type: "toolCall";
			id?: string;
			name: string;
			arguments: Record<string, unknown> | string;
	  };

export interface MockResponse {
	content?: ReadonlyArray<MockContent>;
	stopReason?: StopReason;
	stopDetails?: StopDetails | null;
	errorMessage?: string;
	usage?: Partial<Omit<Usage, "cost">> & { cost?: Partial<Usage["cost"]> };
	responseId?: string;
	throw?: string | Error;
	delayMs?: number;
	responseHeaders?: Readonly<Record<string, string>>;
	responseStatus?: number;
	responseRequestId?: string;
}

export type MockHandler =
	| MockResponse
	| ((context: Context, options?: SimpleStreamOptions) => MockResponse | Promise<MockResponse>);

export type MockResponseSource = Iterable<MockHandler> | AsyncIterable<MockHandler>;

export interface MockCall {
	readonly context: Context;
	readonly options?: SimpleStreamOptions;
}

export interface MockModelOptions {
	id?: string;
	provider?: string;
	responses?: MockResponseSource;
	handler?: MockHandler;
	cost?: Model["cost"];
	contextWindow?: number;
	maxTokens?: number;
	reasoning?: boolean;
}

export const ZERO_COST: Model["cost"] = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
};
