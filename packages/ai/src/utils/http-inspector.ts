import * as path from "node:path";
import { getLogsDir } from "@veyyon/utils/dirs";
import { isBunTestRuntime } from "@veyyon/utils/env";
import { asRecord, errorMessage, getNonBlankStringProperty, isRecord } from "@veyyon/utils/type-guards";
import * as AIError from "../error/flags";
import { redactDiagnosticHeaders } from "./request-debug.js";
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

export function materializeDumpBody(
	dump: RawHttpRequestDump | undefined,
	wireBodyJson: string | undefined,
): RawHttpRequestDump | undefined {
	if (!dump || wireBodyJson === undefined) return dump;
	if (dump.body !== undefined) return dump;
	try {
		dump.body = JSON.parse(wireBodyJson) as unknown;
	} catch {}
	return dump;
}

export type CapturedHttpErrorResponse = {
	status: number;
	headers?: Headers;
	bodyText?: string;
	bodyJson?: unknown;
};

export async function captureHttpErrorResponse(response: Response): Promise<CapturedHttpErrorResponse> {
	let bodyText: string | undefined;
	let bodyJson: unknown;
	try {
		bodyText = await response.text();
		if (bodyText.trim().length > 0) {
			try {
				bodyJson = JSON.parse(bodyText) as unknown;
			} catch {}
		} else {
			bodyText = undefined;
		}
	} catch {}
	return { status: response.status, headers: response.headers, bodyText, bodyJson };
}

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

export function shouldDumpRejectedRequest(error: unknown): boolean {
	const status = AIError.status(error);
	return status === 400 || status === 413;
}

export async function appendRawHttpRequestDumpFor400(
	message: string,
	error: unknown,
	dump: RawHttpRequestDump | undefined,
): Promise<string> {
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

export function rewriteCopilotError(errorMessage: string, error: unknown, provider: string): string {
	if (provider !== "github-copilot") return errorMessage;
	const status = AIError.status(error);
	if (status === 401) {
		return `GitHub Copilot authentication failed (HTTP 401). Your token may have been revoked. Please re-login with /login github-copilot`;
	}
	if (status === 403) {
		return `GitHub Copilot access denied (HTTP 403). Your account may not have access to this model or feature. Check your Copilot plan or model policy settings.`;
	}
	if (AIError.isCopilotTransientModelError(error)) {
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
	return redactDiagnosticHeaders(Object.entries(headers));
}

function formatCapturedHttpError(captured: CapturedHttpErrorResponse | undefined): string | undefined {
	if (!captured) return undefined;
	const bodyText = captured.bodyText?.trim();
	if (!bodyText) return undefined;
	const payload = parseCapturedErrorPayload(captured);
	if (!payload) return bodyText;

	const errorPayload = asRecord(payload.error) ?? payload;
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
		return asRecord(JSON.parse(captured.bodyText)) ?? undefined;
	} catch {
		return undefined;
	}
}
