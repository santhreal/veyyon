/**
 * Shared types and utilities for web-fetch handlers
 */
import { scheduler } from "node:timers/promises";
import { isCancellation } from "@veyyon/utils/abortable";
// Owners, not the `@veyyon/utils` barrel: 3 modules against 74.
import { clamp } from "@veyyon/utils/math";
import { errorMessage } from "@veyyon/utils/type-guards";
import type TurndownService from "turndown";

import type { AgentStorage } from "../../session/agent-storage";
import { ToolAbortError, throwIfAborted } from "../../tools/tool-errors";
import { isTimeoutError, scopedTimeoutSignal } from "../../utils/fetch-timeout";
import { CHROME_WINDOWS_USER_AGENT } from "../search/providers/browser-headers";

export { formatNumber } from "@veyyon/utils/format";

export interface RenderResult {
	url: string;
	finalUrl: string;
	contentType: string;
	method: string;
	content: string;
	fetchedAt: string;
	truncated: boolean;
	notes: string[];
}

/**
 * Loud degrade marker: the handler MATCHED the url but could not scrape it
 * (upstream HTTP failure, response-shape drift, thrown error). The dispatcher
 * surfaces the note on the generic-fetch result so the degrade is operator
 * visible instead of indistinguishable from a URL non-match. Recall is
 * preserved — the generic fetch still runs — but never silently.
 */
export interface ScraperDegrade {
	readonly scraperDegrade: true;
	readonly note: string;
}

/**
 * The result a site handler returns when it MATCHED the URL and could not scrape it.
 *
 * The dispatcher puts the note on the generic-fetch result, so the user learns the
 * structured path was available and broke. Returning `null` instead would read as
 * "no handler claims this site" and degrade silently.
 *
 * A cancellation is rethrown rather than described. Handlers call this from a
 * blanket `catch (error)`, which also catches the user's Ctrl-C and every deadline
 * that fires mid-request; turning those into a degrade told the dispatcher to fall
 * through to the generic fetch and make the very request that was just cancelled.
 * `isCancellation` is the repo-wide owner of that test.
 */
export function scraperDegrade(site: string, reason: unknown): ScraperDegrade {
	if (reason instanceof ToolAbortError || isCancellation(reason)) throw reason;
	const detail = errorMessage(reason);
	return { scraperDegrade: true, note: `${site} scraper failed (${detail}); fell back to a generic fetch` };
}

/** Describe a failed {@link loadPage} result for a degrade note. */
export function loadFailure(result: { status?: number; error?: string }): string {
	if (result.status) return `HTTP ${result.status}`;
	return result.error ?? "fetch failed";
}

export function isScraperDegrade(value: unknown): value is ScraperDegrade {
	return typeof value === "object" && value !== null && (value as ScraperDegrade).scraperDegrade === true;
}

/** Parse a URL, returning null on invalid input (a non-match, not a degrade). */
/**
 * Parse a URL, or `null` when the string is not one.
 *
 * This is the ONE place a scraper decides "that is not a URL", and every URL classifier in this
 * directory starts with it. That matters more than it looks: the classifiers used to ALSO wrap their
 * whole body in `try { ... } catch { return null }`, and since the parse verdict already lives here,
 * that outer catch could only swallow a bug in the classifier itself -- a crash while picking apart the
 * path read as "this is not a GitHub URL", the structured handler was skipped, and the page was fetched
 * as anonymous HTML with all of its issue, PR and Actions handling silently gone. Those catches are gone
 * now. A classifier that throws is a bug that should reach the operator, and `null` means exactly one
 * thing: this URL is not the shape I handle.
 */
export function tryParseUrl(url: string): URL | null {
	try {
		return new URL(url);
	} catch {
		// The throw IS the answer being asked for; there is nothing here to report.
		return null;
	}
}

export type SpecialHandler = (
	url: string,
	timeout: number,
	signal?: AbortSignal,
	storage?: AgentStorage | null,
) => Promise<RenderResult | ScraperDegrade | null>;

export const MAX_OUTPUT_CHARS = 500_000;
export const MAX_BYTES = 50 * 1024 * 1024;

/**
 * Escalation ladder for a page that answers as though we are a bot: plain curl, then a polite bot, then a real
 * browser. Only the last rung has to get through, so its Chrome version comes from the one place that states
 * what browser this tree claims to be rather than from a literal here that went eighteen releases stale.
 */
const USER_AGENTS = ["curl/8.0", "Mozilla/5.0 (compatible; TextBot/1.0)", CHROME_WINDOWS_USER_AGENT];

function isBotBlocked(status: number, content: string): boolean {
	if (status === 403 || status === 503) {
		const lower = content.toLowerCase();
		return (
			lower.includes("cloudflare") ||
			lower.includes("captcha") ||
			lower.includes("challenge") ||
			lower.includes("blocked") ||
			lower.includes("access denied") ||
			lower.includes("bot detection")
		);
	}
	return false;
}

/**
 * Truncate and cleanup output
 */
export function finalizeOutput(content: string): { content: string; truncated: boolean } {
	const cleaned = content.replace(/\n{3,}/g, "\n\n").trim();
	const truncated = cleaned.length > MAX_OUTPUT_CHARS;
	return {
		content: cleaned.slice(0, MAX_OUTPUT_CHARS),
		truncated,
	};
}

export interface LoadPageOptions {
	timeout?: number;
	headers?: Record<string, string>;
	method?: string;
	body?: string;
	maxBytes?: number;
	signal?: AbortSignal;
	/**
	 * Return true to skip reading the response body for this content type
	 * (lowercased mime, no params). The caller is expected to re-fetch the
	 * payload as binary; this avoids streaming + decoding huge binaries twice.
	 */
	skipBodyForContentType?: (contentType: string) => boolean;
}

export interface LoadPageResult {
	content: string;
	contentType: string;
	finalUrl: string;
	ok: boolean;
	status?: number;
	/** True when the body was cut mid-stream at maxBytes. */
	truncated?: boolean;
	/** Last transport-level error message when ok is false. */
	error?: string;
	/** True when the body read was skipped via skipBodyForContentType. */
	bodySkipped?: boolean;
}

const RETRY_AFTER_MAX_MS = 10_000;

/** Parse a Retry-After header (seconds or HTTP-date) into a bounded delay. */
function parseRetryAfterMs(value: string | null): number {
	if (!value) return 1_000;
	const seconds = Number(value);
	if (Number.isFinite(seconds)) return Math.min(Math.max(seconds, 0) * 1000, RETRY_AFTER_MAX_MS);
	const date = Date.parse(value);
	if (!Number.isNaN(date)) return clamp(date - Date.now(), 0, RETRY_AFTER_MAX_MS);
	return 1_000;
}

function charsetFromContentType(header: string): string | undefined {
	return /charset\s*=\s*"?([\w-]+)"?/i.exec(header)?.[1];
}

/**
 * Decode a response body honoring the declared charset (Content-Type header,
 * then a cheap <meta charset> sniff), falling back to UTF-8.
 */
function decodeBody(bytes: Buffer, contentTypeHeader: string): string {
	let label = charsetFromContentType(contentTypeHeader);
	if (!label) {
		// All charsets we can decode are ASCII-compatible in the prefix, so a
		// latin1 view of the first 2KB is enough to find a <meta charset>.
		label = /<meta[^>]+charset\s*=\s*["']?([\w-]+)/i.exec(bytes.subarray(0, 2048).toString("latin1"))?.[1];
	}
	if (label && !/^utf-?8$/i.test(label)) {
		try {
			// Bun.Encoding's union is narrower than the runtime, which accepts
			// WHATWG labels (shift_jis, euc-kr, gbk, big5, …); unknowns throw here.
			return new TextDecoder(label as Bun.Encoding).decode(bytes);
		} catch {
			// Unknown/unsupported label — fall back to UTF-8.
		}
	}
	return bytes.toString("utf-8");
}

/**
 * Fetch a page with a timeout and a size limit.
 *
 * `timeout` is a per-attempt budget AND the whole call's ceiling: an attempt that
 * exhausts it ends the call, so `loadPage(url, { timeout: 20 })` cannot take a
 * minute. Attempts exist for one reason, a site that answers differently to a
 * different `User-Agent`, so the loop advances only on a bot block or an ordinary
 * transport error, never on a deadline.
 *
 * Failures come back as `{ ok: false, error }` because a site being unreachable is
 * an answer the caller reports. Cancellation is the exception and throws: the
 * caller's signal aborting means nobody is waiting for the answer.
 */
export async function loadPage(url: string, options: LoadPageOptions = {}): Promise<LoadPageResult> {
	const { timeout = 20, headers = {}, maxBytes = MAX_BYTES, signal, method = "GET", body } = options;

	let lastError: string | undefined;
	let retried429 = false;
	for (let attempt = 0; attempt < USER_AGENTS.length; attempt++) {
		throwIfAborted(signal, "loadPage");

		const userAgent = USER_AGENTS[attempt];
		// Scoped per attempt so the deadline timer is cleared on settle instead
		// of staying armed like a bare AbortSignal.timeout; the fence spans the
		// streamed body read below.
		const requestTimeout = scopedTimeoutSignal(timeout * 1000, signal);

		try {
			const requestInit: RequestInit = {
				signal: requestTimeout.signal,
				method,
				headers: {
					"User-Agent": userAgent,
					Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
					"Accept-Language": "en-US,en;q=0.5",
					"Accept-Encoding": "identity", // Cloudflare Markdown-for-Agents returns corrupted bytes when compression is negotiated
					...headers,
				},
				redirect: "follow",
			};

			if (body !== undefined) {
				requestInit.body = body;
			}

			const response = await fetch(url, requestInit);

			const rawContentType = response.headers.get("content-type") ?? "";
			const contentType = rawContentType.split(";")[0]?.trim().toLowerCase() ?? "";
			const finalUrl = response.url;

			if (response.status === 429 && !retried429) {
				// Rate limited: retry once, honoring a bounded Retry-After. The
				// wait observes the caller's signal so an Esc during the backoff
				// does not stall for up to the full delay.
				retried429 = true;
				const delayMs = parseRetryAfterMs(response.headers.get("retry-after"));
				void response.body?.cancel().catch(() => {});
				try {
					await scheduler.wait(delayMs, { signal });
				} catch (error) {
					// `scheduler.wait` rejects when the caller's signal aborts, which is
					// the case worth naming: `throwIfAborted` keeps `signal.reason` as the
					// cause so the user learns WHY the wait ended. Minting a bare
					// `ToolAbortError` here threw that reason away, and it also relabelled
					// any other rejection as a user abort.
					throwIfAborted(signal, "loadPage");
					throw error;
				}
				attempt--; // Reuse the same user agent for the retry.
				continue;
			}

			if (response.ok && options.skipBodyForContentType?.(contentType)) {
				void response.body?.cancel().catch(() => {});
				return { content: "", contentType, finalUrl, ok: true, status: response.status, bodySkipped: true };
			}

			const reader = response.body?.getReader();
			if (!reader) {
				return { content: "", contentType, finalUrl, ok: false, status: response.status };
			}

			const chunks: Uint8Array[] = [];
			let totalSize = 0;
			let truncated = false;

			while (true) {
				const { done, value } = await reader.read();
				if (done) break;

				chunks.push(value);
				totalSize += value.length;

				if (totalSize > maxBytes) {
					truncated = true;
					// The size cap is reached, `truncated` is set, and the bytes collected so far are returned. A
					// cancel that fails only means the stream ended on its own; the result is unaffected.
					void reader.cancel().catch(() => {});
					break;
				}
			}

			const content = decodeBody(Buffer.concat(chunks), rawContentType);
			if (isBotBlocked(response.status, content) && attempt < USER_AGENTS.length - 1) {
				continue;
			}

			if (!response.ok) {
				return { content, contentType, finalUrl, ok: false, status: response.status, truncated };
			}

			return { content, contentType, finalUrl, ok: true, status: response.status, truncated };
		} catch (error) {
			// The caller stopping us ends everything, and `signal.reason` travels with
			// the throw so the layer that reports it can say why.
			throwIfAborted(signal, "loadPage");
			lastError = errorMessage(error);
			// A DEADLINE also ends the loop. Rotating the user agent is the answer to a
			// BOT BLOCK, which `isBotBlocked` handles above on its own branch, and it is
			// no answer at all to an origin that could not respond inside the budget.
			// Retrying anyway made `timeout` mean `timeout * USER_AGENTS.length` of wall
			// clock, so a caller asking for 20 seconds waited 60 on every slow origin.
			// That is the option not meaning what it says, not a tuning choice: the
			// deadline is the caller's budget, and one budget buys one attempt at it.
			// The parent's own deadline arrives here too, already handled above, because
			// `scopedTimeoutSignal` composes it with this attempt's timer.
			if (isTimeoutError(error) || attempt === USER_AGENTS.length - 1) break;
		} finally {
			requestTimeout.cancel();
		}
	}

	return { content: "", contentType: "", finalUrl: url, ok: false, error: lastError };
}

/**
 * Cached import of the (heavy) turndown module. Lazy so turndown and
 * turndown-plugin-gfm stay off the startup graph; memoized so `createTurndown`
 * and `normalizeTablesHtml` share a single dynamic import.
 */
let turndownModulePromise: Promise<typeof import("../../utils/turndown")> | undefined;

function getTurndownModule(): Promise<typeof import("../../utils/turndown")> {
	turndownModulePromise ||= import("../../utils/turndown");
	return turndownModulePromise;
}

/** Module-level Turndown instance — built lazily on first use. */
let turndownPromise: Promise<TurndownService> | undefined;

function getTurndown(): Promise<TurndownService> {
	turndownPromise ||= getTurndownModule().then(module => module.createTurndown());
	return turndownPromise;
}

/**
 * Convert HTML to markdown using Turndown with GFM support.
 * Strips script/style tags before conversion, then normalizes tables so a
 * `<td>`-first table (no explicit `<thead>`) still renders as a GFM table rather
 * than being kept as a raw `<table>` blob — the same normalization the markit
 * docx/epub converters apply.
 */
export async function htmlToBasicMarkdown(html: string): Promise<string> {
	const cleaned = html.replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<style[\s\S]*?<\/style>/gi, "");
	const [module, turndown] = await Promise.all([getTurndownModule(), getTurndown()]);
	return turndown.turndown(module.normalizeTablesHtml(cleaned)).trim();
}

/**
 * Build a RenderResult from markdown content. Calls finalizeOutput internally.
 */
export function buildResult(
	md: string,
	opts: { url: string; finalUrl?: string; method: string; fetchedAt: string; notes?: string[]; contentType?: string },
): RenderResult {
	const output = finalizeOutput(md);
	return {
		url: opts.url,
		finalUrl: opts.finalUrl ?? opts.url,
		contentType: opts.contentType ?? "text/markdown",
		method: opts.method,
		content: output.content,
		fetchedAt: opts.fetchedAt,
		truncated: output.truncated,
		notes: opts.notes ?? [],
	};
}

/**
 * Format a date value as YYYY-MM-DD. Returns empty string on invalid input.
 */
export function formatIsoDate(value?: string | number | Date): string {
	if (value == null) return "";
	if (typeof value === "string") {
		const datePrefix = value.match(/^\d{4}-\d{2}-\d{2}/);
		if (datePrefix) return datePrefix[0];
	}
	try {
		return new Date(value).toISOString().split("T")[0];
	} catch {
		return "";
	}
}

/** The named HTML entities this decoder understands, mapped to their text. */
const NAMED_ENTITIES: Record<string, string> = {
	amp: "&",
	lt: "<",
	gt: ">",
	quot: '"',
	apos: "'",
	nbsp: " ",
};

/**
 * A single entity in the grammar {@link decodeHtmlEntities} recognizes: a
 * decimal char ref (`&#39;`), a hex char ref (`&#x2F;`, `&#X1F600;`), or a named
 * ref (`&amp;`). The whole set is decoded in ONE left-to-right pass, never
 * re-scanning produced output.
 */
const HTML_ENTITY_RE = /&(#\d+|#[xX][0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g;

/** Turn a Unicode code point into its character, or return `fallback` when it is not a valid scalar. */
function codePointToChar(code: number, fallback: string): string {
	// Reject out-of-range and lone-surrogate code points rather than emitting
	// replacement junk. fromCodePoint (not fromCharCode) so an astral entity like
	// `&#128512;` becomes one emoji, not a broken surrogate pair.
	if (!Number.isInteger(code) || code < 0 || code > 0x10ffff) return fallback;
	if (code >= 0xd800 && code <= 0xdfff) return fallback;
	try {
		return String.fromCodePoint(code);
	} catch {
		return fallback;
	}
}

/**
 * Decode the common HTML entities in a single left-to-right pass.
 *
 * One pass is the whole point: each `&...;` is replaced from the ORIGINAL text
 * and the replacement is never re-scanned, so a doubly-encoded literal decodes
 * exactly one level. `&amp;quot;` (the encoding of the text `&quot;`) becomes
 * `&quot;`, not `"`; `&#38;lt;` becomes `&lt;`, not `<`. A multi-pass decoder
 * that ran `&amp;` (or the numeric `&#38;`, which is also `&`) before the other
 * entities would wrongly decode both levels.
 *
 * Handles decimal (`&#39;`) and hex (`&#x2F;`) character references for any
 * scalar value, the named set in {@link NAMED_ENTITIES}, and leaves an unknown
 * entity (`&copy;`) or a bare `&` untouched.
 */
export function decodeHtmlEntities(text: string): string {
	return text.replace(HTML_ENTITY_RE, (match, body: string) => {
		if (body[0] === "#") {
			const code =
				body[1] === "x" || body[1] === "X"
					? Number.parseInt(body.slice(2), 16)
					: Number.parseInt(body.slice(1), 10);
			return codePointToChar(code, match);
		}
		const named = NAMED_ENTITIES[body];
		return named !== undefined ? named : match;
	});
}

/**
 * Format seconds into HH:MM:SS or MM:SS.
 */
export function formatMediaDuration(totalSeconds: number): string {
	const hours = Math.floor(totalSeconds / 3600);
	const minutes = Math.floor((totalSeconds % 3600) / 60);
	const secs = Math.floor(totalSeconds % 60);
	if (hours > 0) return `${hours}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
	return `${minutes}:${String(secs).padStart(2, "0")}`;
}

/**
 * Extract localized text, preferring en-US/en.
 */
export type LocalizedText = string | Record<string, string | null> | null | undefined;

export function getLocalizedText(value: LocalizedText, defaultLocale?: string): string | undefined {
	if (value == null) return undefined;
	if (typeof value === "string") return value;
	if (defaultLocale && value[defaultLocale]) return value[defaultLocale];
	return (
		value["en-US"] ?? value.en_US ?? value.en ?? Object.values(value).find(v => typeof v === "string") ?? undefined
	);
}

/**
 * Check if content looks like HTML by inspecting the leading tag.
 */
export function looksLikeHtml(content: string): boolean {
	const trimmed = content.trim().toLowerCase();
	return (
		trimmed.startsWith("<!doctype") ||
		trimmed.startsWith("<html") ||
		trimmed.startsWith("<head") ||
		trimmed.startsWith("<body")
	);
}
