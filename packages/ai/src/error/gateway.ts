import { isAbortError } from "@veyyon/utils/abortable";
import { errorMessage } from "@veyyon/utils/type-guards";
import { isUsageLimit } from "./flags";

export interface GatewayErrorClassification {
	status: number;
	type: string;
	message: string;
}

export function classifyGatewayError(err: unknown): GatewayErrorClassification {
	const message = errorMessage(err);

	const statusProp =
		typeof err === "object" && err !== null && typeof (err as { status?: unknown }).status === "number"
			? (err as { status: number }).status | 0
			: undefined;
	if (statusProp !== undefined) return bucketStatus(statusProp, message);

	if (isAbortError(err)) return { status: 499, type: "request_aborted", message };

	const embedded = extractEmbeddedStatus(message);
	if (embedded !== undefined) return bucketStatus(embedded, message);

	if (/\baborted\b|\babort signal\b/i.test(message)) {
		return { status: 499, type: "request_aborted", message };
	}
	if (
		/\brate[- _]?limit(?:s|ed|ing)?\b|\bquota(?:_exceeded| exceeded)?\b|\btoo[- _]many[- _]requests\b/i.test(
			message,
		) ||
		isUsageLimit(message)
	) {
		return { status: 429, type: "rate_limit_error", message };
	}
	if (/\b(?:unauthorized|forbidden)\b/i.test(message)) {
		return { status: 401, type: "authentication_error", message };
	}
	if (/\b(?:unsupported|invalid_request|invalid request|bad request|malformed)\b/i.test(message)) {
		return { status: 400, type: "invalid_request_error", message };
	}
	return { status: 502, type: "upstream_error", message };
}

function bucketStatus(status: number, message: string): GatewayErrorClassification {
	if (status === 401 || status === 403) return { status, type: "authentication_error", message };
	if (status === 429) return { status, type: "rate_limit_error", message };
	if (status >= 400 && status < 500) return { status, type: "invalid_request_error", message };
	if (status >= 500) return { status, type: "upstream_error", message };
	return { status: 502, type: "upstream_error", message };
}

function extractEmbeddedStatus(message: string): number | undefined {
	const re = /(?:\bHTTP\b|\bAPI error\b|\bstatus(?:[- _]?code)?\b)\s*[:=]?\s*\(?\s*(\d{3})\b|\((\d{3})\)/i;
	const m = message.match(re);
	if (!m) return undefined;
	const raw = m[1] ?? m[2];
	if (!raw) return undefined;
	const code = Number.parseInt(raw, 10);
	return Number.isFinite(code) && code >= 100 && code < 600 ? code : undefined;
}
