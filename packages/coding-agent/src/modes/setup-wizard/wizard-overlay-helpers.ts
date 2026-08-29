import { padding, padLineToWidth } from "@veyyon/tui";
import type { SetupKeyHint } from "./scenes/types";

export type WizardPhase = "splash" | "transition" | "scene" | "outro" | "done";

export const SCENE_MARGIN_X = 4;
export const MIN_CONTENT_WIDTH = 20;
export const SCENE_TRANSITION_MS = 420;

export const DEFAULT_SCENE_HINTS: readonly SetupKeyHint[] = [
	{ keys: "↑↓", label: "select" },
	{ keys: "enter", label: "confirm" },
];

export const CHIP_BACK = "back";
export const CHIP_SKIP = "skip";
export const CHIP_LEAVE = "leave";

export function hintLabel(hint: SetupKeyHint): string {
	return `${hint.keys} ${hint.label}`;
}

export function indentLine(line: string, width: number, indent: number): string {
	const prefix = padding(Math.min(indent, Math.max(0, width - 1)));
	return padLineToWidth(prefix + line, width);
}
export function rowNoise(y: number): number {
	const h = Math.imul(y ^ 0x9e3779b9, 2654435761);
	return ((h ^ (h >>> 15)) >>> 0) / 4294967296;
}

export function dissolveFrames(from: string[], to: string[], progress: number, height: number): string[] {
	const eased = progress * progress * (3 - 2 * progress);
	const denom = Math.max(1, height - 1);
	const out: string[] = [];
	for (let y = 0; y < height; y++) {
		const threshold = 0.78 * (y / denom) + 0.22 * rowNoise(y);
		out.push((eased >= threshold ? to[y] : from[y]) ?? "");
	}
	return out;
}
