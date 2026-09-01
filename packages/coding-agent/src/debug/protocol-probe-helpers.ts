import * as zlib from "node:zlib";
import { encodeTextSized, ImageProtocol, NotifyProtocol, TERMINAL, type TextSizingScale } from "@veyyon/tui";
import { theme } from "../modes/theme/theme";

export const PNG_SIGNATURE = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);

export function pngChunk(type: string, data: Uint8Array): Uint8Array {
	const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
	const out = Buffer.alloc(body.length + 8);
	out.writeUInt32BE(data.length, 0);
	body.copy(out, 4);
	out.writeUInt32BE(Bun.hash.crc32(body) >>> 0, out.length - 4);
	return out;
}

export function encodeRgbPng(width: number, height: number, rgb: Uint8Array): Uint8Array {
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(width, 0);
	ihdr.writeUInt32BE(height, 4);
	ihdr[8] = 8; // bit depth
	ihdr[9] = 2; // color type: truecolor RGB

	const stride = width * 3;
	const raw = Buffer.alloc((stride + 1) * height);
	for (let y = 0; y < height; y++) {
		raw.set(rgb.subarray(y * stride, y * stride + stride), y * (stride + 1) + 1);
	}
	const idat = zlib.deflateSync(raw);

	return Buffer.concat([
		PNG_SIGNATURE,
		pngChunk("IHDR", ihdr),
		pngChunk("IDAT", idat),
		pngChunk("IEND", new Uint8Array(0)),
	]);
}

export interface SampleImage {
	base64: string;
	mimeType: string;
	dimensions: { widthPx: number; heightPx: number };
}

export function buildSampleImage(width = 192, height = 128): SampleImage {
	const denomX = Math.max(1, width - 1);
	const denomY = Math.max(1, height - 1);
	const rgb = new Uint8Array(width * height * 3);
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const i = (y * width + x) * 3;
			rgb[i] = Math.round((x / denomX) * 255);
			rgb[i + 1] = Math.round((y / denomY) * 255);
			rgb[i + 2] = 128;
		}
	}
	const png = encodeRgbPng(width, height, rgb);
	return {
		base64: Buffer.from(png).toString("base64"),
		mimeType: "image/png",
		dimensions: { widthPx: width, heightPx: height },
	};
}

export const LARGE_TEXT_SAMPLE = "Aa Bb 123";

export function buildLargeTextLines(scales: readonly TextSizingScale[] = [2, 3]): string[] {
	const lines: string[] = [];
	for (const scale of scales) {
		lines.push(`  ${theme.fg("accent", encodeTextSized(`${LARGE_TEXT_SAMPLE} (${scale}x)`, { scale }))}`);
		for (let reserved = 1; reserved < scale; reserved++) lines.push("");
	}
	return lines;
}

export function hsvToRgb(h: number, s: number, v: number): [number, number, number] {
	const c = v * s;
	const hp = (((h % 360) + 360) % 360) / 60;
	const x = c * (1 - Math.abs((hp % 2) - 1));
	let r = 0;
	let g = 0;
	let b = 0;
	if (hp < 1) [r, g, b] = [c, x, 0];
	else if (hp < 2) [r, g, b] = [x, c, 0];
	else if (hp < 3) [r, g, b] = [0, c, x];
	else if (hp < 4) [r, g, b] = [0, x, c];
	else if (hp < 5) [r, g, b] = [x, 0, c];
	else [r, g, b] = [c, 0, x];
	const m = v - c;
	const to8 = (n: number) => Math.round((n + m) * 255);
	return [to8(r), to8(g), to8(b)];
}

export function truecolorBar(cells: number): string {
	let out = "";
	for (let i = 0; i < cells; i++) {
		const [r, g, b] = hsvToRgb((i / cells) * 360, 0.85, 1);
		out += `\x1b[48;2;${r};${g};${b}m `;
	}
	return `${out}\x1b[0m`;
}

export function notifyProtocolLabel(): string {
	switch (TERMINAL.notifyProtocol) {
		case NotifyProtocol.Osc99:
			return "OSC 99 (kitty)";
		case NotifyProtocol.Osc9:
			return "OSC 9 (iTerm2/WezTerm)";
		default:
			return "BEL";
	}
}

export function imageProtocolLabel(): string {
	switch (TERMINAL.imageProtocol) {
		case ImageProtocol.Kitty:
			return "Kitty graphics";
		case ImageProtocol.Iterm2:
			return "iTerm2 inline images";
		case ImageProtocol.Sixel:
			return "Sixel";
		default:
			return "none — text fallback";
	}
}
