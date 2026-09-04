import { isReadableUrlPath, type LineRange, parseLineRanges } from "../core/path-utils";
import { ToolError } from "../core/tool-errors";

/** Repair a scheme collapsed by filesystem path normalization. */
function repairCollapsedScheme(value: string): string {
	const m = value.match(/^(https?):\/(?!\/)/i);
	return m ? `${m[1]}://${value.slice(m[0].length)}` : value;
}

/** Repair a collapsed scheme, then add a scheme if one is missing. */
export function normalizeUrl(url: string): string {
	url = repairCollapsedScheme(url);
	if (!url.match(/^https?:\/\//i)) {
		return `https://${url}`;
	}
	return url;
}

// URL line selectors mirror the file form: `:50`, `:50-100`, `:50+150`, `:5-10,20-30`, `:raw`,
// or `:raw:N-M` / `:N-M:raw` to combine raw mode with a range. If a URL would otherwise look
// like `host:port`, add a trailing slash before the selector (e.g. `https://example.com/:80`
// to read line 80 of the document at `https://example.com/`).
export interface ParsedReadUrlTarget {
	path: string;
	raw: boolean;
	offset?: number;
	limit?: number;
	/** Populated only when the selector contains 2+ ranges. Single-range stays on offset/limit. */
	ranges?: readonly LineRange[];
}

/** Recognize a single selector token (`raw` or one/many line ranges). */
function isUrlSelectorToken(token: string): boolean {
	if (token.toLowerCase() === "raw") return true;
	try {
		return parseLineRanges(token) !== null;
	} catch {
		// Malformed ranges remain part of the URL rather than becoming selectors.
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

/** Peel valid selector tokens from the right, preserving their source order. */
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
