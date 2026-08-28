/** OSC 8 terminal hyperlink support for paths and URLs. Wraps display text in `ESC ] 8 ; id=HASH ; URI ESC \ TEXT ESC ] 8 ; ; ESC \` */
import * as url from "node:url";
import { detectStreamAnsiPolicy, TERMINAL } from "@veyyon/tui";
import { BEL, OSC, ST } from "@veyyon/tui/ansi";
// The slot leaf, not the 94-module store: this file reads values, it does not fill them.
import { isSettingsInitialized, settings } from "../config/settings-instance";
// The three leaf modules, NOT the `../internal-urls` barrel. The barrel also exports the MCP protocol, which reaches `mcp/manager` -> `mcp/tool-bridge` ->
import { LocalProtocolHandler, resolveLocalUrlToPath } from "../internal-urls/local-protocol";
import { memoryRootsFromRegistry, resolveMemoryUrlToPath } from "../internal-urls/memory-protocol";
import { parseInternalUrl } from "../internal-urls/parse";

/** Stable 8-char hex ID derived from a URI — hints terminals to coalesce identical adjacent links. */
function buildLinkId(uri: string): string {
	let h = 0;
	for (let i = 0; i < uri.length; i++) {
		// FNV-1a-inspired mix — good enough for a UI hint, no deps
		h = (Math.imul(31, h) + uri.charCodeAt(i)) | 0;
	}
	return (h >>> 0).toString(16).padStart(8, "0");
}

/** Build a properly encoded `file://` URI with optional line/col query params. */
function buildFileUri(filePath: string, opts?: { line?: number; col?: number }): string {
	const uri = url.pathToFileURL(filePath);
	if (opts?.line !== undefined) uri.searchParams.set("line", String(opts.line));
	if (opts?.col !== undefined) uri.searchParams.set("col", String(opts.col));
	return uri.href;
}

/** Returns true when OSC 8 hyperlinks should be emitted. Respects `tui.hyperlinks` setting: */
export function isHyperlinkEnabled(): boolean {
	if (!isSettingsInitialized()) return false;
	const mode = settings.get("tui.hyperlinks");
	if (mode === "off") return false;
	if (mode === "always") return true;
	// auto: respect terminal capabilities and the shared styling policy. Reading `NO_COLOR` here directly was a second home for that decision and could
	if (detectStreamAnsiPolicy() !== "full") return false;
	return TERMINAL.hyperlinks;
}

function safeHyperlinkUri(uri: string): string | undefined {
	if (!uri || /[\x00-\x1f\x7f]/.test(uri)) return undefined;
	return uri;
}

function wrapHyperlinkCore(uri: string, displayText: string, terminator: typeof ST | typeof BEL): string {
	// Do not double-wrap if the text already embeds an OSC 8 sequence.
	if (displayText.includes("\x1b]8;")) return displayText;
	const safeUri = safeHyperlinkUri(uri);
	if (!safeUri) return displayText;
	const id = buildLinkId(safeUri);
	return `${OSC}8;id=${id};${safeUri}${terminator}${displayText}${OSC}8;;${terminator}`;
}

function wrapHyperlink(uri: string, displayText: string): string {
	if (!isHyperlinkEnabled()) return displayText;
	return wrapHyperlinkCore(uri, displayText, ST);
}

/** Wrap `displayText` in an OSC 8 hyperlink pointing at `uri`. Returns `displayText` unchanged when hyperlinks are disabled, `uri` contains */
export function uriHyperlink(uri: string, displayText: string): string {
	return wrapHyperlink(uri, displayText);
}

/** Wrap `displayText` in an OSC 8 hyperlink pointing at an HTTP(S) URL. `www.example.com` inputs are linked as `https://www.example.com`. */
export function urlHyperlink(url: string, displayText: string): string {
	const normalized = url.match(/^www\./i) ? `https://${url}` : url;
	try {
		const parsed = new URL(normalized);
		if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return displayText;
		return wrapHyperlink(parsed.href, displayText);
	} catch {
		return displayText;
	}
}

/** Wrap `displayText` in an OSC 8 hyperlink pointing at an HTTP(S) URL, bypassing terminal capability auto-detection. Used for auth prompts where */
export function urlHyperlinkAlways(url: string, displayText: string): string {
	if (!isSettingsInitialized()) return displayText;
	if (settings.get("tui.hyperlinks") === "off") return displayText;
	const normalized = url.match(/^www\./i) ? `https://${url}` : url;
	try {
		const parsed = new URL(normalized);
		if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return displayText;
		return wrapHyperlinkCore(parsed.href, displayText, BEL);
	} catch {
		return displayText;
	}
}

/** Wrap `displayText` in an OSC 8 hyperlink pointing at a filesystem path. Returns `displayText` unchanged when hyperlinks are disabled or when */
export function fileHyperlink(filePath: string, displayText: string, opts?: { line?: number; col?: number }): string {
	return wrapHyperlink(buildFileUri(filePath, opts), displayText);
}

/** Synchronously resolve a filesystem-backed internal URL (e.g. `local://foo.md`, `memory://root/notes.md`) to its absolute filesystem path. Returns `undefined` */
export function tryResolveInternalUrlSync(input: string): string | undefined {
	try {
		if (input.startsWith("local://")) {
			const opts = LocalProtocolHandler.resolveOptions();
			if (!opts) return undefined;
			return resolveLocalUrlToPath(input, opts);
		}
		if (input.startsWith("memory://")) {
			const url = parseInternalUrl(input);
			const roots = memoryRootsFromRegistry();
			// Exactly one project, or no link. Trying roots in order and returning the first that parses offered to open another project's memory file
			const only = roots.length === 1 ? roots[0] : undefined;
			if (!only) return undefined;
			return resolveMemoryUrlToPath(url, only);
		}
	} catch {
		// Hyperlink targets come from rendered text, including text a model wrote, so a URL this cannot map to
		// a local path is ordinary. Undefined means "not a link this terminal should offer to open", which is
		// the safe direction: the alternative is offering to open a path that was guessed.
		return undefined;
	}
	return undefined;
}
