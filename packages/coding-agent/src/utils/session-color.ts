import { clampLow, hexToHsv, hslToHex, relativeLuminance } from "@veyyon/utils";

function nameToHue(name: string): number {
	let hash = 5381;
	for (let i = 0; i < name.length; i++) {
		hash = ((hash << 5) + hash) ^ name.charCodeAt(i);
		hash = hash >>> 0; // keep 32-bit unsigned
	}
	return hash % 360;
}

const ACCENT_SATURATION = 0.9;
const ACCENT_DARK_LIGHTNESS = 0.72;
const ACCENT_MIN_CONTRAST = 3;

function accentLuminanceCap(surfaceLuminance: number): number {
	return Math.max(0, (surfaceLuminance + 0.05) / ACCENT_MIN_CONTRAST - 0.05);
}

const MIN_HUE_DISTANCE = 10;
const MIN_SATURATION_FOR_HUE = 0.1;

function hueDistance(a: number, b: number): number {
	const d = Math.abs(a - b);
	return Math.min(d, 360 - d);
}

function hexToHue(hex: string): number | undefined {
	const hsv = hexToHsv(hex);
	if (hsv.s < MIN_SATURATION_FOR_HUE) return undefined;
	return hsv.h;
}

function findSafeHue(target: number, occupied: number[], lo: number, hi: number): number {
	if (occupied.length === 0) return target;
	if (occupied.every(h => hueDistance(target, h) >= MIN_HUE_DISTANCE)) {
		return target;
	}
	for (let d = 1; d <= hi - lo; d++) {
		for (const dir of [1, -1]) {
			const candidate = clampLow(target + d * dir, lo, hi);
			if (occupied.every(h => hueDistance(candidate, h) >= MIN_HUE_DISTANCE)) {
				return candidate;
			}
		}
	}
	return target;
}

const DARK_HUE_START = 0;
const DARK_HUE_END = 120;
const LIGHT_HUE_START = 180;
const LIGHT_HUE_END = 300;

export function getSessionAccentHex(name: string, themeColorHexes: string[], surfaceLuminance?: number): string {
	const hueStart = surfaceLuminance === undefined ? DARK_HUE_START : LIGHT_HUE_START;
	const hueEnd = surfaceLuminance === undefined ? DARK_HUE_END : LIGHT_HUE_END;
	const range = hueEnd - hueStart;

	let targetHue = hueStart + (nameToHue(name) % range);

	const themeHues: number[] = [];
	for (let ti = 0; ti < themeColorHexes.length; ti++) {
		const h = hexToHue(themeColorHexes[ti]!);
		if (h !== undefined) themeHues.push(h);
	}
	targetHue = findSafeHue(targetHue, themeHues, hueStart, hueEnd);

	if (surfaceLuminance === undefined) {
		return hslToHex(targetHue, ACCENT_SATURATION, ACCENT_DARK_LIGHTNESS);
	}

	const cap = accentLuminanceCap(surfaceLuminance);
	const top = hslToHex(targetHue, ACCENT_SATURATION, ACCENT_DARK_LIGHTNESS);
	if ((relativeLuminance(top) ?? 0) <= cap) return top;

	let lo = 0;
	let hi = ACCENT_DARK_LIGHTNESS;
	for (let i = 0; i < 20; i++) {
		const mid = (lo + hi) / 2;
		if ((relativeLuminance(hslToHex(targetHue, ACCENT_SATURATION, mid)) ?? 0) > cap) {
			hi = mid;
		} else {
			lo = mid;
		}
	}
	return hslToHex(targetHue, ACCENT_SATURATION, lo);
}

export function getSessionAccentAnsi(hex: string | undefined): string | undefined {
	if (!hex) return undefined;
	return Bun.color(hex, "ansi-16m") ?? undefined;
}
