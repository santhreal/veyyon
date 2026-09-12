/**
 * Pure helpers shared by tool renderers. Host-agnostic; no DOM beyond
 * `globalThis` feature probes, no host-framework imports. `stripAnsi` is
 * re-exported from the dependency-free `@veyyon/utils/strip-ansi` subpath
 * (bypasses the Node-heavy package barrel) so this file stays safe to bundle
 * for the browser — see BACKLOG SPEC-ONE-PLACE-AUDIT F6.
 */

import { collapseWhitespace } from "@veyyon/utils/collapse-whitespace";
import { formatCount, truncate as truncateChars } from "@veyyon/utils/format";
import { stringifyJsonSafe } from "@veyyon/utils/json";
import { stripAnsi } from "@veyyon/utils/strip-ansi";
import { finiteNumber, isRecord } from "@veyyon/utils/type-guards";
import type { ToolResultImage, ToolResultLike } from "./types";

// Re-exported from the dependency-free type-guards subpath for the same
// bundle-safety reason as stripAnsi above.
export { finiteNumber, formatCount, isRecord, stripAnsi };

/** String passthrough; anything else (including null/undefined) → null. */
export function str(value: unknown): string | null {
	return typeof value === "string" ? value : null;
}

export function strList(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	const out: string[] = [];
	for (const item of value) {
		if (typeof item === "string" && item) out.push(item);
	}
	return out;
}

export function recordList(value: unknown): Record<string, unknown>[] {
	if (!Array.isArray(value)) return [];
	const out: Record<string, unknown>[] = [];
	for (const item of value) {
		if (isRecord(item)) out.push(item);
	}
	return out;
}

/**
 * React keys for a sibling list whose items carry no id of their own. Each key is the item's
 * identity as `identity` states it; siblings with equal identities are told apart by an ordinal
 * among equals, so inserting or removing an unrelated sibling leaves every other key unchanged.
 */
export function keyed<T>(items: readonly T[], identity: (item: T) => string): { key: string; item: T }[] {
	const seen = new Map<string, number>();
	return items.map(item => {
		const id = identity(item);
		const ordinal = seen.get(id) ?? 0;
		seen.set(id, ordinal + 1);
		return { key: ordinal === 0 ? id : `${id}\u001f${ordinal}`, item };
	});
}

export function truncateWs(value: unknown, maxLen = 80): string {
	const text = str(value);
	return text ? truncate(normalizeWs(text), maxLen) : "";
}

/** Coerce unknown to a display string ("" for null/undefined). */
export function display(value: unknown): string {
	if (value == null) return "";
	if (typeof value === "string") return value;
	if (typeof value === "number" || typeof value === "boolean") return String(value);
	// The shared owner, so a cyclic or bigint value renders its contents rather
	// than the literal text "[object Object]".
	return stringifyJsonSafe(value);
}

/**
 * Replace the `/Users/<x>` / `/home/<x>` home prefix with `~` for display.
 *
 * Browser-safe: this package bundles for the web, where `os.homedir()` is
 * unavailable, so the home directory is matched by the `/Users/<user>` and
 * `/home/<user>` conventions rather than the real `$HOME`. The coding-agent
 * TUI has its own `shortenPath` in `coding-agent/src/tools/core/render-utils.ts`
 * that collapses the real home dir (it runs under Node, where `$HOME` is
 * known); the two are a deliberate runtime split, not an accidental
 * duplicate. This is the single owner for every browser surface: collab-web
 * re-exports it from here rather than keeping its own copy.
 *
 * Pass `collapseAfter` to also elide a long middle: a path with more than
 * `collapseAfter` slash-separated segments renders as `first/…/last-two`.
 * Omit it (the default) to shorten only the home prefix.
 */
export function shortenPath(p: string, opts?: { collapseAfter?: number }): string {
	let out = p;
	for (const prefix of ["/Users/", "/home/"]) {
		if (p.startsWith(prefix)) {
			const rest = p.slice(prefix.length);
			const slash = rest.indexOf("/");
			out = slash < 0 ? "~" : `~${rest.slice(slash)}`;
			break;
		}
	}
	const collapseAfter = opts?.collapseAfter;
	if (collapseAfter !== undefined) {
		const segs = out.split("/");
		if (segs.length > collapseAfter) {
			out = `${segs[0]}/…/${segs.slice(-2).join("/")}`;
		}
	}
	return out;
}

/**
 * Search scope for display: the current `path` argument (else the legacy
 * `paths`), normalized from a single string, a JSON-encoded string array
 * (`'["a.ts","b.ts"]'`), or an actual array into a flat `string[]`. Mirrors the
 * coding-agent `toPathList` so web cards render the same scope the tool searched.
 */
export function scopePaths(args: Record<string, unknown>): string[] {
	const raw = args.path ?? args.paths;
	if (typeof raw === "string") {
		const trimmed = raw.trim();
		if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
			try {
				const parsed: unknown = JSON.parse(trimmed);
				if (Array.isArray(parsed) && parsed.every((p): p is string => typeof p === "string")) {
					return parsed;
				}
			} catch {
				// Not valid JSON — treat the whole string as one path.
			}
		}
		if (trimmed.includes(";")) {
			const parts = trimmed
				.split(";")
				.map(p => p.trim())
				.filter(Boolean);
			if (parts.length > 0) return parts;
		}
		return [raw];
	}
	if (Array.isArray(raw)) return raw.filter((p): p is string => typeof p === "string");
	return [];
}

/** Differs from `@veyyon/utils/format`: provides default maxLen = 100 for tool renderers. */
export function truncate(s: string, maxLen = 100): string {
	return truncateChars(s, maxLen);
}

/** Collapse all whitespace runs to single spaces (for one-line summaries). */
export function normalizeWs(s: string): string {
	return collapseWhitespace(s);
}

export { replaceTabs } from "@veyyon/utils/tab-width";

const EXT_TO_LANG: Record<string, string> = {
	ts: "typescript",
	tsx: "typescript",
	mts: "typescript",
	cts: "typescript",
	js: "javascript",
	jsx: "javascript",
	mjs: "javascript",
	cjs: "javascript",
	py: "python",
	rb: "ruby",
	rs: "rust",
	go: "go",
	java: "java",
	kt: "kotlin",
	swift: "swift",
	c: "c",
	h: "c",
	cpp: "cpp",
	cc: "cpp",
	hpp: "cpp",
	cs: "csharp",
	php: "php",
	sh: "bash",
	bash: "bash",
	zsh: "bash",
	fish: "bash",
	sql: "sql",
	html: "html",
	css: "css",
	scss: "scss",
	less: "less",
	json: "json",
	jsonc: "json",
	json5: "json",
	yaml: "yaml",
	yml: "yaml",
	toml: "ini",
	ini: "ini",
	xml: "xml",
	svg: "xml",
	md: "markdown",
	mdx: "markdown",
	dockerfile: "dockerfile",
	lua: "lua",
	zig: "zig",
	diff: "diff",
	patch: "diff",
};

export function languageFromPath(filePath: string): string | null {
	const base = filePath.split("/").pop() ?? "";
	if (/^dockerfile$/i.test(base)) return "dockerfile";
	const ext = base.split(".").pop()?.toLowerCase() ?? "";
	return EXT_TO_LANG[ext] ?? null;
}

/** Joined text blocks of a tool result ("" when absent). */
export function resultTextOf(result: ToolResultLike | undefined): string {
	if (!result || !Array.isArray(result.content)) return "";
	const parts: string[] = [];
	for (const block of result.content) {
		if (isRecord(block) && block.type === "text" && "text" in block && typeof block.text === "string") {
			parts.push(block.text);
		}
	}
	return parts.join("\n");
}

/** Whether a tool result contains at least one valid image content block (non-allocating). */
export function resultHasImages(result: ToolResultLike | undefined): boolean {
	if (!result) return false;
	if (
		Array.isArray(result.content) &&
		result.content.some(
			block =>
				isRecord(block) &&
				block.type === "image" &&
				typeof block.data === "string" &&
				typeof block.mimeType === "string",
		)
	) {
		return true;
	}
	if (isRecord(result.details) && Array.isArray(result.details.images)) {
		return result.details.images.some(
			block => isRecord(block) && typeof block.data === "string" && typeof block.mimeType === "string",
		);
	}
	return false;
}

export function resultImagesOf(result: ToolResultLike | undefined): ToolResultImage[] {
	if (!result) return [];
	const images: ToolResultImage[] = [];
	if (Array.isArray(result.content)) {
		for (const block of result.content) {
			if (
				isRecord(block) &&
				block.type === "image" &&
				typeof block.data === "string" &&
				typeof block.mimeType === "string"
			) {
				images.push({ type: "image", data: block.data, mimeType: block.mimeType });
			}
		}
	}
	if (images.length === 0 && isRecord(result.details) && Array.isArray(result.details.images)) {
		for (const block of result.details.images) {
			if (isRecord(block) && typeof block.data === "string" && typeof block.mimeType === "string") {
				images.push({ type: "image", data: block.data, mimeType: block.mimeType });
			}
		}
	}
	return images;
}

/** `result.details` when it is a plain object; renderers narrow field-by-field. */
export function detailsRecord(result: ToolResultLike | undefined): Record<string, unknown> | null {
	return result && isRecord(result.details) ? result.details : null;
}

/** Compact one-line JSON digest of arbitrary args (generic summary fallback). */
export function argsDigest(args: unknown, maxLen = 96): string {
	if (args == null) return "";
	if (isRecord(args) && Object.keys(args).length === 0) return "";
	return truncate(normalizeWs(display(args)), maxLen);
}

/** Formatted JSON string representation with safe fallback (`try JSON.stringify ... catch String(...)`). */
export function prettyJson(value: unknown, indent = 2): string {
	if (value === undefined) return "";
	try {
		return JSON.stringify(value, null, indent) ?? "";
	} catch {
		return String(value);
	}
}

interface HljsLike {
	getLanguage(name: string): unknown;
	highlight(code: string, options: { language: string; ignoreIllegals?: boolean }): { value: string };
}

/**
 * Optional syntax highlighter seam. The HTML export page ships highlight.js as
 * a global; the collab-web app does not bundle it. Renderers degrade to plain
 * text when absent.
 */
export function getHljs(): HljsLike | null {
	const candidate = (globalThis as { hljs?: HljsLike }).hljs;
	return candidate && typeof candidate.highlight === "function" ? candidate : null;
}
