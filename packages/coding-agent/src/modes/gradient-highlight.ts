import { SGR_FG_RESET } from "@veyyon/tui/ansi";
import { maskNonProse } from "./markdown-prose";
import { theme } from "./theme/theme";

export type KeywordHighlighter = (text: string, resetTo?: string, phase?: number) => string;

export interface GradientHighlightSpec {
	probe: RegExp;
	highlight: RegExp;
	stops: number;
	hue: (t: number) => number;
	saturation?: number;
	lightness?: number;
}

export function createGradientHighlighter(spec: GradientHighlightSpec): KeywordHighlighter {
	const { probe, highlight, stops, hue, saturation = 90, lightness = 62 } = spec;

	let cachedMode: string | undefined;
	let cachedPalette: readonly string[] | undefined;

	const palette = (): readonly string[] => {
		const mode = theme.getColorMode();
		if (cachedPalette && cachedMode === mode) return cachedPalette;
		const format = mode === "truecolor" ? "ansi-16m" : "ansi-256";
		const next: string[] = [];
		for (let i = 0; i < stops; i++) {
			next.push(Bun.color(`hsl(${Math.round(hue(i / stops))}, ${saturation}%, ${lightness}%)`, format) ?? "");
		}
		cachedMode = mode;
		cachedPalette = next;
		return next;
	};

	const paint = (word: string, resetTo: string, phase: number): string => {
		const stopsArr = palette();
		const m = stopsArr.length;
		const n = word.length;
		let out = "";
		let prev = "";
		for (let i = 0; i < n; i++) {
			const t = (i / n + phase) % 1;
			const color = stopsArr[Math.floor(t * m) % m] ?? stopsArr[0] ?? "";
			if (color !== prev) {
				out += color;
				prev = color;
			}
			out += word[i];
		}
		return `${out}${resetTo}`;
	};

	return (text: string, resetTo: string = SGR_FG_RESET, phase: number = 0): string => {
		if (!probe.test(text)) return text;
		const wrappedPhase = ((phase % 1) + 1) % 1;
		const masked = maskNonProse(text);
		let out = "";
		let last = 0;
		for (const m of masked.matchAll(highlight)) {
			const start = m.index ?? 0;
			const end = start + m[0].length;
			out += text.slice(last, start) + paint(text.slice(start, end), resetTo, wrappedPhase);
			last = end;
		}
		return out + text.slice(last);
	};
}
