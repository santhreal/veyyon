import { Database } from "bun:sqlite";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolResult } from "@veyyon/agent-core";
import type { FetchImpl, ImageContent, TextContent } from "@veyyon/ai";
import { AgentStorage } from "@veyyon/kernel/session/agent-storage";
import { htmlToMarkdown } from "@veyyon/natives";
import { isCancellation } from "@veyyon/utils/abortable";
import { truncate } from "@veyyon/utils/format";
import { isEnoent } from "@veyyon/utils/fs-error";
// Owners, not the `@veyyon/utils` barrel: 8 modules against 74.
import * as logger from "@veyyon/utils/logger";
import * as ptree from "@veyyon/utils/ptree";
import { errorMessage } from "@veyyon/utils/type-guards";
import { trimTrailingSlashes } from "@veyyon/utils/url";
import { $which } from "@veyyon/utils/which";
import { extractWithParallel, findParallelApiKey, getParallelExtractContent } from "@veyyon/web/parallel";
import {
	decodeHtmlEntities,
	finalizeOutput,
	isScraperDegrade,
	type LoadPageResult,
	loadPage,
	looksLikeHtml,
	MAX_BYTES,
	MAX_OUTPUT_CHARS,
	type RenderResult,
	type ScraperDegrade,
	type SpecialHandler,
} from "@veyyon/web/scrapers/types";
import { type BinaryFetchResult, fetchBinary } from "@veyyon/web/scrapers/utils";
import { LRUCache } from "lru-cache/raw";
import type { Settings } from "../../config/settings";
import { readEditableNotebookText } from "../../edit/notebook";
import { CONVERTIBLE_EXTENSIONS } from "../../export/markit/convertible-extensions";
import { type ProviderTextTransformResolver, resolveProviderTextTransform } from "../../provider-boundary";
import type { ToolSession } from "../../sdk";
import { primarySessionCpuAdoption } from "../../session/cpu-limit";
import { truncateHead } from "../../session/streaming-output";
// Each from its owner, not the `../tui` barrel: the barrel is 768 modules because it re-exports the
// hyperlink module, and `read.ts` imports this file.
import { scopedTimeoutSignal } from "../../utils/fetch-timeout";
import { webpExclusionForModel } from "../../utils/image-loading";
import { formatDimensionNote, type ResizedImage, resizeImage } from "../../utils/image-resize";
import { ensureTool } from "../../utils/tools-manager";
import { type ArchiveFormat, listArchiveRoot, sniffArchiveFormat } from "../../utils/zip";
import { applyListLimit } from "../core/list-limit";
import { inlineBudgetFor } from "../core/output-artifact";
import type { OutputMeta } from "../core/output-meta";
import { formatBytes } from "../core/render-utils";
import { listTables, looksLikeSqlite, renderTableList } from "../core/sqlite-reader";
import { ToolError, throwIfAborted } from "../core/tool-errors";
import { toolResult } from "../core/tool-result";
import { clampTimeout } from "../core/tool-timeouts";
import { normalizeUrl } from "./read-url-target";
import { convertDocument, scrapeServices } from "./scrape-services";

// =============================================================================
// Types and Constants
// =============================================================================

const FETCH_DEFAULT_MAX_LINES = 300;

// The native `htmlToMarkdown` recurses per nested element and hard-crashes the
// whole process (unrecoverable native stack overflow, not a catchable throw) on
// deeply nested HTML — ~2000 nested elements is fine, ~5000 core-dumps. Fetch
// runs it on attacker-controlled pages, so a hostile/malformed page with deep
// nesting would take down the agent. Real pages nest well under ~100 deep, so a
// cap of 500 never rejects legitimate content while keeping the input far below
// the crash threshold; over-nested HTML skips the native path and falls through
// to the next extractor. The native binary is prebuilt (no in-repo source), so
// this boundary guard is the only place to fix it.
const MAX_HTML_NESTING_DEPTH = 500;
// HTML void elements never nest (no closing tag), so they must not count toward
// depth or a page with a long run of them (many <br>/<img>) would false-trip.
const VOID_HTML_ELEMENTS = new Set([
	"area",
	"base",
	"br",
	"col",
	"embed",
	"hr",
	"img",
	"input",
	"link",
	"meta",
	"param",
	"source",
	"track",
	"wbr",
]);
const HTML_TAG_RE = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)\b[^>]*?(\/?)>/g;

/**
 * True when `html`'s element nesting exceeds {@link MAX_HTML_NESTING_DEPTH}.
 * A linear tag scan: opening tags increase depth, closing tags decrease it, and
 * void/self-closing tags are depth-neutral. Approximate (it does not validate
 * mismatched tags), but it cannot under-count the pure `<div>`-repeat attack,
 * and over-counting only matters far above any real page's depth.
 *
 * Exported for the DoS regression test (calling htmlToMarkdown on the attack
 * input would core-dump the test process, so the guard is verified directly).
 */
export function htmlNestingExceeds(html: string, limit: number): boolean {
	let depth = 0;
	HTML_TAG_RE.lastIndex = 0;
	for (let m = HTML_TAG_RE.exec(html); m !== null; m = HTML_TAG_RE.exec(html)) {
		const isClose = m[1] === "/";
		const selfClosing = m[3] === "/";
		const name = m[2]!.toLowerCase();
		if (isClose) {
			if (depth > 0) depth--;
		} else if (!selfClosing && !VOID_HTML_ELEMENTS.has(name)) {
			depth++;
			if (depth > limit) return true;
		}
	}
	return false;
}

// Convertible document types handled by markit.
const CONVERTIBLE_MIMES = new Set([
	"application/pdf",
	"application/msword",
	"application/vnd.ms-powerpoint",
	"application/vnd.ms-excel",
	"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
	"application/vnd.openxmlformats-officedocument.presentationml.presentation",
	"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
	"application/rtf",
	"application/epub+zip",
]);

const NOTEBOOK_MIMES = new Set(["application/x-ipynb+json"]);
const NOTEBOOK_EXTENSIONS = new Set([".ipynb"]);

const SQLITE_MIMES = new Set([
	"application/vnd.sqlite3",
	"application/x-sqlite3",
	"application/sqlite3",
	"application/sqlite",
]);
const SQLITE_EXTENSIONS = new Set([".sqlite", ".sqlite3", ".db", ".db3"]);

const ARCHIVE_MIMES = new Set([
	"application/zip",
	"application/x-zip-compressed",
	"application/x-tar",
	"application/tar",
	"application/gzip",
	"application/x-gzip",
]);
const ARCHIVE_EXTENSIONS = new Set([".zip", ".tar", ".tar.gz", ".tgz", ".gz"]);

const IMAGE_MIME_BY_EXTENSION = new Map<string, string>([
	[".png", "image/png"],
	[".jpg", "image/jpeg"],
	[".jpeg", "image/jpeg"],
	[".gif", "image/gif"],
	[".webp", "image/webp"],
]);
const SUPPORTED_INLINE_IMAGE_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const MAX_INLINE_IMAGE_SOURCE_BYTES = 20 * 1024 * 1024;
const MAX_INLINE_IMAGE_OUTPUT_BYTES = 300 * 1024;

// =============================================================================
// Utilities
// =============================================================================

/**
 * Check if a command exists (cross-platform)
 */
function hasCommand(cmd: string): boolean {
	return Boolean($which(cmd));
}

/**
 * Build llms.txt candidates scoped to the requested URL
 */
function buildLlmEndpointCandidates(url: string): string[] {
	try {
		const parsed = new URL(url);
		if (parsed.pathname === "/") {
			return [`${parsed.origin}/.well-known/llms.txt`, `${parsed.origin}/llms.txt`, `${parsed.origin}/llms.md`];
		}

		const trimmedPath = trimTrailingSlashes(parsed.pathname);
		const segments = trimmedPath.split("/").filter(Boolean);
		const scopeDepth = parsed.pathname.endsWith("/") ? segments.length : Math.max(segments.length - 1, 1);
		const endpoints: string[] = [];

		for (let depth = scopeDepth; depth >= 1; depth--) {
			const scope = `/${segments.slice(0, depth).join("/")}/`;
			endpoints.push(`${parsed.origin}${scope}llms.txt`, `${parsed.origin}${scope}llms.md`);
		}

		return endpoints;
	} catch {
		// `new URL` threw, so there is no origin to hang an llms.txt path off. No endpoints is the honest
		// answer, and the caller's own fetch of the same URL reports the malformed input.
		return [];
	}
}

const URL_CREDENTIAL_LABELS: Record<string, true> = {
	accesskey: true,
	accesstoken: true,
	apikey: true,
	auth: true,
	authorization: true,
	bearer: true,
	code: true,
	credential: true,
	jwt: true,
	key: true,
	password: true,
	passwd: true,
	secret: true,
	securitytoken: true,
	sig: true,
	signature: true,
	signed: true,
	token: true,
	xamzcredential: true,
	xamzsecuritytoken: true,
	xamzsignature: true,
	xgoogcredential: true,
	xgoogsignature: true,
};

function decodeUrlCredentialComponent(component: string): string {
	let decoded = component;
	for (let pass = 0; pass < 3; pass += 1) {
		try {
			const next = decodeURIComponent(decoded);
			if (next === decoded) break;
			decoded = next;
		} catch {
			break;
		}
	}
	return decoded;
}

function isUrlCredentialLabel(label: string): boolean {
	const normalized = decodeUrlCredentialComponent(label)
		.toLowerCase()
		.replace(/[^a-z0-9]/g, "");
	return (
		URL_CREDENTIAL_LABELS[normalized] === true ||
		normalized.endsWith("accesstoken") ||
		normalized.endsWith("apikey") ||
		normalized.endsWith("credential") ||
		normalized.endsWith("password") ||
		normalized.endsWith("secret") ||
		normalized.endsWith("signature")
	);
}

function looksLikeOpaqueUrlCredential(candidate: string): boolean {
	const decoded = decodeUrlCredentialComponent(candidate);
	if (decoded.length < 20 || /\s/.test(decoded)) return false;
	if (/^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(decoded)) return true;
	if (/^[a-f0-9]{24,}$/i.test(decoded)) return true;
	return (
		/^[A-Za-z0-9_~-]+$/.test(decoded) && /[A-Za-z]/.test(decoded) && /\d/.test(decoded) && /[A-Z_~]/.test(decoded)
	);
}

/**
 * Detect a URL capability that must go only to the target host/local readers.
 *
 * Remote reader services need the complete URL to fetch it, so redacting a
 * credential would both break the URL and still disclose its shape. Detection
 * is deliberately conservative: false positives merely use the already-loaded
 * HTML or a direct reader, while a false negative discloses the capability to a
 * secondary service.
 */
export function hasCredentialBearingUrl(value: string): boolean {
	let parsed: URL;
	try {
		parsed = new URL(value);
	} catch {
		// Never forward an unparseable URL to a secondary service.
		return true;
	}
	if (parsed.username.length > 0 || parsed.password.length > 0) return true;

	for (const [key, item] of parsed.searchParams) {
		if (isUrlCredentialLabel(key) || looksLikeOpaqueUrlCredential(item)) return true;
	}

	let previousWasLabel = false;
	for (const encodedSegment of parsed.pathname.split("/").filter(Boolean)) {
		const segment = decodeUrlCredentialComponent(encodedSegment);
		if (previousWasLabel && segment.length > 0) return true;
		const separator = segment.search(/[=:]/);
		if (separator > 0 && isUrlCredentialLabel(segment.slice(0, separator))) return true;
		if (looksLikeOpaqueUrlCredential(segment)) return true;
		previousWasLabel = isUrlCredentialLabel(segment);
	}

	const fragment = decodeUrlCredentialComponent(parsed.hash.slice(1));
	if (fragment.length > 0) {
		const separator = fragment.search(/[=:]/);
		if (
			(separator > 0 && isUrlCredentialLabel(fragment.slice(0, separator))) ||
			looksLikeOpaqueUrlCredential(fragment)
		) {
			return true;
		}
	}
	return false;
}

/**
 * Normalize MIME type (lowercase, strip charset/params)
 */
function normalizeMime(contentType: string): string {
	return contentType.split(";")[0].trim().toLowerCase();
}

function getFilenameExtensionHint(filename: string): string {
	const lower = filename.toLowerCase();
	if (lower.endsWith(".tar.gz")) return ".tar.gz";
	return path.extname(filename).toLowerCase();
}

/**
 * Get extension from URL or Content-Disposition
 */
function getExtensionHint(url: string, contentDisposition?: string): string {
	// Try Content-Disposition filename first
	if (contentDisposition) {
		const match = contentDisposition.match(/filename[*]?=["']?([^"';\n]+)/i);
		if (match) {
			const ext = getFilenameExtensionHint(match[1]);
			if (ext) return ext;
		}
	}

	// Fall back to URL path
	try {
		const pathname = new URL(url).pathname;
		const ext = getFilenameExtensionHint(pathname);
		if (ext) return ext;
	} catch {
		// `new URL` on a caller-supplied string: no parseable path means no
		// extension hint, which is the empty string below.
	}

	return "";
}

/**
 * Check if content type is convertible via markit.
 */
function isConvertible(mime: string, extensionHint: string): boolean {
	if (CONVERTIBLE_MIMES.has(mime)) return true;
	if (mime === "application/octet-stream" && CONVERTIBLE_EXTENSIONS.has(extensionHint)) return true;
	if (CONVERTIBLE_EXTENSIONS.has(extensionHint)) return true;
	return false;
}

function resolveImageMimeType(mime: string, extensionHint: string): string | null {
	if (mime.startsWith("image/")) return mime;
	const shouldUseExtensionHint =
		mime.length === 0 || mime === "application/octet-stream" || mime === "binary/octet-stream" || mime === "unknown";
	if (!shouldUseExtensionHint) return null;
	return IMAGE_MIME_BY_EXTENSION.get(extensionHint) ?? null;
}

function isInlineImageMimeTypeSupported(mimeType: string): boolean {
	return SUPPORTED_INLINE_IMAGE_MIME_TYPES.has(mimeType);
}

/** A markdown, plain-text or feed rendition of a page, fetched from an address other than the page itself. */
interface Rendition {
	readonly note: string;
	readonly contentType: string;
	readonly method: string;
	readonly content: string;
}

type RenditionProbe = (signal: AbortSignal) => Promise<Rendition | null>;

/**
 * Start every probe at once and resolve to the answer of the first probe, in the order given, that
 * answers. Each probe is a network round trip that usually misses, so the wait is the slowest probe
 * up to the winner rather than the sum of every probe. Probes still running once the winner is known
 * are aborted, and a probe's rejection surfaces only when every probe ahead of it answered null.
 */
async function firstRendition(
	probes: readonly RenditionProbe[],
	signal: AbortSignal | undefined,
): Promise<Rendition | null> {
	if (probes.length === 0) return null;
	const losers = new AbortController();
	const probeSignal = signal ? AbortSignal.any([signal, losers.signal]) : losers.signal;
	const answers = probes.map(probe => probe(probeSignal));
	for (const answer of answers) answer.catch(() => {});
	try {
		for (const answer of answers) {
			const rendition = await answer;
			if (rendition) return rendition;
		}
		return null;
	} finally {
		losers.abort();
	}
}

/** A body long enough to be content and not an HTML page standing in for the text asked for. */
function isSubstantialText(result: LoadPageResult): boolean {
	return result.ok && result.content.trim().length > 100 && !looksLikeHtml(result.content);
}

/** Probe `url` for a substantial non-HTML text body, answered as a rendition described by `found`. */
function textProbe(url: string, timeout: number, found: Omit<Rendition, "content">): RenditionProbe {
	return async signal => {
		const result = await loadPage(url, { timeout, signal });
		return isSubstantialText(result) ? { ...found, content: result.content } : null;
	};
}

/**
 * The `.md` sibling of a page under the llms.txt convention: `/a/` → `/a/index.html.md`,
 * `/a/b.html` → `/a/b.html.md`, `/a/b` → `/a/b.md`.
 */
function markdownSiblingProbe(url: string, timeout: number): RenditionProbe | null {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		// An unparseable URL has no markdown sibling to guess at, and the fetch that follows reports
		// the URL itself.
		return null;
	}
	const suffix = parsed.pathname.endsWith("/") ? "index.html.md" : ".md";
	return textProbe(`${parsed.origin}${parsed.pathname}${suffix}`, timeout, {
		note: "Found .md suffix version",
		contentType: "text/markdown",
		method: "md-suffix",
	});
}

/** Ask the page's own address for markdown or plain text through the `Accept` header. */
function negotiationProbe(url: string, timeout: number): RenditionProbe {
	return async signal => {
		const result = await loadPage(url, {
			timeout,
			headers: { Accept: "text/markdown, text/plain;q=0.9, text/html;q=0.8" },
			signal,
		});
		if (!result.ok) return null;
		const mime = normalizeMime(result.contentType);
		if ((!mime.includes("markdown") && mime !== "text/plain") || looksLikeHtml(result.content)) return null;
		return {
			note: `Content negotiation returned ${result.contentType}`,
			contentType: mime,
			method: "content-negotiation",
			content: result.content,
		};
	};
}

/** A feed the page links as its alternate, rendered as markdown. */
function feedProbe(url: string, timeout: number): RenditionProbe {
	return async signal => {
		const result = await loadPage(url, { timeout, signal });
		if (!result.ok || result.content.trim().length <= 200) return null;
		return {
			note: `Used feed alternate: ${url}`,
			contentType: "application/feed",
			method: "alternate-feed",
			content: await parseFeedToMarkdown(result.content),
		};
	};
}

/** The llms.txt and llms.md files scoped to the requested URL, nearest scope first. */
function llmsTxtProbes(url: string, timeout: number): RenditionProbe[] {
	const probeTimeout = Math.min(timeout, 5);
	return buildLlmEndpointCandidates(url).map(endpoint =>
		textProbe(endpoint, probeTimeout, {
			note: `Used llms.txt fallback: ${endpoint}`,
			contentType: "text/plain",
			method: "llms.txt",
		}),
	);
}

function isMarkdownAlternate(href: string): boolean {
	return href.endsWith(".md") || href.includes("markdown");
}

/** An alternate link resolved against the page, or null for an href that does not resolve. */
function resolveAlternate(href: string, pageUrl: string): string | null {
	if (href.startsWith("http")) return href;
	try {
		return new URL(href, pageUrl).href;
	} catch {
		return null;
	}
}

/**
 * Every digestible rendition an HTML page may offer, in the order one is preferred: its markdown
 * alternate link, its `.md` sibling, markdown through content negotiation, then its first two feed
 * alternates.
 */
function htmlRenditionProbes(html: string, pageUrl: string, requestedUrl: string, timeout: number): RenditionProbe[] {
	const alternates = parseAlternateLinks(html, pageUrl);
	const probes: RenditionProbe[] = [];
	const markdownAlternate = alternates.find(isMarkdownAlternate);
	const markdownUrl = markdownAlternate === undefined ? null : resolveAlternate(markdownAlternate, pageUrl);
	if (markdownUrl) {
		probes.push(
			textProbe(markdownUrl, timeout, {
				note: `Used markdown alternate: ${markdownUrl}`,
				contentType: "text/markdown",
				method: "alternate-markdown",
			}),
		);
	}
	const sibling = markdownSiblingProbe(pageUrl, timeout);
	if (sibling) probes.push(sibling);
	probes.push(negotiationProbe(requestedUrl, timeout));
	for (const href of alternates.filter(alt => !isMarkdownAlternate(alt)).slice(0, 2)) {
		const feedUrl = resolveAlternate(href, pageUrl);
		if (feedUrl) probes.push(feedProbe(feedUrl, timeout));
	}
	return probes;
}

/**
 * Read a single HTML attribute from a tag string
 */
function getHtmlAttribute(tag: string, attribute: string): string | null {
	const pattern = new RegExp(`\\b${attribute}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'=<>]+))`, "i");
	const match = tag.match(pattern);
	if (!match) return null;
	return (match[1] ?? match[2] ?? match[3] ?? "").trim();
}

/**
 * Extract bounded <head> markup to avoid expensive whole-page parsing
 */
function extractHeadHtml(html: string): string {
	const lower = html.toLowerCase();
	const headStart = lower.indexOf("<head");
	if (headStart === -1) {
		return html.slice(0, 32 * 1024);
	}

	const headTagEnd = html.indexOf(">", headStart);
	if (headTagEnd === -1) {
		return html.slice(headStart, headStart + 32 * 1024);
	}

	const headEnd = lower.indexOf("</head>", headTagEnd + 1);
	const fallbackEnd = Math.min(html.length, headTagEnd + 1 + 32 * 1024);
	return html.slice(headStart, headEnd === -1 ? fallbackEnd : headEnd + 7);
}

/**
 * Parse alternate links from HTML head
 */
export function parseAlternateLinks(html: string, pageUrl: string): string[] {
	const links: string[] = [];

	// Only the URL parse can throw here, and the sole reason it would is a page URL
	// that is not a URL. Wrapping the whole loop instead meant any later fault
	// returned however many links had been collected so far, and a truncated list
	// is indistinguishable from a page that genuinely has no alternates.
	let pagePath: string;
	try {
		pagePath = new URL(pageUrl).pathname;
	} catch {
		return links;
	}

	const headHtml = extractHeadHtml(html);
	const linkTags = headHtml.match(/<link\b[^>]*>/gi) ?? [];

	for (const tag of linkTags) {
		const rel = getHtmlAttribute(tag, "rel")?.toLowerCase() ?? "";
		const relTokens = rel.split(/\s+/).filter(Boolean);
		if (!relTokens.includes("alternate")) continue;

		const href = getHtmlAttribute(tag, "href");
		const type = getHtmlAttribute(tag, "type")?.toLowerCase() ?? "";
		if (!href) continue;

		// Skip site-wide feeds
		if (
			href.includes("RecentChanges") ||
			href.includes("Special:") ||
			href.includes("/feed/") ||
			href.includes("action=feed")
		) {
			continue;
		}

		if (type.includes("markdown")) {
			links.push(href);
		} else if (
			(type.includes("rss") || type.includes("atom") || type.includes("feed")) &&
			(href.includes(pagePath) || href.includes("comments"))
		) {
			links.push(href);
		}
	}

	return links;
}

/**
 * Extract document links from HTML (for PDF/DOCX wrapper pages)
 */
export function extractDocumentLinks(html: string, baseUrl: string): string[] {
	const links: string[] = [];
	const seen = new Set<string>();

	const anchorTags = html.slice(0, 512 * 1024).match(/<a\b[^>]*>/gi) ?? [];
	for (const tag of anchorTags) {
		const href = getHtmlAttribute(tag, "href");
		if (!href) continue;

		const ext = path.extname(href).toLowerCase();
		if (!CONVERTIBLE_EXTENSIONS.has(ext)) continue;

		// Per href, not around the loop. Resolving a relative href throws when that
		// one href is malformed, and catching it outside meant a single broken link
		// anywhere on the page ended the scan and dropped every document link after
		// it. On a page listing twenty PDFs, one bad anchor could hide nineteen.
		let resolved: string;
		try {
			resolved = href.startsWith("http") ? href : new URL(href, baseUrl).href;
		} catch {
			continue;
		}
		if (seen.has(resolved)) continue;
		seen.add(resolved);
		links.push(resolved);
		if (links.length >= 20) break;
	}

	return links;
}

/**
 * Strip the CDATA wrapper, decode HTML entities, then strip HTML tags from a
 * feed text node.
 *
 * Entity-decode runs before tag-strip on purpose: a feed that encodes markup as
 * `&lt;script&gt;` decodes to a real `<script>` tag which the tag-strip then
 * removes, so encoded markup does not leak into the output. Decoding goes
 * through the shared {@link decodeHtmlEntities} owner (single pass, `&amp;`-safe,
 * decimal/hex/named) instead of the four hand-rolled entity replacements this
 * carried, which decoded `&amp;` before the others and so double-decoded a
 * literal like `&amp;quot;`.
 */
function cleanFeedText(text: string): string {
	const withoutCdata = text.replace(/<!\[CDATA\[/g, "").replace(/\]\]>/g, "");
	return decodeHtmlEntities(withoutCdata)
		.replace(/<[^>]+>/g, "")
		.trim();
}

/**
 * Parse RSS/Atom feed to markdown
 */
async function parseFeedToMarkdown(content: string, maxItems = 10): Promise<string> {
	const { parseHTML } = await import("linkedom");
	try {
		const doc = parseHTML(content).document;

		// Try RSS
		const channel = doc.querySelector("channel");
		if (channel) {
			const title = cleanFeedText(channel.querySelector("title")?.text || "RSS Feed");
			const items = channel.querySelectorAll("item").slice(0, maxItems);

			let md = `# ${title}\n\n`;
			for (const item of items) {
				const itemTitle = cleanFeedText(item.querySelector("title")?.text || "Untitled");
				const link = cleanFeedText(item.querySelector("link")?.text || "");
				const pubDate = cleanFeedText(item.querySelector("pubDate")?.text || "");
				const desc = cleanFeedText(item.querySelector("description")?.text || "");

				md += `## ${itemTitle}\n`;
				if (pubDate) md += `*${pubDate}*\n\n`;
				if (desc) md += `${truncate(desc, 500, "...")}\n\n`;
				if (link) md += `[Read more](${link})\n\n`;
				md += "---\n\n";
			}
			return md;
		}

		// Try Atom
		const feed = doc.querySelector("feed");
		if (feed) {
			const title = cleanFeedText(feed.querySelector("title")?.text || "Atom Feed");
			const entries = feed.querySelectorAll("entry").slice(0, maxItems);

			let md = `# ${title}\n\n`;
			for (const entry of entries) {
				const entryTitle = cleanFeedText(entry.querySelector("title")?.text || "Untitled");
				const link = entry.querySelector("link")?.getAttribute("href") || "";
				const updated = cleanFeedText(entry.querySelector("updated")?.text || "");
				const summary = cleanFeedText(
					entry.querySelector("summary")?.text || entry.querySelector("content")?.text || "",
				);

				md += `## ${entryTitle}\n`;
				if (updated) md += `*${updated}*\n\n`;
				if (summary) md += `${truncate(summary, 500, "...")}\n\n`;
				if (link) md += `[Read more](${link})\n\n`;
				md += "---\n\n";
			}
			return md;
		}
	} catch {
		// Feed parsing is opportunistic. The raw content returned below is what
		// the caller asked for, so the operator still sees the document.
	}

	return content; // Fall back to raw content
}

/**
 * Cap on any single remote reader-mode request (Parallel, Jina) so a stalled
 * remote endpoint cannot consume the whole reader-mode budget and starve the
 * local fallback renderers (trafilatura, lynx, native). See #1449.
 */
const REMOTE_READER_MAX_MS = 10_000;

/** Reader backends for {@link renderHtmlToText}, in default priority order. */
export type FetchProvider = "native" | "trafilatura" | "lynx" | "parallel" | "jina";

const FETCH_PROVIDER_ORDER: readonly FetchProvider[] = ["native", "trafilatura", "lynx", "parallel", "jina"];

/**
 * Render HTML to markdown by trying reader backends in priority order: native
 * (in-process), trafilatura, lynx, Parallel, then Jina. The `providers.fetch`
 * setting picks the order — `auto` uses the default above; any specific backend
 * is tried first, then the remaining backends as fallbacks. Every backend's
 * output must clear the same quality gate (>100 non-whitespace chars and not
 * {@link isLowQualityOutput}) before it is accepted, otherwise the next backend
 * is tried.
 *
 * The overall `timeout` budget bounds the whole call; remote backends (Parallel,
 * Jina) are additionally capped at `REMOTE_READER_MAX_MS` so a hung endpoint
 * cannot starve later renderers — especially the purely-local native converter,
 * which always works on already-loaded HTML. Only a real `userSignal`
 * cancellation aborts the chain (#1449).
 */
export async function renderHtmlToText(
	url: string,
	html: string,
	timeout: number,
	settings: Settings,
	userSignal: AbortSignal | undefined,
	storage: AgentStorage | null,
	fetchOverride?: FetchImpl,
	resolveTextTransform?: ProviderTextTransformResolver,
): Promise<{ content: string; ok: boolean; method: string }> {
	// Scoped so the overall-budget timer is cleared on settle instead of
	// staying armed like a bare AbortSignal.timeout.
	const overallTimeout = scopedTimeoutSignal(timeout * 1000, userSignal);
	const overallSignal = overallTimeout.signal;
	try {
		const execOptions = {
			mode: "group" as const,
			allowNonZero: true,
			allowAbort: true,
			stderr: "full" as const,
			signal: overallSignal,
			onSpawnPid: primarySessionCpuAdoption(),
		};
		const remoteBudgetMs = Math.min(timeout * 1000, REMOTE_READER_MAX_MS);
		const fetchImpl = fetchOverride ?? fetch;
		// Jina/Parallel are unrelated services. Credential-bearing target URLs
		// stay byte-exact and can only use direct/local readers.
		const allowSecondaryReaders = !hasCredentialBearingUrl(url);

		const runners: Record<FetchProvider, () => Promise<string | null>> = {
			// Purely local, no network/subprocess: still works on already-loaded HTML
			// even after remote/subprocess attempts are aborted by the budget. Deeply
			// nested HTML crashes the native converter (see MAX_HTML_NESTING_DEPTH), so
			// skip it for such input and let the chain fall through to another reader.
			native: () =>
				htmlNestingExceeds(html, MAX_HTML_NESTING_DEPTH)
					? Promise.resolve(null)
					: htmlToMarkdown(html, { cleanContent: true }),
			trafilatura: async () => {
				const trafilatura = await ensureTool("trafilatura", { signal: overallSignal, silent: true });
				if (!trafilatura) return null;
				const result = await ptree.exec([trafilatura, "-u", url, "--output-format", "markdown"], execOptions);
				return result.ok ? result.stdout : null;
			},
			lynx: async () => {
				if (!hasCommand("lynx")) return null;
				const result = await ptree.exec(["lynx", "-dump", "-nolist", "-width", "250", url], execOptions);
				return result.ok ? result.stdout : null;
			},
			parallel: async () => {
				if (!allowSecondaryReaders || !findParallelApiKey(storage)) return null;
				const transform = resolveProviderTextTransform(resolveTextTransform, "Parallel remote reader");
				if (transform(url) !== url) return null;
				// Per-attempt budget for remote endpoints so one stall cannot consume
				// the whole reader-mode budget and starve the local fallbacks; scoped
				// so the timer is cleared when the attempt settles.
				const remoteTimeout = scopedTimeoutSignal(remoteBudgetMs, userSignal);
				try {
					const parallelResult = await extractWithParallel(
						[url],
						{
							objective: "Extract the main content",
							excerpts: true,
							fullContent: false,
							signal: remoteTimeout.signal,
							fetch: fetchImpl,
						},
						storage,
					);
					const firstDocument = parallelResult.results[0];
					return firstDocument ? getParallelExtractContent(firstDocument) : null;
				} finally {
					remoteTimeout.cancel();
				}
			},
			jina: async () => {
				if (!allowSecondaryReaders) return null;
				const transform = resolveProviderTextTransform(resolveTextTransform, "Jina remote reader");
				if (transform(url) !== url) return null;
				const remoteTimeout = scopedTimeoutSignal(remoteBudgetMs, userSignal);
				try {
					const response = await fetchImpl(`https://r.jina.ai/${url}`, {
						headers: { Accept: "text/markdown" },
						signal: remoteTimeout.signal,
					});
					return response.ok ? await response.text() : null;
				} finally {
					remoteTimeout.cancel();
				}
			},
		};

		const preference = settings.get("providers.fetch");
		const order: readonly FetchProvider[] =
			preference === "auto"
				? FETCH_PROVIDER_ORDER
				: [preference, ...FETCH_PROVIDER_ORDER.filter(method => method !== preference)];

		// Highest-priority output that is substantial but fails the low-quality gate.
		// Surfaced (ok: true) only when no backend clears the gate, so the caller's
		// targeted fallbacks (llms.txt / document extraction) still run and we beat
		// returning the unrendered raw HTML.
		let lowQuality: { content: string; method: FetchProvider } | null = null;

		for (const method of order) {
			// Honour real user cancellation between attempts; remote per-attempt and
			// overall-budget timeouts still fall through to later (local) renderers.
			userSignal?.throwIfAborted();
			try {
				const content = await runners[method]();
				if (!content || content.trim().length <= 100) continue;
				if (!isLowQualityOutput(content)) {
					return { content, ok: true, method };
				}
				lowQuality ??= { content, method };
			} catch {
				userSignal?.throwIfAborted();
			}
		}

		if (lowQuality) {
			return { content: lowQuality.content, ok: true, method: lowQuality.method };
		}
		return { content: "", ok: false, method: "none" };
	} finally {
		overallTimeout.cancel();
	}
}

/**
 * Check if lynx output looks JS-gated or mostly navigation
 */
function isLowQualityOutput(content: string): boolean {
	const lower = content.toLowerCase();

	// JS-gated indicators
	const jsGated = [
		"enable javascript",
		"javascript required",
		"turn on javascript",
		"please enable javascript",
		"browser not supported",
	];
	if (content.length < 1024 && jsGated.some(t => lower.includes(t))) {
		return true;
	}

	// Mostly navigation (high link/menu density)
	const lines = content.split("\n").filter(l => l.trim());
	const shortLines = lines.filter(l => l.trim().length < 40);
	if (lines.length > 10 && shortLines.length / lines.length > 0.7) {
		return true;
	}

	return false;
}

/**
 * Format JSON
 */
function formatJson(content: string): string {
	try {
		return JSON.stringify(JSON.parse(content), null, 2);
	} catch {
		return content;
	}
}

interface FetchImagePayload {
	data: string;
	mimeType: string;
}

type FetchRenderResult = RenderResult & {
	image?: FetchImagePayload;
};

const BINARY_SAMPLE_CHARS = 4096;
const URL_ARCHIVE_LIST_LIMIT = 500;
const URL_SQLITE_LIST_LIMIT = 500;

function sampleLooksBinary(text: string): boolean {
	const limit = Math.min(text.length, BINARY_SAMPLE_CHARS);
	if (limit === 0) return false;

	let replacementCount = 0;
	for (let index = 0; index < limit; index++) {
		const code = text.charCodeAt(index);
		if (code === 0) return true;
		if (code === 0xfffd) replacementCount++;
	}

	return replacementCount >= 3 && replacementCount / limit > 0.01;
}

function isNotebookHint(mime: string, extensionHint: string): boolean {
	return NOTEBOOK_MIMES.has(mime) || NOTEBOOK_EXTENSIONS.has(extensionHint);
}

function isSqliteHint(mime: string, extensionHint: string): boolean {
	return SQLITE_MIMES.has(mime) || SQLITE_EXTENSIONS.has(extensionHint);
}

function isArchiveHint(mime: string, extensionHint: string): boolean {
	return ARCHIVE_MIMES.has(mime) || ARCHIVE_EXTENSIONS.has(extensionHint);
}

/**
 * Content types whose payload renderUrl always re-fetches via fetchBinary.
 * Skipping the initial body read for them avoids downloading and
 * string-decoding huge binaries (PDFs, archives, images) twice.
 */
function shouldSkipBodyDownload(contentType: string): boolean {
	return (
		CONVERTIBLE_MIMES.has(contentType) ||
		NOTEBOOK_MIMES.has(contentType) ||
		SQLITE_MIMES.has(contentType) ||
		ARCHIVE_MIMES.has(contentType) ||
		SUPPORTED_INLINE_IMAGE_MIME_TYPES.has(contentType)
	);
}

function getArchiveFormatHint(mime: string, extensionHint: string): ArchiveFormat | undefined {
	if (extensionHint === ".zip" || mime === "application/zip" || mime === "application/x-zip-compressed") {
		return "zip";
	}
	if (extensionHint === ".tar" || mime === "application/x-tar" || mime === "application/tar") {
		return "tar";
	}
	if (
		extensionHint === ".tar.gz" ||
		extensionHint === ".tgz" ||
		extensionHint === ".gz" ||
		mime === "application/gzip" ||
		mime === "application/x-gzip"
	) {
		return "tar.gz";
	}
	return undefined;
}

function binaryContentType(mime: string): string {
	return mime || "application/octet-stream";
}

function buildBinaryNotice(finalUrl: string, mime: string, byteLength?: number): string {
	const size = byteLength === undefined ? "unknown size" : formatBytes(byteLength);
	return `[Binary content: ${binaryContentType(mime)}, ${size}] ${finalUrl}`;
}

function binaryFetchFailure(error: string | undefined): string {
	return error ? `Binary fetch failed: ${error}` : "Binary fetch failed";
}

const TEXT_FALLBACK_NOTE = "Falling back to textual rendering from initial response";

/** Everything {@link renderUrl} is asked for past the address itself. */
interface UrlRenderRequest {
	readonly raw: boolean;
	readonly timeout: number;
	readonly signal: AbortSignal | undefined;
	readonly settings: Settings;
	readonly storage: AgentStorage | null;
	readonly fetchOverride?: FetchImpl;
	readonly excludeWebP?: true;
	readonly resolveTextTransform?: ProviderTextTransformResolver;
}

/** A page whose first response arrived, on its way to a render result. Every step appends to `notes`. */
class FetchedPage {
	readonly finalUrl: string;
	readonly rawContent: string;
	readonly mime: string;
	readonly extHint: string;
	readonly bodySkipped: boolean;
	#binary: Promise<BinaryFetchResult> | undefined;

	constructor(
		readonly url: string,
		response: LoadPageResult,
		readonly fetchedAt: string,
		readonly notes: string[],
		readonly request: UrlRenderRequest,
	) {
		this.finalUrl = response.finalUrl;
		this.rawContent = response.content;
		this.mime = normalizeMime(response.contentType);
		this.extHint = getExtensionHint(response.finalUrl);
		this.bodySkipped = response.bodySkipped === true;
	}

	/**
	 * The response's bytes, downloaded once however many renderers ask: an image or a document that
	 * fails to render falls through to the binary payload renderers, which read the same bytes.
	 */
	binary(): Promise<BinaryFetchResult> {
		this.#binary ??= fetchBinary(this.finalUrl, this.request.timeout, this.request.signal);
		return this.#binary;
	}

	/** Bounds `content` with {@link finalizeOutput} and assembles the render result around it. */
	finish(contentType: string, method: string, content: string): FetchRenderResult {
		const output = finalizeOutput(content);
		return {
			url: this.url,
			finalUrl: this.finalUrl,
			contentType,
			method,
			content: output.content,
			fetchedAt: this.fetchedAt,
			truncated: output.truncated,
			notes: this.notes,
		};
	}

	finishRendition(rendition: Rendition): FetchRenderResult {
		this.notes.push(rendition.note);
		return this.finish(rendition.contentType, rendition.method, rendition.content);
	}
}

async function withTempBinaryFile<T>(
	prefix: string,
	extension: string,
	bytes: Uint8Array,
	readTempFile: (tempPath: string) => Promise<T>,
): Promise<T> {
	const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
	const tempPath = path.join(tempDir, `payload${extension}`);
	try {
		await Bun.write(tempPath, bytes);
		return await readTempFile(tempPath);
	} finally {
		await fs.rm(tempDir, { recursive: true, force: true });
	}
}

async function renderNotebookPayload(bytes: Uint8Array, displayUrl: string): Promise<string> {
	return withTempBinaryFile("veyyon-url-notebook-", ".ipynb", bytes, tempPath =>
		readEditableNotebookText(tempPath, displayUrl),
	);
}

async function renderSqlitePayload(bytes: Uint8Array): Promise<string> {
	return withTempBinaryFile("veyyon-url-sqlite-", ".sqlite", bytes, async tempPath => {
		let db: Database | null = null;
		try {
			db = new Database(tempPath, { readonly: true, strict: true });
			db.run("PRAGMA busy_timeout = 3000");
			const listLimit = applyListLimit(listTables(db), { limit: URL_SQLITE_LIST_LIMIT });
			return renderTableList(listLimit.items);
		} finally {
			db?.close();
		}
	});
}

/** A structured binary payload the response's bytes can be listed as. */
interface BinaryPayloadRenderer {
	readonly method: string;
	/** Names the format in the note a failed render leaves. */
	readonly format: string;
	render(): Promise<string>;
}

function binaryPayloadRenderer(
	finalUrl: string,
	mime: string,
	extHint: string,
	bytes: Uint8Array,
): BinaryPayloadRenderer | null {
	if (isNotebookHint(mime, extHint)) {
		return { method: "notebook", format: "Notebook", render: () => renderNotebookPayload(bytes, finalUrl) };
	}
	if (isSqliteHint(mime, extHint) || looksLikeSqlite(bytes)) {
		return { method: "sqlite", format: "SQLite", render: () => renderSqlitePayload(bytes) };
	}
	// A convertible document is sniffed for an archive only when its name or type says it is one: a
	// DOCX is a zip, and listing its parts is not what reading it asked for.
	const archiveFormat =
		getArchiveFormatHint(mime, extHint) ?? (isConvertible(mime, extHint) ? undefined : sniffArchiveFormat(bytes));
	if (archiveFormat) {
		return {
			method: "archive",
			format: "Archive",
			render: () => listArchiveRoot(bytes, archiveFormat, { limit: URL_ARCHIVE_LIST_LIMIT }),
		};
	}
	return null;
}

/**
 * A notebook, SQLite database, archive or opaque binary, rendered from the response's bytes; null
 * for a response that names none of them and reads as text.
 */
async function tryRenderBinaryPayload(page: FetchedPage): Promise<FetchRenderResult | null> {
	const { finalUrl, mime, extHint, notes } = page;
	const rawLooksBinary = page.bodySkipped || sampleLooksBinary(page.rawContent);
	if (
		!rawLooksBinary &&
		!isNotebookHint(mime, extHint) &&
		!isSqliteHint(mime, extHint) &&
		!isArchiveHint(mime, extHint)
	) {
		return null;
	}

	const contentType = binaryContentType(mime);
	const binary = await page.binary();
	if (!binary.ok) {
		notes.push(binaryFetchFailure(binary.error));
		return page.finish(contentType, "binary", buildBinaryNotice(finalUrl, mime));
	}

	const notice = buildBinaryNotice(finalUrl, mime, binary.buffer.byteLength);
	const binaryExtHint = getExtensionHint(finalUrl, binary.contentDisposition) || extHint;
	const payload = binaryPayloadRenderer(finalUrl, mime, binaryExtHint, binary.buffer);
	if (payload) {
		try {
			return page.finish(contentType, payload.method, await payload.render());
		} catch (error) {
			notes.push(`${payload.format} rendering failed: ${errorMessage(error)}`);
			return page.finish(contentType, "binary", notice);
		}
	}
	return rawLooksBinary ? page.finish(contentType, "binary", notice) : null;
}

// =============================================================================
// Unified Special Handler Dispatch
// =============================================================================

let specialHandlersPromise: Promise<SpecialHandler[]> | undefined;

/**
 * Lazily load the site-specific scraper handlers. The scrapers barrel eagerly
 * imports ~80 site modules, none of which are needed until the first fetch that
 * requires a special handler, so we keep them out of the cold-startup graph.
 */
function loadSpecialHandlers(): Promise<SpecialHandler[]> {
	specialHandlersPromise ??= import("@veyyon/web/scrapers").then(m => m.specialHandlers);
	return specialHandlersPromise;
}

/**
 * Try all special handlers
 */
export async function handleSpecialUrls(
	url: string,
	timeout: number,
	signal: AbortSignal | undefined,
	storage: AgentStorage | null | undefined,
	notes: string[],
	handlers?: SpecialHandler[],
): Promise<FetchRenderResult | null> {
	const specialHandlers = handlers ?? (await loadSpecialHandlers());
	// One object for the whole walk: a handler that needs a credential, a converter or a managed
	// binary asks this rather than importing it, which is what keeps the scrapers in their own
	// package.
	const services = scrapeServices(storage);
	for (const handler of specialHandlers) {
		throwIfAborted(signal, "fetch");
		let result: RenderResult | ScraperDegrade | null;
		try {
			result = await handler(url, timeout, signal, services);
		} catch (error) {
			// STOP, DO NOT DEGRADE. `isCancellation` is the repo-wide owner of this
			// test and it covers both halves: the user aborting, AND a deadline
			// expiring. The deadline half is the one this guard used to miss, and it
			// is the half that actually fires here. A handler receives `timeout` and
			// builds its own `scopedTimeoutSignal` from it, so when a slow site
			// exhausts the budget the rejection is a `TimeoutError` while the USER's
			// signal is still unaborted. The old condition asked only
			// `signal?.aborted || error instanceof ToolAbortError`, so a timeout fell
			// through to the note-and-continue below and the generic fetch then made
			// the very request that had just run out of time, against the same site,
			// with the budget already spent. `scraperDegrade` in
			// `web/scrapers/types.ts` exists to prevent exactly that and rethrows a
			// cancellation for exactly this reason; the dispatcher's own catch, one
			// layer above it, never got the same guard, so a handler that threw
			// rather than returning a degrade bypassed the protection entirely.
			//
			// The error is rethrown AS IS rather than replaced with a bare
			// `new ToolAbortError()`. A minted one carries no reason and no `cause`,
			// which is what makes a timeout indistinguishable from an abort by the
			// time it reaches the agent loop -- and those mean different things to a
			// user: work they stopped, versus work worth retrying with a longer limit.
			if (isCancellation(error)) throw error;
			// The signal aborted but the handler threw something else, so it swallowed
			// the cancellation on the way out. Report the cancellation, keeping the
			// signal's own reason as the cause.
			throwIfAborted(signal, "fetch");
			// A handler must never take the whole fetch down: record the failure
			// loudly and keep going so the generic fetch still runs.
			const detail = errorMessage(error);
			notes.push(`${handler.name || "site"} scraper threw (${detail}); fell back to a generic fetch`);
			continue;
		}
		throwIfAborted(signal, "fetch");
		if (!result) continue;
		if (isScraperDegrade(result)) {
			// The handler matched the URL but could not scrape it. Surface the
			// degrade on the generic-fetch result — never silently — and stop
			// probing: no other handler claims this site.
			notes.push(result.note);
			return null;
		}
		return result;
	}
	return null;
}

// =============================================================================
// Main Render Function
// =============================================================================

/**
 * Render a URL: a site scraper when one claims it, else the page's first response shaped by what
 * its bytes are (image, convertible document, binary payload, text) and, for HTML, a digestible
 * rendition or the reader-backend chain.
 */
async function renderUrl(requestedUrl: string, request: UrlRenderRequest): Promise<FetchRenderResult> {
	const { raw, timeout, signal, storage } = request;
	const fetchedAt = new Date().toISOString();
	throwIfAborted(signal, "fetch");

	if (requestedUrl.startsWith("pi-internal://")) {
		return {
			url: requestedUrl,
			finalUrl: requestedUrl,
			contentType: "text/plain",
			method: "internal",
			content: "",
			fetchedAt,
			truncated: false,
			notes: ["Internal protocol URL - no external content"],
		};
	}

	const url = normalizeUrl(requestedUrl);
	const notes: string[] = [];
	if (!raw) {
		const specialResult = await handleSpecialUrls(url, timeout, signal, storage, notes);
		if (specialResult) return specialResult;
	}

	const response = await loadPage(url, { timeout, signal, skipBodyForContentType: shouldSkipBodyDownload });
	throwIfAborted(signal, "fetch");
	if (!response.ok) {
		notes.push(response.status ? `Failed to fetch URL (HTTP ${response.status})` : "Failed to fetch URL");
		if (response.error) notes.push(`Cause: ${response.error}`);
		return {
			url,
			finalUrl: response.finalUrl || url,
			contentType: response.contentType || "unknown",
			method: "failed",
			content: "",
			fetchedAt,
			truncated: false,
			notes,
		};
	}
	if (response.truncated) {
		notes.push(`Response body exceeded ${formatBytes(MAX_BYTES)} and was cut mid-stream; content is incomplete`);
	}

	const page = new FetchedPage(url, response, fetchedAt, notes, request);
	return (await renderBinaryResponse(page)) ?? (await renderTextResponse(page));
}

/**
 * A response whose bytes are an image, a convertible document or a binary payload; null for a text
 * response. An image or document that does not render falls through to the binary payload renderers.
 */
async function renderBinaryResponse(page: FetchedPage): Promise<FetchRenderResult | null> {
	const imageMimeType = resolveImageMimeType(page.mime, page.extHint);
	if (imageMimeType) {
		const image = await renderImage(page, imageMimeType);
		if (image) return image;
	} else if (isConvertible(page.mime, page.extHint)) {
		const document = await convertResponseDocument(page);
		if (document) return document;
	}
	return tryRenderBinaryPayload(page);
}

/** An image inlined for the model under the inline output limit; null when the text rendering stands instead. */
async function renderImage(page: FetchedPage, mimeType: string): Promise<FetchRenderResult | null> {
	const { notes } = page;
	if (!isInlineImageMimeTypeSupported(mimeType)) {
		notes.push(
			`Image MIME type ${mimeType} is unsupported for inline model serialization; returning text metadata only`,
			TEXT_FALLBACK_NOTE,
		);
		return null;
	}
	const binary = await page.binary();
	if (!binary.ok) {
		notes.push(binaryFetchFailure(binary.error), TEXT_FALLBACK_NOTE);
		return null;
	}

	notes.push("Fetched image binary");
	const tooLarge = `Fetched image content (${mimeType}), but it is too large to inline render.`;
	if (binary.buffer.byteLength > MAX_INLINE_IMAGE_SOURCE_BYTES) {
		notes.push(
			`Image exceeds inline source limit (${binary.buffer.byteLength} bytes > ${MAX_INLINE_IMAGE_SOURCE_BYTES} bytes)`,
		);
		return page.finish(mimeType, "image-too-large", tooLarge);
	}
	let resized: ResizedImage;
	try {
		resized = await resizeImage(
			{ type: "image", data: Buffer.from(binary.buffer).toBase64(), mimeType },
			{ maxBytes: MAX_INLINE_IMAGE_OUTPUT_BYTES, excludeWebP: page.request.excludeWebP },
		);
	} catch {
		// resizeImage rejects every payload it cannot decode, whatever the label promised. A text body
		// the first response carried, such as a gateway's error page, says why; bytes say nothing.
		notes.push(`Fetched payload could not be decoded as ${mimeType}; returning text metadata only`);
		const { rawContent } = page;
		const content =
			rawContent && !sampleLooksBinary(rawContent)
				? rawContent
				: `Fetched payload was labeled ${mimeType}, but bytes were not a valid image.`;
		return page.finish(mimeType, "image-invalid", content);
	}
	if (resized.buffer.length > MAX_INLINE_IMAGE_OUTPUT_BYTES) {
		notes.push(
			`Image exceeds inline output limit after resize (${resized.buffer.length} bytes > ${MAX_INLINE_IMAGE_OUTPUT_BYTES} bytes)`,
		);
		return page.finish(mimeType, "image-too-large", tooLarge);
	}

	const dimensionNote = formatDimensionNote(resized);
	const summary = `Fetched image content (${resized.mimeType}).${dimensionNote ? `\n${dimensionNote}` : ""}`;
	return {
		...page.finish(resized.mimeType, "image", summary),
		image: { data: resized.data, mimeType: resized.mimeType },
	};
}

/** A PDF, DOCX or other convertible document converted with markit; null when conversion yields nothing usable. */
async function convertResponseDocument(page: FetchedPage): Promise<FetchRenderResult | null> {
	const { notes } = page;
	const binary = await page.binary();
	if (!binary.ok) {
		notes.push(binaryFetchFailure(binary.error));
		return null;
	}
	const extension = getExtensionHint(page.finalUrl, binary.contentDisposition) || page.extHint;
	const converted = await convertDocument(binary.buffer, extension, page.request.timeout, page.request.signal);
	if (!converted.ok) {
		notes.push(converted.error ? `markit conversion failed: ${converted.error}` : "markit conversion failed");
		return null;
	}
	if (converted.content.trim().length <= 50) {
		notes.push("markit conversion produced no usable output");
		return null;
	}
	notes.push("Converted with markit");
	return page.finish(page.mime, "markit", converted.content);
}

/** A text response shaped by its content type. Raw mode returns the body as it arrived. */
async function renderTextResponse(page: FetchedPage): Promise<FetchRenderResult> {
	const { mime, rawContent } = page;
	if (page.request.raw) return page.finish(mime, "raw", rawContent);
	if (mime.includes("json")) return page.finish(mime, "json", formatJson(rawContent));

	const isHtml = mime.includes("html");
	const isFeed = mime.includes("rss") || mime.includes("atom") || mime.includes("feed");
	const isXmlFeed = !isHtml && mime.includes("xml") && (rawContent.includes("<rss") || rawContent.includes("<feed"));
	if (isFeed || isXmlFeed) return page.finish(mime, "feed", await parseFeedToMarkdown(rawContent));

	const isText = mime.includes("text/plain") || mime.includes("text/markdown");
	if (isText && !looksLikeHtml(rawContent)) return page.finish(mime, "text", rawContent);
	if (isHtml) return renderHtmlResponse(page);
	return page.finish(mime, "raw", rawContent);
}

/**
 * An HTML page: a digestible rendition when the site offers one, else the reader-backend chain, with
 * a linked document or an llms.txt file standing in for output that failed or reads as navigation.
 */
async function renderHtmlResponse(page: FetchedPage): Promise<FetchRenderResult> {
	const { notes, request, finalUrl, rawContent } = page;
	const { timeout, signal } = request;
	const rendition = await firstRendition(htmlRenditionProbes(rawContent, finalUrl, page.url, timeout), signal);
	if (rendition) return page.finishRendition(rendition);
	throwIfAborted(signal, "fetch");

	const html = await renderHtmlToText(
		finalUrl,
		rawContent,
		timeout,
		request.settings,
		signal,
		request.storage,
		request.fetchOverride,
		request.resolveTextTransform,
	);
	if (!html.ok) {
		notes.push("html rendering failed (no reader backend produced usable output)");
		const llmsTxt = await firstRendition(llmsTxtProbes(finalUrl, timeout), signal);
		return llmsTxt ? page.finishRendition(llmsTxt) : page.finish(page.mime, "raw-html", rawContent);
	}
	if (isLowQualityOutput(html.content)) {
		const standIn =
			(await linkedDocument(page, html.content)) ?? (await firstRendition(llmsTxtProbes(finalUrl, timeout), signal));
		if (standIn) return page.finishRendition(standIn);
		notes.push("Page appears to require JavaScript or is mostly navigation");
	}
	return page.finish(page.mime, html.method, html.content);
}

/** The first document a navigation-heavy page links to, converted, when it reads longer than the page. */
async function linkedDocument(page: FetchedPage, rendered: string): Promise<Rendition | null> {
	const [documentUrl] = extractDocumentLinks(page.rawContent, page.finalUrl);
	if (documentUrl === undefined) return null;
	const { timeout, signal } = page.request;
	const binary = await fetchBinary(documentUrl, timeout, signal);
	if (!binary.ok) {
		if (binary.error) page.notes.push(binaryFetchFailure(binary.error));
		return null;
	}
	const extension = getExtensionHint(documentUrl, binary.contentDisposition);
	const converted = await convertDocument(binary.buffer, extension, timeout, signal);
	if (converted.ok && converted.content.trim().length > rendered.length) {
		return {
			note: `Extracted and converted document: ${documentUrl}`,
			contentType: "application/document",
			method: "extracted-document",
			content: converted.content,
		};
	}
	if (!converted.ok && converted.error) page.notes.push(`markit conversion failed: ${converted.error}`);
	return null;
}

// =============================================================================
// Tool Definition
// =============================================================================

export interface ReadUrlToolDetails {
	kind: "url";
	url: string;
	finalUrl: string;
	contentType: string;
	method: string;
	truncated: boolean;
	notes: string[];
	meta?: OutputMeta;
}

interface ReadUrlCacheEntry {
	artifactId?: string;
	artifactPath?: string;
	contentPath?: string;
	details: ReadUrlToolDetails;
	image?: FetchImagePayload;
	output: string;
	content: string;
}

const READ_URL_CACHE_MAX_ENTRIES = 100;
const readUrlCache = new LRUCache<string, ReadUrlCacheEntry>({ max: READ_URL_CACHE_MAX_ENTRIES });

function getReadUrlCacheKey(session: ToolSession, requestedUrl: string, raw: boolean): string {
	const scope = session.getSessionFile() ?? session.cwd;
	return `${scope}::${raw ? "raw" : "rendered"}::${normalizeUrl(requestedUrl)}`;
}

/**
 * Resolve an `artifact://<id>` reference to the file that holds it, or null when there is no such
 * artifact. Exported for the regression suite that pins what an unreadable artifact directory
 * reports; production callers reach it through the read_url cache.
 */
export async function findArtifactPath(session: ToolSession, artifactId: string): Promise<string | null> {
	const artifactsDir = session.getArtifactsDir?.();
	if (!artifactsDir) return null;

	try {
		const files = await fs.readdir(artifactsDir);
		const match = files.find(file => file.startsWith(`${artifactId}.`));
		return match ? path.join(artifactsDir, match) : null;
	} catch (err) {
		// An absent directory means no artifact has been written yet, which is a genuine miss. A
		// directory that is there and unreadable is not: returning the same null told the user their
		// `artifact://` URL pointed at nothing, when it pointed at a file this process could not list.
		if (!isEnoent(err)) {
			logger.warn("Artifact directory could not be read; the artifact cannot be resolved", {
				dir: artifactsDir,
				artifactId,
				error: errorMessage(err),
			});
		}
		return null;
	}
}

async function readArtifactOutput(session: ToolSession, artifactId: string): Promise<string | null> {
	const artifactPath = await findArtifactPath(session, artifactId);
	return artifactPath ? await Bun.file(artifactPath).text() : null;
}

async function materializeReadUrlCacheEntry(
	session: ToolSession,
	entry: ReadUrlCacheEntry,
): Promise<ReadUrlCacheEntry | null> {
	if (entry.artifactId) {
		const artifactOutput = await readArtifactOutput(session, entry.artifactId);
		if (artifactOutput !== null) {
			return { ...entry, output: artifactOutput };
		}
	}

	return entry.output.length > 0 ? entry : null;
}

async function persistReadUrlArtifact(
	session: ToolSession,
	output: string,
): Promise<{ id?: string; path?: string } | undefined> {
	const artifact = await session.allocateOutputArtifact?.("read");
	if (!artifact?.path) return undefined;
	await Bun.write(artifact.path, output);
	return artifact;
}

async function ensureReadUrlCacheArtifact(session: ToolSession, entry: ReadUrlCacheEntry): Promise<ReadUrlCacheEntry> {
	if (entry.artifactId && entry.artifactPath) return entry;
	if (entry.artifactId) {
		const artifactPath = await findArtifactPath(session, entry.artifactId);
		if (artifactPath) return { ...entry, artifactPath };
	}
	const artifact = await persistReadUrlArtifact(session, entry.output);
	return artifact?.id ? { ...entry, artifactId: artifact.id, artifactPath: artifact.path } : entry;
}

function readUrlContentExtension(finalUrl: string): string {
	try {
		const ext = getFilenameExtensionHint(new URL(finalUrl).pathname);
		return ext && /^\.[a-z0-9][a-z0-9+.-]{0,15}$/i.test(ext) ? ext : ".txt";
	} catch {
		return ".txt";
	}
}

async function ensureReadUrlContentFile(
	session: ToolSession,
	entry: ReadUrlCacheEntry,
	raw: boolean,
): Promise<ReadUrlCacheEntry> {
	if (entry.contentPath) {
		try {
			await Bun.file(entry.contentPath).stat();
			return entry;
		} catch {
			// Recreate below when the cached scratch file was removed.
		}
	}
	const root = session.getArtifactsDir?.();
	if (!root) {
		throw new ToolError("Cannot search URL output because this session cannot materialize read artifacts.");
	}
	const dir = path.join(root, "url-search");
	await fs.mkdir(dir, { recursive: true });
	const hash = Bun.hash(`${raw ? "raw" : "rendered"}:${entry.details.finalUrl}`).toString(36);
	const contentPath = path.join(dir, `${hash}${readUrlContentExtension(entry.details.finalUrl)}`);
	await Bun.write(contentPath, entry.content);
	return { ...entry, contentPath };
}

function cacheReadUrlEntry(session: ToolSession, requestedUrl: string, raw: boolean, entry: ReadUrlCacheEntry): void {
	readUrlCache.set(getReadUrlCacheKey(session, requestedUrl, raw), entry);
	readUrlCache.set(getReadUrlCacheKey(session, entry.details.finalUrl, raw), entry);
}

async function buildReadUrlCacheEntry(
	session: ToolSession,
	params: { path: string; raw?: boolean },
	signal?: AbortSignal,
	options?: { ensureArtifact?: boolean },
): Promise<ReadUrlCacheEntry> {
	const { path: url, raw = false } = params;

	// The read-url path exposes no per-call timeout, so the fetch tool's
	// configured default is the single source of truth (TOOL_TIMEOUTS.fetch).
	// Passing no override keeps the value in ONE place instead of a literal here
	// that silently diverged from the config's `default`.
	const effectiveTimeout = clampTimeout("fetch", undefined, session.settings.get("tools.maxTimeout"));

	throwIfAborted(signal, "fetch");

	const result = await renderUrl(url, {
		raw,
		timeout: effectiveTimeout,
		signal,
		settings: session.settings,
		storage: AgentStorage.forAgentDir(session.settings.getAgentDir()),
		fetchOverride: session.fetch,
		excludeWebP: webpExclusionForModel(session.getActiveModel?.()),
		resolveTextTransform: () => session.obfuscateProviderText,
	});
	const output = buildUrlReadOutput(result, result.content);
	const artifact = options?.ensureArtifact ? await persistReadUrlArtifact(session, output) : undefined;

	return {
		artifactId: artifact?.id,
		artifactPath: artifact?.path,
		details: {
			kind: "url",
			url: result.url,
			finalUrl: result.finalUrl,
			contentType: result.contentType,
			method: result.method,
			truncated: Boolean(result.truncated),
			notes: result.notes,
		},
		image: result.image,
		output,
		content: result.content,
	};
}

export async function loadReadUrlCacheEntry(
	session: ToolSession,
	params: { path: string; raw?: boolean },
	signal?: AbortSignal,
	options?: { ensureArtifact?: boolean; preferCached?: boolean },
): Promise<ReadUrlCacheEntry> {
	const raw = params.raw ?? false;
	const cached = readUrlCache.get(getReadUrlCacheKey(session, params.path, raw));
	if (options?.preferCached && cached) {
		const prepared = options.ensureArtifact ? await ensureReadUrlCacheArtifact(session, cached) : cached;
		const materialized = await materializeReadUrlCacheEntry(session, prepared);
		if (materialized) {
			cacheReadUrlEntry(session, params.path, raw, materialized);
			return materialized;
		}
	}

	const fresh = await buildReadUrlCacheEntry(session, params, signal, {
		ensureArtifact: options?.ensureArtifact,
	});
	cacheReadUrlEntry(session, params.path, raw, fresh);
	return fresh;
}

/** Materialize rendered URL body text to a local file for tools that require filesystem paths. */
export async function materializeReadUrlToFile(
	session: ToolSession,
	params: { path: string; raw?: boolean },
	signal?: AbortSignal,
): Promise<{ path: string; details: ReadUrlToolDetails }> {
	if (!session.settings.get("fetch.enabled")) {
		throw new ToolError("URL reads are disabled by settings.");
	}
	const cacheEntry = await loadReadUrlCacheEntry(session, params, signal, { preferCached: true });
	const materialized = await ensureReadUrlContentFile(session, cacheEntry, params.raw ?? false);
	cacheReadUrlEntry(session, params.path, params.raw ?? false, materialized);
	if (!materialized.contentPath) {
		throw new ToolError("Cannot search URL output because this session cannot materialize read artifacts.");
	}
	return { path: materialized.contentPath, details: materialized.details };
}

function buildUrlReadOutput(result: FetchRenderResult, content: string): string {
	let output = "";
	output += `URL: ${result.finalUrl}\n`;
	output += `Content-Type: ${result.contentType}\n`;
	output += `Method: ${result.method}\n`;
	if (result.notes.length > 0) {
		output += `Notes: ${result.notes.join("; ")}\n`;
	}
	output += `\n---\n\n`;
	output += content;
	return output;
}

export async function executeReadUrl(
	session: ToolSession,
	params: { path: string; raw?: boolean },
	signal?: AbortSignal,
): Promise<AgentToolResult<ReadUrlToolDetails>> {
	let cacheEntry = await loadReadUrlCacheEntry(session, params, signal, { preferCached: true });
	const truncation = truncateHead(cacheEntry.output, {
		maxBytes: inlineBudgetFor(session),
		maxLines: FETCH_DEFAULT_MAX_LINES,
	});
	const needsArtifact = truncation.truncated;
	if (needsArtifact && !cacheEntry.artifactId) {
		cacheEntry = await ensureReadUrlCacheArtifact(session, cacheEntry);
		cacheReadUrlEntry(session, params.path, params.raw ?? false, cacheEntry);
	}
	const output = needsArtifact ? truncation.content : cacheEntry.output;
	const details: ReadUrlToolDetails = {
		...cacheEntry.details,
		truncated: Boolean(cacheEntry.details.truncated || needsArtifact),
	};

	const contentBlocks: Array<TextContent | ImageContent> = [{ type: "text", text: output }];
	if (cacheEntry.image) {
		contentBlocks.push({ type: "image", data: cacheEntry.image.data, mimeType: cacheEntry.image.mimeType });
	}

	const resultBuilder = toolResult(details).content(contentBlocks).sourceUrl(details.finalUrl);
	if (needsArtifact) {
		resultBuilder.truncation(truncation, { direction: "head", artifactId: cacheEntry.artifactId });
	} else if (cacheEntry.details.truncated) {
		const outputLines = cacheEntry.output.split("\n").length;
		const outputBytes = Buffer.byteLength(cacheEntry.output, "utf-8");
		const totalBytes = Math.max(outputBytes + 1, MAX_OUTPUT_CHARS + 1);
		const totalLines = outputLines + 1;
		resultBuilder.truncationFromText(cacheEntry.output, {
			direction: "tail",
			totalLines,
			totalBytes,
			maxBytes: MAX_OUTPUT_CHARS,
		});
	}

	return resultBuilder.done();
}

// =============================================================================
// TUI Rendering
// =============================================================================
