import * as zlib from "node:zlib";
import {
	type Component,
	Container,
	encodeTextSized,
	Image,
	type ImageBudget,
	ImageProtocol,
	NotifyProtocol,
	Spacer,
	TERMINAL,
	Text,
	type TextSizingScale,
} from "@veyyon/tui";
import { COMPOSER_INSET_COLS } from "../modes/components/composer-chrome";
import { theme } from "../modes/theme/theme";

const PNG_SIGNATURE = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);

function pngChunk(type: string, data: Uint8Array): Uint8Array {
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

const LARGE_TEXT_SAMPLE = "Aa Bb 123";

export function buildLargeTextLines(scales: readonly TextSizingScale[] = [2, 3]): string[] {
	const lines: string[] = [];
	for (const scale of scales) {
		lines.push(`  ${theme.fg("accent", encodeTextSized(`${LARGE_TEXT_SAMPLE} (${scale}x)`, { scale }))}`);
		for (let reserved = 1; reserved < scale; reserved++) lines.push("");
	}
	return lines;
}

function hsvToRgb(h: number, s: number, v: number): [number, number, number] {
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

function truecolorBar(cells: number): string {
	let out = "";
	for (let i = 0; i < cells; i++) {
		const [r, g, b] = hsvToRgb((i / cells) * 360, 0.85, 1);
		out += `\x1b[48;2;${r};${g};${b}m `;
	}
	return `${out}\x1b[0m`;
}

function notifyProtocolLabel(): string {
	switch (TERMINAL.notifyProtocol) {
		case NotifyProtocol.Osc99:
			return "OSC 99 (kitty)";
		case NotifyProtocol.Osc9:
			return "OSC 9 (iTerm2/WezTerm)";
		default:
			return "BEL";
	}
}

function imageProtocolLabel(): string {
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

class RawLines implements Component {
	#lines: readonly string[];
	constructor(lines: readonly string[]) {
		this.#lines = lines;
	}
	invalidate(): void {}
	render(): string[] {
		return this.#lines.slice();
	}
}

export interface ProtocolProbeOptions {
	image: SampleImage;
	imageBudget: ImageBudget;
	notificationSuppressed: boolean;
}

export class ProtocolProbeComponent extends Container {
	constructor(options: ProtocolProbeOptions) {
		super();
		const hyperlinksOn = TERMINAL.hyperlinks;
		const sizingOn = TERMINAL.textSizing;
		const yesNo = (on: boolean) => (on ? theme.fg("success", "supported") : theme.fg("muted", "unsupported"));

		this.addChild(new Text(theme.bold(theme.fg("accent", "Terminal Protocol Test")), COMPOSER_INSET_COLS, 0));
		this.addChild(new Spacer(1));

		const styling = [
			theme.fg("muted", "Styling (SGR)"),
			`  ${theme.bold("bold")}  ${theme.italic("italic")}  ${theme.underline("underline")}  ${theme.strikethrough("strike")}  ${theme.inverse(" inverse ")}  ${theme.fg("dim", "dim")}`,
			`  ${theme.fg("accent", "accent")}  ${theme.fg("success", "success")}  ${theme.fg("warning", "warning")}  ${theme.fg("error", "error")}`,
			`  truecolor: ${truecolorBar(32)} (${theme.fg("muted", `24-bit ${TERMINAL.trueColor ? "on" : "off"}`)})`,
		].join("\n");
		this.addChild(new Text(styling, COMPOSER_INSET_COLS, 0));
		this.addChild(new Spacer(1));

		this.addChild(
			new Text(
				[
					`${theme.fg("muted", "Hyperlinks (OSC 8)")} — ${yesNo(hyperlinksOn)}`,
					`  \x1b]8;;https://github.com/santhreal/veyyon\x07Veyyon repo\x1b]8;;\x07`,
				].join("\n"),
				COMPOSER_INSET_COLS,
				0,
			),
		);
		this.addChild(new Spacer(1));

		this.addChild(
			new Text(`${theme.fg("muted", "Text sizing (OSC 66)")} — ${yesNo(sizingOn)}`, COMPOSER_INSET_COLS, 0),
		);
		if (sizingOn) {
			this.addChild(new RawLines(buildLargeTextLines()));
		} else {
			this.addChild(
				new Text(
					theme.fg("dim", "  (enable via the tui.textSizing setting on a Kitty terminal)"),
					COMPOSER_INSET_COLS,
					0,
				),
			);
		}
		this.addChild(new Spacer(1));

		this.addChild(
			new Text(
				`${theme.fg("muted", "Graphics")} — ${theme.fg("dim", imageProtocolLabel())}`,
				COMPOSER_INSET_COLS,
				0,
			),
		);
		this.addChild(
			new Image(
				options.image.base64,
				options.image.mimeType,
				{ fallbackColor: (text: string) => theme.fg("toolOutput", text) },
				{ maxWidthCells: 20, maxHeightCells: 16, budget: options.imageBudget },
				options.image.dimensions,
			),
		);
		this.addChild(new Spacer(1));

		const notifyStatus = options.notificationSuppressed
			? theme.fg("warning", "suppressed (VEYYON_NOTIFICATIONS)")
			: theme.fg("success", "sent — check your desktop / titlebar");
		this.addChild(
			new Text(
				`${theme.fg("muted", "Notification")} (${theme.fg("dim", notifyProtocolLabel())}) — ${notifyStatus}`,
				COMPOSER_INSET_COLS,
				0,
			),
		);
	}
}
