import { describe, expect, it } from "bun:test";
import { parseImageMetadata, SUPPORTED_IMAGE_MIME_TYPES } from "../src/mime";

function pngHeader(width: number, height: number, colorType: number): Uint8Array {
	const header = new Uint8Array(26);
	header.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
	header.set([0x49, 0x48, 0x44, 0x52], 12); // "IHDR"
	const view = new DataView(header.buffer);
	view.setUint32(16, width, false);
	view.setUint32(20, height, false);
	view.setUint8(24, 8); // bit depth
	view.setUint8(25, colorType);
	return header;
}

function gifHeader(width: number, height: number): Uint8Array {
	const header = new Uint8Array(10);
	header.set([0x47, 0x49, 0x46, 0x38, 0x39, 0x61], 0); // "GIF89a"
	const view = new DataView(header.buffer);
	view.setUint16(6, width, true);
	view.setUint16(8, height, true);
	return header;
}

describe("parseImageMetadata", () => {
	it("reads PNG dimensions and maps color type to channels/alpha", () => {
		expect(parseImageMetadata(pngHeader(640, 480, 6))).toEqual({
			mimeType: "image/png",
			width: 640,
			height: 480,
			channels: 4,
			hasAlpha: true,
		});
		expect(parseImageMetadata(pngHeader(2, 3, 0))).toEqual({
			mimeType: "image/png",
			width: 2,
			height: 3,
			channels: 1,
			hasAlpha: false,
		});
	});

	it("reads GIF logical-screen dimensions (little-endian)", () => {
		expect(parseImageMetadata(gifHeader(320, 200))).toEqual({
			mimeType: "image/gif",
			width: 320,
			height: 200,
			channels: 3,
		});
	});

	it("recognizes a JPEG by magic even without a start-of-frame segment", () => {
		expect(parseImageMetadata(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toEqual({ mimeType: "image/jpeg" });
	});

	it("reads JPEG dimensions from an SOF0 segment after skipping APP0", () => {
		// SOI, APP0 (length 16), SOF0 with precision 8, height 480, width 640, 3 channels
		const jpeg = new Uint8Array([
			0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01,
			0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x01, 0xe0, 0x02, 0x80, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01,
			0x03, 0x11, 0x01,
		]);
		expect(parseImageMetadata(jpeg)).toEqual({
			mimeType: "image/jpeg",
			width: 640,
			height: 480,
			channels: 3,
			hasAlpha: false,
		});
	});

	it("does not read dimensions from DHT/JPG/DAC markers excluded from the SOF range", () => {
		// SOI then DHT (0xC4) shaped exactly like the SOF0 above: must NOT parse as a frame
		const jpeg = new Uint8Array([
			0xff, 0xd8, 0xff, 0xc4, 0x00, 0x11, 0x08, 0x01, 0xe0, 0x02, 0x80, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01,
			0x03, 0x11, 0x01,
		]);
		expect(parseImageMetadata(jpeg)).toEqual({ mimeType: "image/jpeg" });
	});

	it("reads WebP VP8X extended-format dimensions and alpha flag", () => {
		const header = new Uint8Array(30);
		header.set([0x52, 0x49, 0x46, 0x46], 0); // "RIFF"
		header.set([0x57, 0x45, 0x42, 0x50], 8); // "WEBP"
		header.set([0x56, 0x50, 0x38, 0x58], 12); // "VP8X"
		header[20] = 0x10; // alpha flag
		header.set([0x7f, 0x02, 0x00], 24); // width-1 = 639
		header.set([0xdf, 0x01, 0x00], 27); // height-1 = 479
		expect(parseImageMetadata(header)).toEqual({
			mimeType: "image/webp",
			width: 640,
			height: 480,
			channels: 4,
			hasAlpha: true,
		});
	});

	it("reads WebP VP8L lossless dimensions from the packed bitstream", () => {
		const header = new Uint8Array(30);
		header.set([0x52, 0x49, 0x46, 0x46], 0);
		header.set([0x57, 0x45, 0x42, 0x50], 8);
		header.set([0x56, 0x50, 0x38, 0x4c], 12); // "VP8L"
		// bits = (width-1) | (height-1)<<14 | alpha<<28, width 640 height 480 no alpha
		const bits = (640 - 1) | ((480 - 1) << 14);
		new DataView(header.buffer).setUint32(21, bits, true);
		expect(parseImageMetadata(header)).toEqual({
			mimeType: "image/webp",
			width: 640,
			height: 480,
			channels: 3,
			hasAlpha: false,
		});
	});

	it("reads WebP lossy VP8 dimensions and identifies truncated WebP by magic only", () => {
		const header = new Uint8Array(30);
		header.set([0x52, 0x49, 0x46, 0x46], 0);
		header.set([0x57, 0x45, 0x42, 0x50], 8);
		header.set([0x56, 0x50, 0x38, 0x20], 12); // "VP8 "
		new DataView(header.buffer).setUint16(26, 320, true);
		new DataView(header.buffer).setUint16(28, 200, true);
		expect(parseImageMetadata(header)).toEqual({
			mimeType: "image/webp",
			width: 320,
			height: 200,
			channels: 3,
			hasAlpha: false,
		});

		const truncated = new Uint8Array(12);
		truncated.set([0x52, 0x49, 0x46, 0x46], 0);
		truncated.set([0x57, 0x45, 0x42, 0x50], 8);
		expect(parseImageMetadata(truncated)).toEqual({ mimeType: "image/webp" });
	});

	it("returns null for non-image bytes and truncated magics", () => {
		expect(parseImageMetadata(new Uint8Array([0x00, 0x01, 0x02, 0x03]))).toBeNull();
		expect(parseImageMetadata(new TextEncoder().encode("just text"))).toBeNull();
		expect(parseImageMetadata(new Uint8Array([0x89, 0x50]))).toBeNull(); // half a PNG magic
		expect(parseImageMetadata(new Uint8Array(0))).toBeNull();
	});

	it("exposes exactly the four supported raster types", () => {
		expect([...SUPPORTED_IMAGE_MIME_TYPES].sort()).toEqual(["image/gif", "image/jpeg", "image/png", "image/webp"]);
	});
});
