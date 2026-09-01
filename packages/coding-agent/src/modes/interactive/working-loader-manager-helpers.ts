import { interruptHint } from "../shared";
import { type ShimmerPalette, shimmerSegments, shimmerText } from "../theme/shimmer";
import { theme } from "../theme/theme";

export const HINT_SHIMMER_PALETTE: ShimmerPalette = {
	low: "dim",
	mid: "muted",
	high: "borderAccent",
};

export type WorkingMessageAccent = { main: string; dim: string };

export type WorkingMessageAccentCacheKey = {
	sessionAccentEnabled: boolean;
	sessionName?: string;
	accentSurfaceLuminance?: number;
};

export const workingMessagePaletteCache = new WeakMap<
	WorkingMessageAccent,
	{ main: ShimmerPalette; hint: ShimmerPalette }
>();

function workingMessagePalettes(accent: WorkingMessageAccent): { main: ShimmerPalette; hint: ShimmerPalette } {
	let entry = workingMessagePaletteCache.get(accent);
	if (!entry) {
		entry = {
			main: { low: "dim", mid: { ansi: accent.main }, high: { ansi: accent.main }, bold: true },
			hint: { low: "dim", mid: { ansi: accent.dim }, high: { ansi: accent.dim } },
		};
		workingMessagePaletteCache.set(accent, entry);
	}
	return entry;
}

export function renderWorkingMessage(message: string, accent?: WorkingMessageAccent, clockText?: string): string {
	const palettes = accent ? workingMessagePalettes(accent) : undefined;
	const palette = palettes?.main;
	const hintPalette = palettes?.hint ?? HINT_SHIMMER_PALETTE;
	const hint = interruptHint();
	let body = message;
	let hasHint = false;
	if (body.endsWith(hint)) {
		body = body.slice(0, -hint.length);
		hasHint = true;
	}
	let clock = "";
	if (clockText && body.endsWith(clockText)) {
		body = body.slice(0, -clockText.length);
		clock = clockText;
	}
	if (!hasHint && !clock) return shimmerText(message, theme, palette);
	const segments = [{ text: body, palette }];
	if (clock) segments.push({ text: clock, palette: hintPalette });
	if (hasHint) segments.push({ text: hint, palette: hintPalette });
	return shimmerSegments(segments, theme);
}
