import {
	type CapturedHttpErrorResponse,
	finalizeErrorMessage,
	type RawHttpRequestDump,
	rewriteCopilotError,
} from "../utils/http-inspector";
import { formatErrorMessageWithRetryAfter } from "../utils/retry-after";
import { LLAMA_CPP_TOOL_CALL_PARSE_PATTERN } from "./flags";

/**
 * The pattern is the gate, not the provider id.
 *
 * `LLAMA_CPP_TOOL_CALL_PARSE_PATTERN` matches llama.cpp's own parse error, and
 * the classifier in `flags.ts` already applies it to every provider — that is
 * what strips Transient so the agent stops retrying a deterministic failure.
 * Gating the explanation on `provider === "ollama"` left every other route to
 * the same server (llama-cpp, lmstudio, an OpenAI-compatible local endpoint)
 * showing a bare HTTP 500 while its retry was silently suppressed, and the
 * explanation is the only thing that names the fix.
 */
function rewriteLlamaCppToolCallJsonError(message: string): string {
	if (!LLAMA_CPP_TOOL_CALL_PARSE_PATTERN.test(message)) return message;
	return `The local model emitted malformed tool-call JSON and llama.cpp rejected it (HTTP 500). This is usually a deterministic model-output failure after context degradation, not a transient server outage; reload the model or reduce context, then retry.\n${message}`;
}

/** Inputs that steer {@link formatMessage}'s formatter selection. */
export interface FormatMessageOptions {
	/** When present, the raw request is dumped into the message for 400-class failures. */
	rawRequestDump?: RawHttpRequestDump;
	/** Captured non-2xx response body, appended to the message when available. */
	capturedErrorResponse?: CapturedHttpErrorResponse;
	/** Provider id; gates provider-specific user-facing rewrites. */
	provider?: string;
}

/**
 * Format a provider error into a user-facing message, unifying the three
 * formatters: lightweight retry-after extraction, the raw-dump finalizer, and
 * the copilot rewrite.
 *
 * Selection is driven by inputs, not a mode flag: a `rawRequestDump` routes
 * through {@link finalizeErrorMessage} (retry-after + raw dump + captured body),
 * otherwise the lightweight {@link formatErrorMessageWithRetryAfter} is used.
 */
export async function formatMessage(error: unknown, opts: FormatMessageOptions = {}): Promise<string> {
	let message = opts.rawRequestDump
		? await finalizeErrorMessage(error, opts.rawRequestDump, opts.capturedErrorResponse)
		: formatErrorMessageWithRetryAfter(error);
	if (opts.provider === "github-copilot") {
		message = rewriteCopilotError(message, error, opts.provider);
	}
	return rewriteLlamaCppToolCallJsonError(message);
}
