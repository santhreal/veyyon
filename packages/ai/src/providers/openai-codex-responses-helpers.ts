import * as os from "node:os";
import {
	CODEX_BASE_URL,
	CODEX_CLIENT_VERSION,
	getCodexAccountId,
	OPENAI_HEADER_VALUES,
	OPENAI_HEADERS,
} from "@veyyon/catalog/wire/codex";
import { getInstallId } from "@veyyon/utils/dirs";
import { $env, $flag } from "@veyyon/utils/env";
import { errorMessage } from "@veyyon/utils/type-guards";
import { trimTrailingSlashes } from "@veyyon/utils/url";
import packageJson from "../../package.json" with { type: "json" };
import { type CacheTrackerState, createCacheTrackerState } from "../cache";
import { CodexProviderStreamError, CodexWebSocketTransportError } from "../error/classes";

import type {
	AssistantMessage,
	CodexCompactionContext,
	CodexCompactionRequestContext,
	Context,
	FetchImpl,
	Model,
	ProviderSessionState,
	RawSseEvent,
	ServiceTier,
	StreamOptions,
	TextContent,
	ThinkingContent,
	Tool,
	ToolCall,
	ToolChoice,
} from "../types";
import { kStreamingLastParseLen, kStreamingPartialJson } from "../utils/block-symbols";
import type { AssistantMessageEventStream } from "../utils/event-stream";
import type { FirstEventBudget } from "../utils/first-event-budget";

import type { RawHttpRequestDump } from "../utils/http-inspector";
import { redactDiagnosticHeaders } from "../utils/request-debug";
import { notifyRawSseEvent } from "../utils/sse-debug";
import {
	type CodexReasoningContext,
	type InputItem,
	type RequestBody,
	resolveCodexResponsesLite,
} from "./openai-codex/request-transformer";
import type {
	ResponseCustomToolCall,
	ResponseFunctionToolCall,
	ResponseInput,
	ResponseInputContent,
	ResponseOutputMessage,
	ResponseReasoningItem,
} from "./openai-responses-wire";
import {
	accumulateCustomToolCallInputDelta,
	accumulateToolCallArgumentsDelta,
	appendResponsesToolResultMessages,
	convertResponsesAssistantMessage,
	convertResponsesInputContent,
	createSequentialCutoffSummaryState,
	finalizeCustomToolCallInputDone,
	finalizeToolCallArgumentsDone,
	isOpenAIResponsesProgressEvent,
	normalizeOpenAIPromptCacheKey,
	resolveResponsesToolCallDeltaShape,
	type SequentialCutoffSummaryState,
	type ToolCallArgumentsDeltaShape,
} from "./openai-shared";

export interface OpenAICodexResponsesOptions extends StreamOptions {
	reasoning?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
	reasoningSummary?: "auto" | "concise" | "detailed" | null;
	reasoningContext?: CodexReasoningContext;
	textVerbosity?: "low" | "medium" | "high";
	include?: string[];
	codexMode?: boolean;
	toolChoice?: ToolChoice;
	preferWebsockets?: boolean;
	serviceTier?: ServiceTier;
	responsesLite?: boolean;
	clientMetadata?: Record<string, string>;
	onModerationMetadata?: (metadata: unknown) => void;
}

export interface OpenAICodexCompatibilityMetadataOptions {
	sessionId?: string;
	providerSessionState?: Map<string, ProviderSessionState>;
	requestKind: OpenAICodexRequestKind;
	compaction?: CodexCompactionRequestContext;
	startNewTurn?: boolean;
	turnStartedAtUnixMs?: number;
	clientMetadata?: Readonly<Record<string, string>>;
	includeInstallationHeader?: boolean;
}

export interface OpenAICodexCompatibilityMetadata {
	clientMetadata: Record<string, string>;
	headers: Record<string, string>;
}

export interface OpenAICodexCompactionResetOptions {
	providerSessionState?: Map<string, ProviderSessionState>;
	sessionId?: string;
	compaction: CodexCompactionContext;
}

export function createOpenAICodexCompactionRequestContext(options: {
	context: CodexCompactionContext | undefined;
	implementation: "responses" | "responses_compaction_v2" | "responses_compact";
}): CodexCompactionRequestContext | undefined {
	const context = options.context;
	if (!context) return undefined;
	return {
		operationId: context.operationId,
		trigger: context.trigger,
		reason: context.reason,
		implementation: options.implementation,
		phase: context.phase,
		strategy: context.strategy,
	};
}

export const CODEX_DEBUG = $flag("VEYYON_CODEX_DEBUG");
export const CODEX_MAX_RETRIES = 5;
export const CODEX_RETRY_DELAY_MS = 500;
export const CODEX_WEBSOCKET_CONNECT_TIMEOUT_MS = 10000;
export const CODEX_WEBSOCKET_PING_INTERVAL_MS = Number($env.VEYYON_CODEX_WEBSOCKET_PING_INTERVAL_MS || 10_000);
export const CODEX_WEBSOCKET_PONG_TIMEOUT_MS = Number($env.VEYYON_CODEX_WEBSOCKET_PONG_TIMEOUT_MS || 60_000);
export const CODEX_WEBSOCKET_MESSAGE_QUEUE_CAPACITY = Number(
	$env.VEYYON_CODEX_WEBSOCKET_MESSAGE_QUEUE_CAPACITY || 4096,
);
export const CODEX_WEBSOCKET_MAX_IDLE_REUSE_MS = Number($env.VEYYON_CODEX_WEBSOCKET_MAX_IDLE_REUSE_MS || 30_000);
export const CODEX_WEBSOCKET_IDLE_TIMEOUT_MS = Number($env.VEYYON_CODEX_WEBSOCKET_IDLE_TIMEOUT_MS || 300_000);
export const CODEX_WEBSOCKET_FIRST_EVENT_TIMEOUT_MS = Number(
	$env.VEYYON_CODEX_WEBSOCKET_FIRST_EVENT_TIMEOUT_MS || 60_000,
);
export const CODEX_WEBSOCKET_RETRY_BUDGET = Number($env.VEYYON_CODEX_WEBSOCKET_RETRY_BUDGET || CODEX_MAX_RETRIES);
export const CODEX_WEBSOCKET_RETRY_DELAY_MS = Number(
	$env.VEYYON_CODEX_WEBSOCKET_RETRY_DELAY_MS || CODEX_RETRY_DELAY_MS,
);
// Codes Codex sends for a retryable failure, checked against TRANSIENT_TRANSPORT_PATTERN.
export const CODEX_RETRYABLE_EVENT_CODES = new Set(["model_error", "server_error", "internal_error"]);
export const CODEX_PROVIDER_SESSION_STATE_KEY = "openai-codex-responses";
export const X_CODEX_TURN_STATE_HEADER = "x-codex-turn-state";
export const X_MODELS_ETAG_HEADER = "x-models-etag";
export const CODEX_WS_RESPONSES_LITE_CLIENT_METADATA_KEY = "ws_request_header_x_openai_internal_codex_responses_lite";
export const CODEX_MODERATION_METADATA_KEY = "openai_chatgpt_moderation_metadata";
export const CODEX_WEBSOCKET_FATAL_PATTERNS = [
	"websocket error:",
	"websocket closed before open",
	"connection timeout",
];
export const CODEX_RATE_LIMIT_BUDGET_MS = 5 * 60 * 1000;
export const CODEX_ADDITIONAL_PROGRESS_EVENT_TYPES = new Set(["response.done", "response.incomplete"]);
// Breaker for whitespace-only function call argument loops.
export const CODEX_WHITESPACE_TOOL_CALL_ARGUMENT_DELTA_EVENT_LIMIT = 256;
export const CODEX_WHITESPACE_TOOL_CALL_ARGUMENT_DELTA_CHAR_LIMIT = 16 * 1024;
export const CODEX_WHITESPACE_LOOP_RETRY_LIMIT = 2;
export const CODEX_WHITESPACE_LOOP_RETRY_DELAY_MS = 250;

export function isCodexStreamProgressEvent(event: unknown): boolean {
	if (isOpenAIResponsesProgressEvent(event)) return true;
	if (!event || typeof event !== "object") return false;
	const type = (event as { type?: unknown }).type;
	return typeof type === "string" && CODEX_ADDITIONAL_PROGRESS_EVENT_TYPES.has(type);
}

export function extractCodexFrameResponseId(frame: Record<string, unknown>): string | undefined {
	const response = (frame as { response?: { id?: unknown } }).response;
	const id = response?.id;
	return typeof id === "string" && id.length > 0 ? id : undefined;
}

export function extractCodexFrameSequenceNumber(frame: Record<string, unknown>): number | undefined {
	const raw = (frame as { sequence_number?: unknown }).sequence_number;
	return typeof raw === "number" && Number.isFinite(raw) ? Math.trunc(raw) : undefined;
}

export type CodexWebSocketTimeoutDetails = {
	lastEventAt: number;
	lastEventType?: string;
	lastProgressAt: number;
	lastProgressEventType?: string;
};

export function createCodexWebSocketTimeoutMessage(reason: string, details: CodexWebSocketTimeoutDetails): string {
	const now = Date.now();
	const lastEvent = details.lastEventType
		? `${details.lastEventType} ${Math.max(0, now - details.lastEventAt)}ms ago`
		: "none";
	const lastProgress = details.lastProgressEventType
		? `${details.lastProgressEventType} ${Math.max(0, now - details.lastProgressAt)}ms ago`
		: "none";
	return `${reason} (last event: ${lastEvent}; last progress: ${lastProgress})`;
}

export type CodexTransport = "sse" | "websocket";
export type CodexEventItem =
	| ResponseReasoningItem
	| ResponseOutputMessage
	| ResponseFunctionToolCall
	| ResponseCustomToolCall;
export type CodexOutputBlock =
	| ThinkingContent
	| TextContent
	| (ToolCall & { [kStreamingPartialJson]: string; [kStreamingLastParseLen]?: number });

export interface CodexResponseUsage {
	input_tokens?: number;
	output_tokens?: number;
	total_tokens?: number;
	prompt_cache_hit_tokens?: number;
	input_tokens_details?: {
		cached_tokens?: number;
		cache_write_tokens?: number;
		orchestration_input_tokens?: number;
		orchestration_input_cached_tokens?: number;
	};
	output_tokens_details?: {
		reasoning_tokens?: number;
		orchestration_output_tokens?: number;
	};
}

export interface OpenAICodexTurnRequestDiagnostics {
	transport: "sse" | "websocket";
	previousResponseIdPresent: boolean;
	inputItemCount: number;
	inputItemTypes: string[];
	firstInputItemType?: string;
	inputJsonBytes: number;
	promptCacheKey?: string;
	toolsHash?: string;
	optionsHash: string;
	canAppendBeforeRequest: boolean;
}

export interface OpenAICodexTurnUsageDiagnostics {
	rawInputTokens: number;
	rawCachedTokens: number;
	rawUncachedTokens: number;
	rawOutputTokens: number;
	rawTotalTokens?: number;
	rawOrchestrationInputTokens?: number;
	rawOrchestrationCachedTokens?: number;
	rawOrchestrationOutputTokens?: number;
	displayedInputTokens: number;
	displayedOutputTokens: number;
	displayedCacheReadTokens: number;
	displayedCacheWriteTokens: number;
	displayedTotalTokens: number;
	displayedOrchestrationInputTokens: number;
	displayedOrchestrationCacheReadTokens: number;
	displayedOrchestrationOutputTokens: number;
}

export interface OpenAICodexTurnDiagnostics {
	request: OpenAICodexTurnRequestDiagnostics;
	usage?: OpenAICodexTurnUsageDiagnostics;
}

export interface OpenAICodexWebSocketDebugStats {
	fullContextRequests: number;
	deltaRequests: number;
	lastInputItems: number;
	lastDeltaInputItems?: number;
	lastPreviousResponseId?: string;
	lastTurn?: OpenAICodexTurnDiagnostics;
}

export type CodexWebSocketSessionState = {
	disableWebsocket: boolean;
	lastRequest?: RequestBody;
	lastResponseId?: string;
	lastResponseItems?: InputItem[];
	canAppend: boolean;
	turnState?: string;
	modelsEtag?: string;
	connection?: CodexWebSocketConnection;
	lastTransport?: CodexTransport;
	fallbackCount: number;
	lastFallbackAt?: number;
	prewarmed: boolean;
	stats: OpenAICodexWebSocketDebugStats;
};

export interface CodexProviderSessionState extends ProviderSessionState {
	webSocketSessions: Map<string, CodexWebSocketSessionState>;
	webSocketPublicToPrivate: Map<string, string>;
	metadataSessions: Map<string, CodexMetadataSessionState>;
	cacheTracker: CacheTrackerState;
}

export type OpenAICodexRequestKind = "turn" | "prewarm" | "compaction";

export interface CodexMetadataSessionState {
	sessionId: string;
	threadId: string;
	windowId: string;
	turnId?: string;
	turnStartedAtUnixMs?: number;
	compactionOperationId?: string;
	reuseTurnForNextRequest?: boolean;
}

export interface CodexCompatibilityIdentity {
	installationId: string;
	sessionId: string;
	threadId: string;
	windowId: string;
	turnMetadataJson?: string;
}

export interface CodexRequestMetadata extends CodexCompatibilityIdentity {
	turnId: string;
	turnMetadataJson: string;
	clientMetadata: Record<string, string>;
}

export const CODEX_RESERVED_METADATA_KEYS: Record<string, true> = {
	installation_id: true,
	[OPENAI_HEADERS.INSTALLATION_ID]: true,
	session_id: true,
	thread_id: true,
	turn_id: true,
	window_id: true,
	[OPENAI_HEADERS.WINDOW_ID]: true,
	[OPENAI_HEADERS.TURN_METADATA]: true,
	[OPENAI_HEADERS.PARENT_THREAD_ID]: true,
	[OPENAI_HEADERS.SUBAGENT]: true,
	request_kind: true,
	compaction: true,
	turn_started_at_unix_ms: true,
	forked_from_thread_id: true,
	parent_thread_id: true,
	subagent_kind: true,
	thread_source: true,
	sandbox: true,
	workspaces: true,
};

export function createCodexMetadataSessionState(sessionId: string): CodexMetadataSessionState {
	return {
		sessionId,
		threadId: crypto.randomUUID(),
		windowId: crypto.randomUUID(),
	};
}

export function getOrCreateCodexMetadataSessionState(
	sessionId: string,
	providerState: CodexProviderSessionState | undefined,
): CodexMetadataSessionState {
	if (!providerState) return createCodexMetadataSessionState(sessionId);
	const existing = providerState.metadataSessions.get(sessionId);
	if (existing) return existing;
	const created = createCodexMetadataSessionState(sessionId);
	providerState.metadataSessions.set(sessionId, created);
	return created;
}

export function createCodexCompatibilityIdentity(session: CodexMetadataSessionState): CodexCompatibilityIdentity {
	return {
		installationId: getInstallId(),
		sessionId: session.sessionId,
		threadId: session.threadId,
		windowId: session.windowId,
	};
}

export function resolveCodexStartNewTurn(
	session: CodexMetadataSessionState,
	requestKind: OpenAICodexRequestKind,
	compaction: CodexCompactionRequestContext | undefined,
	override: boolean | undefined,
): boolean {
	if (requestKind !== "compaction") {
		if (requestKind === "turn") {
			const reuseCompactionTurn = session.reuseTurnForNextRequest === true;
			session.reuseTurnForNextRequest = false;
			session.compactionOperationId = undefined;
			if (reuseCompactionTurn) return false;
		}
		return override ?? requestKind === "turn";
	}
	if (!compaction) return override ?? false;
	const startsNewOperation = session.compactionOperationId !== compaction.operationId;
	if (startsNewOperation) session.reuseTurnForNextRequest = false;
	session.compactionOperationId = compaction.operationId;
	return override ?? (compaction.phase !== "mid_turn" && startsNewOperation);
}

export function toAsciiJsonString(value: Record<string, unknown>): string {
	return JSON.stringify(value).replace(
		/[\x7f-\uffff]/g,
		char => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`,
	);
}

export function createCodexRequestMetadata(
	session: CodexMetadataSessionState,
	requestKind: OpenAICodexRequestKind,
	options: {
		startNewTurn: boolean;
		turnStartedAtUnixMs?: number;
		clientMetadata?: Readonly<Record<string, string>>;
		compaction?: CodexCompactionRequestContext;
	},
): CodexRequestMetadata {
	if (options.startNewTurn || !session.turnId) {
		session.turnId = crypto.randomUUID();
		session.turnStartedAtUnixMs = options.turnStartedAtUnixMs;
	}
	const identity = createCodexCompatibilityIdentity(session);
	const extra: Record<string, string> = {};
	const callerMetadata = options.clientMetadata;
	if (callerMetadata) {
		for (const key in callerMetadata) {
			if (!Object.hasOwn(CODEX_RESERVED_METADATA_KEYS, key)) extra[key] = callerMetadata[key];
		}
	}
	const turnMetadata: Record<string, unknown> = {
		installation_id: identity.installationId,
		session_id: identity.sessionId,
		thread_id: identity.threadId,
		turn_id: session.turnId,
		window_id: identity.windowId,
		request_kind: requestKind,
	};
	if (options.compaction) {
		turnMetadata.compaction = {
			trigger: options.compaction.trigger,
			reason: options.compaction.reason,
			implementation: options.compaction.implementation,
			phase: options.compaction.phase,
			strategy: options.compaction.strategy,
		};
	}
	if (session.turnStartedAtUnixMs !== undefined) {
		turnMetadata.turn_started_at_unix_ms = session.turnStartedAtUnixMs;
	}
	for (const key in extra) turnMetadata[key] = extra[key];
	const turnMetadataJson = toAsciiJsonString(turnMetadata);
	return {
		...identity,
		turnId: session.turnId,
		turnMetadataJson,
		clientMetadata: {
			[OPENAI_HEADERS.INSTALLATION_ID]: identity.installationId,
			session_id: identity.sessionId,
			thread_id: identity.threadId,
			[OPENAI_HEADERS.WINDOW_ID]: identity.windowId,
			turn_id: session.turnId,
			[OPENAI_HEADERS.TURN_METADATA]: turnMetadataJson,
		},
	};
}

export function applyCodexCompatibilityHeaders(headers: Headers, metadata: CodexCompatibilityIdentity): void {
	headers.set(OPENAI_HEADERS.SCOPED_SESSION_ID, metadata.sessionId);
	headers.set(OPENAI_HEADERS.THREAD_ID, metadata.threadId);
	headers.set(OPENAI_HEADERS.WINDOW_ID, metadata.windowId);
	if (metadata.turnMetadataJson) {
		headers.set(OPENAI_HEADERS.TURN_METADATA, metadata.turnMetadataJson);
	} else {
		headers.delete(OPENAI_HEADERS.TURN_METADATA);
	}
}

export function createOpenAICodexCompatibilityMetadata(
	options: OpenAICodexCompatibilityMetadataOptions,
): OpenAICodexCompatibilityMetadata {
	const providerState = getCodexProviderSessionState(options.providerSessionState);
	const sessionId = normalizeOpenAIPromptCacheKey(options.sessionId) ?? crypto.randomUUID();
	const session = getOrCreateCodexMetadataSessionState(sessionId, providerState);
	const startNewTurn = resolveCodexStartNewTurn(
		session,
		options.requestKind,
		options.compaction,
		options.startNewTurn,
	);
	const metadata = createCodexRequestMetadata(session, options.requestKind, {
		startNewTurn,
		turnStartedAtUnixMs: options.turnStartedAtUnixMs ?? (startNewTurn || !session.turnId ? Date.now() : undefined),
		clientMetadata: options.clientMetadata,
		compaction: options.compaction,
	});
	const headers = new Headers();
	applyCodexCompatibilityHeaders(headers, metadata);
	if (options.includeInstallationHeader) {
		headers.set(OPENAI_HEADERS.INSTALLATION_ID, metadata.installationId);
	}
	return {
		clientMetadata: { ...metadata.clientMetadata },
		headers: Object.fromEntries(headers.entries()),
	};
}

export function createOpenAICodexDirectRequest(options: {
	model: Model<"openai-codex-responses">;
	accessToken: string;
	pathSuffix?: string;
	requestKind: OpenAICodexRequestKind;
	sessionId?: string;
	providerSessionState?: Map<string, ProviderSessionState>;
	compaction?: CodexCompactionRequestContext;
	responsesLite?: boolean;
}): { url: string; headers: Record<string, string>; clientMetadata: Record<string, string> } {
	const baseUrl = options.model.baseUrl || CODEX_BASE_URL;
	const identity = createOpenAICodexCompatibilityMetadata({
		sessionId: options.sessionId,
		providerSessionState: options.providerSessionState,
		requestKind: options.requestKind,
		compaction: options.compaction,
		includeInstallationHeader: true,
	});
	const responsesLite = resolveCodexResponsesLite(options.model, options.responsesLite);
	const headers = createCodexHeaders(
		options.model.headers,
		getCodexAccountId(options.accessToken),
		options.accessToken,
		CODEX_CLIENT_VERSION,
		normalizeOpenAIPromptCacheKey(options.sessionId),
		"sse",
		undefined,
		responsesLite,
	);
	for (const [name, value] of Object.entries(identity.headers)) headers.set(name, value);
	headers.set("accept", "application/json");
	headers.set("content-type", "application/json");
	return {
		url: `${resolveCodexResponsesUrl(baseUrl)}${options.pathSuffix ?? ""}`,
		headers: Object.fromEntries(headers.entries()),
		clientMetadata: identity.clientMetadata,
	};
}

export function resetOpenAICodexHistoryAfterCompaction(options: OpenAICodexCompactionResetOptions): void {
	const providerState = options.providerSessionState?.get(CODEX_PROVIDER_SESSION_STATE_KEY);
	if (!isCodexProviderSessionState(providerState)) return;
	for (const websocketState of providerState.webSocketSessions.values()) {
		resetCodexWebSocketAppendState(websocketState);
		if (options.compaction.phase !== "mid_turn") websocketState.turnState = undefined;
	}
	const sessionId = normalizeOpenAIPromptCacheKey(options.sessionId);
	if (!sessionId) return;
	const metadataSession = providerState.metadataSessions.get(sessionId);
	if (!metadataSession) return;
	metadataSession.windowId = crypto.randomUUID();
	metadataSession.compactionOperationId = undefined;
	metadataSession.reuseTurnForNextRequest = options.compaction.phase !== "standalone_turn";
}

export interface CodexRequestContext {
	apiKey: string;
	accountId?: string;
	baseUrl: string;
	url: string;
	requestHeaders: Record<string, string>;
	codexClientVersion: string;
	transportSessionId?: string;
	providerSessionState?: CodexProviderSessionState;
	isolatedTransportState?: CodexProviderSessionState;
	websocketState?: CodexWebSocketSessionState;
	responsesLite: boolean;
	requestMetadata?: CodexRequestMetadata;
	transformedBody: RequestBody;
	rawRequestDump: RawHttpRequestDump;
	wireBodyJson?: string;
}

export interface CodexRequestSetup {
	requestSignal: AbortSignal;
	wrapCodexSseStream: (source: AsyncGenerator<Record<string, unknown>>) => AsyncGenerator<Record<string, unknown>>;
	requestAbortController: AbortController;
	firstEventTimeoutMs: number | undefined;
	firstEventBudget: FirstEventBudget;
	websocketIdleTimeoutMs: number | undefined;
	websocketFirstEventTimeoutMs: number | undefined;
}

export interface CodexOpenItem {
	item: CodexEventItem;
	block: CodexOutputBlock | null;
	contentIndex: number;
	itemId?: string;
	outputIndex?: number;
}

export class CodexStreamRuntime {
	eventStream: AsyncGenerator<Record<string, unknown>>;
	requestBodyForState: RequestBody;
	transport: CodexTransport;
	websocketState?: CodexWebSocketSessionState;
	openItems = new Map<string, CodexOpenItem>();
	openItemsByOutputIndex = new Map<number, CodexOpenItem>();
	currentEntry: CodexOpenItem | null = null;
	currentItem: CodexEventItem | null = null;
	currentBlock: CodexOutputBlock | null = null;
	nativeOutputItems: Array<Record<string, unknown>> = [];
	cutoffSummaries: SequentialCutoffSummaryState = createSequentialCutoffSummaryState();
	pendingSummaryDeltas = new Map<CodexOpenItem, string[]>();
	websocketStreamRetries = 0;
	providerRetryAttempt = 0;
	sawTerminalEvent = false;
	canSafelyReplayWebsocketOverSse = true;
	whitespaceToolCallArgumentsDelta?: CodexWhitespaceToolCallArgumentsDeltaState;
	whitespaceLoopRetries = 0;

	constructor(initial: {
		eventStream: AsyncGenerator<Record<string, unknown>>;
		requestBodyForState: RequestBody;
		transport: CodexTransport;
		websocketState?: CodexWebSocketSessionState;
	}) {
		this.eventStream = initial.eventStream;
		this.requestBodyForState = initial.requestBodyForState;
		this.transport = initial.transport;
		this.websocketState = initial.websocketState;
	}

	resetAccumulators(): void {
		this.openItems.clear();
		this.openItemsByOutputIndex.clear();
		this.currentEntry = null;
		this.currentItem = null;
		this.currentBlock = null;
		this.nativeOutputItems.length = 0;
		this.pendingSummaryDeltas.clear();
		this.cutoffSummaries = createSequentialCutoffSummaryState();
	}

	openItemForEvent(rawEvent: Record<string, unknown>): CodexOpenItem | null {
		const itemId = typeof rawEvent.item_id === "string" ? rawEvent.item_id : "";
		if (itemId) return this.openItems.get(itemId) ?? null;
		const outputIndex =
			typeof rawEvent.output_index === "number" && Number.isFinite(rawEvent.output_index)
				? Math.trunc(rawEvent.output_index)
				: undefined;
		if (outputIndex !== undefined) return this.openItemsByOutputIndex.get(outputIndex) ?? null;
		return this.currentEntry;
	}
	queueSummaryDelta(entry: CodexOpenItem | null | undefined, delta: string): void {
		if (entry?.block?.type !== "thinking" || delta.length === 0) return;
		const pending = this.pendingSummaryDeltas.get(entry) ?? [];
		pending.push(delta);
		this.pendingSummaryDeltas.set(entry, pending);
	}

	takeSummaryDeltas(entry: CodexOpenItem | null | undefined): string[] {
		if (!entry) return [];
		const pending = this.pendingSummaryDeltas.get(entry) ?? [];
		this.pendingSummaryDeltas.delete(entry);
		return pending;
	}

	closeOpenItem(entry: CodexOpenItem | null | undefined): void {
		if (!entry) return;
		if (entry.itemId) this.openItems.delete(entry.itemId);
		if (entry.outputIndex !== undefined) this.openItemsByOutputIndex.delete(entry.outputIndex);
		if (this.currentEntry === entry) {
			this.currentEntry = null;
			this.currentItem = null;
			this.currentBlock = null;
		}
	}

	observeWhitespaceToolCallArgumentsDelta(
		rawEvent: Record<string, unknown>,
		delta: string,
	): CodexWhitespaceToolCallArgumentsDeltaInterruption | undefined {
		if (!isJsonWhitespaceOnly(delta)) {
			this.whitespaceToolCallArgumentsDelta = undefined;
			return undefined;
		}

		const itemId =
			typeof rawEvent.item_id === "string" && rawEvent.item_id.length > 0
				? rawEvent.item_id
				: (this.currentItem?.id ?? "");
		const outputIndex =
			typeof rawEvent.output_index === "number" && Number.isFinite(rawEvent.output_index)
				? Math.trunc(rawEvent.output_index)
				: undefined;
		const sequenceNumber =
			typeof rawEvent.sequence_number === "number" && Number.isFinite(rawEvent.sequence_number)
				? Math.trunc(rawEvent.sequence_number)
				: undefined;
		let state = this.whitespaceToolCallArgumentsDelta;
		if (!state || state.itemId !== itemId || state.outputIndex !== outputIndex) {
			state = {
				itemId,
				outputIndex,
				consecutiveEvents: 0,
				consecutiveChars: 0,
				firstSequenceNumber: sequenceNumber,
			};
			this.whitespaceToolCallArgumentsDelta = state;
		}

		state.consecutiveEvents += 1;
		state.consecutiveChars += delta.length;
		state.lastSequenceNumber = sequenceNumber;
		if (
			state.consecutiveEvents < CODEX_WHITESPACE_TOOL_CALL_ARGUMENT_DELTA_EVENT_LIMIT &&
			state.consecutiveChars < CODEX_WHITESPACE_TOOL_CALL_ARGUMENT_DELTA_CHAR_LIMIT
		) {
			return undefined;
		}

		const itemLabel = itemId ? ` for item ${itemId}` : "";
		const sequenceLabel =
			state.firstSequenceNumber === undefined || state.lastSequenceNumber === undefined
				? ""
				: `, sequence ${state.firstSequenceNumber}..${state.lastSequenceNumber}`;
		return {
			message: `Interrupted OpenAI Codex response after ${state.consecutiveEvents} consecutive whitespace-only tool-call argument delta events (${state.consecutiveChars} chars${sequenceLabel})${itemLabel}.`,
		};
	}

	handleToolCallArgumentsDelta(
		rawEvent: Record<string, unknown>,
		stream: AssistantMessageEventStream,
		output: AssistantMessage,
		shape?: ToolCallArgumentsDeltaShape,
	): CodexWhitespaceToolCallArgumentsDeltaInterruption | undefined {
		const delta = (rawEvent as { delta?: string }).delta || "";
		const interruption = this.observeWhitespaceToolCallArgumentsDelta(rawEvent, delta);
		if (interruption) return interruption;
		const entry = this.openItemForEvent(rawEvent);
		if (!entry) return undefined;
		if (entry.item.type !== "function_call" || entry.block?.type !== "toolCall") return undefined;
		accumulateToolCallArgumentsDelta(
			entry.block,
			delta,
			stream,
			output,
			entry.contentIndex,
			shape ?? resolveResponsesToolCallDeltaShape("openai-codex", "openai-codex-responses"),
		);
		return undefined;
	}

	handleToolCallArgumentsDone(rawEvent: Record<string, unknown>): void {
		const entry = this.openItemForEvent(rawEvent);
		if (entry?.item.type !== "function_call" || entry.block?.type !== "toolCall") return;
		const args = (rawEvent as { arguments?: string }).arguments;
		if (typeof args === "string") finalizeToolCallArgumentsDone(entry.block, args);
	}

	handleCustomToolCallInputDelta(
		rawEvent: Record<string, unknown>,
		stream: AssistantMessageEventStream,
		output: AssistantMessage,
	): CodexWhitespaceToolCallArgumentsDeltaInterruption | undefined {
		const delta = (rawEvent as { delta?: string }).delta || "";
		const interruption = this.observeWhitespaceToolCallArgumentsDelta(rawEvent, delta);
		if (interruption) return interruption;
		const entry = this.openItemForEvent(rawEvent);
		if (!entry) return undefined;
		if (entry.item.type !== "custom_tool_call" || entry.block?.type !== "toolCall") return undefined;
		accumulateCustomToolCallInputDelta(entry.block, delta, stream, output, entry.contentIndex);
		return undefined;
	}

	handleCustomToolCallInputDone(rawEvent: Record<string, unknown>): void {
		const entry = this.openItemForEvent(rawEvent);
		if (entry?.item.type !== "custom_tool_call" || entry.block?.type !== "toolCall") return;
		const input = (rawEvent as { input?: string }).input;
		if (typeof input === "string") finalizeCustomToolCallInputDone(entry.block, input);
	}

	handleResponseCreated(rawEvent: Record<string, unknown>): void {
		const response = (rawEvent as { response?: { id?: string } }).response;
		const state = this.websocketState;
		if (state && this.transport === "websocket" && typeof response?.id === "string" && response.id.length > 0) {
			state.lastResponseId = response.id;
		}
	}
}

export interface CodexWhitespaceToolCallArgumentsDeltaState {
	itemId: string;
	outputIndex?: number;
	consecutiveEvents: number;
	consecutiveChars: number;
	firstSequenceNumber?: number;
	lastSequenceNumber?: number;
}

export interface CodexWhitespaceToolCallArgumentsDeltaInterruption {
	message: string;
}

export interface CodexStreamFailureContext {
	model: Model<"openai-codex-responses">;
	output: AssistantMessage;
	options: OpenAICodexResponsesOptions | undefined;
	requestContext: CodexRequestContext;
	startTime: number;
	firstTokenTime?: number;
}

export interface CodexStreamCompletion {
	firstTokenTime?: number;
}

export function createCodexProviderSessionState(): CodexProviderSessionState {
	const state: CodexProviderSessionState = {
		webSocketSessions: new Map(),
		webSocketPublicToPrivate: new Map(),
		metadataSessions: new Map(),
		cacheTracker: createCacheTrackerState(),
		close: () => {
			for (const session of state.webSocketSessions.values()) {
				session.connection?.close("session_disposed");
			}
			state.webSocketSessions.clear();
			state.webSocketPublicToPrivate.clear();
			state.metadataSessions.clear();
			state.cacheTracker = createCacheTrackerState();
		},
	};
	return state;
}

export function isCodexProviderSessionState(
	state: ProviderSessionState | undefined,
): state is CodexProviderSessionState {
	return (
		state !== undefined &&
		"webSocketSessions" in state &&
		state.webSocketSessions instanceof Map &&
		"webSocketPublicToPrivate" in state &&
		state.webSocketPublicToPrivate instanceof Map &&
		"metadataSessions" in state &&
		state.metadataSessions instanceof Map
	);
}

export function getCodexProviderSessionState(
	providerSessionState: Map<string, ProviderSessionState> | undefined,
): CodexProviderSessionState | undefined {
	if (!providerSessionState) return undefined;
	const existing = providerSessionState.get(CODEX_PROVIDER_SESSION_STATE_KEY);
	if (isCodexProviderSessionState(existing)) return existing;
	const created = createCodexProviderSessionState();
	providerSessionState.set(CODEX_PROVIDER_SESSION_STATE_KEY, created);
	return created;
}

export function isCodexWebSocketRetryableStreamError(error: unknown): boolean {
	if (!(error instanceof CodexWebSocketTransportError)) return false;
	const message = error.message.toLowerCase();
	return (
		message.includes("websocket closed (") ||
		message.includes("websocket closed before response completion") ||
		message.includes("websocket connection is unavailable") ||
		message.includes("websocket send failed") ||
		message.includes("websocket ping failed") ||
		message.includes("websocket pong timeout") ||
		message.includes("websocket message queue exceeded") ||
		message.includes("websocket request already in progress") ||
		message.includes("idle timeout waiting for websocket") ||
		message.includes("timeout waiting for first websocket event") ||
		message.includes("syntaxerror") ||
		message.includes("json")
	);
}
export function toCodexHeaderRecord(value: unknown): Record<string, string> | null {
	if (!value || typeof value !== "object") return null;
	const headers: Record<string, string> = {};
	for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
		if (typeof entry === "string") {
			headers[key] = entry;
		} else if (Array.isArray(entry) && entry.every(item => typeof item === "string")) {
			headers[key] = entry.join(",");
		} else if (typeof entry === "number" || typeof entry === "boolean") {
			headers[key] = String(entry);
		}
	}
	return Object.keys(headers).length > 0 ? headers : null;
}

export function toCodexHeaders(value: unknown): Headers | undefined {
	if (!value) return undefined;
	if (value instanceof Headers) return value;
	if (Array.isArray(value)) {
		try {
			return new Headers(value as Array<[string, string]>);
		} catch {
			return undefined;
		}
	}
	const record = toCodexHeaderRecord(value);
	if (!record) return undefined;
	return new Headers(record);
}

export function updateCodexSessionMetadataFromHeaders(
	state: CodexWebSocketSessionState | undefined,
	headers: Headers | Record<string, string> | null | undefined,
): void {
	if (!state || !headers) return;
	const resolvedHeaders = headers instanceof Headers ? headers : new Headers(headers);
	const turnState = resolvedHeaders.get(X_CODEX_TURN_STATE_HEADER);
	if (turnState && turnState.length > 0) {
		state.turnState = turnState;
	}
	const modelsEtag = resolvedHeaders.get(X_MODELS_ETAG_HEADER);
	if (modelsEtag && modelsEtag.length > 0) {
		state.modelsEtag = modelsEtag;
	}
}

export function extractCodexWebSocketHandshakeHeaders(socket: Bun.WebSocket, openEvent?: Event): Headers | undefined {
	const eventRecord = openEvent as Record<string, unknown> | undefined;
	const eventResponse = eventRecord?.response as Record<string, unknown> | undefined;
	const socketRecord = socket as unknown as Record<string, unknown>;
	const socketResponse = socketRecord.response as Record<string, unknown> | undefined;
	const socketHandshake = socketRecord.handshake as Record<string, unknown> | undefined;
	return (
		toCodexHeaders(eventRecord?.responseHeaders) ??
		toCodexHeaders(eventRecord?.headers) ??
		toCodexHeaders(eventResponse?.headers) ??
		toCodexHeaders(socketRecord.responseHeaders) ??
		toCodexHeaders(socketRecord.handshakeHeaders) ??
		toCodexHeaders(socketResponse?.headers) ??
		toCodexHeaders(socketHandshake?.headers)
	);
}

export function notifyCodexWebSocketInbound(
	observer: ((event: RawSseEvent) => void) | undefined,
	parsed: Record<string, unknown>,
	text: string,
): void {
	const type = typeof parsed.type === "string" ? parsed.type : null;
	const raw: string[] = [`: ws ← ${type ?? "(untyped)"}`];
	if (type) raw.push(`event: ${type}`);
	raw.push(`data: ${text}`);
	notifyRawSseEvent(observer, { event: type, data: text, raw });
}

export function notifyCodexWebSocketOutbound(
	observer: ((event: RawSseEvent) => void) | undefined,
	request: Record<string, unknown>,
	payload: string,
): void {
	const type = typeof request.type === "string" ? request.type : null;
	const raw: string[] = [`: ws → ${type ?? "(untyped)"}`];
	if (type) raw.push(`event: ${type}`);
	raw.push(`data: ${payload}`);
	notifyRawSseEvent(observer, { event: type, data: payload, raw });
}

export function notifyCodexWebSocketMalformed(
	observer: ((event: RawSseEvent) => void) | undefined,
	data: unknown,
	error: unknown,
): void {
	const text = typeof data === "string" ? data : "";
	const reason = errorMessage(error);
	const raw: string[] = [`: ws ← (parse-error: ${reason})`];
	if (text) raw.push(`data: ${text}`);
	notifyRawSseEvent(observer, { event: "parse_error", data: text, raw });
}

export function normalizeCodexToolChoice(
	choice: ToolChoice | undefined,
	tools: Tool[] = [],
	model?: Model<"openai-codex-responses">,
): string | Record<string, unknown> | undefined {
	if (!choice) return undefined;
	if (typeof choice === "string") return choice;
	const allowFreeform = model ? model.applyPatchToolType === "freeform" : false;
	const mapName = (name: string): Record<string, string> | undefined => {
		const directTool = tools.find(tool => tool.name === name);
		const customTool = allowFreeform
			? tools.find(tool => tool.customFormat && (tool.name === name || tool.customWireName === name))
			: undefined;
		const offeredTool = customTool ?? directTool;
		if (!offeredTool) return undefined;
		return customTool
			? { type: "custom", name: customTool.customWireName ?? customTool.name }
			: { type: "function", name: offeredTool.name };
	};
	if (choice.type === "function") {
		if ("function" in choice && choice.function?.name) {
			return mapName(choice.function.name);
		}
		if ("name" in choice && choice.name) {
			return mapName(choice.name);
		}
	}
	if (choice.type === "tool" && choice.name) {
		return mapName(choice.name);
	}
	return undefined;
}

export function getCodexServiceTierCostMultiplier(
	model: Pick<Model<"openai-codex-responses">, "id">,
	serviceTier: ServiceTier | "default" | undefined,
): number {
	switch (serviceTier) {
		case "flex":
			return 0.5;
		case "priority":
			return model.id === "gpt-5.5" ? 2.5 : 2;
		default:
			return 1;
	}
}

export function isJsonWhitespaceOnly(value: string): boolean {
	for (let index = 0; index < value.length; index += 1) {
		const code = value.charCodeAt(index);
		if (code !== 0x09 && code !== 0x0a && code !== 0x0d && code !== 0x20) {
			return false;
		}
	}
	return true;
}

export function resetCodexWebSocketAppendState(state: CodexWebSocketSessionState): void {
	state.canAppend = false;
	state.lastRequest = undefined;
	state.lastResponseId = undefined;
	state.lastResponseItems = undefined;
}

export function createCodexHeaders(
	initHeaders: Record<string, string> | undefined,
	accountId: string | undefined,
	accessToken: string,
	codexClientVersion: string,
	sessionId?: string,
	transport: CodexTransport = "sse",
	state?: CodexWebSocketSessionState,
	responsesLite = false,
	requestMetadata?: CodexCompatibilityIdentity,
): Headers {
	const headers = new Headers(initHeaders ?? {});
	headers.delete("x-api-key");
	headers.set("Authorization", `Bearer ${accessToken}`);
	if (accountId) headers.set(OPENAI_HEADERS.ACCOUNT_ID, accountId);
	const betaHeader =
		transport === "websocket"
			? OPENAI_HEADER_VALUES.BETA_RESPONSES_WEBSOCKETS_V2
			: OPENAI_HEADER_VALUES.BETA_RESPONSES;
	headers.delete(OPENAI_HEADERS.BETA);
	headers.delete("openai-beta");
	headers.set(OPENAI_HEADERS.BETA, betaHeader);
	headers.set(OPENAI_HEADERS.ORIGINATOR, OPENAI_HEADER_VALUES.ORIGINATOR_CODEX);
	headers.set(OPENAI_HEADERS.VERSION, codexClientVersion);
	headers.set("User-Agent", `pi/${packageJson.version} (${os.platform()} ${os.release()}; ${os.arch()})`);
	if (sessionId) {
		headers.set(OPENAI_HEADERS.CONVERSATION_ID, sessionId);
		headers.set(OPENAI_HEADERS.SESSION_ID, sessionId);
		headers.set("x-client-request-id", sessionId);
	} else {
		headers.delete(OPENAI_HEADERS.CONVERSATION_ID);
		headers.delete(OPENAI_HEADERS.SESSION_ID);
		headers.delete("x-client-request-id");
	}
	headers.delete(OPENAI_HEADERS.INSTALLATION_ID);
	if (requestMetadata) {
		applyCodexCompatibilityHeaders(headers, requestMetadata);
	} else {
		headers.delete(OPENAI_HEADERS.SCOPED_SESSION_ID);
		headers.delete(OPENAI_HEADERS.THREAD_ID);
		headers.delete(OPENAI_HEADERS.WINDOW_ID);
		headers.delete(OPENAI_HEADERS.TURN_METADATA);
	}
	if (state?.turnState) {
		headers.set(X_CODEX_TURN_STATE_HEADER, state.turnState);
	} else {
		headers.delete(X_CODEX_TURN_STATE_HEADER);
	}
	if (state?.modelsEtag) {
		headers.set(X_MODELS_ETAG_HEADER, state.modelsEtag);
	} else {
		headers.delete(X_MODELS_ETAG_HEADER);
	}
	if (responsesLite) {
		headers.set(OPENAI_HEADERS.RESPONSES_LITE, "true");
	} else {
		headers.delete(OPENAI_HEADERS.RESPONSES_LITE);
	}
	if (transport === "sse") {
		headers.set("accept", "text/event-stream");
		headers.set("content-type", "application/json");
	} else {
		headers.delete("accept");
		headers.delete("content-type");
	}
	return headers;
}

export function isCodexIdentityHeader(lower: string): boolean {
	return (
		lower.includes("account") ||
		lower.includes("session") ||
		lower.includes("conversation") ||
		lower.includes("thread") ||
		lower.includes("window") ||
		lower.includes("installation") ||
		lower.startsWith("x-codex-turn") ||
		lower === "x-client-request-id"
	);
}

export function redactHeaders(headers: Headers): Record<string, string> {
	return redactDiagnosticHeaders(headers.entries(), isCodexIdentityHeader);
}

export function resolveCodexResponsesUrl(baseUrl: string | undefined): string {
	const raw = baseUrl && baseUrl.trim().length > 0 ? baseUrl : CODEX_BASE_URL;
	const normalized = trimTrailingSlashes(raw);
	if (normalized.endsWith("/codex/responses")) return normalized;
	if (normalized.endsWith("/codex")) return `${normalized}/responses`;
	return `${normalized}/codex/responses`;
}

import { toFields, toStringValue } from "@veyyon/catalog/utils";
import { structuredCloneJSON } from "@veyyon/utils/json";
import * as logger from "@veyyon/utils/logger";
import { readSseJson } from "@veyyon/utils/stream";
import * as AIError from "../error";
import {
	getOpenAIResponsesHistoryItems,
	getOpenAIResponsesHistoryPayload,
	sanitizeOpenAIResponsesAssistantFallbackItemsForReplay,
	sanitizeOpenAIResponsesAssistantHistoryItemsForReplay,
} from "../utils";
import { isPreResponseStall } from "../utils/first-event-budget";
import { armPreResponseTimeout } from "../utils/idle-iterator";

import type { OpenAIStreamHandle } from "../utils/openai-http";
import { fetchProviderWithRetry } from "../utils/provider-fetch";
import { adaptSchemaForStrict, NO_STRICT, sanitizeSchemaForOpenAIResponses, toolWireSchema } from "../utils/schema";
import { compactGrammarDefinition } from "./grammar";
import { CodexApiError } from "./openai-codex/response-handler";
import { CodexWebSocketConnection, headersToRecord } from "./openai-codex-responses";
import { transformMessages } from "./transform-messages";

export async function getOrCreateCodexWebSocketConnection(
	state: CodexWebSocketSessionState,
	url: string,
	headers: Headers,
	signal?: AbortSignal,
): Promise<CodexWebSocketConnection> {
	const headerRecord = headersToRecord(headers);
	for (let joinAttempt = 0; joinAttempt < 3; joinAttempt += 1) {
		const pending = state.connection;
		if (!pending || pending.isOpen() || !pending.isConnecting()) break;
		try {
			await pending.connect(signal);
		} catch {}
	}
	if (state.connection?.isOpen()) {
		if (!state.connection.matchesAuth(headerRecord)) {
			state.connection.close("token-refresh");
			resetCodexWebSocketAppendState(state);
		} else if (state.connection.isHealthyForReuse()) {
			logger.time("codexWs:reuseOpenSocket");
			return state.connection;
		} else {
			CODEX_DEBUG && logger.debug("[codex] codex websocket reuse rejected by health check", {});
			state.connection.close("stale-reuse");
			resetCodexWebSocketAppendState(state);
		}
	}
	state.connection?.close("reconnect");
	resetCodexWebSocketAppendState(state);
	logger.time("codexWs:newSocket");
	state.connection = new CodexWebSocketConnection(url, headerRecord, {
		onHandshakeHeaders: handshakeHeaders => {
			updateCodexSessionMetadataFromHeaders(state, handshakeHeaders);
		},
	});
	await state.connection.connect(signal);
	return state.connection;
}

export async function openCodexSseEventStream(
	url: string,
	requestHeaders: Record<string, string> | undefined,
	accountId: string | undefined,
	apiKey: string,
	sessionId: string | undefined,
	body: RequestBody,
	state: CodexWebSocketSessionState | undefined,
	responsesLite: boolean,
	codexClientVersion: string,
	requestMetadata: CodexRequestMetadata | undefined,
	signal: AbortSignal | undefined,
	firstEventTimeoutMs: number | undefined,
	firstEventBudget: FirstEventBudget,
	maxRetryDelayMs: number | undefined,
	onSseEvent?: OpenAICodexResponsesOptions["onSseEvent"],
	fetchOverride?: FetchImpl,
	prepareBody: () => RequestBody | Promise<RequestBody> = () => structuredCloneJSON(body),
): Promise<OpenAIStreamHandle<Record<string, unknown>>> {
	const headers = createCodexHeaders(
		requestHeaders,
		accountId,
		apiKey,
		codexClientVersion,
		sessionId,
		"sse",
		state,
		responsesLite,
		requestMetadata,
	);
	CODEX_DEBUG &&
		logger.debug("[codex] codex request", {
			url,
			model: body.model,
			headers: redactHeaders(headers),
			sentTurnStateHeader: headers.has(X_CODEX_TURN_STATE_HEADER),
			sentModelsEtagHeader: headers.has(X_MODELS_ETAG_HEADER),
		});
	let clearPreResponseTimeout: (() => void) | undefined;
	const fetchAttempt: FetchImpl = async (input, init) => {
		try {
			return await (fetchOverride ?? fetch)(input, init);
		} finally {
			clearPreResponseTimeout?.();
			clearPreResponseTimeout = undefined;
		}
	};
	let response: Response;
	try {
		response = await fetchProviderWithRetry(url, {
			method: "POST",
			headers,
			body: JSON.stringify(body),
			signal,
			prepareInit: async () => {
				const wireBody = await prepareBody();
				const watchdog = armPreResponseTimeout(signal, firstEventTimeoutMs);
				clearPreResponseTimeout = watchdog.clear;
				return { body: JSON.stringify(wireBody), signal: watchdog.signal };
			},
			maxAttempts: CODEX_MAX_RETRIES + 1,
			defaultDelayMs: attempt => CODEX_RETRY_DELAY_MS * (attempt + 1),
			maxDelayMs: maxRetryDelayMs ?? CODEX_RATE_LIMIT_BUDGET_MS,
			shouldRetryError: error => !(isPreResponseStall(error) && firstEventBudget.spent()),
			fetch: fetchAttempt,
			timeout: false,
		});
	} finally {
		clearPreResponseTimeout?.();
	}
	CODEX_DEBUG &&
		logger.debug("[codex] codex response", {
			url: response.url,
			status: response.status,
			statusText: response.statusText,
			contentType: response.headers.get("content-type") || null,
			cfRay: response.headers.get("cf-ray") || null,
		});
	if (!response.ok) {
		throw await CodexApiError.fromResponse(response);
	}
	updateCodexSessionMetadataFromHeaders(state, response.headers);
	if (!response.body) {
		throw new CodexProviderStreamError("No response body", { retryable: false });
	}
	const events = readSseJson<Record<string, unknown>>(response.body, signal, event =>
		notifyRawSseEvent(onSseEvent, { event: event.event, data: event.data, raw: event.raw.slice() }),
	);
	return { events, response, requestId: response.headers.get("x-request-id") };
}

export function convertMessages(model: Model<"openai-codex-responses">, context: Context): ResponseInput {
	const messages: ResponseInput = [];

	const normalizeToolCallId = (id: string): string => {
		if (!id.includes("|")) return id;
		const [callId, itemId] = id.split("|");
		const sanitizedCallId = callId.replace(/[^a-zA-Z0-9_-]/g, "_");
		let sanitizedItemId = itemId.replace(/[^a-zA-Z0-9_-]/g, "_");
		if (!sanitizedItemId.startsWith("fc")) {
			sanitizedItemId = `fc_${sanitizedItemId}`;
		}
		let normalizedCallId = sanitizedCallId.length > 64 ? sanitizedCallId.slice(0, 64) : sanitizedCallId;
		let normalizedItemId = sanitizedItemId.length > 64 ? sanitizedItemId.slice(0, 64) : sanitizedItemId;
		normalizedCallId = normalizedCallId.replace(/_+$/, "");
		normalizedItemId = normalizedItemId.replace(/_+$/, "");
		return `${normalizedCallId}|${normalizedItemId}`;
	};

	const transformedMessages = transformMessages(context.messages, model, normalizeToolCallId);
	let msgIndex = 0;
	const customCallIds = new Set<string>();
	const knownCallIds = new Set<string>();

	for (const msg of transformedMessages) {
		if (msg.role === "user" || msg.role === "developer") {
			const providerPayload = (msg as { providerPayload?: AssistantMessage["providerPayload"] }).providerPayload;
			const historyItems = getOpenAIResponsesHistoryItems(providerPayload, model.provider) as
				| Array<ResponseInput[number]>
				| undefined;
			if (historyItems) {
				for (const item of historyItems) {
					const maybe = item as { type?: string; call_id?: string };
					if (maybe.type === "custom_tool_call" && typeof maybe.call_id === "string") {
						customCallIds.add(maybe.call_id);
					}
				}
				for (let hi = 0; hi < historyItems.length; hi++) messages.push(historyItems[hi]!);
				msgIndex += 1;
				continue;
			}

			if (
				msg.role === "developer" &&
				Array.isArray(msg.content) &&
				msg.content.some(item => item.type === "image")
			) {
				const textContent = normalizeInputMessageContent(
					model,
					msg.content.filter((item): item is TextContent => item.type === "text"),
				);
				const imageContent = normalizeInputMessageContent(
					model,
					msg.content.filter(item => item.type === "image"),
				);
				if (textContent.length > 0) messages.push({ role: "developer", content: textContent });
				if (imageContent.length > 0) messages.push({ role: "user", content: imageContent });
				msgIndex += 1;
				continue;
			}
			const normalizedContent = normalizeInputMessageContent(model, msg.content);
			if (normalizedContent.length === 0) continue;
			messages.push({ role: msg.role, content: normalizedContent });
			msgIndex += 1;
			continue;
		}

		if (msg.role === "assistant") {
			const assistantMsg = msg as AssistantMessage;
			const providerPayload =
				assistantMsg.api === model.api && assistantMsg.model === model.id
					? getOpenAIResponsesHistoryPayload(assistantMsg.providerPayload, model.provider, assistantMsg.provider)
					: undefined;
			const historyItems = providerPayload?.items as Array<Record<string, unknown>> | undefined;
			let suppressHiddenEmptyFallback = false;
			if (historyItems) {
				const sanitizedHistoryItems = sanitizeOpenAIResponsesAssistantHistoryItemsForReplay(historyItems);
				if (sanitizedHistoryItems) {
					for (const item of sanitizedHistoryItems) {
						const maybe = item as { type?: string; call_id?: string };
						if (maybe.type === "custom_tool_call" && typeof maybe.call_id === "string") {
							customCallIds.add(maybe.call_id);
						}
					}
					if (providerPayload?.dt) {
						for (let hi = 0; hi < sanitizedHistoryItems.length; hi++) messages.push(sanitizedHistoryItems[hi]!);
					} else {
						messages.splice(0, messages.length, ...sanitizedHistoryItems);
					}
					msgIndex += 1;
					continue;
				}
				suppressHiddenEmptyFallback = true;
			}

			const convertedOutputItems = convertResponsesAssistantMessage(
				msg as AssistantMessage,
				model,
				msgIndex,
				knownCallIds,
				!suppressHiddenEmptyFallback,
				customCallIds,
			);
			const outputItems = suppressHiddenEmptyFallback
				? sanitizeOpenAIResponsesAssistantFallbackItemsForReplay(convertedOutputItems)
				: convertedOutputItems;
			if (outputItems.length > 0) {
				for (let oi = 0; oi < outputItems.length; oi++) messages.push(outputItems[oi]!);
			}
			msgIndex += 1;
			continue;
		}

		if (msg.role === "toolResult") {
			appendResponsesToolResultMessages(
				messages,
				msg,
				model,
				false,
				model.compat.supportsImageDetailOriginal,
				knownCallIds,
				customCallIds,
			);
		}

		msgIndex += 1;
	}

	return messages;
}

export function normalizeInputMessageContent(
	model: Model<"openai-codex-responses">,
	content: string | Array<{ type: "text"; text: string } | { type: "image"; mimeType: string; data: string }>,
): ResponseInputContent[] {
	if (typeof content === "string") {
		if (!content || content.trim() === "") return [];
		return [{ type: "input_text", text: content.toWellFormed() }];
	}

	return (
		convertResponsesInputContent(content, model.input.includes("image"), model.compat.supportsImageDetailOriginal) ??
		[]
	);
}

export { convertMessages as convertCodexResponsesMessages };

export type CodexToolPayload =
	| {
			type: "function";
			name: string;
			description: string;
			parameters: Record<string, unknown>;
			strict?: boolean;
	  }
	| {
			type: "custom";
			name: string;
			description: string;
			format: { type: "grammar"; syntax: "lark" | "regex"; definition: string };
	  };

export function convertOpenAICodexResponsesTools(
	tools: Tool[],
	model: Model<"openai-codex-responses">,
): CodexToolPayload[] {
	const allowFreeform = model.applyPatchToolType === "freeform";
	return tools.map((tool): CodexToolPayload => {
		if (allowFreeform && tool.customFormat) {
			return {
				type: "custom",
				name: tool.customWireName ?? tool.name,
				description: tool.description || "",
				format: {
					type: "grammar",
					syntax: tool.customFormat.syntax,
					definition: compactGrammarDefinition(tool.customFormat.syntax, tool.customFormat.definition),
				},
			};
		}
		const strict = !!(!NO_STRICT && tool.strict);
		const baseParameters = sanitizeSchemaForOpenAIResponses(toolWireSchema(tool));
		const { schema: parameters, strict: effectiveStrict } = adaptSchemaForStrict(baseParameters, strict);
		return {
			type: "function",
			name: tool.name,
			description: tool.description || "",
			parameters,
			...(effectiveStrict ? { strict: true } : !NO_STRICT && tool.strict === false ? { strict: false } : {}),
		};
	});
}

export interface CodexErrorDetail {
	code?: string | undefined;
	type?: string | undefined;
	message?: string | undefined;
}

export interface CodexFailureResponse {
	error?: CodexErrorDetail | undefined;
	message?: string | undefined;
	status?: string | undefined;
}

export interface CodexFailureEvent {
	type?: string | undefined;
	code?: string | undefined;
	message?: string | undefined;
	status?: string | undefined;
	error?: CodexErrorDetail | undefined;
	response?: CodexFailureResponse | undefined;
}

export function readCodexErrorDetail(value: unknown): CodexErrorDetail | undefined {
	const fields = toFields(value);
	if (!fields) {
		return undefined;
	}
	return {
		code: toStringValue(fields.code),
		type: toStringValue(fields.type),
		message: toStringValue(fields.message),
	};
}

export function readCodexFailureEvent(rawEvent: Record<string, unknown>): CodexFailureEvent {
	const response = toFields(rawEvent.response);
	return {
		type: toStringValue(rawEvent.type),
		code: toStringValue(rawEvent.code),
		message: toStringValue(rawEvent.message),
		status: toStringValue(rawEvent.status),
		error: readCodexErrorDetail(rawEvent.error),
		response: response
			? {
					error: readCodexErrorDetail(response.error),
					message: toStringValue(response.message),
					status: toStringValue(response.status),
				}
			: undefined,
	};
}

export function isRetryableCodexFailureEvent(rawEvent: Record<string, unknown>): boolean {
	const event = readCodexFailureEvent(rawEvent);
	const error = event.error ?? event.response?.error;
	const code = error?.code ?? error?.type ?? event.code;
	if (code && CODEX_RETRYABLE_EVENT_CODES.has(code.toLowerCase())) {
		return true;
	}
	const message = error?.message ?? event.message ?? event.response?.message;
	return !!message && AIError.isTransientErrorText(message);
}

export function createCodexProviderStreamError(rawEvent: Record<string, unknown>): CodexProviderStreamError {
	const event = readCodexFailureEvent(rawEvent);
	const nestedError = event.error ?? event.response?.error;
	const code = nestedError?.code ?? nestedError?.type ?? event.code ?? "";
	const message = event.message ?? "";
	const formattedMessage =
		event.type === "error"
			? formatCodexErrorEvent(rawEvent, code, message)
			: (formatCodexFailure(rawEvent) ?? "Codex response failed");
	return new CodexProviderStreamError(formattedMessage, {
		retryable: isRetryableCodexFailureEvent(rawEvent),
		code: code || undefined,
	});
}

export function formatCodexFailure(rawEvent: Record<string, unknown>): string | null {
	const event = readCodexFailureEvent(rawEvent);
	const error = event.error ?? event.response?.error;
	const message = error?.message ?? event.message ?? event.response?.message;
	const code = error?.code ?? error?.type ?? event.code;
	const status = event.response?.status ?? event.status;

	const meta: string[] = [];
	if (code) meta.push(`code=${code}`);
	if (status) meta.push(`status=${status}`);

	if (message) {
		const metaText = meta.length ? ` (${meta.join(", ")})` : "";
		return `Codex response failed: ${message}${metaText}`;
	}
	if (meta.length) {
		return `Codex response failed (${meta.join(", ")})`;
	}
	try {
		const rawEventJson = JSON.stringify(rawEvent);
		const truncatedRawEventJson =
			rawEventJson.length <= 800
				? rawEventJson
				: `${rawEventJson.slice(0, 800)}…[truncated ${rawEventJson.length - 800}]`;
		return `Codex response failed: ${truncatedRawEventJson}`;
	} catch {
		return "Codex response failed";
	}
}

export function formatCodexErrorEvent(rawEvent: Record<string, unknown>, code: string, message: string): string {
	const detail = formatCodexFailure(rawEvent);
	if (detail) {
		return detail.replace("response failed", "error event");
	}
	const meta: string[] = [];
	if (code) meta.push(`code=${code}`);
	if (message) meta.push(`message=${message}`);
	if (meta.length > 0) {
		return `Codex error event (${meta.join(", ")})`;
	}
	try {
		const rawEventJson = JSON.stringify(rawEvent);
		const truncatedRawEventJson =
			rawEventJson.length <= 800
				? rawEventJson
				: `${rawEventJson.slice(0, 800)}…[truncated ${rawEventJson.length - 800}]`;
		return `Codex error event: ${truncatedRawEventJson}`;
	} catch {
		return "Codex error event";
	}
}
