/**
 * One reader for the body of a failed HTTP response, bounded before it is allocated.
 *
 * WHAT WAS WRONG. Every non-2xx path in this package called `await response.text()`.
 * That reads the whole body first and caps it afterwards, so the cap bounded the
 * MESSAGE and nothing bounded the READ: a 100 MB error page — a captive portal, a
 * misrouted gateway, a proxy dumping the request back at you, or a hostile endpoint —
 * was decoded into one string before a single character was thrown away. The string
 * then reached `Error.message`, the assistant turn, the session file and the TUI.
 *
 * Two things follow from reading a stranger's bytes, and both are handled here rather
 * than at twenty call sites:
 *
 *  - **The read is bounded.** At most {@link MAX_PROVIDER_ERROR_BODY_BYTES} are pulled
 *    off the stream and the rest is cancelled, so the allocation is bounded by a
 *    constant instead of by whatever the server decided to send. Decoding is
 *    incremental, so a multibyte character split across the cap does not become a
 *    replacement character in the middle of a word.
 *  - **The text is answerable to a terminal and to a bug report.** Control bytes and
 *    escape sequences are stripped, because an error body is rendered in the TUI and a
 *    body that repositions the cursor or sets a scroll region is an attack on the
 *    display. Credential-shaped runs are redacted, because a proxy that echoes the
 *    request back — `Authorization: Bearer …` in an HTML dump is the common one — moves
 *    the key into a log file the operator then attaches to an issue.
 *
 * WHAT IS DELIBERATELY NOT DONE. The status, the status text, and a provider's own
 * structured `code` are never touched: they are the diagnosis, and a small JSON
 * envelope survives this path byte for byte apart from a redaction. Truncation is
 * always visible and always says how much was read, because silent truncation and a
 * genuinely terse body look identical to the person reading the message.
 */
// The sanitizer leaf, NOT the `@veyyon/utils` barrel. Every error class imports this
// module, and the barrel would drag the whole utils graph behind an error message.
import { sanitizeText } from "@veyyon/utils/sanitize-text";
import { boundProviderErrorDetail, MAX_PROVIDER_ERROR_DETAIL_CHARS } from "./detail-bounds";

/**
 * Ceiling on bytes pulled off a failed response.
 *
 * 64 KiB is far above any provider's error envelope — the largest real one observed
 * here is a Google `error.details` array under 8 KiB — and far below a size worth
 * allocating. The character cap in {@link boundProviderErrorDetail} still applies to
 * what an operator reads; this is the bound on what is read at all.
 */
export const MAX_PROVIDER_ERROR_BODY_BYTES = 64 * 1024;

/** How a redacted run is spelled, matching the request-debug dumps. */
function redacted(length: number): string {
	return `<redacted ${length} chars>`;
}

/**
 * A family of credential-shaped text redacted out of a provider's error body.
 *
 * The list is exported so a test can sweep it at run time: adding a family without a
 * sample that proves it redacts turns that sweep red. Each `redact` is total — it is
 * given the whole body and returns it with its own family removed.
 */
export interface ProviderSecretFamily {
	readonly name: string;
	readonly redact: (text: string) => string;
}

/** `Authorization: <value>`, and the same header echoed with `=`. */
const LABELLED_CREDENTIAL = /((?:authorization|proxy-authorization|cookie)\s*[:=]\s*)(?:["']?)([^\s"',;]+)/gi;
/** `x-api-key`, `api_key`, `access-token`, `auth-token`, however the echo spells it. */
const LABELLED_KEY =
	/((?:x-)?(?:api[-_]?key|access[-_]?token|auth[-_]?token|refresh[-_]?token|client[-_]?secret)\s*[:=]\s*)(?:["']?)([^\s"',;]+)/gi;
/** A bearer token wherever it appears, including inside a JSON string. */
const BEARER = /(bearer\s+)([A-Za-z0-9._~+/=-]{8,})/gi;
/** A three-segment JWT, which is what most of the above actually carry. */
const JWT = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/g;
/** Vendor key prefixes, which are recognisable with no label at all. */
const PREFIXED_KEY =
	/\b(?:sk-ant-[A-Za-z0-9_-]{16,}|sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{16,}|AIza[A-Za-z0-9_-]{20,}|ya29\.[A-Za-z0-9_-]{20,}|xox[baprse]-[A-Za-z0-9-]{10,}|(?:AKIA|ASIA)[0-9A-Z]{12,})/g;

/**
 * Every credential family stripped from an error body, in the order applied.
 *
 * Labelled forms run first so `Authorization: Bearer <jwt>` is redacted once as a
 * header value rather than three times in pieces.
 */
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

/**
 * Remove every credential-shaped run from text that came off the wire.
 *
 * This is not a general secret scanner and does not pretend to be one. It covers the
 * shapes a server actually echoes back: the request's own auth headers, a bearer
 * token, a JWT, and the vendor prefixes that are identifiable on their own.
 */
export function redactProviderSecrets(text: string): string {
	let redactedText = text;
	for (const family of PROVIDER_SECRET_FAMILIES) redactedText = family.redact(redactedText);
	return redactedText;
}

/**
 * The part of a response a bounded error-body read touches.
 *
 * Structural rather than `Response` because the caller is often holding a clone, and a clone's type
 * comes from whichever fetch typings the package resolves. Widening the parameter is honest about
 * what the read needs; casting the argument would be a claim about the whole interface.
 */
export interface ReadableErrorResponse {
	body: ReadableStream<Uint8Array> | null;
	headers: { get(name: string): string | null };
	text(): Promise<string>;
}

/** What a bounded read of a failed response produced. */
export interface ProviderErrorBody {
	/**
	 * Sanitized, redacted body text, capped by the byte ceiling but not by the
	 * character ceiling. This is what a provider parses when it wants its own
	 * structured `message` and `code`.
	 */
	readonly text: string;
	/**
	 * The same content prepared for an `Error.message`: character-capped, and carrying
	 * a visible note when the read stopped early. Never empty — an absent body reads
	 * as the `NO_PROVIDER_ERROR_DETAIL` sentinel from `detail-bounds`.
	 */
	readonly detail: string;
	/** Bytes actually pulled off the stream. */
	readonly bytesRead: number;
	/** Whether bytes were left unread on the wire. */
	readonly truncated: boolean;
	/** The server's `content-length`, when it sent one and it parsed. */
	readonly declaredBytes: number | undefined;
}

function declaredLength(response: ReadableErrorResponse): number | undefined {
	const header = response.headers.get("content-length");
	if (header === null) return undefined;
	const parsed = Number.parseInt(header, 10);
	return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

/**
 * One note for every cut the body took, in one bracket.
 *
 * Two cuts can happen to the same body: the read stopped at the byte ceiling, and
 * what it did read was longer than a message may carry. Reporting them separately
 * produced two adjacent `[truncated, …]` brackets whose numbers disagreed — the
 * character note called the truncated read the whole body. One note states what
 * reached the message and what never came off the wire.
 *
 * With a `content-length` the unread count is exact. Without one — a chunked error
 * page, which is the usual shape of the enormous ones — the honest statement is
 * where the read stopped, not a number nobody measured.
 */
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
		// A response with no stream — synthesized in a test, or already buffered by the
		// runtime. There is nothing to stop reading, so cap what is there.
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
	// Incremental decode: a character split across the cap or across two chunks is
	// completed rather than turned into a replacement character.
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
			// The loop stopped exactly at the ceiling. One more read distinguishes a body
			// that happened to be that size from one that has more to give, so a body of
			// exactly the cap is not reported as truncated.
			const probe = await reader.read();
			if (!probe.done) truncated = true;
		}
		// The flush of a sequence cut by the ceiling would otherwise arrive as U+FFFD in the
		// middle of a word. The split character is dropped instead: it is one character of a
		// body that is already being truncated, and a replacement character reads as
		// corruption the provider did not send.
		text += decoder.decode().replaceAll("\ufffd", "");
	} catch {
		// A stream that fails mid-read leaves what it already gave. Replacing the
		// status with a read error is the one thing that must not happen: the status is
		// the diagnosis and the body was only ever context.
	} finally {
		await reader.cancel().catch(() => {});
	}
	return { text, bytesRead, truncated };
}

/**
 * Read a failed response's body under a byte ceiling, sanitized and redacted.
 *
 * Never throws and never rejects: a body that cannot be read degrades to an absent
 * detail, because a read error must not replace the status that caused the failure.
 */
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

/**
 * The detail for a body whose read stopped early: at most the character ceiling of
 * what was read, plus the one note naming both cuts. An empty read is the note on its
 * own — a proxy that sent a length and then nothing is still worth saying out loud.
 */
function boundedWithNote(text: string, bytesRead: number, declaredBytes: number | undefined): string {
	const trimmed = text.trim();
	if (trimmed.length === 0) return truncationNote(0, 0, bytesRead, declaredBytes);
	const shown = Math.min(trimmed.length, MAX_PROVIDER_ERROR_DETAIL_CHARS);
	return `${trimmed.slice(0, shown)} ${truncationNote(shown, trimmed.length, bytesRead, declaredBytes)}`;
}

/**
 * The bounded body's operator-facing detail, for a call site that wants one string.
 *
 * The overwhelmingly common shape at a call site is interpolating one detail into one
 * message, and a helper for it keeps `readProviderErrorBody`'s richer result from
 * being destructured twenty times for the same field.
 */
export async function readProviderErrorDetail(response: Response, options?: { maxBytes?: number }): Promise<string> {
	return (await readProviderErrorBody(response, options)).detail;
}
