/**
 * The PNG writer has to produce a file real decoders accept.
 *
 * This suite exists because of a specific near-miss: `Bun.deflateSync` returns RAW
 * deflate, and PNG requires a zlib stream in `IDAT`. With the wrapper missing, every
 * chunk CRC still verified, `file(1)` still reported "PNG image data, 8-bit/color
 * RGB", and the dimensions were right, so every cheap check passed while no viewer
 * could open the image. A proof tool that emits unopenable proofs is worse than
 * having none, because the failure is silent at exactly the moment you are relying
 * on the picture.
 *
 * So the assertions here read the file the way a decoder does: chunk structure, CRC
 * per chunk, and `IDAT` inflated through a real zlib implementation back to the exact
 * filtered scanlines that went in.
 */
import { describe, expect, it } from "bun:test";
import { inflateSync } from "node:zlib";
import { adler32, BYTES_PER_PIXEL, crc32, encodePng } from "./png";

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

interface Chunk {
	type: string;
	data: Uint8Array;
	crcOk: boolean;
}

/** Walk the chunks the way a decoder must: length, type, data, CRC over type+data. */
function readChunks(png: Uint8Array): Chunk[] {
	const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
	const chunks: Chunk[] = [];
	let offset = 8;
	while (offset < png.length) {
		const length = view.getUint32(offset);
		const type = new TextDecoder().decode(png.subarray(offset + 4, offset + 8));
		const data = png.subarray(offset + 8, offset + 8 + length);
		const stored = view.getUint32(offset + 8 + length);
		chunks.push({ type, data, crcOk: crc32(png.subarray(offset + 4, offset + 8 + length)) === stored });
		offset += 12 + length;
	}
	return chunks;
}

function solid(width: number, height: number, rgb: [number, number, number]): Uint8Array {
	const pixels = new Uint8Array(width * height * BYTES_PER_PIXEL);
	for (let i = 0; i < width * height; i++) {
		pixels[i * 3] = rgb[0];
		pixels[i * 3 + 1] = rgb[1];
		pixels[i * 3 + 2] = rgb[2];
	}
	return pixels;
}

describe("checksums", () => {
	/** Against the zlib specification's own worked example, so a transcription
	 * error in the loop cannot hide behind self-consistency. */
	it("computes the Adler-32 of a known input", () => {
		expect(adler32(new TextEncoder().encode("abc"))).toBe(0x024d0127);
		expect(adler32(new Uint8Array(0))).toBe(1);
	});

	/** The CRC of the empty IEND chunk is a fixed, published value. */
	it("computes the CRC-32 the PNG spec requires for IEND", () => {
		expect(crc32(new TextEncoder().encode("IEND"))).toBe(0xae426082);
	});

	/** Both checksums must be unsigned. A negative number here would be written as
	 * a bogus 32-bit field and every decoder would reject the file. */
	it("returns unsigned 32-bit values for high-bit results", () => {
		expect(crc32(new TextEncoder().encode("IEND"))).toBeGreaterThan(0);
		expect(adler32(new Uint8Array([255, 255, 255, 255]))).toBeGreaterThan(0);
	});
});

describe("file structure", () => {
	it("starts with the PNG signature", () => {
		const png = encodePng(2, 2, solid(2, 2, [1, 2, 3]));

		expect([...png.subarray(0, 8)]).toEqual(SIGNATURE);
	});

	it("emits exactly IHDR, IDAT, IEND, in that order, each with a valid CRC", () => {
		const chunks = readChunks(encodePng(3, 4, solid(3, 4, [9, 9, 9])));

		expect(chunks.map(c => c.type)).toEqual(["IHDR", "IDAT", "IEND"]);
		expect(chunks.every(c => c.crcOk)).toBe(true);
	});

	it("declares the dimensions and the truecolour, non-interlaced format", () => {
		const ihdr = readChunks(encodePng(17, 5, solid(17, 5, [0, 0, 0])))[0].data;
		const view = new DataView(ihdr.buffer, ihdr.byteOffset, ihdr.byteLength);

		expect(view.getUint32(0)).toBe(17);
		expect(view.getUint32(4)).toBe(5);
		expect([...ihdr.subarray(8)]).toEqual([8, 2, 0, 0, 0]);
	});
});

describe("the IDAT stream", () => {
	/** THE regression test. Raw deflate here passes every other check in this file
	 * and produces an image nothing can open. */
	it("is a zlib stream a real inflater accepts", () => {
		const idat = readChunks(encodePng(4, 3, solid(4, 3, [7, 8, 9])))[1].data;

		expect(() => inflateSync(Buffer.from(idat))).not.toThrow();
	});

	it("inflates back to one filter byte plus the pixels of each row", () => {
		const width = 3;
		const height = 2;
		const pixels = new Uint8Array([
			10, 11, 12, 13, 14, 15, 16, 17, 18 /* row 1 */, 20, 21, 22, 23, 24, 25, 26, 27, 28 /* row 2 */,
		]);

		const idat = readChunks(encodePng(width, height, pixels))[1].data;
		const raw = new Uint8Array(inflateSync(Buffer.from(idat)));

		const stride = width * BYTES_PER_PIXEL;
		expect(raw.length).toBe((stride + 1) * height);
		expect(raw[0]).toBe(0); // filter: none
		expect([...raw.subarray(1, 1 + stride)]).toEqual([10, 11, 12, 13, 14, 15, 16, 17, 18]);
		expect(raw[stride + 1]).toBe(0);
		expect([...raw.subarray(stride + 2)]).toEqual([20, 21, 22, 23, 24, 25, 26, 27, 28]);
	});

	/** The Adler-32 trailer covers the UNCOMPRESSED bytes. Checksumming the
	 * compressed ones instead is the classic mistake, and it produces a stream that
	 * inflates correctly in permissive decoders and fails in strict ones. */
	it("closes with the Adler-32 of the uncompressed data", () => {
		const idat = readChunks(encodePng(2, 2, solid(2, 2, [4, 5, 6])))[1].data;
		const raw = new Uint8Array(inflateSync(Buffer.from(idat)));

		const trailer = new DataView(idat.buffer, idat.byteOffset, idat.byteLength).getUint32(idat.length - 4);
		expect(trailer).toBe(adler32(raw));
	});
});

describe("refusals", () => {
	/** Encoding a short buffer would produce a file that opens as corrupt in some
	 * viewers and half-drawn in others, and a half-drawn proof is a wrong answer
	 * rather than a missing one. */
	it("refuses a pixel buffer that does not match the dimensions", () => {
		expect(() => encodePng(4, 4, solid(4, 3, [0, 0, 0]))).toThrow(/expected 48 for 4x4 RGB/);
		expect(() => encodePng(2, 2, new Uint8Array(0))).toThrow(/0 bytes/);
	});

	it("refuses non-positive or fractional dimensions", () => {
		expect(() => encodePng(0, 4, new Uint8Array(0))).toThrow(/positive integers/);
		expect(() => encodePng(4, -1, new Uint8Array(0))).toThrow(/positive integers/);
		expect(() => encodePng(2.5, 4, new Uint8Array(30))).toThrow(/positive integers/);
	});
});
