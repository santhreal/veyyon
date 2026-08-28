export type Rgb = [number, number, number];

export function hexVal(c: number): number {
	if (c >= 0x30 && c <= 0x39) return c - 0x30;
	if (c >= 0x41 && c <= 0x46) return c - 0x41 + 10;
	return c - 0x61 + 10;
}

export function hexChannel(hex: string, i: number): number {
	const hi = hex.charCodeAt(1 + i * 2);
	const lo = hex.charCodeAt(2 + i * 2);
	return (hexVal(hi) << 4) | hexVal(lo);
}

export function parseHex(hex: string): Rgb {
	return [hexChannel(hex, 0), hexChannel(hex, 1), hexChannel(hex, 2)];
}
