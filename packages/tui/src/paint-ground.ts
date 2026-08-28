export type PaintGroundSetting = "auto" | "always" | "never";

export const PAINT_GROUND_AUTO_TOLERANCE = 32;

export function parseHexColor(hex: string): { r: number; g: number; b: number } | null {
	const match = /^#([0-9a-fA-F]{6})$/.exec(hex);
	if (!match) return null;
	const value = parseInt(match[1]!, 16);
	return { r: (value >> 16) & 0xff, g: (value >> 8) & 0xff, b: value & 0xff };
}

export function oscChannelTo8Bit(hexChannel: string): number {
	const value = parseInt(hexChannel, 16);
	if (Number.isNaN(value)) return 0;
	const max = 16 ** hexChannel.length - 1;
	return max > 0 ? Math.round((value / max) * 255) : 0;
}

export function colorDistance(aHex: string, bHex: string): number {
	const a = parseHexColor(aHex);
	const b = parseHexColor(bHex);
	if (!a || !b) return Number.POSITIVE_INFINITY;
	return Math.sqrt((a.r - b.r) ** 2 + (a.g - b.g) ** 2 + (a.b - b.b) ** 2);
}

export function resolvePaintGround(
	setting: PaintGroundSetting,
	themeGroundHex: string,
	terminalBackgroundHex: string | undefined,
): boolean {
	switch (setting) {
		case "always":
			return true;
		case "never":
			return false;
		case "auto":
			if (terminalBackgroundHex === undefined) return false;
			return colorDistance(themeGroundHex, terminalBackgroundHex) <= PAINT_GROUND_AUTO_TOLERANCE;
	}
}

export interface PaintGroundPlan {
	paint: string | null;
	unhonoredAlways: boolean;
}

export function planPaintGround(
	setting: PaintGroundSetting,
	themeGroundHex: string | undefined,
	terminalBackgroundHex: string | undefined,
): PaintGroundPlan {
	if (themeGroundHex === undefined) {
		return { paint: null, unhonoredAlways: setting === "always" };
	}
	const shouldPaint = resolvePaintGround(setting, themeGroundHex, terminalBackgroundHex);
	return { paint: shouldPaint ? themeGroundHex : null, unhonoredAlways: false };
}

export function osc11SetBackgroundSequence(hex: string): string | null {
	const rgb = parseHexColor(hex);
	if (!rgb) return null;
	const channel = (v: number) => v.toString(16).padStart(2, "0");
	return `\x1b]11;rgb:${channel(rgb.r)}/${channel(rgb.g)}/${channel(rgb.b)}\x07`;
}

export const OSC11_RESET_BACKGROUND_SEQUENCE = "\x1b]111\x07";
