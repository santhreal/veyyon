/**
 * Google Gemini CLI / Antigravity provider.
 * Shared implementation for both google-gemini-cli and google-antigravity providers.
 * Uses the Cloud Code Assist API endpoint to access Gemini and Claude models.
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { scheduler } from "node:timers/promises";
import {
	ANTIGRAVITY_ENDPOINTS,
	ANTIGRAVITY_PRIMARY_ENDPOINT,
	ANTIGRAVITY_SANDBOX_ENDPOINT,
	CLOUD_CODE_ENDPOINT,
} from "@veyyon/catalog/provider-endpoints";
import {
	ANTIGRAVITY_SYSTEM_INSTRUCTION,
	getAntigravityModelWireProfile,
	getAntigravityUserAgent,
	getGeminiCliHeaders,
} from "@veyyon/catalog/wire/gemini-headers";
import { extractHttpStatusFromError } from "@veyyon/utils/fetch-retry";
import { readSseJson } from "@veyyon/utils/stream";
import { trimTrailingSlashes } from "@veyyon/utils/url";
import { type } from "arktype";
import * as AIError from "../error";
import type {
	Api,
	AssistantMessage,
	Context,
	Model,
	ProviderSessionState,
	StreamFunction,
	StreamOptions,
	TextContent,
} from "../types";
import { normalizeSystemPrompts } from "../utils";
import { AssistantMessageEventStream } from "../utils/event-stream";
import { extractGoogleValidationUrl, formatGoogleValidationRequiredMessage } from "../utils/google-validation";
import { materializeDumpBody, type RawHttpRequestDump } from "../utils/http-inspector";
import { armPreResponseTimeout, getStreamFirstEventTimeoutMs } from "../utils/idle-iterator";
import { fetchProviderWithRetry } from "../utils/provider-fetch";
// Refresh is the sole responsibility of AuthStorage (broker-aware, single-flighted);
// the stream provider trusts the access token threaded through `options.apiKey`.
import { normalizeSchemaForCCA } from "../utils/schema";
import { StreamMarkupHealing, type StreamMarkupHealingEvent } from "../utils/stream-markup-healing";
import { interleavedThinkingBeta } from "./anthropic";
import type { Content, FunctionCallingConfigMode, ThinkingConfig, ThinkingLevel } from "./google-shared";
import {
	applyGoogleFinishReason,
	applyGoogleUsage,
	buildGoogleBaseGenerationConfig,
	buildGoogleToolConfig,
	convertMessages,
	convertTools,
	EMPTY_STREAM_BASE_DELAY_MS,
	GoogleResponseBlocks,
	type GoogleThinkingLevel,
	googleDoneReason,
	hasMeaningfulGoogleContent,
	isThinkingPart,
	MAX_EMPTY_STREAM_RETRIES,
	mapStopReasonString,
	resetGoogleStreamOutputForRetry,
	retainThoughtSignature,
	settleGoogleTerminallessEof,
	throwIfGooglePromptBlocked,
} from "./google-shared";
import { createInitialResponsesAssistantMessage } from "./initial-message";

/**
 * Thinking level for Gemini 3 models. Re-exported from `google-shared` so existing
 * `import { GoogleThinkingLevel } from "./google-gemini-cli"` callers keep working.
 */
export type { GoogleThinkingLevel };

function isPlanningLeakPrefix(text: string): boolean {
	const trimmed = text.trimStart();
	if (!trimmed.startsWith("{")) {
		return false;
	}
	const afterBrace = trimmed.slice(1).trimStart();
	if (afterBrace === "") {
		return trimmed.length <= 100;
	}
	if (afterBrace[0] !== '"') {
		return false;
	}
	const nextQuoteIndex = afterBrace.indexOf('"', 1);
	if (nextQuoteIndex === -1) {
		const keyPrefix = afterBrace.slice(1);
		return "thought".startsWith(keyPrefix) && trimmed.length <= 100;
	}
	const key = afterBrace.slice(1, nextQuoteIndex);
	if (key !== "thought") {
		return false;
	}
	const afterKey = afterBrace.slice(nextQuoteIndex + 1).trimStart();
	if (afterKey === "") {
		return trimmed.length <= 100;
	}
	if (afterKey[0] !== ":") {
		return false;
	}
	return true;
}

type BufferedPlanningResult =
	| { kind: "incomplete" }
	| { kind: "plain"; visibleText: string }
	| { kind: "leak"; visibleText: string };

function isPlanningLeakObject(parsed: unknown, toolNames: Set<string>): boolean {
	if (!parsed || typeof parsed !== "object") return false;
	const record = parsed as Record<string, unknown>;
	const hasThought = typeof record.thought === "string";
	const isOmpTool = typeof record.call === "string" && toolNames.has(record.call);
	const hasToolSignature =
		"_i" in record || "paths" in record || "command" in record || ("path" in record && "content" in record);
	return hasThought || isOmpTool || hasToolSignature;
}

function splitLeadingJsonObject(text: string): { prefixLength: number; jsonText: string; rest: string } | undefined {
	const prefixLength = text.length - text.trimStart().length;
	const trimmed = text.slice(prefixLength);
	if (!trimmed.startsWith("{")) return undefined;

	let depth = 0;
	let inString = false;
	let escaped = false;

	for (let index = 0; index < trimmed.length; index += 1) {
		const ch = trimmed[index];
		if (inString) {
			if (escaped) {
				escaped = false;
				continue;
			}
			if (ch === "\\") {
				escaped = true;
				continue;
			}
			if (ch === '"') inString = false;
			continue;
		}
		if (ch === '"') {
			inString = true;
			continue;
		}
		if (ch === "{") {
			depth += 1;
			continue;
		}
		if (ch !== "}") continue;
		depth -= 1;
		if (depth !== 0) continue;

		const jsonText = trimmed.slice(0, index + 1);
		return {
			prefixLength: prefixLength + index + 1,
			jsonText,
			rest: trimmed.slice(index + 1),
		};
	}

	return undefined;
}

function splitLeadingJsonObjectIgnoringQuotes(
	text: string,
): { prefixLength: number; jsonText: string; rest: string } | undefined {
	const prefixLength = text.length - text.trimStart().length;
	const trimmed = text.slice(prefixLength);
	if (!trimmed.startsWith("{")) return undefined;

	let depth = 0;
	for (let index = 0; index < trimmed.length; index += 1) {
		const ch = trimmed[index];
		if (ch === "{") {
			depth += 1;
		} else if (ch === "}") {
			depth -= 1;
			if (depth === 0) {
				return {
					prefixLength: prefixLength + index + 1,
					jsonText: trimmed.slice(0, index + 1),
					rest: trimmed.slice(index + 1),
				};
			}
		}
	}
	return undefined;
}

/**
 * Whether `text` carries a planning-leak signature, matched textually.
 *
 * The one owner of what a leak looks like when the JSON cannot be parsed. This
 * predicate was written out three separate times inside `consumePlanningBuffer`
 * — once for the EOF-with-no-closing-brace case, once for the unparseable-JSON
 * case, and the key list again in each — as byte-identical copies. Byte-identical
 * copies drift: adding a fifth signature to two of the three would leave the
 * third quietly passing planning JSON through to the user, which is precisely the
 * failure this function exists to prevent, and no test would have noticed because
 * each path is reached by a different malformed input.
 *
 * `toolNames` is a parameter rather than a module constant because the leak keys
 * are whatever tools the current request declared.
 */
function hasPlanningLeakSignature(text: string, toolNames: Set<string>): boolean {
	if (text.includes('"thought"')) return true;
	for (const name of toolNames) {
		if (text.includes(`"${name}"`)) return true;
	}
	return (
		text.includes('"_i"') ||
		text.includes('"paths"') ||
		text.includes('"command"') ||
		(text.includes('"path"') && text.includes('"content"'))
	);
}

function consumePlanningBuffer(text: string, toolNames: Set<string>, isFinal = false): BufferedPlanningResult {
	if (!isPlanningLeakPrefix(text)) {
		return { kind: "plain", visibleText: text };
	}

	// Try standard brace-balanced slicing first (respecting quotes and escapes)
	let leading = splitLeadingJsonObject(text);

	// If standard parsing fails (e.g. due to unescaped quotes), fall back to quote-ignoring brace-balanced slicing
	if (!leading) {
		leading = splitLeadingJsonObjectIgnoringQuotes(text);
	}

	if (!leading) {
		if (isFinal) {
			// At EOF, if the buffer has a leak signature but no closing brace at all, discard the whole buffer.
			if (hasPlanningLeakSignature(text.trim(), toolNames)) {
				return { kind: "leak", visibleText: "" };
			}
			return { kind: "plain", visibleText: text };
		}
		return { kind: "incomplete" };
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(leading.jsonText);
	} catch {
		// Unescaped quotes inside the planning object defeat JSON.parse, so fall
		// back to the textual signature. Same predicate as the EOF case above, one
		// owner, so the two paths cannot disagree about what a leak is.
		if (hasPlanningLeakSignature(leading.jsonText, toolNames)) {
			return { kind: "leak", visibleText: leading.rest };
		}
		// Unparseable leading object is not safe to strip; release it as normal text.
		return { kind: "plain", visibleText: text };
	}

	return isPlanningLeakObject(parsed, toolNames)
		? { kind: "leak", visibleText: leading.rest }
		: { kind: "plain", visibleText: text };
}

export interface GoogleGeminiCliOptions extends StreamOptions {
	/**
	 * Tool selection mode. String forms map directly to Gemini
	 * `FunctionCallingConfigMode`. The object form forces a single named tool —
	 * `mode: "ANY"` is wire-required when `allowedFunctionNames` is set.
	 */
	toolChoice?: "auto" | "none" | "any" | { mode: "ANY"; allowedFunctionNames: [string, ...string[]] };
	/**
	 * Thinking/reasoning configuration.
	 * - Gemini 2.x models: use `budgetTokens` to set the thinking budget
	 * - Gemini 3 models (gemini-3-pro-*, gemini-3-flash-*): use `level` instead
	 *
	 * When using `streamSimple`, this is handled automatically based on the model.
	 */
	thinking?: {
		enabled: boolean;
		/** Thinking budget in tokens. Use for Gemini 2.x models. */
		budgetTokens?: number;
		/** Thinking level. Use for Gemini 3 models (LOW/HIGH for Pro, MINIMAL/LOW/MEDIUM/HIGH for Flash). */
		level?: GoogleThinkingLevel;
		/**
		 * Explicit wire suppression when `enabled` is false. Cloud Code Assist
		 * re-applies the per-id baked server default when thinkingConfig is
		 * omitted, so models with `thinking.suppressWhenOff` must send
		 * `includeThoughts: false` plus a MINIMAL level (or zero budget).
		 */
		suppress?: { level: GoogleThinkingLevel } | { budget: number };
	};
	/** Request that Cloud Code Assist omit human-readable thought summaries while still allowing internal reasoning. */
	hideThinkingSummary?: boolean;
	/**
	 * Upstream wire model id override for collapsed effort-tier variants.
	 * Serialized as `requestModelId ?? model.requestModelId ?? model.id`.
	 */
	requestModelId?: string;
	projectId?: string;
	/** Antigravity endpoint routing mode: "auto" (default with failover), "production", "sandbox". */
	antigravityEndpointMode?: "auto" | "production" | "sandbox";
	providerSessionState?: Map<string, ProviderSessionState>;
}

export interface AntigravityProviderSessionState extends ProviderSessionState {
	lastGoodEndpoint?: string;
	/**
	 * Per-conversation request-envelope identity that mirrors the real
	 * Antigravity client. `sessionId` is the signed-decimal session id;
	 * `agentId`/`trajectoryId` are UUIDs; `stepIndex` is the monotonic step
	 * counter; `lastExecutionId` is the prior response id echoed as
	 * `labels.last_execution_id`.
	 */
	agentId?: string;
	trajectoryId?: string;
	sessionId?: string;
	stepIndex?: number;
	lastExecutionId?: string;
}

const ANTIGRAVITY_PROVIDER_SESSION_STATE_KEY = "google-antigravity-session-state";

export function getAntigravityProviderSessionState(
	providerSessionState: Map<string, ProviderSessionState> | undefined,
): AntigravityProviderSessionState | undefined {
	if (!providerSessionState) return undefined;
	let existing = providerSessionState.get(ANTIGRAVITY_PROVIDER_SESSION_STATE_KEY) as
		| AntigravityProviderSessionState
		| undefined;
	if (!existing) {
		existing = {
			close: () => {},
		};
		providerSessionState.set(ANTIGRAVITY_PROVIDER_SESSION_STATE_KEY, existing);
	}
	return existing;
}

export {
	ANTIGRAVITY_SYSTEM_INSTRUCTION,
	getAntigravityUserAgent,
	getGeminiCliHeaders,
	getGeminiCliUserAgent,
} from "@veyyon/catalog/wire/gemini-headers";

// Retry configuration
const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1000;
const RATE_LIMIT_BUDGET_MS = 5 * 60 * 1000;
const GOOGLE_GEMINI_REFRESH_SKEW_MS = 60_000;
const ANTIGRAVITY_REFRESH_SKEW_MS = 60_000;

function isClaudeModel(modelId: string): boolean {
	return modelId.toLowerCase().includes("claude");
}

function needsClaudeThinkingBetaHeader(model: Model<"google-gemini-cli">): boolean {
	return model.provider === "google-antigravity" && model.id.startsWith("claude-") && model.reasoning;
}

function shouldInjectAntigravitySystemInstruction(modelId: string): boolean {
	const normalized = modelId.toLowerCase();
	return normalized.includes("claude") || normalized.includes("gemini-3");
}

const optionalCredentialString = type("unknown").pipe(raw => {
	const out = type("string")(raw);
	return out instanceof type.errors ? undefined : out;
});

const innerCredentialsSchema = type({
	"token?": optionalCredentialString,
	"projectId?": optionalCredentialString,
	"project_id?": optionalCredentialString,
	"refreshToken?": optionalCredentialString,
	"refresh?": optionalCredentialString,
	"email?": optionalCredentialString,
	"expiresAt?": "unknown",
	"expires?": "unknown",
});

const geminiCliCredentialsSchema = type("unknown").pipe(raw => {
	const out = innerCredentialsSchema(raw);
	return out instanceof type.errors ? {} : out;
});

interface ParsedGeminiCliCredentials {
	accessToken: string;
	projectId: string;
	refreshToken?: string;
	expiresAt?: number;
	email?: string;
}

function normalizeExpiryMs(value: unknown): number | undefined {
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
		return undefined;
	}
	return value < 10_000_000_000 ? value * 1000 : value;
}

export function parseGeminiCliCredentials(apiKeyRaw: string): ParsedGeminiCliCredentials {
	// `/login` alone was the entire remedy at all three of these sites, and it is
	// a TUI-only slash command (no `textMode: true` in the coding agent's
	// `slash-commands/builtin-declarations.ts`), so a headless run, an ACP client
	// and the model were each told to do something they cannot do, with no
	// alternative offered. The provider id is `google-gemini-cli`.
	const invalidCredentialsMessage =
		"The stored Google Cloud Code Assist credentials could not be parsed, so they cannot be used. Fix: run `veyyon auth-broker login google-gemini-cli` to sign in again from a terminal, or `/login google-gemini-cli` in an interactive veyyon session.";
	const missingCredentialsMessage =
		"The stored Google Cloud Code Assist credentials are missing their token or projectId, so no request can be signed. Fix: run `veyyon auth-broker login google-gemini-cli` to sign in again from a terminal, or `/login google-gemini-cli` in an interactive veyyon session.";

	let rawCredentials: unknown;
	try {
		rawCredentials = JSON.parse(apiKeyRaw);
	} catch {
		throw new AIError.ValidationError(invalidCredentialsMessage);
	}
	const parsed = geminiCliCredentialsSchema(rawCredentials);
	if (parsed instanceof type.errors) {
		throw new AIError.ValidationError(invalidCredentialsMessage);
	}

	const projectId = parsed.projectId ?? parsed.project_id;
	if (parsed.token === undefined || projectId === undefined) {
		throw new AIError.ValidationError(missingCredentialsMessage);
	}

	const refreshToken = parsed.refreshToken ?? parsed.refresh;
	const expiresAt = normalizeExpiryMs(parsed.expiresAt ?? parsed.expires);
	const email = parsed.email && parsed.email.length > 0 ? parsed.email : undefined;

	return {
		accessToken: parsed.token,
		projectId,
		refreshToken,
		expiresAt,
		email,
	};
}

export function shouldRefreshGeminiCliCredentials(
	expiresAt: number | undefined,
	isAntigravity: boolean,
	nowMs = Date.now(),
): boolean {
	if (expiresAt === undefined) {
		return false;
	}

	const skewMs = isAntigravity ? ANTIGRAVITY_REFRESH_SKEW_MS : GOOGLE_GEMINI_REFRESH_SKEW_MS;
	return nowMs + skewMs >= expiresAt;
}

interface CloudCodeAssistRequest {
	project: string;
	model: string;
	request: {
		contents: Content[];
		sessionId?: string;
		systemInstruction?: { role?: string; parts: { text: string }[] };
		generationConfig?: {
			maxOutputTokens?: number;
			temperature?: number;
			topP?: number;
			topK?: number;
			minP?: number;
			presencePenalty?: number;
			repetitionPenalty?: number;
			thinkingConfig?: ThinkingConfig;
		};
		tools?: { functionDeclarations: Record<string, unknown>[] }[] | undefined;
		toolConfig?: {
			functionCallingConfig: {
				mode: FunctionCallingConfigMode;
				allowedFunctionNames?: string[];
			};
		};
		labels?: Record<string, string>;
	};
	requestType?: string;
	userAgent?: string;
	requestId?: string;
}

/** One streamed part of a Cloud Code Assist candidate. */
interface CloudCodeAssistPart {
	text?: string;
	thought?: boolean;
	thoughtSignature?: string;
	functionCall?: {
		name: string;
		args: Record<string, unknown>;
		id?: string;
	};
}

interface CloudCodeAssistResponseChunk {
	response?: {
		candidates?: Array<{
			content?: {
				role: string;
				parts?: CloudCodeAssistPart[];
			};
			finishReason?: string;
		}>;
		usageMetadata?: {
			promptTokenCount?: number;
			candidatesTokenCount?: number;
			thoughtsTokenCount?: number;
			totalTokenCount?: number;
			cachedContentTokenCount?: number;
		};
		modelVersion?: string;
		responseId?: string;
		promptFeedback?: { blockReason?: string; blockReasonMessage?: string };
	};
	/** In-band stream failure (quota, internal error) delivered as a final JSON event. */
	error?: { code?: number; message?: string; status?: string };
	traceId?: string;
}

/**
 * Decodes one Cloud Code Assist response body into `output`.
 *
 * Visible text passes through the `<thinking>` markup healer. On flash models a text run that
 * opens with `{` is held back until it is known to be ordinary text or a leaked planning
 * object, which is dropped.
 */
class CloudCodeAssistResponseDecoder {
	readonly #blocks: GoogleResponseBlocks;
	readonly #healing = new StreamMarkupHealing({ pattern: "thinking" });
	readonly #holdsLeadingJson: boolean;
	/** Text held back while it may still be a planning leak; undefined while nothing is held. */
	#held: string | undefined;
	/**
	 * Signature of the held text. A function call drops the held text but not this, and the
	 * healer's trailing text is flushed with it at the end of the body.
	 */
	#heldSignature: string | undefined;
	#sawLeak = false;
	sawFinishReason = false;
	/** The response id, committed as the next request's `last_execution_id` on success. */
	responseId: string | undefined;
	/** Whether the body carried anything to deliver: content, or a dropped planning leak. */
	receivedContent = false;

	constructor(
		readonly model: Model<"google-gemini-cli">,
		readonly output: AssistantMessage,
		stream: AssistantMessageEventStream,
		readonly toolNames: Set<string>,
		onBlockAppended: () => void,
	) {
		this.#blocks = new GoogleResponseBlocks(output, stream, true, onBlockAppended);
		this.#holdsLeadingJson = model.id.includes("flash");
	}

	apply(chunk: CloudCodeAssistResponseChunk): void {
		if (chunk.error) {
			const detail = chunk.error.message || chunk.error.status || "unknown error";
			const message = `Cloud Code Assist stream error: ${detail}`;
			throw typeof chunk.error.code === "number" && chunk.error.code >= 400
				? new AIError.GeminiCliApiError(message, chunk.error.code)
				: new AIError.ProviderResponseError(message, { provider: this.model.provider, kind: "runtime" });
		}
		const response = chunk.response;
		if (!response) return;
		if (response.responseId) this.responseId = response.responseId;
		throwIfGooglePromptBlocked(response, this.model.provider);

		const candidate = response.candidates?.[0];
		const parts = candidate?.content?.parts;
		if (parts) {
			for (const part of parts) this.#applyPart(part);
		}
		if (candidate?.finishReason) {
			this.sawFinishReason = true;
			applyGoogleFinishReason(this.output, mapStopReasonString(candidate.finishReason), candidate.finishReason);
		}
		if (response.usageMetadata) applyGoogleUsage(this.model, this.output, response.usageMetadata);
	}

	/** Release whatever is still held or buffered and close the open block. */
	finish(): void {
		if (this.#held) {
			const held = consumePlanningBuffer(this.#held, this.toolNames, true);
			if (held.kind === "leak") this.#sawLeak = true;
			if (held.kind !== "incomplete") this.#feedVisibleText(held.visibleText, this.#heldSignature);
			this.#heldSignature = undefined;
			this.#held = undefined;
		}
		this.#emitHealingEvents(this.#healing.flushEvents(), this.#heldSignature);
		this.#blocks.endBlock();
		this.receivedContent = hasMeaningfulGoogleContent(this.output) || this.#sawLeak;
	}

	#applyPart(part: CloudCodeAssistPart): void {
		if (part.text !== undefined && part.text !== "") {
			if (isThinkingPart(part)) {
				this.#emitHealingEvents(this.#healing.flushEvents());
				this.#blocks.appendThinking(part.text, part.thoughtSignature);
			} else {
				this.#applyText(part.text, part.thoughtSignature);
			}
		} else if (part.text === "" && part.thoughtSignature && !part.functionCall) {
			this.#blocks.retainSignature(part.thoughtSignature);
		}

		if (part.functionCall) {
			this.#emitHealingEvents(this.#healing.flushEvents());
			this.#held = undefined;
			this.#blocks.appendFunctionCall(part.functionCall, part.thoughtSignature);
		}
	}

	#applyText(text: string, thoughtSignature: string | undefined): void {
		if (this.#held !== undefined) {
			this.#held += text;
			this.#heldSignature = retainThoughtSignature(this.#heldSignature, thoughtSignature);
		} else if (this.#holdsLeadingJson && text.trimStart().startsWith("{")) {
			this.#held = text;
			this.#heldSignature = thoughtSignature;
		} else {
			this.#feedVisibleText(text, thoughtSignature);
			return;
		}

		const held = consumePlanningBuffer(this.#held, this.toolNames);
		if (held.kind === "incomplete") return;
		if (held.kind === "leak") this.#sawLeak = true;
		const signature = this.#heldSignature;
		this.#held = undefined;
		this.#heldSignature = undefined;
		this.#feedVisibleText(held.visibleText, signature);
	}

	#feedVisibleText(delta: string, thoughtSignature: string | undefined): void {
		this.#emitHealingEvents(this.#healing.feedEvents(delta), thoughtSignature);
	}

	#emitHealingEvents(events: Iterable<StreamMarkupHealingEvent>, thoughtSignature?: string): void {
		for (const event of events) {
			if (event.type === "text") {
				this.#blocks.appendText(event.text, thoughtSignature);
			} else if (event.type === "thinking") {
				this.#blocks.appendThinking(event.thinking);
			}
		}
	}
}

/** What one Cloud Code Assist request sends, resolved once and replayed to every endpoint and retry. */
interface CloudCodeAssistPlan {
	readonly endpoints: readonly string[];
	readonly headers: Record<string, string>;
	readonly bodyJson: string;
	readonly providerState: AntigravityProviderSessionState | undefined;
	/** The signed-in account, named in a validation-required error. */
	readonly email: string | undefined;
	readonly firstEventTimeoutMs: number | undefined;
	readonly toolNames: Set<string>;
}

/**
 * The endpoints a request tries, in order.
 *
 * Antigravity in `auto` mode fails over across its production and sandbox endpoints, the
 * last one that answered first. A pinned mode, or a custom base URL, is the only endpoint,
 * and forgets the remembered one.
 */
function cloudCodeAssistEndpoints(
	model: Model<"google-gemini-cli">,
	options: GoogleGeminiCliOptions | undefined,
	providerState: AntigravityProviderSessionState | undefined,
): string[] {
	const baseUrl = model.baseUrl?.trim();
	if (model.provider !== "google-antigravity") return [baseUrl || CLOUD_CODE_ENDPOINT];

	const mode = options?.antigravityEndpointMode ?? "auto";
	let pinned: string | undefined;
	if (mode === "sandbox") {
		pinned = ANTIGRAVITY_SANDBOX_ENDPOINT;
	} else if (mode === "production") {
		pinned = ANTIGRAVITY_PRIMARY_ENDPOINT;
	} else if (baseUrl) {
		const cleanUrl = trimTrailingSlashes(baseUrl);
		if (cleanUrl !== ANTIGRAVITY_PRIMARY_ENDPOINT && cleanUrl !== ANTIGRAVITY_SANDBOX_ENDPOINT) pinned = baseUrl;
	}
	if (pinned) {
		if (providerState) providerState.lastGoodEndpoint = undefined;
		return [pinned];
	}

	const fallbacks = ANTIGRAVITY_ENDPOINTS.slice() as string[];
	const lastGood = providerState?.lastGoodEndpoint;
	return lastGood && fallbacks.includes(lastGood) ? [lastGood, ...fallbacks.filter(e => e !== lastGood)] : fallbacks;
}

async function cloudCodeAssistApiError(
	response: Response,
	email: string | undefined,
): Promise<AIError.GeminiCliApiError> {
	const errorBody = await AIError.readProviderErrorBody(response);
	const validationUrl = extractGoogleValidationUrl(errorBody.text);
	const errorMessage = validationUrl
		? formatGoogleValidationRequiredMessage(validationUrl, "retry your request", email)
		: errorBody.detail;
	return new AIError.GeminiCliApiError(
		`Cloud Code Assist API error (${response.status}): ${errorMessage}`,
		response.status,
		{ headers: response.headers },
	);
}

/** One `streamGoogleGeminiCli` call: plan the request, stream it from an endpoint, settle the message. */
class GeminiCliStreamRun {
	readonly #startTime = performance.now();
	readonly #output: AssistantMessage;
	#firstTokenTime: number | undefined;
	#started = false;
	#rawRequestDump: RawHttpRequestDump | undefined;
	/** Exact bytes of the last sent request body; materialized into a dump only on the 400/413 path. */
	#wireBodyJson: string | undefined;

	constructor(
		readonly model: Model<"google-gemini-cli">,
		readonly context: Context,
		readonly options: GoogleGeminiCliOptions | undefined,
		readonly stream: AssistantMessageEventStream,
	) {
		this.#output = createInitialResponsesAssistantMessage("google-gemini-cli" as Api, model.provider, model.id);
	}

	async run(): Promise<void> {
		const output = this.#output;
		try {
			await this.#streamFromEndpoints(await this.#plan());
			const reason = googleDoneReason(output, this.model.provider);
			this.#stampTiming();
			this.stream.push({ type: "done", reason, message: output });
		} catch (error) {
			const result = await AIError.finalize(error, {
				api: this.model.api,
				signal: this.options?.signal,
				rawRequestDump: materializeDumpBody(this.#rawRequestDump, this.#wireBodyJson),
			});
			AIError.applyFinalizeResult(output, result);
			this.#stampTiming();
			this.stream.push({ type: "error", reason: output.stopReason, error: output });
		}
		this.stream.end();
	}

	async #plan(): Promise<CloudCodeAssistPlan> {
		const { model, context, options } = this;
		const apiKeyRaw = options?.apiKey;
		if (!apiKeyRaw) {
			throw new AIError.ConfigurationError(
				"No Google Cloud Code Assist credential is available, and this provider accepts only an OAuth credential, never a plain API key. Fix: run `veyyon auth-broker login google-gemini-cli` to sign in from a terminal, or `/login google-gemini-cli` in an interactive veyyon session. Setting a `GEMINI_API_KEY`-style key does not work here.",
			);
		}

		const isAntigravity = model.provider === "google-antigravity";
		const credentials = parseGeminiCliCredentials(apiKeyRaw);
		// AuthStorage already refreshed credentials before threading them here (see
		// {@link OAUTH_REFRESH_SKEW_MS}). A credential that lands expired fails rather than
		// POSTing a stale token; the next call, driven by AuthStorage's invalidate+retry
		// path, carries a fresh credential.
		if (credentials.expiresAt !== undefined && Date.now() >= credentials.expiresAt) {
			throw new AIError.OAuthError(
				"OAuth token expired before request — please retry; AuthStorage will refresh on the next attempt.",
				{ kind: "token-refresh", provider: model.provider },
			);
		}
		const providerState = isAntigravity
			? getAntigravityProviderSessionState(options?.providerSessionState)
			: undefined;
		const endpoints = cloudCodeAssistEndpoints(model, options, providerState);

		let requestBody = buildRequest(model, context, credentials.projectId, options, isAntigravity);
		const replacementPayload = await options?.onPayload?.(requestBody, model);
		if (replacementPayload !== undefined) {
			requestBody = replacementPayload as typeof requestBody;
		}
		const headers = {
			Authorization: `Bearer ${credentials.accessToken}`,
			"Content-Type": "application/json",
			Accept: "text/event-stream",
			...(isAntigravity ? { "User-Agent": getAntigravityUserAgent() } : getGeminiCliHeaders(model.id)),
			...(needsClaudeThinkingBetaHeader(model) ? { "anthropic-beta": interleavedThinkingBeta } : {}),
			...(options?.headers ?? {}),
		};
		const bodyJson = JSON.stringify(requestBody);
		this.#rawRequestDump = {
			provider: model.provider,
			api: this.#output.api,
			model: model.id,
			method: "POST",
			headers,
		};
		this.#wireBodyJson = bodyJson;

		return {
			endpoints,
			headers,
			bodyJson,
			providerState,
			email: credentials.email,
			// Direct callers that skip `register-builtins` (which installs the iterator-level
			// watchdog) need a pre-response timer alongside `timeout: false`; otherwise a
			// stalled Cloud Code Assist proxy would hang forever. Floor matches the lazy
			// wrapper's 5min default.
			firstEventTimeoutMs: options?.streamFirstEventTimeoutMs ?? getStreamFirstEventTimeoutMs(undefined, 300_000),
			toolNames: new Set(context.tools?.map(t => t.name) ?? []),
		};
	}

	/**
	 * Try each endpoint in turn. A transient failure moves on to the next endpoint unless it
	 * is the last one or the response already started streaming.
	 */
	async #streamFromEndpoints(plan: CloudCodeAssistPlan): Promise<void> {
		const { endpoints } = plan;
		for (let i = 0; i < endpoints.length; i++) {
			const isLastEndpoint = i === endpoints.length - 1;
			try {
				if (await this.#streamFromEndpoint(plan, endpoints[i], isLastEndpoint)) return;
			} catch (error) {
				const transient = AIError.isTransientStatus(extractHttpStatusFromError(error));
				if (transient && !isLastEndpoint && !this.#started) continue;
				throw error;
			}
		}
	}

	/** True when this endpoint produced the response, false to move on to the next one. */
	async #streamFromEndpoint(plan: CloudCodeAssistPlan, endpoint: string, isLastEndpoint: boolean): Promise<boolean> {
		this.#started = false;
		resetGoogleStreamOutputForRetry(this.model, this.#output);
		const requestUrl = `${endpoint}/v1internal:streamGenerateContent?alt=sse`;
		const response = await this.#post(plan, requestUrl, isLastEndpoint);
		if (!response.ok) {
			if (AIError.isTransientStatus(response.status) && !isLastEndpoint) return false;
			throw await cloudCodeAssistApiError(response, plan.email);
		}

		const decoder = await this.#streamWithEmptyRetries(plan, requestUrl, response);
		googleDoneReason(this.#output, this.model.provider);
		if (!decoder?.receivedContent) {
			throw new AIError.ProviderResponseError("Cloud Code Assist API returned an empty response", {
				provider: this.model.provider,
				kind: "empty-body",
			});
		}
		if (this.options?.signal?.aborted) {
			throw new AIError.RequestAbortError("Request was aborted");
		}
		if (!decoder.sawFinishReason) settleGoogleTerminallessEof(this.#output, this.model.provider, "Cloud Code Assist");

		const state = plan.providerState;
		if (state) {
			const mode = this.options?.antigravityEndpointMode;
			if (!mode || mode === "auto") state.lastGoodEndpoint = endpoint;
			// Committed only after a fully successful attempt; the next request sends it as
			// `last_execution_id`. Overwritten even when undefined so a response without an
			// id cannot leave a stale value.
			state.lastExecutionId = decoder.responseId;
		}
		return true;
	}

	async #post(plan: CloudCodeAssistPlan, requestUrl: string, isLastEndpoint: boolean): Promise<Response> {
		// Per attempt: arm a pre-response (TTFT) timer, cleared the instant headers arrive so it
		// never aborts the actively streaming body — an absolute `AbortSignal.timeout` would
		// (issue #2422).
		const watchdog = armPreResponseTimeout(this.options?.signal, plan.firstEventTimeoutMs);
		try {
			return await fetchProviderWithRetry(() => requestUrl, {
				method: "POST",
				headers: plan.headers,
				body: plan.bodyJson,
				signal: watchdog.signal,
				maxAttempts: isLastEndpoint ? MAX_RETRIES + 1 : 1,
				defaultDelayMs: attempt => BASE_DELAY_MS * 2 ** attempt,
				maxDelayMs: this.options?.maxRetryDelayMs ?? RATE_LIMIT_BUDGET_MS,
				fetch: this.options?.fetch,
				timeout: false,
			});
		} finally {
			watchdog.clear();
		}
	}

	/**
	 * Gemini occasionally finishes with a benign `STOP` and nothing in it. The request is sent
	 * again a bounded number of times, with backoff. Undefined when every attempt was empty.
	 */
	async #streamWithEmptyRetries(
		plan: CloudCodeAssistPlan,
		requestUrl: string,
		response: Response,
	): Promise<CloudCodeAssistResponseDecoder | undefined> {
		let current = response;
		for (let emptyAttempt = 0; emptyAttempt <= MAX_EMPTY_STREAM_RETRIES; emptyAttempt++) {
			if (this.options?.signal?.aborted) {
				throw new AIError.RequestAbortError("Request was aborted");
			}
			if (emptyAttempt > 0) current = await this.#resend(plan, requestUrl, emptyAttempt);
			const decoder = await this.#decode(current, plan.toolNames);
			if (this.#output.stopReason !== "stop" || decoder.receivedContent) return decoder;
			if (emptyAttempt < MAX_EMPTY_STREAM_RETRIES) resetGoogleStreamOutputForRetry(this.model, this.#output);
		}
		return undefined;
	}

	/**
	 * An empty-response retry POSTs to the URL this attempt used, not `response.url`: a custom
	 * `options.fetch` that answers with a constructed `Response` leaves that empty.
	 */
	async #resend(plan: CloudCodeAssistPlan, requestUrl: string, emptyAttempt: number): Promise<Response> {
		const signal = this.options?.signal;
		try {
			await scheduler.wait(EMPTY_STREAM_BASE_DELAY_MS * 2 ** (emptyAttempt - 1), { signal });
		} catch {
			throw new AIError.RequestAbortError("Request was aborted");
		}
		const response = await (this.options?.fetch ?? fetch)(requestUrl, {
			method: "POST",
			headers: plan.headers,
			body: plan.bodyJson,
			signal,
		});
		if (!response.ok) {
			const retryErrorText = await response.text();
			throw new AIError.GeminiCliApiError(
				`Cloud Code Assist API error (${response.status}): ${retryErrorText}`,
				response.status,
				{ headers: response.headers },
			);
		}
		return response;
	}

	async #decode(response: Response, toolNames: Set<string>): Promise<CloudCodeAssistResponseDecoder> {
		const body = response.body;
		if (!body) {
			throw new AIError.ProviderResponseError("No response body", {
				provider: this.model.provider,
				kind: "empty-body",
			});
		}
		const { model, options } = this;
		const decoder = new CloudCodeAssistResponseDecoder(
			model,
			this.#output,
			this.stream,
			toolNames,
			this.#ensureStarted,
		);
		for await (const chunk of readSseJson<CloudCodeAssistResponseChunk>(body, options?.signal, event =>
			options?.onSseEvent?.({ event: event.event, data: event.data, raw: event.raw.slice() }, model),
		)) {
			decoder.apply(chunk);
		}
		decoder.finish();
		return decoder;
	}

	readonly #ensureStarted = (): void => {
		if (this.#started) return;
		if (!this.#firstTokenTime) this.#firstTokenTime = performance.now();
		this.stream.push({ type: "start", partial: this.#output });
		this.#started = true;
	};

	#stampTiming(): void {
		this.#output.duration = performance.now() - this.#startTime;
		if (this.#firstTokenTime) this.#output.ttft = this.#firstTokenTime - this.#startTime;
	}
}

export const streamGoogleGeminiCli: StreamFunction<"google-gemini-cli"> = (
	model: Model<"google-gemini-cli">,
	context: Context,
	options?: GoogleGeminiCliOptions,
): AssistantMessageEventStream => {
	const stream = new AssistantMessageEventStream();
	void new GeminiCliStreamRun(model, context, options, stream).run();
	return stream;
};

const INT63_MASK = (1n << 63n) - 1n;
const ANTIGRAVITY_RANDOM_BOUND = 9_000_000_000_000_000_000n;

function formatSignedDecimalSessionId(value: bigint): string {
	return `-${value.toString()}`;
}

function deriveSignedDecimalFromHash(text: string): string {
	const digest = createHash("sha256").update(text).digest();
	let value = 0n;
	for (let index = 0; index < 8; index += 1) {
		value = (value << 8n) | BigInt(digest[index] ?? 0);
	}
	return formatSignedDecimalSessionId(value & INT63_MASK);
}

function randomBoundedInt63(maxExclusive: bigint): bigint {
	while (true) {
		const bytes = randomBytes(8);
		let value = 0n;
		for (const byte of bytes) {
			value = (value << 8n) | BigInt(byte);
		}
		value &= INT63_MASK;
		if (value < maxExclusive) {
			return value;
		}
	}
}

function randomSignedDecimalSessionId(): string {
	return formatSignedDecimalSessionId(randomBoundedInt63(ANTIGRAVITY_RANDOM_BOUND));
}

function getFirstUserTextForAntigravitySession(context: Context): string | undefined {
	for (const message of context.messages) {
		if (message.role !== "user") {
			continue;
		}

		if (typeof message.content === "string") {
			return message.content;
		}

		if (Array.isArray(message.content)) {
			const firstTextPart = message.content.find((item): item is TextContent => item.type === "text");
			return firstTextPart?.text;
		}

		return undefined;
	}

	return undefined;
}

function deriveAntigravitySessionId(context: Context): string {
	const text = getFirstUserTextForAntigravitySession(context);
	if (text && text.trim().length > 0) {
		return deriveSignedDecimalFromHash(text);
	}

	return randomSignedDecimalSessionId();
}

function normalizeAntigravityTools(
	tools: CloudCodeAssistRequest["request"]["tools"],
): CloudCodeAssistRequest["request"]["tools"] {
	return tools?.map(tool => ({
		...tool,
		functionDeclarations: tool.functionDeclarations.map(declaration => {
			if ("parameters" in declaration) {
				return declaration;
			}

			const { parametersJsonSchema, ...rest } = declaration;
			return {
				...rest,
				parameters: normalizeSchemaForCCA(parametersJsonSchema),
			};
		}),
	}));
}

interface AntigravityRequestEnvelope {
	sessionId: string;
	requestId: string;
	labels: Record<string, string>;
}

/**
 * Build the Antigravity request envelope (sessionId, structured requestId,
 * labels) advancing the per-conversation session state. Mirrors the real
 * `antigravity/hub` client: `requestId` is `agent/<agentId>/<ts>/<trajectoryId>/<step>`
 * and `labels.last_step_index` trails the requestId step by one. Without session
 * state (direct callers/tests) it falls back to ephemeral ids.
 */
function buildAntigravityRequestEnvelope(
	model: Model<"google-gemini-cli">,
	context: Context,
	wireModelId: string,
	state: AntigravityProviderSessionState | undefined,
): AntigravityRequestEnvelope {
	if (state) {
		state.agentId ??= randomUUID();
		state.trajectoryId ??= randomUUID();
		state.sessionId ??= randomSignedDecimalSessionId();
		state.stepIndex = (state.stepIndex ?? 1) + 1;
	}
	const agentId = state?.agentId ?? randomUUID();
	const trajectoryId = state?.trajectoryId ?? randomUUID();
	const sessionId = state?.sessionId ?? deriveAntigravitySessionId(context);
	const step = state?.stepIndex ?? 2;
	const requestId = `agent/${agentId}/${Date.now()}/${trajectoryId}/${step}`;
	const isClaude = isClaudeModel(model.id);
	const profile = getAntigravityModelWireProfile(wireModelId);
	const labels: Record<string, string> = {};
	if (state?.lastExecutionId) labels.last_execution_id = state.lastExecutionId;
	labels.last_step_index = String(step - 1);
	if (profile?.modelEnum !== undefined) labels.model_enum = profile.modelEnum;
	labels.trajectory_id = trajectoryId;
	labels.used_claude = String(isClaude);
	labels.used_claude_conservative = String(isClaude);
	return { sessionId, requestId, labels };
}

export function buildRequest(
	model: Model<"google-gemini-cli">,
	context: Context,
	projectId: string,
	options: GoogleGeminiCliOptions = {},
	isAntigravity = false,
): CloudCodeAssistRequest {
	const systemPrompts = normalizeSystemPrompts(context.systemPrompt);
	const contents = convertMessages(model, context);
	const generationConfig: CloudCodeAssistRequest["request"]["generationConfig"] =
		buildGoogleBaseGenerationConfig(options);

	// Thinking config
	if (options.thinking?.enabled && model.reasoning) {
		generationConfig.thinkingConfig = {
			includeThoughts: !options.hideThinkingSummary,
		};
		// Gemini 3 models use thinkingLevel, older models use thinkingBudget
		if (options.thinking.level !== undefined) {
			// GoogleThinkingLevel mirrors the SDK's `ThinkingLevel` string enum values 1:1.
			generationConfig.thinkingConfig.thinkingLevel = options.thinking.level as ThinkingLevel;
		} else if (options.thinking.budgetTokens !== undefined) {
			generationConfig.thinkingConfig.thinkingBudget = options.thinking.budgetTokens;
		}
	} else if (options.thinking?.suppress && model.reasoning) {
		// Explicit off: omitting thinkingConfig re-applies the per-id baked
		// server default (the model silently thinks and bills the tokens).
		const suppress = options.thinking.suppress;
		generationConfig.thinkingConfig = { includeThoughts: false };
		if ("level" in suppress) {
			// GoogleThinkingLevel mirrors the SDK's `ThinkingLevel` string enum values 1:1.
			generationConfig.thinkingConfig.thinkingLevel = suppress.level as ThinkingLevel;
		} else {
			generationConfig.thinkingConfig.thinkingBudget = suppress.budget;
		}
	}

	const request: CloudCodeAssistRequest["request"] = {
		contents,
	};

	// System instruction is an object with parts, not a plain string. Antigravity
	// tags it with role "user" to mirror the real client.
	if (systemPrompts.length > 0) {
		request.systemInstruction = {
			...(isAntigravity ? { role: "user" } : {}),
			parts: systemPrompts.map(text => ({ text })),
		};
	}

	if (isAntigravity && shouldInjectAntigravitySystemInstruction(model.id)) {
		const existingParts = request.systemInstruction?.parts ?? [];
		request.systemInstruction = {
			role: "user",
			parts: [{ text: ANTIGRAVITY_SYSTEM_INSTRUCTION }, ...existingParts],
		};
	}

	if (context.tools && context.tools.length > 0) {
		const convertedTools = convertTools(context.tools, model);
		request.tools = isAntigravity ? normalizeAntigravityTools(convertedTools) : convertedTools;
		const toolConfig = buildGoogleToolConfig(options.toolChoice);
		if (toolConfig) {
			request.toolConfig = toolConfig;
		}
		// Antigravity's default tool mode is VALIDATED (verified for Gemini and
		// Claude); an explicit non-auto tool choice above wins.
		if (isAntigravity && !request.toolConfig) {
			request.toolConfig = {
				functionCallingConfig: { mode: "VALIDATED" as FunctionCallingConfigMode },
			};
		}
	}

	// Claude on Antigravity always forces VALIDATED, even with no tools declared.
	if (isAntigravity && isClaudeModel(model.id)) {
		request.toolConfig = {
			functionCallingConfig: {
				mode: "VALIDATED" as FunctionCallingConfigMode,
			},
		};
	}

	const wireModelId = options.requestModelId ?? model.requestModelId ?? model.id;

	if (isAntigravity) {
		// The real client sends a fixed per-model output cap independent of the
		// thinking budget; reassign so it keeps its slot ahead of thinkingConfig.
		const profile = getAntigravityModelWireProfile(wireModelId);
		if (profile) {
			generationConfig.maxOutputTokens = profile.maxOutputTokens;
		}
		const state = getAntigravityProviderSessionState(options.providerSessionState);
		const envelope = buildAntigravityRequestEnvelope(model, context, wireModelId, state);
		request.labels = envelope.labels;
		if (Object.keys(generationConfig).length > 0) {
			request.generationConfig = generationConfig;
		}
		request.sessionId = envelope.sessionId;
		return {
			project: projectId,
			requestId: envelope.requestId,
			request,
			model: wireModelId,
			userAgent: "antigravity",
			requestType: "agent",
		};
	}

	if (Object.keys(generationConfig).length > 0) {
		request.generationConfig = generationConfig;
	}

	return {
		project: projectId,
		model: wireModelId,
		request,
	};
}
