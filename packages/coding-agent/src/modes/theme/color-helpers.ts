export type Rgb = [number, number, number];

export function hexVal(c: number): number {
	if (c >= 0x30 && c <= 0x39) return c - 0x30;
	if (c >= 0x41 && c <= 0x46) return c - 0x41 + 10;
	return c - 0x61 + 10;
}

function hexChannel(hex: string, i: number): number {
	const hi = hex.charCodeAt(1 + i * 2);
	const lo = hex.charCodeAt(2 + i * 2);
	return (hexVal(hi) << 4) | hexVal(lo);
}

export function parseHex(hex: string): Rgb {
	return [hexChannel(hex, 0), hexChannel(hex, 1), hexChannel(hex, 2)];
}

export function mixRgb(a: Rgb, b: Rgb, t: number): Rgb {
	const c = t < 0 ? 0 : t > 1 ? 1 : t;
	return [
		Math.round(a[0] + (b[0] - a[0]) * c),
		Math.round(a[1] + (b[1] - a[1]) * c),
		Math.round(a[2] + (b[2] - a[2]) * c),
	];
}
