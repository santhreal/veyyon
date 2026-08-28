import { collapseWhitespace } from "@veyyon/utils/collapse-whitespace";
import { truncate as truncateChars } from "@veyyon/utils/format";
import { stringifyJsonSafe } from "@veyyon/utils/json";
import { stripAnsi } from "@veyyon/utils/strip-ansi";
import { isRecord } from "@veyyon/utils/type-guards";
import type { ToolResultImage, ToolResultLike } from "./types";

export { isRecord, stripAnsi };

export function str(value: unknown): string | null {
	return typeof value === "string" ? value : null;
}

export function num(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function display(value: unknown): string {
	if (value == null) return "";
	if (typeof value === "string") return value;
	if (typeof value === "number" || typeof value === "boolean") return String(value);
	return stringifyJsonSafe(value);
}

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
			} catch {}
		}
		return [raw];
	}
	if (Array.isArray(raw)) return raw.filter((p): p is string => typeof p === "string");
	return [];
}

export function truncate(s: string, maxLen = 100): string {
	return truncateChars(s, maxLen);
}

export function normalizeWs(s: string): string {
	return collapseWhitespace(s);
}

export function replaceTabs(s: string): string {
	return s.replace(/\t/g, "   ");
}

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

export function resultTextOf(result: ToolResultLike | undefined): string {
	if (!result) return "";
	const parts: string[] = [];
	for (const block of result.content) {
		if (block.type === "text" && typeof (block as { text?: unknown }).text === "string") {
			parts.push((block as { text: string }).text);
		}
	}
	return parts.join("\n");
}

export function resultImagesOf(result: ToolResultLike | undefined): ToolResultImage[] {
	if (!result) return [];
	const images: ToolResultImage[] = [];
	for (const block of result.content) {
		const img = block as Partial<ToolResultImage>;
		if (block.type === "image" && typeof img.data === "string" && typeof img.mimeType === "string") {
			images.push(img as ToolResultImage);
		}
	}
	return images;
}

export function detailsRecord(result: ToolResultLike | undefined): Record<string, unknown> | null {
	return result && isRecord(result.details) ? result.details : null;
}

export function argsDigest(args: unknown, maxLen = 96): string {
	if (args == null) return "";
	if (isRecord(args) && Object.keys(args).length === 0) return "";
	return truncate(normalizeWs(display(args)), maxLen);
}

interface HljsLike {
	getLanguage(name: string): unknown;
	highlight(code: string, options: { language: string; ignoreIllegals?: boolean }): { value: string };
}

export function getHljs(): HljsLike | null {
	const candidate = (globalThis as { hljs?: HljsLike }).hljs;
	return candidate && typeof candidate.highlight === "function" ? candidate : null;
}
