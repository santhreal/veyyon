import { type MermaidAsciiRenderOptions, renderMermaidAsciiSafe } from "@veyyon/utils/mermaid-ascii";
import { LRUCache } from "lru-cache/raw";

/**
 * Options controlling how fenced Mermaid source is resolved to terminal ASCII.
 * Extends the raw render options (theme, color mode, spacing, `useAscii`) with a
 * viewport-fitting hint.
 */
export interface MermaidResolveOptions extends MermaidAsciiRenderOptions {
	/**
	 * Maximum display width (terminal columns) the diagram should occupy. A
	 * layout that overflows this width is re-rendered in the perpendicular
	 * orientation — a wide horizontal chain collapses to a tall vertical column
	 * (which the terminal can scroll), and a wide vertical fan-out collapses to a
	 * tall horizontal column. Omit to keep the source's own layout regardless of
	 * width.
	 */
	maxWidth?: number;
}

/** A render that failed, held so a malformed diagram is not parsed again on every frame. */
const FAILED = Symbol("mermaid render failed");

/**
 * UTF-16 code units of source and ASCII the cache holds, least recently used first out. A streamed
 * diagram resolves once per frame on the fence received so far and every frame is a new source, so
 * without a bound the renders of every frame of every diagram stayed for the life of the session.
 */
const CACHE_MAX_UNITS = 512 * 1024;

// Memoizes rendered ASCII (and failures) keyed on the render options + the
// layout-direction variant + source. Width selection happens per call against
// the cached renders, so a terminal resize re-decides without re-rendering.
const cache = new LRUCache<string, string | typeof FAILED>({
	maxSize: CACHE_MAX_UNITS,
	sizeCalculation: (ascii, key) => key.length + (ascii === FAILED ? 0 : ascii.length),
});

/** Widest rendered row in display columns (ANSI- and CJK-aware). */
function asciiDisplayWidth(ascii: string): number {
	let max = 0;
	for (const line of ascii.split("\n")) {
		const width = Bun.stringWidth(line);
		if (width > max) max = width;
	}
	return max;
}

function renderVariant(
	source: string,
	baseOptions: MermaidAsciiRenderOptions,
	baseKey: string,
	direction: "TD" | "LR" | null,
): string | null {
	const key = `${baseKey}\x00${direction ?? ""}\x00${source}`;
	const cached = cache.get(key);
	if (cached !== undefined) return cached === FAILED ? null : cached;

	const ascii = renderMermaidAsciiSafe(source, direction ? { ...baseOptions, direction } : baseOptions);
	cache.set(key, ascii ?? FAILED);
	return ascii;
}

/**
 * Resolve mermaid ASCII from fenced block source text.
 * Returns null when rendering fails, while memoizing failures to avoid repeated work.
 */
export function resolveMermaidAscii(source: string, options?: MermaidResolveOptions): string | null {
	const normalizedSource = source.replace(/\r\n?/g, "\n").trim();
	if (!normalizedSource) return null;

	const { maxWidth, ...rest } = options ?? {};
	// Default to uncolored output; callers opt into a themed palette explicitly.
	const baseOptions: MermaidAsciiRenderOptions = { colorMode: "none", ...rest };
	const baseKey = JSON.stringify(baseOptions);

	const base = renderVariant(normalizedSource, baseOptions, baseKey, null);
	if (base === null) return null;
	if (maxWidth === undefined) return base;

	let best = base;
	let bestWidth = asciiDisplayWidth(base);
	if (bestWidth <= maxWidth) return base;

	// The as-authored layout overflows. Render both forced orientations and keep
	// the narrowest (clipping at the call site handles any residual overflow).
	// Re-rendering the already-authored orientation is a cache hit, so this stays
	// cheap, and one of the two will be the perpendicular fit.
	for (const direction of ["TD", "LR"] as const) {
		const variant = renderVariant(normalizedSource, baseOptions, baseKey, direction);
		if (variant === null) continue;
		const variantWidth = asciiDisplayWidth(variant);
		if (variantWidth < bestWidth) {
			best = variant;
			bestWidth = variantWidth;
		}
	}
	return best;
}

/**
 * Clear the mermaid cache.
 */
export function clearMermaidCache(): void {
	cache.clear();
}
