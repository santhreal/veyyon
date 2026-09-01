import { type MermaidAsciiRenderOptions, renderMermaidAsciiSafe } from "@veyyon/utils/mermaid-ascii";

export interface MermaidResolveOptions extends MermaidAsciiRenderOptions {
	maxWidth?: number;
}

const cache = new Map<string, string | null>();

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
	if (cached !== undefined) return cached;

	const ascii = renderMermaidAsciiSafe(source, direction ? { ...baseOptions, direction } : baseOptions);
	cache.set(key, ascii);
	return ascii;
}

export function resolveMermaidAscii(source: string, options?: MermaidResolveOptions): string | null {
	const normalizedSource = source.replace(/\r\n?/g, "\n").trim();
	if (!normalizedSource) return null;

	const { maxWidth, ...rest } = options ?? {};
	const baseOptions: MermaidAsciiRenderOptions = { colorMode: "none", ...rest };
	const baseKey = JSON.stringify(baseOptions);

	const base = renderVariant(normalizedSource, baseOptions, baseKey, null);
	if (base === null) return null;
	if (maxWidth === undefined) return base;

	let best = base;
	let bestWidth = asciiDisplayWidth(base);
	if (bestWidth <= maxWidth) return base;

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

export function clearMermaidCache(): void {
	cache.clear();
}
