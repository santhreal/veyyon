/**
 * Terminal-ground-relative tints — the ONE owner for deriving chrome colors
 * from the terminal's REAL background instead of hardcoding hexes.
 *
 * Why this exists: titanium's structural hexes (borderMuted #202329, the
 * retired quiet-card #0C0E12) were calibrated against a pure-black terminal.
 * On any other ground they fail in one of two ways: absolute dark fills
 * render as foreign black slabs (the 2026-07-22 regression), and hairlines a
 * few steps above black vanish into a grey ground (the invisible card
 * outlines in the same day's proof renders). The fix is relative color: take
 * the DETECTED ground (OSC 11, via `terminal.backgroundColor` /
 * `onBackgroundColorChange`) and offset it by a fixed contrast delta, so the
 * chrome keeps the same subtle distance from the ground on every terminal.
 *
 * With no detection (terminal never answered OSC 11) every getter returns
 * `undefined` and callers keep their static theme-token fallback. That
 * degrade is loud in behavior, not silent in correctness: the fallback is the
 * exact pre-detection rendering, never a wrong guess at the ground.
 */

import type { PaintGroundPlan } from "@veyyon/tui";

/** Currently detected terminal background (`#rrggbb`), if any. */
let detectedGround: string | undefined;

/** The ground this process painted onto the terminal (`#rrggbb`), if any. */
let paintedGround: string | undefined;

/** Change listeners (the TUI re-render hook). */
const listeners: Array<() => void> = [];

const HEX_RE = /^#[0-9a-fA-F]{6}$/;

/** Record the detected terminal ground. Pass `undefined` to clear (e.g. a
 *  terminal that later revoked its report). Notifies listeners on change. */
export function setDetectedTerminalGround(hex: string | undefined): void {
	const normalized = hex !== undefined && HEX_RE.test(hex) ? hex.toLowerCase() : undefined;
	if (normalized === detectedGround) return;
	detectedGround = normalized;
	for (const listener of listeners) listener();
}

export function getDetectedTerminalGround(): string | undefined {
	return detectedGround;
}

/**
 * Record the ground the app painted onto the terminal (OSC 11), or `undefined`
 * when it painted none. The paint policy (`tui.paintGround`) decides this, and a
 * theme's declared ground is NOT it: `auto` refuses to paint a ground far from
 * the terminal's own, so a theme declaring black on a grey terminal leaves grey
 * on screen. Anything mixing a color out of "what is behind this row" needs the
 * color that is actually behind it.
 */
export function setPaintedGround(hex: string | undefined): void {
	const normalized = hex !== undefined && HEX_RE.test(hex) ? hex.toLowerCase() : undefined;
	if (normalized === paintedGround) return;
	paintedGround = normalized;
	for (const listener of listeners) listener();
}

/**
 * The ground a row VISIBLY sits on: the ground this process painted, else the
 * one the terminal reported, else undefined when neither is known.
 */
export function getVisibleGround(): string | undefined {
	return paintedGround ?? detectedGround;
}

/** The two terminal calls a ground paint needs; both optional on the Terminal interface. */
interface GroundPaintTarget {
	setBackgroundColor?(hex: string): void;
	resetBackgroundColor?(): void;
}

/**
 * Carry out a paint decision: set (or clear) the terminal background, and record
 * the ground that leaves on screen.
 *
 * One function because the two halves cannot be allowed to disagree. Painting
 * without recording is the defect this closes — the policy declined to paint
 * titanium's black onto a grey terminal, nothing told the animations, and every
 * fade went on mixing out of a black that was not there.
 */
export function applyGroundPaint(plan: PaintGroundPlan, terminal: GroundPaintTarget): void {
	if (plan.paint !== null) terminal.setBackgroundColor?.(plan.paint);
	else terminal.resetBackgroundColor?.();
	setPaintedGround(plan.paint ?? undefined);
}

/** Subscribe to ground changes (used to request a repaint). */
export function onGroundTintChange(listener: () => void): void {
	listeners.push(listener);
}

/** Test hook: drop all listeners, the detected ground, and the painted one. */
export function resetGroundTintsForTest(): void {
	detectedGround = undefined;
	paintedGround = undefined;
	listeners.length = 0;
}

function channels(hex: string): [number, number, number] {
	return [
		Number.parseInt(hex.slice(1, 3), 16),
		Number.parseInt(hex.slice(3, 5), 16),
		Number.parseInt(hex.slice(5, 7), 16),
	];
}

function toHex(rgb: [number, number, number]): string {
	return `#${rgb
		.map(c =>
			Math.round(Math.min(255, Math.max(0, c)))
				.toString(16)
				.padStart(2, "0"),
		)
		.join("")}`;
}

/** Perceived lightness in [0,1] (Rec. 601 luma — enough to pick a direction). */
function luma(rgb: [number, number, number]): number {
	return (0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2]) / 255;
}

/**
 * Mix the ground toward its contrast pole (white on dark grounds, black on
 * light grounds) by `amount` in [0,1]. The SAME delta on every terminal is
 * what keeps the chrome equally quiet everywhere.
 */
function tintFromGround(amount: number): string | undefined {
	if (detectedGround === undefined) return undefined;
	const rgb = channels(detectedGround);
	const pole = luma(rgb) < 0.5 ? 255 : 0;
	return toHex([
		rgb[0] + (pole - rgb[0]) * amount,
		rgb[1] + (pole - rgb[1]) * amount,
		rgb[2] + (pole - rgb[2]) * amount,
	]);
}

/** Hairline / card outline: visible but structural (12% toward the pole). */
export function groundHairlineHex(): string | undefined {
	return tintFromGround(0.12);
}

/** Raised surface (card ground, selected row base): a whisper (5%). */
export function groundRaisedHex(): string | undefined {
	return tintFromGround(0.05);
}

/** 24-bit foreground open for a derived tint, or undefined without detection
 *  or 24-bit color. Callers fall back to their static theme token. */
export function groundTintFgAnsi(hex: string | undefined, trueColor: boolean): string | undefined {
	if (hex === undefined || !trueColor) return undefined;
	const [r, g, b] = channels(hex);
	return `\x1b[38;2;${r};${g};${b}m`;
}

/** 24-bit background open for a derived tint, or undefined without detection
 *  or 24-bit color. Callers fall back to no paint (transparent). */
export function groundTintBgAnsi(hex: string | undefined, trueColor: boolean): string | undefined {
	if (hex === undefined || !trueColor) return undefined;
	const rgb = channels(hex);
	return `\x1b[48;2;${rgb[0]};${rgb[1]};${rgb[2]}m`;
}
