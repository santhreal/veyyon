import { sanitizeText } from "@veyyon/utils/sanitize-text";
import { boundProviderErrorDetail, MAX_PROVIDER_ERROR_DETAIL_CHARS } from "./detail-bounds";

export const MAX_PROVIDER_ERROR_BODY_BYTES = 64 * 1024;

function redacted(length: number): string {
	return `<redacted ${length} chars>`;
}

export interface ProviderSecretFamily {
	readonly name: string;
	readonly redact: (text: string) => string;
}

const LABELLED_CREDENTIAL = /((?:authorization|proxy-authorization|cookie)\s*[:=]\s*)(?:["']?)([^\s"',;]+)/gi;
const LABELLED_KEY =
	/((?:x-)?(?:api[-_]?key|access[-_]?token|auth[-_]?token|refresh[-_]?token|client[-_]?secret)\s*[:=]\s*)(?:["']?)([^\s"',;]+)/gi;
const BEARER = /(bearer\s+)([A-Za-z0-9._~+/=-]{8,})/gi;
const JWT = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/g;
const PREFIXED_KEY =
	/\b(?:sk-ant-[A-Za-z0-9_-]{16,}|sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{16,}|AIza[A-Za-z0-9_-]{20,}|ya29\.[A-Za-z0-9_-]{20,}|xox[baprse]-[A-Za-z0-9-]{10,}|(?:AKIA|ASIA)[0-9A-Z]{12,})/g;

export const PROVIDER_SECRET_FAMILIES: readonly ProviderSecretFamily[] = [
	{
		name: "labelled-credential",
		redact: text =>
			text.replace(
				LABELLED_CREDENTIAL,
				(_match, label: string, value: string) => `${label}${redacted(value.length)}`,
			),
	},
	{
		name: "labelled-key",
		redact: text =>
			text.replace(LABELLED_KEY, (_match, label: string, value: string) => `${label}${redacted(value.length)}`),
	},
	{
		name: "bearer-token",
		redact: text =>
			text.replace(BEARER, (_match, label: string, value: string) => `${label}${redacted(value.length)}`),
	},
	{ name: "jwt", redact: text => text.replace(JWT, match => redacted(match.length)) },
	{ name: "prefixed-key", redact: text => text.replace(PREFIXED_KEY, match => redacted(match.length)) },
];

export function redactProviderSecrets(text: string): string {
	let redactedText = text;
	for (const family of PROVIDER_SECRET_FAMILIES) redactedText = family.redact(redactedText);
	return redactedText;
}

export interface ReadableErrorResponse {
	body: ReadableStream<Uint8Array> | null;
	headers: { get(name: string): string | null };
	text(): Promise<string>;
}

export interface ProviderErrorBody {
	readonly text: string;
	readonly detail: string;
	readonly bytesRead: number;
	readonly truncated: boolean;
	readonly declaredBytes: number | undefined;
}

function declaredLength(response: ReadableErrorResponse): number | undefined {
	const header = response.headers.get("content-length");
	if (header === null) return undefined;
	const parsed = Number.parseInt(header, 10);
	return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function truncationNote(
	shownChars: number,
	readChars: number,
	bytesRead: number,
	declaredBytes: number | undefined,
): string {
	const shown = shownChars < readChars ? `showing ${shownChars} of ${readChars} chars read, ` : "";
	const wire =
		declaredBytes !== undefined && declaredBytes > bytesRead
			? `${declaredBytes - bytesRead} of ${declaredBytes} bytes not read`
			: `read stopped at ${bytesRead} bytes`;
	return `[truncated, ${shown}${wire}]`;
}

async function readBoundedText(
	response: ReadableErrorResponse,
	maxBytes: number,
): Promise<{ text: string; bytesRead: number; truncated: boolean }> {
	const body = response.body;
	if (!body) {
		const whole = await response.text().catch(() => "");
		const encoded = new TextEncoder().encode(whole);
		if (encoded.byteLength <= maxBytes) {
			return { text: whole, bytesRead: encoded.byteLength, truncated: false };
		}
		return {
			text: new TextDecoder().decode(encoded.subarray(0, maxBytes)),
			bytesRead: maxBytes,
			truncated: true,
		};
	}

	const reader = body.getReader();
	const decoder = new TextDecoder();
	let text = "";
	let bytesRead = 0;
	let truncated = false;
	let ended = false;
	try {
		while (bytesRead < maxBytes) {
			const chunk = await reader.read();
			if (chunk.done) {
				ended = true;
				break;
			}
			const value = chunk.value;
			if (value === undefined || value.byteLength === 0) continue;
			const room = maxBytes - bytesRead;
			if (value.byteLength > room) {
				text += decoder.decode(value.subarray(0, room), { stream: true });
				bytesRead += room;
				truncated = true;
				break;
			}
			text += decoder.decode(value, { stream: true });
			bytesRead += value.byteLength;
		}
		if (!ended && !truncated) {
			const probe = await reader.read();
			if (!probe.done) truncated = true;
		}
		text += decoder.decode().replaceAll("\ufffd", "");
	} catch {
	} finally {
		await reader.cancel().catch(() => {});
	}
	return { text, bytesRead, truncated };
}

export async function readProviderErrorBody(
	response: ReadableErrorResponse,
	options?: { maxBytes?: number },
): Promise<ProviderErrorBody> {
	const maxBytes = options?.maxBytes ?? MAX_PROVIDER_ERROR_BODY_BYTES;
	const declaredBytes = declaredLength(response);
	const { text: raw, bytesRead, truncated } = await readBoundedText(response, maxBytes);
	const text = redactProviderSecrets(sanitizeText(raw));
	const detail = truncated ? boundedWithNote(text, bytesRead, declaredBytes) : boundProviderErrorDetail(text);
	return { text, detail, bytesRead, truncated, declaredBytes };
}

function boundedWithNote(text: string, bytesRead: number, declaredBytes: number | undefined): string {
	const trimmed = text.trim();
	if (trimmed.length === 0) return truncationNote(0, 0, bytesRead, declaredBytes);
	const shown = Math.min(trimmed.length, MAX_PROVIDER_ERROR_DETAIL_CHARS);
	return `${trimmed.slice(0, shown)} ${truncationNote(shown, trimmed.length, bytesRead, declaredBytes)}`;
}

export async function readProviderErrorDetail(response: Response, options?: { maxBytes?: number }): Promise<string> {
	return (await readProviderErrorBody(response, options)).detail;
}

export function providerErrorMessage(body: ProviderErrorBody): string {
	const trimmed = body.text.trim();
	if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return body.detail;
	let parsed: unknown;
	try {
		parsed = JSON.parse(trimmed);
	} catch {
		return body.detail;
	}
	const message = extractMessage(parsed);
	return message ? boundProviderErrorDetail(message) : body.detail;
}

function extractMessage(value: unknown): string | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const own = (key: string): unknown =>
		Object.hasOwn(value, key) ? (value as Record<string, unknown>)[key] : undefined;
	const error = own("error");
	if (typeof error === "string" && error.trim()) return error.trim();
	if (typeof error === "object" && error !== null) {
		const nested = Object.hasOwn(error, "message") ? (error as Record<string, unknown>).message : undefined;
		if (typeof nested === "string" && nested.trim()) return nested.trim();
	}
	for (const key of ["message", "detail"]) {
		const candidate = own(key);
		if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
	}
	return undefined;
}
