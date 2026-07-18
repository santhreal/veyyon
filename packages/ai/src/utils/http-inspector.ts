import * as path from "node:path";
import {
	asRecord,
	errorMessage,
	getLogsDir,
	getNonBlankStringProperty,
	isBunTestRuntime,
	isRecord,
} from "@veyyon/utils";
import * as AIError from "../error/flags";
import { isCopilotTransientModelError } from "./retry.js";
import { formatErrorMessageWithRetryAfter } from "./retry-after.js";

export type RawHttpRequestDump = {
	provider: string;
	api: string;
	model: string;
	method?: string;
	url?: string;
	headers?: Record<string, string>;
	body?: unknown;
};

export type CapturedHttpErrorResponse = {
	status: number;
	headers?: Headers;
	bodyText?: string;
	bodyJson?: unknown;
};

/**
 * Capture a non-2xx response body for error reporting. The body is read once;
 * a JSON body is parsed opportunistically (a non-JSON or unreadable body still
 * yields a useful capture — the caller is already on an error path, so capture
 * failures degrade to a status-only record rather than masking the HTTP error).
 */
export async function captureHttpErrorResponse(response: Response): Promise<CapturedHttpErrorResponse> {
	let bodyText: string | undefined;
	let bodyJson: unknown;
	try {
		bodyText = await response.text();
		if (bodyText.trim().length > 0) {
			try {
				bodyJson = JSON.parse(bodyText) as unknown;
			} catch {
				// Non-JSON error body: keep the raw text.
			}
		} else {
			bodyText = undefined;
		}
	} catch {
		// Body unreadable (already consumed / stream fault): status-only capture.
	}
	return { status: response.status, headers: response.headers, bodyText, bodyJson };
}

const SENSITIVE_HEADERS = ["authorization", "x-api-key", "api-key", "cookie", "set-cookie", "proxy-authorization"];

/**
 * Build the JSON persisted for a rejected request. Request fields stay at the
 * top level (so existing dump parsers still read `body`); the provider's error
 * is added under `errorResponse` so a failed request is diagnosable from the
 * dump file rather than the request alone.
 */
export function buildHttp400DumpPayload(
	dump: RawHttpRequestDump,
	error: unknown,
	message: string,
): RawHttpRequestDump & { errorResponse: { status: number | undefined; message: string } } {
	return {
		...sanitizeDump(dump),
		errorResponse: { status: AIError.status(error), message },
	};
}

/** HTTP statuses whose rejected request we persist for post-hoc diagnosis: the
 *  request-content rejections that wedge a session. 400 (bad request) and 413
 *  (payload too large — an oversized image / snapcompact frame payload that 413s
 *  and empties the turn). Auth (401/403), not-found (404), rate limits and 5xx
 *  are excluded: 429/5xx are retried, so persisting them here would write one
 *  dump per attempt. */
export function shouldDumpRejectedRequest(error: unknown): boolean {
	const status = AIError.status(error);
	return status === 400 || status === 413;
}

export async function appendRawHttpRequestDumpFor400(
	message: string,
	error: unknown,
	dump: RawHttpRequestDump | undefined,
): Promise<string> {
	// Never persist dumps under the test runner: providers exercise the 400 path
	if (!dump || isBunTestRuntime() || !shouldDumpRejectedRequest(error)) {
		return message;
	}

	const payload = buildHttp400DumpPayload(dump, error, message);
	const fileName = `${Date.now()}-${Bun.hash(JSON.stringify(payload)).toString(36)}.json`;
	const filePath = path.join(getLogsDir(), "http-400-requests", fileName);

	try {
		await Bun.write(filePath, `${JSON.stringify(payload, null, 2)}\n`);
		return `${message}\nraw-http-request=${filePath}`;
	} catch (writeError) {
		return `${message}\nraw-http-request-save-failed=${errorMessage(writeError)}`;
	}
}

export async function finalizeErrorMessage(
	error: unknown,
	rawRequestDump: RawHttpRequestDump | undefined,
	capturedErrorResponse?: CapturedHttpErrorResponse,
): Promise<string> {
	let message = formatErrorMessageWithRetryAfter(error, capturedErrorResponse?.headers);
	const capturedMessage = formatCapturedHttpError(capturedErrorResponse);
	if (capturedMessage) {
		if (/\bstatus code\s*\(no body\)/i.test(message)) {
			message = `${capturedErrorResponse?.status ?? "HTTP"} status code: ${capturedMessage}`;
		} else if (!message.includes(capturedMessage)) {
			message = `${message}\n${capturedMessage}`;
		}
	}
	return appendRawHttpRequestDumpFor400(message, error, rawRequestDump);
}

/**
 * Rewrite error message for GitHub Copilot request failures.
 * Must run AFTER finalizeErrorMessage since it replaces the message entirely.
 *
 * 400 `model_not_supported` = Copilot routing rollout gap for our OAuth client.
 *        A preview model (gpt-5.3-codex, gpt-5.4*, ...) flaps between 200 and
 *        400 because only some of Copilot's backends have the model. After the
 *        in-request retry exhausts, surface guidance rather than the raw error.
 * 401 = token invalid/expired → credential removal is safe, prompt re-login.
 * 403 = token valid but access denied (plan, model policy, org restriction) →
 *       do NOT reuse the auth-failed string (which triggers credential removal).
 */
export function rewriteCopilotError(errorMessage: string, error: unknown, provider: string): string {
	if (provider !== "github-copilot") return errorMessage;
	const status = AIError.status(error);
	if (status === 401) {
		return `GitHub Copilot authentication failed (HTTP 401). Your token may have been revoked. Please re-login with /login github-copilot`;
	}
	if (status === 403) {
		return `GitHub Copilot access denied (HTTP 403). Your account may not have access to this model or feature. Check your Copilot plan or model policy settings.`;
	}
	if (isCopilotTransientModelError(error)) {
		return `GitHub Copilot rejected this model (HTTP 400 model_not_supported) after retries. This is a known intermittent rollout gap for preview models on OAuth clients other than VS Code. Try again in a few seconds, switch to a GA model (gpt-5-mini, gpt-5.2), or run this model from VS Code.`;
	}
	return errorMessage;
}

function sanitizeDump(dump: RawHttpRequestDump): RawHttpRequestDump {
	return {
		...dump,
		headers: redactHeaders(dump.headers),
	};
}

function redactHeaders(headers: Record<string, string> | undefined): Record<string, string> | undefined {
	if (!headers) {
		return undefined;
	}

	const redacted: Record<string, string> = {};
	for (const [key, value] of Object.entries(headers)) {
		if (SENSITIVE_HEADERS.includes(key.toLowerCase())) {
			redacted[key] = "[redacted]";
			continue;
		}
		redacted[key] = value;
	}
	return redacted;
}

function formatCapturedHttpError(captured: CapturedHttpErrorResponse | undefined): string | undefined {
	if (!captured) return undefined;
	const bodyText = captured.bodyText?.trim();
	if (!bodyText) return undefined;
	const payload = parseCapturedErrorPayload(captured);
	if (!payload) return bodyText;

	const errorPayload = asRecord(payload.error) ?? payload;
	// {"error": "string"} — the error value is a plain string, not a nested object.
	// Fall back to it when the structured fields ("message", etc.) are absent.
	const stringError = errorPayload === payload ? getNonBlankStringProperty(payload, "error") : undefined;
	const message =
		getNonBlankStringProperty(errorPayload, "message") ??
		getNonBlankStringProperty(payload, "message") ??
		stringError ??
		bodyText;
	const extras = (["type", "param", "code"] as const)
		.map(field => {
			const value = getNonBlankStringProperty(errorPayload, field) ?? getNonBlankStringProperty(payload, field);
			return value === undefined ? undefined : `${field}=${value}`;
		})
		.filter((entry): entry is string => entry !== undefined);
	return extras.length > 0 ? `${message} (${extras.join(" ")})` : message;
}

function parseCapturedErrorPayload(captured: CapturedHttpErrorResponse): Record<string, unknown> | undefined {
	if (isRecord(captured.bodyJson)) {
		return captured.bodyJson;
	}
	if (!captured.bodyText) return undefined;
	try {
		// Data tolerance: an error body is provider-controlled text; non-JSON
		// falls through to the raw-bodyText rendering above.
		return asRecord(JSON.parse(captured.bodyText)) ?? undefined;
	} catch {
		return undefined;
	}
}
