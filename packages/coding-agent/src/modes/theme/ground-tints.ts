import { type PaintGroundPlan, toHexColor } from "@veyyon/tui";

let detectedGround: string | undefined;

let paintedGround: string | undefined;

const listeners: Array<() => void> = [];

const HEX_RE = /^#[0-9a-fA-F]{6}$/;

export function setDetectedTerminalGround(hex: string | undefined): void {
	const normalized = hex !== undefined && HEX_RE.test(hex) ? hex.toLowerCase() : undefined;
	if (normalized === detectedGround) return;
	detectedGround = normalized;
	for (const listener of listeners) listener();
}

export function getDetectedTerminalGround(): string | undefined {
	return detectedGround;
}

export function setPaintedGround(hex: string | undefined): void {
	const normalized = hex !== undefined && HEX_RE.test(hex) ? hex.toLowerCase() : undefined;
	if (normalized === paintedGround) return;
	paintedGround = normalized;
	for (const listener of listeners) listener();
}

export function getVisibleGround(): string | undefined {
	return paintedGround ?? detectedGround;
}

interface GroundPaintTarget {
	setBackgroundColor?(hex: string): void;
	resetBackgroundColor?(): void;
}

export function applyGroundPaint(plan: PaintGroundPlan, terminal: GroundPaintTarget): void {
	if (plan.paint !== null) terminal.setBackgroundColor?.(plan.paint);
	else terminal.resetBackgroundColor?.();
	setPaintedGround(plan.paint ?? undefined);
}

export function onGroundTintChange(listener: () => void): void {
	listeners.push(listener);
}

export function resetGroundTintsForTest(): void {
	detectedGround = undefined;
	paintedGround = undefined;
	listeners.length = 0;
}

function hexVal(c: number): number {
	if (c >= 0x30 && c <= 0x39) return c - 0x30;
	if (c >= 0x41 && c <= 0x46) return c - 0x41 + 10;
	return c - 0x61 + 10;
}

function channels(hex: string): [number, number, number] {
	return [
		(hexVal(hex.charCodeAt(1)) << 4) | hexVal(hex.charCodeAt(2)),
		(hexVal(hex.charCodeAt(3)) << 4) | hexVal(hex.charCodeAt(4)),
		(hexVal(hex.charCodeAt(5)) << 4) | hexVal(hex.charCodeAt(6)),
	];
}

function toHex(rgb: [number, number, number]): string {
	return toHexColor(rgb[0], rgb[1], rgb[2]);
}

function luma(rgb: [number, number, number]): number {
	return (0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2]) / 255;
}

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

export function groundHairlineHex(): string | undefined {
	return tintFromGround(0.12);
}

export function groundRaisedHex(): string | undefined {
	return tintFromGround(0.05);
}

export function groundTintFgAnsi(hex: string | undefined, trueColor: boolean): string | undefined {
	if (hex === undefined || !trueColor) return undefined;
	const [r, g, b] = channels(hex);
	return `\x1b[38;2;${r};${g};${b}m`;
}

export function groundTintBgAnsi(hex: string | undefined, trueColor: boolean): string | undefined {
	if (hex === undefined || !trueColor) return undefined;
	const rgb = channels(hex);
	return `\x1b[48;2;${rgb[0]};${rgb[1]};${rgb[2]}m`;
}
