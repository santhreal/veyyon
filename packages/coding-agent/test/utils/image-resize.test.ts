import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { once } from "node:events";
import { createDeflate } from "node:zlib";
import type { ResizedImage } from "@veyyon/coding-agent/utils/image-resize";
import {
	canonicalizeImageContent,
	formatDimensionNote,
	MAX_IMAGE_DECODED_BYTES,
	MAX_IMAGE_INPUT_HEIGHT,
	MAX_IMAGE_INPUT_PIXELS,
	MAX_IMAGE_INPUT_WIDTH,
	resizeImage,
} from "@veyyon/coding-agent/utils/image-resize";

/**
 * formatDimensionNote is the coordinate-mapping hint appended to a downscaled image so
 * the model can translate pixel coordinates back to the original. It had no test. It must
 * emit nothing when the image was not resized, when any dimension is missing/zero, or when
 * the displayed size equals the original; otherwise it reports both sizes and the exact
 * width scale factor (original/displayed, two decimals). A wrong or missing note silently
 * misaligns every coordinate the model produces.
 */
describe("formatDimensionNote", () => {
	const base: Omit<ResizedImage, "originalWidth" | "originalHeight" | "width" | "height" | "wasResized"> = {
		buffer: new Uint8Array(),
		mimeType: "image/png",
		get data() {
			return "";
		},
	};

	it("reports both sizes and the width scale factor for a downscaled image", () => {
		expect(
			formatDimensionNote({
				...base,
				originalWidth: 2000,
				originalHeight: 1000,
				width: 1000,
				height: 500,
				wasResized: true,
			}),
		).toBe(
			"[Image: original 2000x1000, displayed at 1000x500. Multiply coordinates by 2.00 to map to original image.]",
		);
		expect(
			formatDimensionNote({
				...base,
				originalWidth: 1500,
				originalHeight: 900,
				width: 500,
				height: 300,
				wasResized: true,
			}),
		).toBe(
			"[Image: original 1500x900, displayed at 500x300. Multiply coordinates by 3.00 to map to original image.]",
		);
	});

	it("emits no note when the image was not resized", () => {
		expect(
			formatDimensionNote({
				...base,
				originalWidth: 2000,
				originalHeight: 1000,
				width: 2000,
				height: 1000,
				wasResized: false,
			}),
		).toBeUndefined();
	});

	it("emits no note when the displayed size equals the original", () => {
		expect(
			formatDimensionNote({
				...base,
				originalWidth: 100,
				originalHeight: 100,
				width: 100,
				height: 100,
				wasResized: true,
			}),
		).toBeUndefined();
	});

	it("emits no note when any dimension is missing or zero", () => {
		expect(
			formatDimensionNote({
				...base,
				originalWidth: 0,
				originalHeight: 1000,
				width: 1000,
				height: 500,
				wasResized: true,
			}),
		).toBeUndefined();
	});
});

// 1x1 red PNG (69 bytes) — used as a Bun.Image seed to synthesize larger fixtures
// without checking binary blobs into the repo.
const RED_1X1_PNG_BASE64 =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC";

async function makeRedPng(width: number, height: number): Promise<string> {
	const seed = Buffer.from(RED_1X1_PNG_BASE64, "base64");
	const upscaled = await new Bun.Image(seed).resize(width, height, { filter: "nearest" }).png().bytes();
	return Buffer.from(upscaled).toBase64();
}

async function makeRedWebP(width: number, height: number): Promise<string> {
	const seed = Buffer.from(RED_1X1_PNG_BASE64, "base64");
	const upscaled = await new Bun.Image(seed)
		.resize(width, height, { filter: "nearest" })
		.webp({ quality: 90 })
		.bytes();
	return Buffer.from(upscaled).toBase64();
}

function pngCrc32(bytes: Uint8Array): number {
	let crc = 0xffffffff;
	for (const byte of bytes) {
		crc ^= byte;
		for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
	}
	return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Uint8Array): Buffer {
	const payload = Buffer.concat([Buffer.from(type, "ascii"), data]);
	const chunk = Buffer.alloc(12 + data.byteLength);
	chunk.writeUInt32BE(data.byteLength, 0);
	payload.copy(chunk, 4);
	chunk.writeUInt32BE(pngCrc32(payload), chunk.length - 4);
	return chunk;
}

async function makeCompressedMonochromePng(width: number, height: number): Promise<Buffer> {
	// 1-bit grayscale keeps an 8192² fixture's streamed uncompressed row at
	// 1,025 bytes instead of ever allocating a full decoded canvas.
	const row = Buffer.alloc(1 + Math.ceil(width / 8));
	const deflate = createDeflate({ level: 9 });
	const compressed: Buffer[] = [];
	deflate.on("data", chunk => compressed.push(Buffer.from(chunk)));
	for (let y = 0; y < height; y += 1) {
		if (!deflate.write(row)) await once(deflate, "drain");
	}
	deflate.end();
	await once(deflate, "end");

	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(width, 0);
	ihdr.writeUInt32BE(height, 4);
	ihdr[8] = 1;
	ihdr[9] = 0;
	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		pngChunk("IHDR", ihdr),
		pngChunk("IDAT", Buffer.concat(compressed)),
		pngChunk("IEND", Buffer.alloc(0)),
	]);
}

function forgedPngHeader(width: number, height: number): Buffer {
	const png = Buffer.alloc(33);
	Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png, 0);
	png.writeUInt32BE(13, 8);
	png.write("IHDR", 12, "ascii");
	png.writeUInt32BE(width, 16);
	png.writeUInt32BE(height, 20);
	png[24] = 8;
	png[25] = 2;
	return png;
}

// Fixtures are synthesized once and shared read-only — `resizeImage` never mutates
// its input, so a single decodable source per shape serves every test. Real image
// encode/decode is the only cost here, so each source is the smallest solid-red
// image that still crosses the threshold under test:
//   - oversizedPng: a strip whose long edge exceeds the 1568 default cap, so
//     re-encodes touch ~1568×392 px instead of 1568×1568. A uniform red keeps format
//     selection deterministic (WebP is always smallest; PNG always beats JPEG), so
//     the strip exercises the same format/budget logic as a large square.
//   - smallPng / smallWebp: 200×200, comfortably inside every default cap (fast path).
let oversizedPng: string;
let smallPng: string;
let smallWebp: string;

beforeAll(async () => {
	[oversizedPng, smallPng, smallWebp] = await Promise.all([
		makeRedPng(1600, 400),
		makeRedPng(200, 200),
		makeRedWebP(200, 200),
	]);
});

describe("resizeImage defaults", () => {
	it("downscales inputs larger than 1568px on the long edge", async () => {
		// 1600px wide — exceeds the default 1568 cap on the long edge.
		const result = await resizeImage({ type: "image", data: oversizedPng, mimeType: "image/png" });

		expect(result.wasResized).toBe(true);
		expect(result.width).toBeLessThanOrEqual(1568);
		expect(result.height).toBeLessThanOrEqual(1568);
		// Aspect ratio of the 1600x400 source preserved (with rounding tolerance).
		expect(Math.abs(result.width / result.height - 1600 / 400)).toBeLessThan(0.01);
	});

	it("preserves inputs already within budget and dimensions (fast path)", async () => {
		// 200x200 red square encodes to ~few hundred bytes — well below budget/4.
		const result = await resizeImage({ type: "image", data: smallPng, mimeType: "image/png" });

		expect(result.wasResized).toBe(false);
		expect(result.width).toBe(200);
		expect(result.height).toBe(200);
		expect(result.mimeType).toBe("image/png");
	});

	it("respects custom maxWidth/maxHeight overrides (browser-tool case)", async () => {
		// 1600px wide — exceeds the 1024 cap from the browser screenshot override.
		const result = await resizeImage(
			{ type: "image", data: oversizedPng, mimeType: "image/png" },
			{ maxWidth: 1024, maxHeight: 1024, maxBytes: 150 * 1024, jpegQuality: 70 },
		);

		expect(result.wasResized).toBe(true);
		expect(result.width).toBeLessThanOrEqual(1024);
		expect(result.height).toBeLessThanOrEqual(1024);
		expect(result.buffer.length).toBeLessThanOrEqual(150 * 1024);
	});

	it("respects custom maxBytes override even when dimensions already fit", async () => {
		// 200x200 sits within every dimension cap, but a byte budget below the
		// source size (after the /4 fast-path headroom) forces a re-encode.
		const originalBytes = Buffer.from(smallPng, "base64").length;

		const result = await resizeImage({ type: "image", data: smallPng, mimeType: "image/png" }, { maxBytes: 1024 });

		// Either the result fits the budget, or the algorithm exhausted its
		// fallbacks and shipped its smallest variant — but in both cases the
		// output must not be larger than the original.
		expect(result.buffer.length).toBeLessThanOrEqual(originalBytes);
	});

	it("uses lossy WebP or JPEG (not PNG) for oversized inputs", async () => {
		// Oversized red strip exceeds the dimension cap, triggering encodeSmallest.
		// Lossy formats (JPEG/WebP) should win over PNG for a solid-color image
		// because they compress more aggressively.
		const result = await resizeImage({ type: "image", data: oversizedPng, mimeType: "image/png" });

		expect(result.wasResized).toBe(true);
		// The result should be a lossy format (JPEG or WebP), not PNG,
		// because lossy encoding for a solid strip is trivially small.
		expect(["image/jpeg", "image/webp"]).toContain(result.mimeType);
		expect(result.buffer.length).toBeLessThanOrEqual(500 * 1024);
	});

	it("excludes WebP when excludeWebP option is true", async () => {
		const result = await resizeImage(
			{ type: "image", data: oversizedPng, mimeType: "image/png" },
			{ excludeWebP: true },
		);

		expect(result.wasResized).toBe(true);
		expect(["image/png", "image/jpeg"]).toContain(result.mimeType);
		expect(result.mimeType).not.toBe("image/webp");
	});

	it("re-encodes a WebP source out of WebP when excludeWebP is set, even on the fast path", async () => {
		// 200x200 WebP — well below 1568px and ~tiny bytes, so it would hit the
		// fast path and pass through as image/webp. excludeWebP MUST force a
		// re-encode to a non-WebP format.
		const result = await resizeImage(
			{ type: "image", data: smallWebp, mimeType: "image/webp" },
			{ excludeWebP: true },
		);

		expect(result.mimeType).not.toBe("image/webp");
		expect(["image/png", "image/jpeg"]).toContain(result.mimeType);
	});
});

describe("image decoded-allocation boundary", () => {
	/** Regression: a tiny compressed 8192² PNG previously allocated and re-encoded the full canvas. */
	it("rejects a valid compressed 8192² PNG above the pixel ceiling before normalization", async () => {
		/**
		 * The fixture is a real PNG, not a forged header: Bun can probe it when
		 * given an explicit 8192² native limit. resizeImage must reject it under
		 * the lower application ceiling without producing a decoded canvas.
		 */
		const width = 8192;
		const height = 8192;
		const png = await makeCompressedMonochromePng(width, height);
		expect(png.byteLength).toBeLessThan(100_000);
		expect(await new Bun.Image(png, { maxPixels: width * height }).metadata()).toMatchObject({ width, height });
		expect(MAX_IMAGE_INPUT_PIXELS).toBeLessThan(width * height);

		await expect(resizeImage({ type: "image", data: png.toBase64(), mimeType: "image/png" })).rejects.toThrow(
			"Image normalization failed",
		);
	});

	/** Negative control: the allocation guard must not reject or relabel ordinary supported images. */
	it("canonicalizes an ordinary image from detected bytes and preserves its dimensions", async () => {
		const canonical = await canonicalizeImageContent({ data: smallPng });
		expect(canonical.mimeType).toBe("image/png");
		expect(canonical.width).toBe(200);
		expect(canonical.height).toBe(200);
		expect(await new Bun.Image(canonical.buffer).metadata()).toMatchObject({
			format: "png",
			width: 200,
			height: 200,
		});
	});

	/** Regression: forged dimensions could overflow products or exceed native decoded-allocation bounds. */
	it("fails closed on dimension, pixel-product, and decoded-byte ceilings", async () => {
		const cases = [
			forgedPngHeader(MAX_IMAGE_INPUT_WIDTH + 1, 1),
			forgedPngHeader(1, MAX_IMAGE_INPUT_HEIGHT + 1),
			forgedPngHeader(8000, Math.floor(MAX_IMAGE_INPUT_PIXELS / 8000) + 1),
			forgedPngHeader(8000, Math.floor(MAX_IMAGE_DECODED_BYTES / 4 / 8000) + 1),
		];
		for (const png of cases) {
			await expect(resizeImage({ type: "image", data: png.toBase64(), mimeType: "image/png" })).rejects.toThrow(
				"Image normalization failed",
			);
		}
	});
});
describe("resizeImage decode boundary", () => {
	it("rejects a forged PNG header instead of forwarding undecoded bytes", async () => {
		// Header-only fallback used to treat IHDR dimensions as proof of an image,
		// allowing arbitrary trailing bytes to cross the provider boundary.
		const png = Buffer.alloc(33);
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png, 0);
		png.writeUInt32BE(13, 8);
		png.write("IHDR", 12, "ascii");
		png.writeUInt32BE(1900, 16);
		png.writeUInt32BE(2474, 20);
		png[24] = 8;
		png[25] = 2;

		await expect(resizeImage({ type: "image", data: png.toBase64(), mimeType: "image/png" })).rejects.toThrow(
			"Image normalization failed",
		);
	});

	it("rejects a forged JPEG SOF instead of forwarding undecoded bytes", async () => {
		// SOF dimensions are untrusted until a real decoder accepts the complete
		// image; otherwise a MIME-shaped secret container could be replayed.
		const jpeg = Buffer.alloc(12);
		jpeg[0] = 0xff;
		jpeg[1] = 0xd8;
		jpeg[2] = 0xff;
		jpeg[3] = 0xc0;
		jpeg.writeUInt16BE(8, 4);
		jpeg[6] = 8;
		jpeg.writeUInt16BE(2474, 7);
		jpeg.writeUInt16BE(1900, 9);
		jpeg[11] = 3;

		await expect(resizeImage({ type: "image", data: jpeg.toBase64(), mimeType: "image/jpeg" })).rejects.toThrow(
			"Image normalization failed",
		);
	});
});

describe("resizeImage minimum dimension", () => {
	it("upscales a degenerate 1x1 image up to the 200px floor", async () => {
		// A 1x1 PNG (e.g. an empty chart render) would sail through the fast path
		// untouched and trip a provider 400 "Could not process image".
		const result = await resizeImage({ type: "image", data: RED_1X1_PNG_BASE64, mimeType: "image/png" });

		expect(result.wasResized).toBe(true);
		// Square source stays square at the floor.
		expect(result.width).toBe(200);
		expect(result.height).toBe(200);
		// The encoded bytes actually carry those dimensions.
		const meta = await new Bun.Image(Buffer.from(result.data, "base64")).metadata();
		expect(meta.width).toBeGreaterThanOrEqual(200);
		expect(meta.height).toBeGreaterThanOrEqual(200);
	});

	it("honors a custom minDimension override", async () => {
		const result = await resizeImage(
			{ type: "image", data: RED_1X1_PNG_BASE64, mimeType: "image/png" },
			{ minDimension: 64 },
		);

		expect(result.width).toBe(64);
		expect(result.height).toBe(64);
	});

	it("stretches a degenerate aspect ratio so both edges clear the floor and stay within the cap", async () => {
		// 1x1600 strip: the cap pulls the long edge to 1568 while the short edge
		// stays at 1px, so a uniform scale can't satisfy both bounds — the floor
		// must be reached by fill-stretching the short edge.
		const strip = await makeRedPng(1, 1600);
		const result = await resizeImage({ type: "image", data: strip, mimeType: "image/png" });

		expect(result.wasResized).toBe(true);
		expect(result.width).toBeGreaterThanOrEqual(200);
		expect(result.height).toBeGreaterThanOrEqual(200);
		expect(result.width).toBeLessThanOrEqual(1568);
		expect(result.height).toBeLessThanOrEqual(1568);
		const meta = await new Bun.Image(Buffer.from(result.data, "base64")).metadata();
		expect(meta.width).toBeGreaterThanOrEqual(200);
		expect(meta.height).toBeGreaterThanOrEqual(200);
	});
});

describe("resizeImage env wiring", () => {
	const prior = Bun.env.VEYYON_NO_WEBP;

	beforeEach(() => {
		delete (Bun.env as Record<string, string | undefined>).VEYYON_NO_WEBP;
	});

	afterEach(() => {
		if (prior === undefined) delete (Bun.env as Record<string, string | undefined>).VEYYON_NO_WEBP;
		else Bun.env.VEYYON_NO_WEBP = prior;
	});

	it("treats VEYYON_NO_WEBP=1 set at call time as exclusion (not baked at module load)", async () => {
		Bun.env.VEYYON_NO_WEBP = "1";

		const result = await resizeImage({ type: "image", data: smallWebp, mimeType: "image/webp" });

		expect(result.mimeType).not.toBe("image/webp");
	});

	it("treats VEYYON_NO_WEBP='' / '0' as NOT excluded", async () => {
		Bun.env.VEYYON_NO_WEBP = "";
		const empty = await resizeImage({ type: "image", data: smallWebp, mimeType: "image/webp" });
		expect(empty.mimeType).toBe("image/webp");

		Bun.env.VEYYON_NO_WEBP = "0";
		const zero = await resizeImage({ type: "image", data: smallWebp, mimeType: "image/webp" });
		expect(zero.mimeType).toBe("image/webp");
	});
});
