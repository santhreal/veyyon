/**
 * Lazy provider module loading.
 *
 * Each provider module is loaded only when its stream function is first called.
 * This avoids eagerly importing heavy SDK dependencies (e.g., openai) at
 * startup. The loaded module promise is cached so subsequent calls
 * reuse the same import.
 *
 * The main streaming path imports the lightweight wrappers below. Each wrapper
 * defers its provider SDK import until the corresponding API is selected, then
 * applies the shared first-event and idle watchdogs while forwarding events.
 */

import { emptyUsage } from "@veyyon/catalog/models";
import { errorMessage } from "@veyyon/utils/type-guards";
import * as AIError from "../error";
import type {
	Api,
	AssistantMessage,
	AssistantMessageEvent,
	AssistantMessageEventStream,
	Context,
	Model,
	OptionsForApi,
} from "../types";
import { type AbortSourceTracker, createAbortSourceTracker } from "../utils/abort";
import { AssistantMessageEventStream as EventStreamImpl } from "../utils/event-stream";
import {
	getOpenAIStreamFirstEventTimeoutMs,
	getOpenAIStreamIdleTimeoutMs,
	getStreamFirstEventTimeoutMs,
	getStreamIdleTimeoutMs,
	iterateWithIdleTimeout,
} from "../utils/idle-iterator";
import type { BedrockOptions } from "./amazon-bedrock";
import type { AnthropicOptions } from "./anthropic";
import type { AzureOpenAIResponsesOptions } from "./azure-openai-responses";
import type { CursorOptions } from "./cursor";
import type { DevinOptions } from "./devin";
import type { GoogleOptions } from "./google";
import type { GoogleGeminiCliOptions } from "./google-gemini-cli";
import type { GoogleVertexOptions } from "./google-vertex";
import type { OllamaChatOptions } from "./ollama";
import type { OpenAICodexResponsesOptions } from "./openai-codex-responses";
import type { OpenAICompletionsOptions } from "./openai-completions";
import type { OpenAIResponsesOptions } from "./openai-responses";

// ---------------------------------------------------------------------------
// Lazy provider module shape
// ---------------------------------------------------------------------------

interface LazyProviderModule<TApi extends Api> {
	stream: (model: Model<TApi>, context: Context, options: OptionsForApi<TApi>) => AsyncIterable<AssistantMessageEvent>;
}

export interface AnthropicProviderModule {
	streamAnthropic: (
		model: Model<"anthropic-messages">,
		context: Context,
		options: AnthropicOptions,
	) => AssistantMessageEventStream;
}

export interface AzureOpenAIResponsesProviderModule {
	streamAzureOpenAIResponses: (
		model: Model<"azure-openai-responses">,
		context: Context,
		options: AzureOpenAIResponsesOptions,
	) => AssistantMessageEventStream;
}

export interface GoogleProviderModule {
	streamGoogle: (
		model: Model<"google-generative-ai">,
		context: Context,
		options: GoogleOptions,
	) => AssistantMessageEventStream;
}

export interface GoogleGeminiCliProviderModule {
	streamGoogleGeminiCli: (
		model: Model<"google-gemini-cli">,
		context: Context,
		options: GoogleGeminiCliOptions,
	) => AssistantMessageEventStream;
}

export interface GoogleVertexProviderModule {
	streamGoogleVertex: (
		model: Model<"google-vertex">,
		context: Context,
		options: GoogleVertexOptions,
	) => AssistantMessageEventStream;
}

export interface OpenAICodexResponsesProviderModule {
	streamOpenAICodexResponses: (
		model: Model<"openai-codex-responses">,
		context: Context,
		options: OpenAICodexResponsesOptions,
	) => AssistantMessageEventStream;
}

export interface OpenAICompletionsProviderModule {
	streamOpenAICompletions: (
		model: Model<"openai-completions">,
		context: Context,
		options: OpenAICompletionsOptions,
	) => AssistantMessageEventStream;
}

export interface OpenAIResponsesProviderModule {
	streamOpenAIResponses: (
		model: Model<"openai-responses">,
		context: Context,
		options: OpenAIResponsesOptions,
	) => AssistantMessageEventStream;
}

export interface OllamaProviderModule {
	streamOllama: (
		model: Model<"ollama-chat">,
		context: Context,
		options: OllamaChatOptions,
	) => AssistantMessageEventStream;
}

export interface CursorProviderModule {
	streamCursor: (
		model: Model<"cursor-agent">,
		context: Context,
		options: CursorOptions,
	) => AssistantMessageEventStream;
}

export interface DevinProviderModule {
	streamDevin: (model: Model<"devin-agent">, context: Context, options: DevinOptions) => AssistantMessageEventStream;
}

export interface BedrockProviderModule {
	streamBedrock: (
		model: Model<"bedrock-converse-stream">,
		context: Context,
		options: BedrockOptions,
	) => AssistantMessageEventStream;
}

// ---------------------------------------------------------------------------
// Module-level lazy promise caches
// ---------------------------------------------------------------------------

let anthropicProviderModulePromise: Promise<LazyProviderModule<"anthropic-messages">> | undefined;
let anthropicProviderModuleOverride: LazyProviderModule<"anthropic-messages"> | undefined;
let azureOpenAIResponsesProviderModulePromise: Promise<LazyProviderModule<"azure-openai-responses">> | undefined;
let azureOpenAIResponsesProviderModuleOverride: LazyProviderModule<"azure-openai-responses"> | undefined;
let googleProviderModulePromise: Promise<LazyProviderModule<"google-generative-ai">> | undefined;
let googleProviderModuleOverride: LazyProviderModule<"google-generative-ai"> | undefined;
let googleGeminiCliProviderModulePromise: Promise<LazyProviderModule<"google-gemini-cli">> | undefined;
let googleGeminiCliProviderModuleOverride: LazyProviderModule<"google-gemini-cli"> | undefined;
let googleVertexProviderModulePromise: Promise<LazyProviderModule<"google-vertex">> | undefined;
let googleVertexProviderModuleOverride: LazyProviderModule<"google-vertex"> | undefined;
let openAICodexResponsesProviderModulePromise: Promise<LazyProviderModule<"openai-codex-responses">> | undefined;
let openAICodexResponsesProviderModuleOverride: LazyProviderModule<"openai-codex-responses"> | undefined;
let openAICompletionsProviderModulePromise: Promise<LazyProviderModule<"openai-completions">> | undefined;
let openAICompletionsProviderModuleOverride: LazyProviderModule<"openai-completions"> | undefined;
let openAIResponsesProviderModulePromise: Promise<LazyProviderModule<"openai-responses">> | undefined;
let openAIResponsesProviderModuleOverride: LazyProviderModule<"openai-responses"> | undefined;
let ollamaProviderModulePromise: Promise<LazyProviderModule<"ollama-chat">> | undefined;
let ollamaProviderModuleOverride: LazyProviderModule<"ollama-chat"> | undefined;
let cursorProviderModulePromise: Promise<LazyProviderModule<"cursor-agent">> | undefined;
let cursorProviderModuleOverride: LazyProviderModule<"cursor-agent"> | undefined;
let devinProviderModulePromise: Promise<LazyProviderModule<"devin-agent">> | undefined;
let devinProviderModuleOverride: LazyProviderModule<"devin-agent"> | undefined;
let bedrockProviderModuleOverride: LazyProviderModule<"bedrock-converse-stream"> | undefined;
let bedrockProviderModulePromise: Promise<LazyProviderModule<"bedrock-converse-stream">> | undefined;

export function setAnthropicProviderModule(module?: AnthropicProviderModule): void {
	anthropicProviderModuleOverride = module ? { stream: module.streamAnthropic } : undefined;
}

export function setAzureOpenAIResponsesProviderModule(module?: AzureOpenAIResponsesProviderModule): void {
	azureOpenAIResponsesProviderModuleOverride = module ? { stream: module.streamAzureOpenAIResponses } : undefined;
}

export function setGoogleProviderModule(module?: GoogleProviderModule): void {
	googleProviderModuleOverride = module ? { stream: module.streamGoogle } : undefined;
}

export function setGoogleGeminiCliProviderModule(module?: GoogleGeminiCliProviderModule): void {
	googleGeminiCliProviderModuleOverride = module ? { stream: module.streamGoogleGeminiCli } : undefined;
}

export function setGoogleVertexProviderModule(module?: GoogleVertexProviderModule): void {
	googleVertexProviderModuleOverride = module ? { stream: module.streamGoogleVertex } : undefined;
}

export function setOpenAICodexResponsesProviderModule(module?: OpenAICodexResponsesProviderModule): void {
	openAICodexResponsesProviderModuleOverride = module ? { stream: module.streamOpenAICodexResponses } : undefined;
}

export function setOpenAICompletionsProviderModule(module?: OpenAICompletionsProviderModule): void {
	openAICompletionsProviderModuleOverride = module ? { stream: module.streamOpenAICompletions } : undefined;
}

export function setOpenAIResponsesProviderModule(module?: OpenAIResponsesProviderModule): void {
	openAIResponsesProviderModuleOverride = module ? { stream: module.streamOpenAIResponses } : undefined;
}

export function setOllamaProviderModule(module?: OllamaProviderModule): void {
	ollamaProviderModuleOverride = module ? { stream: module.streamOllama } : undefined;
}

export function setDevinProviderModule(module?: DevinProviderModule): void {
	devinProviderModuleOverride = module ? { stream: module.streamDevin } : undefined;
}

export function setBedrockProviderModule(module?: BedrockProviderModule): void {
	bedrockProviderModuleOverride = module ? { stream: module.streamBedrock } : undefined;
}

export function setCursorProviderModule(module?: CursorProviderModule): void {
	cursorProviderModuleOverride = module ? { stream: module.streamCursor } : undefined;
}

// ---------------------------------------------------------------------------
// Stream forwarding / error helpers
// ---------------------------------------------------------------------------

const LAZY_STREAM_IDLE_TIMEOUT_ERROR = "Provider stream stalled while waiting for the next event";
const LAZY_STREAM_FIRST_EVENT_TIMEOUT_ERROR = "Provider stream timed out while waiting for the first event";

function hasFinalResult(
	source: AsyncIterable<AssistantMessageEvent>,
): source is AsyncIterable<AssistantMessageEvent> & { result(): Promise<AssistantMessage> } {
	return typeof (source as { result?: unknown }).result === "function";
}

/**
 * floor used when neither caller option nor env var pins a value. Generic env
 * vars (`VEYYON_STREAM_FIRST_EVENT_TIMEOUT_MS`, `VEYYON_STREAM_IDLE_TIMEOUT_MS`) still
 * take precedence unless a provider opts into OpenAI-family idle flooring for
 * local backends that users historically tuned with `VEYYON_OPENAI_STREAM_IDLE_TIMEOUT_MS`.
 */
export interface LazyStreamLimits {
	defaultFirstEventTimeoutMs?: number;
	defaultIdleTimeoutMs?: number;
	/**
	 * The provider implementation already wraps its upstream transport with
	 * stream timeouts. Keep the lazy loader from racing it with generic errors.
	 */
	providerHandlesStreamTimeouts?: boolean;
	/**
	 * Apply OpenAI-family idle timeout precedence in the lazy wrapper. Used by
	 * local backends whose users historically tune slow prompt-processing gaps
	 * with `VEYYON_OPENAI_STREAM_IDLE_TIMEOUT_MS`.
	 */
	openAIIdleEnvFloorsFirstEvent?: boolean;
}
/**
 * Cloud Code Assist (google-gemini-cli / google-antigravity) routinely takes
 * longer than the global 100s default to emit its first SSE event when serving
 * the heavier Gemini 3.x Pro tiers at high thinking levels. Bump the first-event
 * floor to five minutes so callers stop seeing spurious "stream timed out while
 * waiting for the first event" aborts on legitimate cold reasoning starts.
 * The steady-state idle watchdog stays on the global default since the upstream
 * emits thinking tokens frequently once it gets going.
 */
const GOOGLE_GEMINI_CLI_LAZY_STREAM_LIMITS: LazyStreamLimits = {
	defaultFirstEventTimeoutMs: 300_000,
};

const PROVIDER_HANDLED_STREAM_TIMEOUTS: LazyStreamLimits = {
	providerHandlesStreamTimeouts: true,
};

const OPENAI_IDLE_FLOORED_LAZY_STREAM_LIMITS: LazyStreamLimits = {
	openAIIdleEnvFloorsFirstEvent: true,
};

/**
 * Backends that run their OWN agent loop server-side (`cursor-agent`,
 * `devin-agent`).
 *
 * These were the only lazy providers left on the generic defaults, 100s to the
 * first event and 120s of silence thereafter, and both numbers are wrong for
 * what these backends do. A Cursor or Devin turn is not a token stream with an
 * occasional gap: the remote agent plans, edits files and runs commands on its
 * own side, emitting nothing to us while it does, and a single step of that
 * routinely outlasts two minutes. The watchdog then aborted a perfectly healthy
 * session with "Provider stream stalled while waiting for the next event",
 * which is exactly the report — the same models behave in their own harnesses,
 * because their own harnesses do not impose this budget.
 *
 * Every OpenAI-family and Anthropic provider is already exempt through
 * `providerHandlesStreamTimeouts`, because each owns a watchdog tuned to its
 * transport. Neither of these two owns one: `devin.ts` is a bare Connect frame
 * reader with no timeout of any kind, so exempting them outright would mean a
 * genuinely dead socket hangs forever. They get a budget instead, sized for an
 * agent rather than for a token stream.
 *
 * `VEYYON_STREAM_IDLE_TIMEOUT_MS` and `VEYYON_STREAM_FIRST_EVENT_TIMEOUT_MS`
 * still win, so anyone who wants the old aggression can ask for it.
 */
export const AGENTIC_BACKEND_LAZY_STREAM_LIMITS: LazyStreamLimits = {
	defaultFirstEventTimeoutMs: 300_000,
	defaultIdleTimeoutMs: 600_000,
};

/**
 * Resolve the watchdog budget a lazy provider stream runs under.
 *
 * Split out of {@link forwardStream} because it is the whole reason a provider
 * either survives a long quiet stretch or gets killed during one, and inside an
 * async IIFE it can only be observed by waiting out the real deadline. As a
 * function it can be asserted directly for every provider class.
 *
 * `undefined` idle means no idle watchdog; a `0` first-event budget means no
 * first-event watchdog. Both are what `providerHandlesStreamTimeouts` yields,
 * for providers that own a watchdog tuned to their own transport.
 */
export function resolveLazyStreamBudget(
	options: { streamIdleTimeoutMs?: number; streamFirstEventTimeoutMs?: number },
	limits?: LazyStreamLimits,
): { idleTimeoutMs: number | undefined; firstItemTimeoutMs: number | undefined } {
	if (limits?.providerHandlesStreamTimeouts === true) {
		return { idleTimeoutMs: undefined, firstItemTimeoutMs: 0 };
	}
	const idleTimeoutMs =
		options.streamIdleTimeoutMs ??
		(limits?.openAIIdleEnvFloorsFirstEvent
			? getOpenAIStreamIdleTimeoutMs(limits.defaultIdleTimeoutMs)
			: getStreamIdleTimeoutMs(limits?.defaultIdleTimeoutMs));
	const firstItemTimeoutMs =
		options.streamFirstEventTimeoutMs ??
		(limits?.openAIIdleEnvFloorsFirstEvent
			? getOpenAIStreamFirstEventTimeoutMs(idleTimeoutMs, limits.defaultFirstEventTimeoutMs)
			: getStreamFirstEventTimeoutMs(idleTimeoutMs, limits?.defaultFirstEventTimeoutMs));
	return { idleTimeoutMs, firstItemTimeoutMs };
}

function forwardStream<TApi extends Api>(
	target: EventStreamImpl,
	source: AsyncIterable<AssistantMessageEvent>,
	model: Model<TApi>,
	options: OptionsForApi<TApi>,
	abortTracker: AbortSourceTracker,
	limits?: LazyStreamLimits,
): void {
	(async () => {
		try {
			const { idleTimeoutMs, firstItemTimeoutMs } = resolveLazyStreamBudget(options, limits);
			// Providers with a server-driven local tool bridge (e.g. the Cursor
			// exec channel) mark their stream busy while a local tool runs; the
			// watchdog must not read that silence as a provider stall (#4593).
			const localWorkSource = source instanceof EventStreamImpl ? source : undefined;
			const watchedSource = iterateWithIdleTimeout(source, {
				idleTimeoutMs,
				firstItemTimeoutMs,
				errorMessage: LAZY_STREAM_IDLE_TIMEOUT_ERROR,
				firstItemErrorMessage: LAZY_STREAM_FIRST_EVENT_TIMEOUT_ERROR,
				onIdle: () => abortTracker.abortLocally(new AIError.StreamTimeoutError(LAZY_STREAM_IDLE_TIMEOUT_ERROR)),
				onFirstItemTimeout: () =>
					abortTracker.abortLocally(new AIError.StreamTimeoutError(LAZY_STREAM_FIRST_EVENT_TIMEOUT_ERROR)),
				abortSignal: options.signal,
				// The synthetic `start` event is yielded immediately by every provider before
				// the upstream model has emitted any tokens. Treating it as the first "real"
				// item would flip the watchdog from `firstItemTimeoutMs` to the much shorter
				// `idleTimeoutMs` while we're still legitimately waiting on the model's
				// first response (slow first-token from reasoning models, cold proxies, etc.).
				isProgressItem: event => (event as AssistantMessageEvent).type !== "start",
				hasPendingLocalWork: localWorkSource ? () => localWorkSource.hasPendingLocalWork : undefined,
			});

			for await (const event of watchedSource) {
				target.push(event);
			}
			if (hasFinalResult(source)) {
				target.end(await source.result());
			} else {
				target.end();
			}
		} catch (error) {
			const stopReason = abortTracker.wasCallerAbort() ? "aborted" : "error";
			const message = createLazyLoadErrorMessage(model, error, stopReason);
			target.push({ type: "error", reason: stopReason, error: message });
			target.end(message);
		}
	})();
}

function createLazyLoadErrorMessage<TApi extends Api>(
	model: Model<TApi>,
	error: unknown,
	stopReason: Extract<AssistantMessage["stopReason"], "aborted" | "error"> = "error",
): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: emptyUsage(),
		stopReason,
		errorMessage: stopReason === "aborted" ? "Request was aborted" : errorMessage(error),
		timestamp: Date.now(),
	};
}

// ---------------------------------------------------------------------------
// Generic lazy stream factory
// ---------------------------------------------------------------------------

function createLazyStream<TApi extends Api>(
	loadModule: () => Promise<LazyProviderModule<TApi>>,
	limits?: LazyStreamLimits,
): (model: Model<TApi>, context: Context, options: OptionsForApi<TApi>) => EventStreamImpl {
	return (model, context, options) => {
		const outer = new EventStreamImpl();
		const streamOptions = (options ?? {}) as OptionsForApi<TApi>;

		loadModule()
			.then(module => {
				const abortTracker = createAbortSourceTracker(streamOptions.signal);
				const providerOptions = { ...streamOptions, signal: abortTracker.requestSignal } as OptionsForApi<TApi>;
				const inner = module.stream(model, context, providerOptions);
				forwardStream(outer, inner, model, streamOptions, abortTracker, limits);
			})
			.catch(error => {
				const message = createLazyLoadErrorMessage(model, error);
				outer.push({ type: "error", reason: "error", error: message });
				outer.end(message);
			});

		return outer;
	};
}

// ---------------------------------------------------------------------------
// Module loaders (one per provider, cached via ||=)
// ---------------------------------------------------------------------------

function loadAnthropicProviderModule(): Promise<LazyProviderModule<"anthropic-messages">> {
	if (anthropicProviderModuleOverride) {
		return Promise.resolve(anthropicProviderModuleOverride);
	}
	anthropicProviderModulePromise ||= import("./anthropic").then(module => {
		const provider = module as AnthropicProviderModule;
		return { stream: provider.streamAnthropic };
	});
	return anthropicProviderModulePromise;
}

function loadAzureOpenAIResponsesProviderModule(): Promise<LazyProviderModule<"azure-openai-responses">> {
	if (azureOpenAIResponsesProviderModuleOverride) {
		return Promise.resolve(azureOpenAIResponsesProviderModuleOverride);
	}
	azureOpenAIResponsesProviderModulePromise ||= import("./azure-openai-responses").then(module => {
		const provider = module as AzureOpenAIResponsesProviderModule;
		return { stream: provider.streamAzureOpenAIResponses };
	});
	return azureOpenAIResponsesProviderModulePromise;
}

function loadGoogleProviderModule(): Promise<LazyProviderModule<"google-generative-ai">> {
	if (googleProviderModuleOverride) {
		return Promise.resolve(googleProviderModuleOverride);
	}
	googleProviderModulePromise ||= import("./google").then(module => {
		const provider = module as GoogleProviderModule;
		return { stream: provider.streamGoogle };
	});
	return googleProviderModulePromise;
}

function loadGoogleGeminiCliProviderModule(): Promise<LazyProviderModule<"google-gemini-cli">> {
	if (googleGeminiCliProviderModuleOverride) {
		return Promise.resolve(googleGeminiCliProviderModuleOverride);
	}
	googleGeminiCliProviderModulePromise ||= import("./google-gemini-cli").then(module => {
		const provider = module as GoogleGeminiCliProviderModule;
		return { stream: provider.streamGoogleGeminiCli };
	});
	return googleGeminiCliProviderModulePromise;
}

function loadGoogleVertexProviderModule(): Promise<LazyProviderModule<"google-vertex">> {
	if (googleVertexProviderModuleOverride) {
		return Promise.resolve(googleVertexProviderModuleOverride);
	}
	googleVertexProviderModulePromise ||= import("./google-vertex").then(module => {
		const provider = module as GoogleVertexProviderModule;
		return { stream: provider.streamGoogleVertex };
	});
	return googleVertexProviderModulePromise;
}

function loadOpenAICodexResponsesProviderModule(): Promise<LazyProviderModule<"openai-codex-responses">> {
	if (openAICodexResponsesProviderModuleOverride) {
		return Promise.resolve(openAICodexResponsesProviderModuleOverride);
	}
	openAICodexResponsesProviderModulePromise ||= import("./openai-codex-responses").then(module => {
		const provider = module as OpenAICodexResponsesProviderModule;
		return { stream: provider.streamOpenAICodexResponses };
	});
	return openAICodexResponsesProviderModulePromise;
}

function loadOpenAICompletionsProviderModule(): Promise<LazyProviderModule<"openai-completions">> {
	if (openAICompletionsProviderModuleOverride) {
		return Promise.resolve(openAICompletionsProviderModuleOverride);
	}
	openAICompletionsProviderModulePromise ||= import("./openai-completions").then(module => {
		const provider = module as OpenAICompletionsProviderModule;
		return { stream: provider.streamOpenAICompletions };
	});
	return openAICompletionsProviderModulePromise;
}

function loadOpenAIResponsesProviderModule(): Promise<LazyProviderModule<"openai-responses">> {
	if (openAIResponsesProviderModuleOverride) {
		return Promise.resolve(openAIResponsesProviderModuleOverride);
	}
	openAIResponsesProviderModulePromise ||= import("./openai-responses").then(module => {
		const provider = module as OpenAIResponsesProviderModule;
		return { stream: provider.streamOpenAIResponses };
	});
	return openAIResponsesProviderModulePromise;
}

function loadOllamaProviderModule(): Promise<LazyProviderModule<"ollama-chat">> {
	if (ollamaProviderModuleOverride) {
		return Promise.resolve(ollamaProviderModuleOverride);
	}
	ollamaProviderModulePromise ||= import("./ollama").then(module => {
		const provider = module as OllamaProviderModule;
		return { stream: provider.streamOllama };
	});
	return ollamaProviderModulePromise;
}

function loadCursorProviderModule(): Promise<LazyProviderModule<"cursor-agent">> {
	if (cursorProviderModuleOverride) {
		return Promise.resolve(cursorProviderModuleOverride);
	}
	cursorProviderModulePromise ||= import("./cursor").then(module => {
		const provider = module as CursorProviderModule;
		return { stream: provider.streamCursor };
	});
	return cursorProviderModulePromise;
}

function loadDevinProviderModule(): Promise<LazyProviderModule<"devin-agent">> {
	if (devinProviderModuleOverride) {
		return Promise.resolve(devinProviderModuleOverride);
	}
	devinProviderModulePromise ||= import("./devin").then(module => {
		const provider = module as DevinProviderModule;
		return { stream: provider.streamDevin };
	});
	return devinProviderModulePromise;
}

function loadBedrockProviderModule(): Promise<LazyProviderModule<"bedrock-converse-stream">> {
	if (bedrockProviderModuleOverride) {
		return Promise.resolve(bedrockProviderModuleOverride);
	}
	bedrockProviderModulePromise ||= import("./amazon-bedrock").then(module => {
		const provider = module as BedrockProviderModule;
		return { stream: provider.streamBedrock };
	});
	return bedrockProviderModulePromise;
}

// ---------------------------------------------------------------------------
// Lazy stream function exports
//
// These use the same names as the direct provider stream functions. When
// stream.ts is updated to import from this module instead of individual
// providers, the lazy loading will take effect on the main code path.
// ---------------------------------------------------------------------------

export const streamAnthropic = createLazyStream(loadAnthropicProviderModule, PROVIDER_HANDLED_STREAM_TIMEOUTS);
export const streamAzureOpenAIResponses = createLazyStream(
	loadAzureOpenAIResponsesProviderModule,
	PROVIDER_HANDLED_STREAM_TIMEOUTS,
);
export const streamGoogle = createLazyStream(loadGoogleProviderModule);
export const streamGoogleGeminiCli = createLazyStream(
	loadGoogleGeminiCliProviderModule,
	GOOGLE_GEMINI_CLI_LAZY_STREAM_LIMITS,
);
export const streamGoogleVertex = createLazyStream(loadGoogleVertexProviderModule);
export const streamOpenAICodexResponses = createLazyStream(
	loadOpenAICodexResponsesProviderModule,
	PROVIDER_HANDLED_STREAM_TIMEOUTS,
);
export const streamOpenAICompletions = createLazyStream(
	loadOpenAICompletionsProviderModule,
	PROVIDER_HANDLED_STREAM_TIMEOUTS,
);
export const streamOpenAIResponses = createLazyStream(
	loadOpenAIResponsesProviderModule,
	PROVIDER_HANDLED_STREAM_TIMEOUTS,
);
export const streamCursor = createLazyStream(loadCursorProviderModule, AGENTIC_BACKEND_LAZY_STREAM_LIMITS);
export const streamDevin = createLazyStream(loadDevinProviderModule, AGENTIC_BACKEND_LAZY_STREAM_LIMITS);
export const streamOllama = createLazyStream(loadOllamaProviderModule, OPENAI_IDLE_FLOORED_LAZY_STREAM_LIMITS);

export const streamBedrock = createLazyStream(loadBedrockProviderModule);
