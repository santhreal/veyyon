import { clamp, clamp01 } from "./math";

export interface HSV {
	h: number;
	s: number;
	v: number;
}

export interface RGB {
	r: number;
	g: number;
	b: number;
}

export function hexToRgb(hex: string): RGB {
	const h = hex.startsWith("#") ? hex.slice(1) : hex;
	if (h.length === 3) {
		return {
			r: parseInt(h[0] + h[0], 16),
			g: parseInt(h[1] + h[1], 16),
			b: parseInt(h[2] + h[2], 16),
		};
	}
	return {
		r: parseInt(h.slice(0, 2), 16),
		g: parseInt(h.slice(2, 4), 16),
		b: parseInt(h.slice(4, 6), 16),
	};
}

export function rgbToHex(rgb: RGB): string {
	const toHex = (n: number) => clamp(Math.round(n), 0, 255).toString(16).padStart(2, "0");
	return `#${toHex(rgb.r)}${toHex(rgb.g)}${toHex(rgb.b)}`;
}

export function rgbToHsv(rgb: RGB): HSV {
	const r = rgb.r / 255;
	const g = rgb.g / 255;
	const b = rgb.b / 255;

	const max = Math.max(r, g, b);
	const min = Math.min(r, g, b);
	const d = max - min;

	let h = 0;
	if (d !== 0) {
		if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
		else if (max === g) h = ((b - r) / d + 2) / 6;
		else h = ((r - g) / d + 4) / 6;
	}

	return {
		h: h * 360,
		s: max === 0 ? 0 : d / max,
		v: max,
	};
}

export function hsvToRgb(hsv: HSV): RGB {
	const { s, v } = hsv;
	const h = ((hsv.h % 360) + 360) % 360; // Normalize to 0-360

	const i = Math.floor(h / 60);
	const f = h / 60 - i;
	const p = v * (1 - s);
	const q = v * (1 - f * s);
	const t = v * (1 - (1 - f) * s);

	let r: number, g: number, b: number;
	switch (i % 6) {
		case 0:
			r = v;
			g = t;
			b = p;
			break;
		case 1:
			r = q;
			g = v;
			b = p;
			break;
		case 2:
			r = p;
			g = v;
			b = t;
			break;
		case 3:
			r = p;
			g = q;
			b = v;
			break;
		case 4:
			r = t;
			g = p;
			b = v;
			break;
		default:
			r = v;
			g = p;
			b = q;
			break;
	}

	return {
		r: Math.round(r * 255),
		g: Math.round(g * 255),
		b: Math.round(b * 255),
	};
}

export function hexToHsv(hex: string): HSV {
	return rgbToHsv(hexToRgb(hex));
}

export function hsvToHex(hsv: HSV): string {
	return rgbToHex(hsvToRgb(hsv));
}

export function shiftHue(hex: string, degrees: number): string {
	const hsv = hexToHsv(hex);
	hsv.h = (hsv.h + degrees) % 360;
	if (hsv.h < 0) hsv.h += 360;
	return hsvToHex(hsv);
}
export interface HSVAdjustment {
	h?: number;
	s?: number;
	v?: number;
}

export function adjustHsv(hex: string, adj: HSVAdjustment): string {
	const hsv = hexToHsv(hex);
	if (adj.h !== undefined) {
		hsv.h = (hsv.h + adj.h) % 360;
		if (hsv.h < 0) hsv.h += 360;
	}
	if (adj.s !== undefined) {
		hsv.s = clamp01(hsv.s * adj.s);
	}
	if (adj.v !== undefined) {
		hsv.v = clamp01(hsv.v * adj.v);
	}
	return hsvToHex(hsv);
}

export function hslToHex(h: number, s: number, l: number): string {
	const a = s * Math.min(l, 1 - l);
	const f = (n: number) => {
		const k = (n + h / 30) % 12;
		const color = l - a * clamp(Math.min(k - 3, 9 - k), -1, 1);
		return Math.round(255 * color)
			.toString(16)
			.padStart(2, "0");
	};
	return `#${f(0)}${f(8)}${f(4)}`;
}

const ANSI_16: readonly (readonly [number, number, number])[] = [
	[0, 0, 0],
	[128, 0, 0],
	[0, 128, 0],
	[128, 128, 0],
	[0, 0, 128],
	[128, 0, 128],
	[0, 128, 128],
	[192, 192, 192],
	[128, 128, 128],
	[255, 0, 0],
	[0, 255, 0],
	[255, 255, 0],
	[0, 0, 255],
	[255, 0, 255],
	[0, 255, 255],
	[255, 255, 255],
];
const CUBE_STEPS = [0, 95, 135, 175, 215, 255] as const;

function paletteToRgb(index: number): RGB | undefined {
	if (!Number.isInteger(index) || index < 0 || index > 255) return undefined;
	if (index < 16) {
		const rgb = ANSI_16[index];
		return rgb ? { r: rgb[0], g: rgb[1], b: rgb[2] } : undefined;
	}
	if (index < 232) {
		const n = index - 16;
		return {
			r: CUBE_STEPS[Math.floor(n / 36) % 6] ?? 0,
			g: CUBE_STEPS[Math.floor(n / 6) % 6] ?? 0,
			b: CUBE_STEPS[n % 6] ?? 0,
		};
	}
	const gray = 8 + (index - 232) * 10;
	return { r: gray, g: gray, b: gray };
}

function toRgb(value: string | number): RGB | undefined {
	if (typeof value === "number") return paletteToRgb(value);
	if (typeof value !== "string" || value[0] !== "#") return undefined;
	if (value.length !== 4 && value.length !== 7) return undefined;
	const rgb = hexToRgb(value);
	if (Number.isNaN(rgb.r) || Number.isNaN(rgb.g) || Number.isNaN(rgb.b)) return undefined;
	return rgb;
}

function linearizeChannel(channel: number): number {
	const c = channel / 255;
	return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

export function colorLuma(value: string | number): number | undefined {
	const rgb = toRgb(value);
	if (!rgb) return undefined;
	return (0.2126 * rgb.r + 0.7152 * rgb.g + 0.0722 * rgb.b) / 255;
}

export function relativeLuminance(value: string | number): number | undefined {
	const rgb = toRgb(value);
	if (!rgb) return undefined;
	return 0.2126 * linearizeChannel(rgb.r) + 0.7152 * linearizeChannel(rgb.g) + 0.0722 * linearizeChannel(rgb.b);
}
