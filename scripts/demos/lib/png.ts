/**
 * A minimal, dependency-free PNG writer.
 *
 * This exists so a render can be turned into an image FILE that a person (or a
 * reviewer, or an agent) can look at. Terminal captures are not admissible
 * evidence for a visual change: a capture renders on whatever ground the capturing
 * terminal happens to use, strips or distorts styling, and drops trailing styled
 * cells, which hides the entire class of background-fill and contrast bugs. An
 * image encoded from the render's own bytes has none of those problems, and it can
 * be produced twice against two different grounds and compared.
 *
 * PNG is the format because it is lossless, it is what every viewer opens, and its
 * minimum viable encoder is small enough to own outright: signature, `IHDR`,
 * `IDAT`, `IEND`, each chunk length-prefixed and CRC-checked, with the pixel data
 * deflated. `Bun.deflateSync` supplies the only non-trivial part, so nothing here
 * needs a dependency that could go missing in CI.
 *
 * Truecolour without alpha (colour type 2) is the whole feature set. A proof image
 * is fully opaque by construction: every pixel is either the ground or something
 * drawn on it, so an alpha channel would add a third of the bytes and nothing else.
 */

/** The eight bytes every PNG starts with. */
const SIGNATURE = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Bytes per pixel in colour type 2 (truecolour, 8 bits per channel). */
export const BYTES_PER_PIXEL = 3;

const CRC_TABLE = buildCrcTable();

function buildCrcTable(): Uint32Array {
	const table = new Uint32Array(256);
	for (let n = 0; n < 256; n++) {
		let c = n;
		for (let k = 0; k < 8; k++) {
			c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		}
		table[n] = c >>> 0;
	}
	return table;
}

/** The Adler-32 checksum that closes a zlib stream. */
export function adler32(bytes: Uint8Array): number {
	let a = 1;
	let b = 0;
	for (let i = 0; i < bytes.length; i++) {
		a = (a + bytes[i]) % 65521;
		b = (b + a) % 65521;
	}
	return ((b << 16) | a) >>> 0;
}

/**
 * Wrap raw deflate output in a zlib stream.
 *
 * `Bun.deflateSync` returns RAW deflate, and PNG's IDAT must hold a zlib stream:
 * two header bytes and an Adler-32 of the UNCOMPRESSED data. Without the wrapper
 * every chunk CRC still checks out and `file(1)` still reports a valid PNG, so the
 * image looks correct by every cheap test and fails to decode in real viewers. That
 * is exactly the trap this comment exists to keep the next reader out of.
 */
function zlibWrap(raw: Uint8Array, deflated: Uint8Array): Uint8Array {
	const out = new Uint8Array(2 + deflated.length + 4);
	out[0] = 0x78; // deflate, 32K window
	out[1] = 0x01; // no preset dictionary, fastest-compression flag bits
	out.set(deflated, 2);
	out.set(u32(adler32(raw)), 2 + deflated.length);
	return out;
}

/** The CRC-32 the PNG spec requires on every chunk (type bytes included). */
export function crc32(bytes: Uint8Array): number {
	let c = 0xffffffff;
	for (let i = 0; i < bytes.length; i++) {
		c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
	}
	return (c ^ 0xffffffff) >>> 0;
}

function u32(value: number): Uint8Array {
	return new Uint8Array([(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff]);
}

/** One length-prefixed, CRC-suffixed chunk. */
function chunk(type: string, data: Uint8Array): Uint8Array {
	const typeBytes = new TextEncoder().encode(type);
	const body = new Uint8Array(typeBytes.length + data.length);
	body.set(typeBytes, 0);
	body.set(data, typeBytes.length);
	const out = new Uint8Array(4 + body.length + 4);
	out.set(u32(data.length), 0);
	out.set(body, 4);
	out.set(u32(crc32(body)), 4 + body.length);
	return out;
}

function concat(parts: Uint8Array[]): Uint8Array {
	const total = parts.reduce((sum, part) => sum + part.length, 0);
	const out = new Uint8Array(total);
	let offset = 0;
	for (const part of parts) {
		out.set(part, offset);
		offset += part.length;
	}
	return out;
}

/**
 * Encode RGB pixels as a PNG.
 *
 * `pixels` is row-major, three bytes per pixel, `width * height * 3` long. Every
 * scanline is written with filter type 0 (none): filtering only buys compression,
 * and a proof image is a few hundred kilobytes of flat colour that deflate already
 * handles well, so the simpler encoder is worth more than the smaller file.
 *
 * Throws on a size mismatch rather than encoding a truncated image, because a PNG
 * whose IDAT is short of its IHDR opens as a corrupt file in some viewers and as a
 * half-drawn image in others, and a half-drawn proof is worse than no proof.
 */
export function encodePng(width: number, height: number, pixels: Uint8Array): Uint8Array {
	if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
		throw new Error(`PNG dimensions must be positive integers, got ${width}x${height}`);
	}
	const expected = width * height * BYTES_PER_PIXEL;
	if (pixels.length !== expected) {
		throw new Error(`PNG pixel buffer is ${pixels.length} bytes, expected ${expected} for ${width}x${height} RGB`);
	}

	const stride = width * BYTES_PER_PIXEL;
	const raw = new Uint8Array((stride + 1) * height);
	for (let y = 0; y < height; y++) {
		raw[y * (stride + 1)] = 0; // filter: none
		raw.set(pixels.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
	}

	const ihdr = new Uint8Array(13);
	ihdr.set(u32(width), 0);
	ihdr.set(u32(height), 4);
	ihdr[8] = 8; // bit depth
	ihdr[9] = 2; // colour type: truecolour
	ihdr[10] = 0; // compression: deflate
	ihdr[11] = 0; // filter method: adaptive
	ihdr[12] = 0; // interlace: none

	return concat([
		SIGNATURE,
		chunk("IHDR", ihdr),
		chunk("IDAT", zlibWrap(raw, new Uint8Array(Bun.deflateSync(raw)))),
		chunk("IEND", new Uint8Array(0)),
	]);
}
