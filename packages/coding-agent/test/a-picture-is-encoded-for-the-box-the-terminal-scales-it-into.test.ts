/**
 * A terminal is handed pixels at the size it is going to draw them.
 *
 * WHAT THIS CLOSES. Every inline-graphics protocol scales one payload into a
 * cell box, and a terminal's scaler is a cheap GPU filter. A 1568x882
 * screenshot handed to WezTerm for an 850x480 box came out smeared past
 * legibility while transmitting 1.1 MB of base64 for it. The fix asks the
 * component for the box and re-encodes at exactly that size, which makes the
 * terminal's own scale a no-op.
 *
 * THE CLASS, not the incident. The contract is not "downscale a screenshot".
 * It is that {@link encodeTerminalImagePayload} is the ONE place that decides
 * the bytes a terminal receives, and that it never returns something the
 * terminal or the transmit path cannot use: always PNG, never larger than the
 * source, never past the pixel ceiling, never a zero-sized image, and never
 * throwing where the picture on screen would be lost. The suite drives the
 * exported functions directly — they have no other collaborators — and sweeps
 * the boundary cases rather than the one reported size.
 *
 * WHAT IT DOES NOT CATCH. It asserts geometry and format, not sharpness: no
 * assertion here would fail if `Bun.Image` swapped Lanczos for nearest
 * neighbour. It does not cover the renderer that consumes the payload; that
 * contract is `packages/tui/test/an-image-is-never-drawn-above-the-row-that-owns-it.test.ts`.
 */
import { describe, expect, test } from "bun:test";
import { deflateSync } from "node:zlib";
import { getCellDimensions, setCellDimensions } from "@veyyon/tui";
import { encodeTerminalImagePayload, terminalImageBox } from "../src/utils/terminal-image-payload";

/** 64x32 PNG with per-pixel variation, so a resample has something to lose. */
function sourcePng(width: number, height: number): string {
	const raw = Buffer.alloc(height * (1 + width * 3));
	let at = 0;
	for (let y = 0; y < height; y++) {
		raw[at++] = 0;
		for (let x = 0; x < width; x++) {
			raw[at++] = (x * 4) % 256;
			raw[at++] = (y * 8) % 256;
			raw[at++] = (x * y) % 256;
		}
	}
	return Buffer.from(encodePng(width, height, raw)).toBase64();
}

function encodePng(width: number, height: number, raw: Buffer): Buffer {
	const header = Buffer.alloc(13);
	header.writeUInt32BE(width, 0);
	header.writeUInt32BE(height, 4);
	header[8] = 8;
	header[9] = 2;
	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		pngChunk("IHDR", header),
		pngChunk("IDAT", deflateSync(raw)),
		pngChunk("IEND", Buffer.alloc(0)),
	]);
}

function pngChunk(type: string, data: Buffer): Buffer {
	const length = Buffer.alloc(4);
	length.writeUInt32BE(data.length, 0);
	const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
	const crc = Buffer.alloc(4);
	crc.writeUInt32BE(Bun.hash.crc32(body) >>> 0, 0);
	return Buffer.concat([length, body, crc]);
}

const SOURCE = { data: sourcePng(64, 32), mimeType: "image/png" };

describe("a picture is encoded for the box the terminal scales it into", () => {
	test("no box leaves the pixels alone and still normalizes the format", async () => {
		const payload = await encodeTerminalImagePayload(SOURCE);
		expect(payload.mimeType).toBe("image/png");
		expect(payload.widthPx).toBe(64);
		expect(payload.heightPx).toBe(32);
	});

	test("a smaller box is met exactly, in both dimensions", async () => {
		for (const box of [
			{ widthPx: 32, heightPx: 16 },
			{ widthPx: 63, heightPx: 31 },
			{ widthPx: 1, heightPx: 1 },
			{ widthPx: 10, heightPx: 30 },
		]) {
			const payload = await encodeTerminalImagePayload(SOURCE, box);
			expect({ w: payload.widthPx, h: payload.heightPx }).toEqual({ w: box.widthPx, h: box.heightPx });
			expect(payload.mimeType).toBe("image/png");
		}
	});

	test("the payload shrinks when the box does", async () => {
		const full = await encodeTerminalImagePayload(SOURCE);
		const small = await encodeTerminalImagePayload(SOURCE, { widthPx: 16, heightPx: 8 });
		expect(small.data.length).toBeLessThan(full.data.length);
	});

	test("a box at or above the source size never upscales", async () => {
		for (const box of [
			{ widthPx: 64, heightPx: 32 },
			{ widthPx: 128, heightPx: 64 },
			{ widthPx: 4096, heightPx: 2048 },
		]) {
			const payload = await encodeTerminalImagePayload(SOURCE, box);
			expect({ w: payload.widthPx, h: payload.heightPx }).toEqual({ w: 64, h: 32 });
		}
	});

	test("a box that is degenerate or past the pixel ceiling is ignored, not obeyed", async () => {
		for (const box of [
			{ widthPx: 0, heightPx: 10 },
			{ widthPx: 10, heightPx: 0 },
			{ widthPx: -20, heightPx: -10 },
			{ widthPx: 0.4, heightPx: 0.4 },
			{ widthPx: 100_000, heightPx: 100_000 },
			{ widthPx: Number.NaN, heightPx: 10 },
		]) {
			const payload = await encodeTerminalImagePayload(SOURCE, box);
			expect({ w: payload.widthPx, h: payload.heightPx }).toEqual({ w: 64, h: 32 });
		}
	});

	test("a fractional box is truncated to whole pixels rather than refused", async () => {
		const payload = await encodeTerminalImagePayload(SOURCE, { widthPx: 33.9, heightPx: 17.2 });
		expect({ w: payload.widthPx, h: payload.heightPx }).toEqual({ w: 33, h: 17 });
	});

	test("bytes that are not an image reject instead of returning a broken payload", async () => {
		await expect(encodeTerminalImagePayload({ data: "bm90LWFuLWltYWdl", mimeType: "image/png" })).rejects.toThrow();
	});

	test("the box is a whole number of cells, inside the caps it was given", () => {
		const cell = { widthPx: 10, heightPx: 20 };
		const original = { ...getCellDimensions() };
		setCellDimensions(cell);
		try {
			for (const caps of [
				{ maxWidthCells: 20, maxHeightCells: 10 },
				{ maxWidthCells: 1, maxHeightCells: 1 },
				{ maxWidthCells: 200, maxHeightCells: 3 },
				{ maxWidthCells: 4, maxHeightCells: 200 },
			]) {
				const box = terminalImageBox(SOURCE, caps);
				expect(box).not.toBeNull();
				const { widthPx, heightPx } = box!;
				expect(widthPx % cell.widthPx).toBe(0);
				expect(heightPx % cell.heightPx).toBe(0);
				expect(widthPx / cell.widthPx).toBeLessThanOrEqual(caps.maxWidthCells);
				expect(heightPx / cell.heightPx).toBeLessThanOrEqual(caps.maxHeightCells);
				expect(widthPx).toBeGreaterThan(0);
				expect(heightPx).toBeGreaterThan(0);
			}
		} finally {
			setCellDimensions(original);
		}
	});

	test("a picture whose header cannot be read has no box, so nothing is resized to a guess", () => {
		expect(terminalImageBox({ data: "bm90LWFuLWltYWdl", mimeType: "image/png" }, { maxWidthCells: 10 })).toBeNull();
	});

	test("the box a picture reports is the size the encoder then produces", async () => {
		const original = { ...getCellDimensions() };
		setCellDimensions({ widthPx: 10, heightPx: 20 });
		let box: { widthPx: number; heightPx: number } | null;
		try {
			box = terminalImageBox(SOURCE, { maxWidthCells: 3, maxHeightCells: 1 });
		} finally {
			setCellDimensions(original);
		}
		expect(box).not.toBeNull();
		const payload = await encodeTerminalImagePayload(SOURCE, box ?? undefined);
		expect({ w: payload.widthPx, h: payload.heightPx }).toEqual({ w: box!.widthPx, h: box!.heightPx });
	});
});
