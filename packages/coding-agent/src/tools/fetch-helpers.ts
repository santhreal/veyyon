import * as path from "node:path";
import { trimTrailingSlashes } from "@veyyon/utils/url";
import { $which } from "@veyyon/utils/which";
import { CONVERTIBLE_EXTENSIONS } from "../markit/convertible-extensions";
import { loadPage, looksLikeHtml } from "../web/scrapers/types";
import { isReadableUrlPath, type LineRange, parseLineRanges } from "./path-utils";
import { ToolError } from "./tool-errors";

export const FETCH_DEFAULT_MAX_LINES = 300;

export const MAX_HTML_NESTING_DEPTH = 500;
export const VOID_HTML_ELEMENTS = new Set([
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
export const HTML_TAG_RE = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)\b[^>]*?(\/?)>/g;

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

export const CONVERTIBLE_MIMES = new Set([
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

export const NOTEBOOK_MIMES = new Set(["application/x-ipynb+json"]);
export const NOTEBOOK_EXTENSIONS = new Set([".ipynb"]);

export const SQLITE_MIMES = new Set([
	"application/vnd.sqlite3",
	"application/x-sqlite3",
	"application/sqlite3",
	"application/sqlite",
]);
export const SQLITE_EXTENSIONS = new Set([".sqlite", ".sqlite3", ".db", ".db3"]);

export const ARCHIVE_MIMES = new Set([
	"application/zip",
	"application/x-zip-compressed",
	"application/x-tar",
	"application/tar",
	"application/gzip",
	"application/x-gzip",
]);
export const ARCHIVE_EXTENSIONS = new Set([".zip", ".tar", ".tar.gz", ".tgz", ".gz"]);

export const IMAGE_MIME_BY_EXTENSION = new Map<string, string>([
	[".png", "image/png"],
	[".jpg", "image/jpeg"],
	[".jpeg", "image/jpeg"],
	[".gif", "image/gif"],
	[".webp", "image/webp"],
]);
export const SUPPORTED_INLINE_IMAGE_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
export const MAX_INLINE_IMAGE_SOURCE_BYTES = 20 * 1024 * 1024;
export const MAX_INLINE_IMAGE_OUTPUT_BYTES = 300 * 1024;

export function hasCommand(cmd: string): boolean {
	return Boolean($which(cmd));
}

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
		return [];
	}
}

function repairCollapsedScheme(value: string): string {
	const m = value.match(/^(https?):\/(?!\/)/i);
	return m ? `${m[1]}://${value.slice(m[0].length)}` : value;
}

export function normalizeUrl(url: string): string {
	url = repairCollapsedScheme(url);
	if (!url.match(/^https?:\/\//i)) {
		return `https://${url}`;
	}
	return url;
}

export const URL_CREDENTIAL_LABELS: Record<string, true> = {
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

export function hasCredentialBearingUrl(value: string): boolean {
	let parsed: URL;
	try {
		parsed = new URL(value);
	} catch {
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

export interface ParsedReadUrlTarget {
	path: string;
	raw: boolean;
	offset?: number;
	limit?: number;
	ranges?: readonly LineRange[];
}

function isUrlSelectorToken(token: string): boolean {
	if (token.toLowerCase() === "raw") return true;
	try {
		return parseLineRanges(token) !== null;
	} catch {
		return false;
	}
}

export function parseReadUrlTarget(readPath: string): ParsedReadUrlTarget | null {
	const repaired = repairCollapsedScheme(readPath);
	const embedded = tryExtractEmbeddedUrlSelector(repaired);
	const urlPath = embedded?.path ?? repaired;
	if (!isReadableUrlPath(urlPath)) {
		return null;
	}

	let raw = false;
	let ranges: readonly LineRange[] | undefined;
	for (const sel of embedded?.sels ?? []) {
		if (sel.toLowerCase() === "raw") {
			raw = true;
			continue;
		}
		if (ranges !== undefined) {
			throw new ToolError(
				`URL selector has multiple range groups; combine them with commas (e.g. \`:5-10,20-30\`).`,
			);
		}
		const parsed = parseLineRanges(sel);
		if (parsed === null) {
			throw new ToolError(`Invalid URL line selector: ${sel}`);
		}
		ranges = parsed;
	}

	if (!ranges || ranges.length === 0) return { path: urlPath, raw };
	if (ranges.length === 1) {
		const r = ranges[0];
		return {
			path: urlPath,
			raw,
			offset: r.startLine,
			limit: r.endLine !== undefined ? r.endLine - r.startLine + 1 : undefined,
		};
	}
	return { path: urlPath, raw, ranges };
}

function tryExtractEmbeddedUrlSelector(readPath: string): { path: string; sels: string[] } | null {
	let basePath = readPath;
	const sels: string[] = [];
	while (true) {
		const lastColonIndex = basePath.lastIndexOf(":");
		if (lastColonIndex <= 0) break;

		const candidate = basePath.slice(lastColonIndex + 1);
		const remainder = basePath.slice(0, lastColonIndex);
		if (!isReadableUrlPath(remainder)) break;
		if (!isUrlSelectorToken(candidate)) break;

		try {
			new URL(
				remainder.startsWith("http://") || remainder.startsWith("https://") ? remainder : `https://${remainder}`,
			);
		} catch {
			break;
		}

		sels.unshift(candidate);
		basePath = remainder;
	}
	if (sels.length === 0) return null;
	return { path: basePath, sels };
}

export function normalizeMime(contentType: string): string {
	return contentType.split(";")[0].trim().toLowerCase();
}

export function getFilenameExtensionHint(filename: string): string {
	const lower = filename.toLowerCase();
	if (lower.endsWith(".tar.gz")) return ".tar.gz";
	return path.extname(filename).toLowerCase();
}

export function getExtensionHint(url: string, contentDisposition?: string): string {
	if (contentDisposition) {
		const match = contentDisposition.match(/filename[*]?=["']?([^"';\n]+)/i);
		if (match) {
			const ext = getFilenameExtensionHint(match[1]);
			if (ext) return ext;
		}
	}

	try {
		const pathname = new URL(url).pathname;
		const ext = getFilenameExtensionHint(pathname);
		if (ext) return ext;
	} catch {}

	return "";
}

export function isConvertible(mime: string, extensionHint: string): boolean {
	if (CONVERTIBLE_MIMES.has(mime)) return true;
	if (mime === "application/octet-stream" && CONVERTIBLE_EXTENSIONS.has(extensionHint)) return true;
	if (CONVERTIBLE_EXTENSIONS.has(extensionHint)) return true;
	return false;
}

export function resolveImageMimeType(mime: string, extensionHint: string): string | null {
	if (mime.startsWith("image/")) return mime;
	const shouldUseExtensionHint =
		mime.length === 0 || mime === "application/octet-stream" || mime === "binary/octet-stream" || mime === "unknown";
	if (!shouldUseExtensionHint) return null;
	return IMAGE_MIME_BY_EXTENSION.get(extensionHint) ?? null;
}

export function isInlineImageMimeTypeSupported(mimeType: string): boolean {
	return SUPPORTED_INLINE_IMAGE_MIME_TYPES.has(mimeType);
}

export async function tryMdSuffix(url: string, timeout: number, signal?: AbortSignal): Promise<string | null> {
	const candidates: string[] = [];

	try {
		const parsed = new URL(url);
		const pathname = parsed.pathname;

		if (pathname.endsWith("/")) {
			candidates.push(`${parsed.origin}${pathname}index.html.md`);
		} else if (pathname.includes(".")) {
			candidates.push(`${parsed.origin}${pathname}.md`);
		} else {
			candidates.push(`${parsed.origin}${pathname}.md`);
		}
	} catch {
		return null;
	}

	if (signal?.aborted) {
		return null;
	}

	for (const candidate of candidates) {
		if (signal?.aborted) {
			return null;
		}
		const result = await loadPage(candidate, { timeout, signal });
		if (result.ok && result.content.trim().length > 100 && !looksLikeHtml(result.content)) {
			return result.content;
		}
	}

	return null;
}

export async function tryLlmEndpoints(
	url: string,
	timeout: number,
	signal?: AbortSignal,
): Promise<{ content: string; endpoint: string } | null> {
	const endpoints = buildLlmEndpointCandidates(url);

	if (signal?.aborted || endpoints.length === 0) {
		return null;
	}

	for (const endpoint of endpoints) {
		if (signal?.aborted) {
			return null;
		}
		const result = await loadPage(endpoint, { timeout: Math.min(timeout, 5), signal });
		if (result.ok && result.content.trim().length > 100 && !looksLikeHtml(result.content)) {
			return { content: result.content, endpoint };
		}
	}
	return null;
}

export async function tryContentNegotiation(
	url: string,
	timeout: number,
	signal?: AbortSignal,
): Promise<{ content: string; type: string } | null> {
	if (signal?.aborted) {
		return null;
	}

	const result = await loadPage(url, {
		timeout,
		headers: { Accept: "text/markdown, text/plain;q=0.9, text/html;q=0.8" },
		signal,
	});

	if (!result.ok) return null;

	const mime = normalizeMime(result.contentType);
	if ((mime.includes("markdown") || mime === "text/plain") && !looksLikeHtml(result.content)) {
		return { content: result.content, type: result.contentType };
	}

	return null;
}

export function getHtmlAttribute(tag: string, attribute: string): string | null {
	const pattern = new RegExp(`\\b${attribute}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'=<>]+))`, "i");
	const match = tag.match(pattern);
	if (!match) return null;
	return (match[1] ?? match[2] ?? match[3] ?? "").trim();
}

export function extractHeadHtml(html: string): string {
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
