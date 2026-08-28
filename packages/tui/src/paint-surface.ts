import { clamp01 } from "@veyyon/utils/math";
import { blendHex } from "./motion-paint";
import { type ColumnWindow, paintBlockBackground } from "./paint-columns";
import { parseHexColor } from "./paint-ground";

const LIGHT = "#ffffff";
const DARK = "#000000";

function liftTarget(ground: string): string {
	const rgb = parseHexColor(ground);
	if (rgb === null) return LIGHT;
	return (0.299 * rgb.r + 0.587 * rgb.g + 0.114 * rgb.b) / 255 < 0.5 ? LIGHT : DARK;
}

export function liftHex(ground: string, amount: number): string {
	return blendHex(ground, liftTarget(ground), clamp01(amount));
}

export interface SurfaceBand {
	start: number;
	end: number;
	lift: number;
}

export interface SurfaceSpec {
	ground: string;
	lift?: number;
	bottomLift?: number;
	bands?: readonly SurfaceBand[];
	columns?: ColumnWindow;
}

const DEFAULT_LIFT = 0.1;
const DEFAULT_BOTTOM_LIFT = 0.055;

export function surfaceColorAt(spec: SurfaceSpec, t: number): string {
	const top = spec.lift ?? DEFAULT_LIFT;
	const bottom = spec.bottomLift ?? DEFAULT_BOTTOM_LIFT;
	const k = clamp01(t);
	return liftHex(spec.ground, top + (bottom - top) * k);
}

export function surfaceRowColor(spec: SurfaceSpec, row: number, rows: number): string {
	for (let i = (spec.bands?.length ?? 0) - 1; i >= 0; i--) {
		const band = spec.bands![i]!;
		if (row >= band.start && row < band.end) return liftHex(spec.ground, band.lift);
	}
	return surfaceColorAt(spec, rows <= 0 ? 0 : row / rows);
}

export function fillSurface(lines: readonly string[], width: number, spec: SurfaceSpec, strength = 1): string[] {
	if (strength <= 0 || lines.length === 0) return lines.slice();
	const rows = Math.max(1, lines.length - 1);
	const clamped = clamp01(strength);
	const groundRgb = parseHexColor(spec.ground);
	if (groundRgb === null) return lines.slice();
	return paintBlockBackground(
		lines,
		width,
		row => {
			const surface = blendHex(spec.ground, surfaceRowColor(spec, row, rows), clamped);
			return ({ background }) => (background === undefined ? surface : undefined);
		},
		spec.columns,
	);
}
