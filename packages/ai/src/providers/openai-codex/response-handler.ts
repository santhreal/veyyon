import { toNumber } from "@veyyon/catalog/utils";
import { boundProviderErrorDetail, ProviderHttpError, readProviderErrorBody } from "../../error";

export type CodexRateLimit = {
	used_percent?: number;
	window_minutes?: number;
	resets_at?: number;
};

export type CodexRateLimits = {
	primary?: CodexRateLimit;
	secondary?: CodexRateLimit;
};

export type CodexErrorInfo = {
	message: string;
	status: number;
	/** Machine-readable error code (`error.code` or `error.type` from the response body), when present. */
	code?: string;
	friendlyMessage?: string;
	rateLimits?: CodexRateLimits;
	raw?: string;
};

/** Non-2xx response from the Codex backend, with the parsed body retained. */
export class CodexApiError extends ProviderHttpError {
	readonly info: CodexErrorInfo;

	constructor(info: CodexErrorInfo, headers?: Headers) {
		super(info.friendlyMessage || info.message, info.status, { headers, code: info.code });
		this.name = "CodexApiError";
		this.info = info;
	}

	static async fromResponse(response: Response): Promise<CodexApiError> {
		return new CodexApiError(await parseCodexError(response), response.headers);
	}
}

export async function parseCodexError(response: Response): Promise<CodexErrorInfo> {
	const body = await readProviderErrorBody(response);
	const raw = body.text;
	// Until a Codex envelope supplies a better one, the body IS the message — which is
	// the proxy-HTML case, so the operator-facing form is what is kept: capped, control
	// bytes stripped, credentials redacted, and carrying the note when the read stopped.
	let message = raw ? body.detail : response.statusText || "Request failed";
	let friendlyMessage: string | undefined;
	let rateLimits: CodexRateLimits | undefined;
	let errorCode: string | undefined;

	try {
		const parsed = JSON.parse(raw) as { error?: Record<string, unknown> };
		const err = parsed?.error ?? {};

		const headers = response.headers;
		const primary = {
			used_percent: toNumber(headers.get("x-codex-primary-used-percent")),
			window_minutes: toInt(headers.get("x-codex-primary-window-minutes")),
			resets_at: toInt(headers.get("x-codex-primary-reset-at")),
		};
		const secondary = {
			used_percent: toNumber(headers.get("x-codex-secondary-used-percent")),
			window_minutes: toInt(headers.get("x-codex-secondary-window-minutes")),
			resets_at: toInt(headers.get("x-codex-secondary-reset-at")),
		};
		rateLimits =
			primary.used_percent !== undefined || secondary.used_percent !== undefined
				? { primary, secondary }
				: undefined;

		const code = String((err as { code?: string; type?: string }).code ?? (err as { type?: string }).type ?? "");
		errorCode = code || undefined;
		const resetsAt = (err as { resets_at?: number }).resets_at ?? primary.resets_at ?? secondary.resets_at;
		const mins = resetsAt ? Math.max(0, Math.round((resetsAt * 1000 - Date.now()) / 60000)) : undefined;

		if (/usage_limit_reached|usage_not_included/i.test(code)) {
			const planType = (err as { plan_type?: string }).plan_type;
			const plan = planType ? ` (${String(planType).toLowerCase()} plan)` : "";
			const when = mins !== undefined ? ` Try again in ~${mins} min.` : "";
			friendlyMessage = `You have hit your ChatGPT usage limit${plan}.${when}`.trim();
		} else if (/rate_limit_exceeded/i.test(code) || response.status === 429) {
			const when = mins !== undefined ? ` Try again in ~${mins} min.` : "";
			friendlyMessage = `ChatGPT rate limit exceeded.${when}`.trim();
		}

		const errMessage = (err as { message?: string }).message;
		message = errMessage ? boundProviderErrorDetail(errMessage) : friendlyMessage || message;
	} catch {
		// raw body not JSON
	}

	return {
		// Both routes above are already bounded: the envelope's own message through
		// `boundProviderErrorDetail`, and a non-envelope body through the bounded read.
		// `raw` is the sanitized body, which feeds classification rather than a rendered
		// message.
		message,
		status: response.status,
		code: errorCode,
		friendlyMessage,
		rateLimits,
		raw: raw,
	};
}

function toInt(v: string | null): number | undefined {
	if (v == null) return undefined;
	const n = parseInt(v, 10);
	return Number.isFinite(n) ? n : undefined;
}
