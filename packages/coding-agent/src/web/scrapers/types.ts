import { scheduler } from "node:timers/promises";
import { isCancellation } from "@veyyon/utils/abortable";
import { clamp } from "@veyyon/utils/math";
import { errorMessage } from "@veyyon/utils/type-guards";
import type TurndownService from "turndown";

import type { AgentStorage } from "../../session/agent-storage";
import { ToolAbortError, throwIfAborted } from "../../tools/tool-errors";
import { isTimeoutError, scopedTimeoutSignal } from "../../utils/fetch-timeout";
import { CHROME_WINDOWS_USER_AGENT } from "../search/providers/browser-fingerprint-constants";

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

export interface ScraperDegrade {
	readonly scraperDegrade: true;
	readonly note: string;
}

export function scraperDegrade(site: string, reason: unknown): ScraperDegrade {
	if (reason instanceof ToolAbortError || isCancellation(reason)) throw reason;
	const detail = errorMessage(reason);
	return { scraperDegrade: true, note: `${site} scraper failed (${detail}); fell back to a generic fetch` };
}

export function loadFailure(result: { status?: number; error?: string }): string {
	if (result.status) return `HTTP ${result.status}`;
	return result.error ?? "fetch failed";
}

export function isScraperDegrade(value: unknown): value is ScraperDegrade {
	return typeof value === "object" && value !== null && (value as ScraperDegrade).scraperDegrade === true;
}

export function tryParseUrl(url: string): URL | null {
	try {
		return new URL(url);
	} catch {
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
	skipBodyForContentType?: (contentType: string) => boolean;
}

export interface LoadPageResult {
	content: string;
	contentType: string;
	finalUrl: string;
	ok: boolean;
	status?: number;
	truncated?: boolean;
	error?: string;
	bodySkipped?: boolean;
}

const RETRY_AFTER_MAX_MS = 10_000;

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

function decodeBody(bytes: Buffer, contentTypeHeader: string): string {
	let label = charsetFromContentType(contentTypeHeader);
	if (!label) {
		label = /<meta[^>]+charset\s*=\s*["']?([\w-]+)/i.exec(bytes.subarray(0, 2048).toString("latin1"))?.[1];
	}
	if (label && !/^utf-?8$/i.test(label)) {
		try {
			return new TextDecoder(label as Bun.Encoding).decode(bytes);
		} catch {}
	}
	return bytes.toString("utf-8");
}

export async function loadPage(url: string, options: LoadPageOptions = {}): Promise<LoadPageResult> {
	const { timeout = 20, headers = {}, maxBytes = MAX_BYTES, signal, method = "GET", body } = options;

	let lastError: string | undefined;
	let retried429 = false;
	for (let attempt = 0; attempt < USER_AGENTS.length; attempt++) {
		throwIfAborted(signal, "loadPage");

		const userAgent = USER_AGENTS[attempt];
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
				retried429 = true;
				const delayMs = parseRetryAfterMs(response.headers.get("retry-after"));
				void response.body?.cancel().catch(() => {});
				try {
					await scheduler.wait(delayMs, { signal });
				} catch (error) {
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
			throwIfAborted(signal, "loadPage");
			lastError = errorMessage(error);
			if (isTimeoutError(error) || attempt === USER_AGENTS.length - 1) break;
		} finally {
			requestTimeout.cancel();
		}
	}

	return { content: "", contentType: "", finalUrl: url, ok: false, error: lastError };
}

let turndownModulePromise: Promise<typeof import("../../utils/turndown")> | undefined;

function getTurndownModule(): Promise<typeof import("../../utils/turndown")> {
	turndownModulePromise ||= import("../../utils/turndown");
	return turndownModulePromise;
}

let turndownPromise: Promise<TurndownService> | undefined;

function getTurndown(): Promise<TurndownService> {
	turndownPromise ||= getTurndownModule().then(module => module.createTurndown());
	return turndownPromise;
}

export async function htmlToBasicMarkdown(html: string): Promise<string> {
	const cleaned = html.replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<style[\s\S]*?<\/style>/gi, "");
	const [module, turndown] = await Promise.all([getTurndownModule(), getTurndown()]);
	return turndown.turndown(module.normalizeTablesHtml(cleaned)).trim();
}

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

const NAMED_ENTITIES: Record<string, string> = {
	amp: "&",
	lt: "<",
	gt: ">",
	quot: '"',
	apos: "'",
	nbsp: " ",
};

const HTML_ENTITY_RE = /&(#\d+|#[xX][0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g;

function codePointToChar(code: number, fallback: string): string {
	if (!Number.isInteger(code) || code < 0 || code > 0x10ffff) return fallback;
	if (code >= 0xd800 && code <= 0xdfff) return fallback;
	try {
		return String.fromCodePoint(code);
	} catch {
		return fallback;
	}
}

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

export function formatMediaDuration(totalSeconds: number): string {
	const hours = Math.floor(totalSeconds / 3600);
	const minutes = Math.floor((totalSeconds % 3600) / 60);
	const secs = Math.floor(totalSeconds % 60);
	if (hours > 0) return `${hours}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
	return `${minutes}:${String(secs).padStart(2, "0")}`;
}

export type LocalizedText = string | Record<string, string | null> | null | undefined;

export function getLocalizedText(value: LocalizedText, defaultLocale?: string): string | undefined {
	if (value == null) return undefined;
	if (typeof value === "string") return value;
	if (defaultLocale && value[defaultLocale]) return value[defaultLocale];
	return (
		value["en-US"] ?? value.en_US ?? value.en ?? Object.values(value).find(v => typeof v === "string") ?? undefined
	);
}

export function looksLikeHtml(content: string): boolean {
	const trimmed = content.trim().toLowerCase();
	return (
		trimmed.startsWith("<!doctype") ||
		trimmed.startsWith("<html") ||
		trimmed.startsWith("<head") ||
		trimmed.startsWith("<body")
	);
}
