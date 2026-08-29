import { AsyncLocalStorage } from "node:async_hooks";
import type { Api, ApiKey, FetchImpl, Model } from "@veyyon/ai";

export interface MnemopiProviderTextSanitizer {
	(text: string): string;
	epoch?: string | number;
}

export type MnemopiLlmPayloadHook = (payload: unknown) => unknown | Promise<unknown>;

export interface MnemopiLlmCompleteOptions {
	maxTokens?: number;
	temperature?: number;
	timeout?: number;
	provider?: string | null;
	model?: string | null;
	fetch?: FetchImpl;
	onPayload?: MnemopiLlmPayloadHook;
}

export interface MnemopiLlmCompletion {
	(prompt: string, opts?: MnemopiLlmCompleteOptions): string | null | Promise<string | null>;
	online?: boolean;
	supportsAttemptPayload?: true;
}

export type EmbeddingOutput = AsyncIterable<number[][]>;

export interface MnemopiEmbeddingProvider {
	embed(texts: readonly string[]): EmbeddingOutput | Promise<EmbeddingOutput>;
	available?(): boolean | Promise<boolean>;
}

export interface MnemopiEmbeddingRuntimeOptions {
	disabled?: boolean;
	model?: string;
	apiUrl?: string;
	apiKey?: ApiKey;
	provider?: MnemopiEmbeddingProvider | ((texts: readonly string[]) => EmbeddingOutput | Promise<EmbeddingOutput>);
	maxInputChars?: number;
	sanitizeProviderText?: MnemopiProviderTextSanitizer;
}

export interface MnemopiLlmRuntimeOptions {
	enabled?: boolean;
	baseUrl?: string;
	apiKey?: ApiKey;
	model?: string | Model<Api>;
	maxTokens?: number;
	complete?: MnemopiLlmCompletion;
	extractionPrompt?: string;
	consolidationPrompt?: string;
	sanitizeProviderText?: MnemopiProviderTextSanitizer;
}

export interface ResolvedMnemopiEmbeddingRuntimeOptions {
	disabled?: boolean;
	model?: string;
	apiUrl?: string;
	apiKey?: ApiKey;
	provider?: MnemopiEmbeddingProvider;
	maxInputChars?: number;
	sanitizeProviderText?: MnemopiProviderTextSanitizer;
}

export interface ResolvedMnemopiLlmRuntimeOptions {
	enabled?: boolean;
	baseUrl?: string;
	apiKey?: ApiKey;
	model?: string | Model<Api>;
	maxTokens?: number;
	complete?: MnemopiLlmCompletion;
	extractionPrompt?: string;
	consolidationPrompt?: string;
	sanitizeProviderText?: MnemopiProviderTextSanitizer;
}

export interface ResolvedMnemopiRuntimeOptions {
	embeddings?: ResolvedMnemopiEmbeddingRuntimeOptions;
	llm?: ResolvedMnemopiLlmRuntimeOptions;
	debug?: boolean;
}

const runtimeOptionsStorage = new AsyncLocalStorage<ResolvedMnemopiRuntimeOptions | undefined>();

export function withMnemopiRuntimeOptions<T>(options: ResolvedMnemopiRuntimeOptions | undefined, fn: () => T): T {
	return runtimeOptionsStorage.run(options, fn);
}

export function getMnemopiRuntimeOptions(): ResolvedMnemopiRuntimeOptions | undefined {
	return runtimeOptionsStorage.getStore();
}

export function mnemopiDebugEnabled(): boolean {
	return runtimeOptionsStorage.getStore()?.debug === true;
}

export function resolveEmbeddingProvider(
	provider:
		| MnemopiEmbeddingProvider
		| ((texts: readonly string[]) => EmbeddingOutput | Promise<EmbeddingOutput>)
		| undefined,
): MnemopiEmbeddingProvider | undefined {
	if (provider === undefined) {
		return undefined;
	}
	if (typeof provider === "function") {
		return { embed: provider };
	}
	return provider;
}

export function isPiAiModel(value: unknown): value is Model<Api> {
	if (value === null || typeof value !== "object") {
		return false;
	}
	const maybe = value as Partial<Model<Api>>;
	return (
		typeof maybe.id === "string" &&
		typeof maybe.provider === "string" &&
		typeof maybe.baseUrl === "string" &&
		typeof maybe.api === "string"
	);
}
