import { peekFile } from "./peek-file";

const DEFAULT_IMAGE_METADATA_HEADER_BYTES = 256 * 1024;

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff]);
const WEBP_RIFF_MAGIC = Buffer.from([0x52, 0x49, 0x46, 0x46]);
const WEBP_MAGIC = Buffer.from([0x57, 0x45, 0x42, 0x50]);
const PNG_IHDR = Buffer.from("IHDR");
const GIF87A = Buffer.from("GIF87a");
const GIF89A = Buffer.from("GIF89a");
const WEBP_VP8X = Buffer.from("VP8X");
const WEBP_VP8L = Buffer.from("VP8L");
const WEBP_VP8 = Buffer.from("VP8 ");

export const SUPPORTED_IMAGE_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

export type ImageMetadata =
	| { mimeType: "image/png"; width?: number; height?: number; channels?: number; hasAlpha?: boolean }
	| { mimeType: "image/jpeg"; width?: number; height?: number; channels?: number; hasAlpha?: false }
	| { mimeType: "image/gif"; width?: number; height?: number; channels?: 3; hasAlpha?: never }
	| { mimeType: "image/webp"; width?: number; height?: number; channels?: number; hasAlpha?: boolean };

function magicEquals(header: Uint8Array, offset: number, magic: Buffer): boolean {
	if (header.length < offset + magic.length) {
		return false;
	}
	return magic.equals(header.subarray(offset, offset + magic.length));
}

function parsePngMetadata(header: Uint8Array): ImageMetadata | null {
	if (!magicEquals(header, 0, PNG_MAGIC)) return null;
	if (!magicEquals(header, 12, PNG_IHDR)) return { mimeType: "image/png" };
	if (header.length < 26) return { mimeType: "image/png" };

	const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
	const width = view.getUint32(16, false);
	const height = view.getUint32(20, false);
	const colorType = view.getUint8(25);
	if (colorType === 0) return { mimeType: "image/png", width, height, channels: 1, hasAlpha: false };
	if (colorType === 2) return { mimeType: "image/png", width, height, channels: 3, hasAlpha: false };
	if (colorType === 3) return { mimeType: "image/png", width, height, channels: 3 };
	if (colorType === 4) return { mimeType: "image/png", width, height, channels: 2, hasAlpha: true };
	if (colorType === 6) return { mimeType: "image/png", width, height, channels: 4, hasAlpha: true };
	return { mimeType: "image/png", width, height };
}

/** Kind of each JPEG marker byte: a segment with a length field, a standalone marker, or a start-of-frame segment. */
const JPEG_SEGMENT = 0;
const JPEG_STANDALONE = 1;
const JPEG_FRAME = 2;
const JPEG_MARKER_KINDS = new Uint8Array(256);
JPEG_MARKER_KINDS.fill(JPEG_FRAME, 0xc0, 0xd0);
// DHT, JPG and DAC sit in the start-of-frame range and carry no frame.
JPEG_MARKER_KINDS[0xc4] = JPEG_SEGMENT;
JPEG_MARKER_KINDS[0xc8] = JPEG_SEGMENT;
JPEG_MARKER_KINDS[0xcc] = JPEG_SEGMENT;
// The restart markers, start and end of image, and TEM carry no length.
JPEG_MARKER_KINDS.fill(JPEG_STANDALONE, 0xd0, 0xda);
JPEG_MARKER_KINDS[0x01] = JPEG_STANDALONE;

function parseJpegMetadata(header: Uint8Array): ImageMetadata | null {
	if (!magicEquals(header, 0, JPEG_MAGIC)) return null;
	if (header.length < 4) return { mimeType: "image/jpeg" };

	const frame = findJpegFrame(header);
	if (frame < 0 || frame + 7 >= header.length) return { mimeType: "image/jpeg" };
	// JPEG fields are big-endian. Reading the bytes directly avoids a DataView per parse.
	return {
		mimeType: "image/jpeg",
		width: (header[frame + 5] << 8) | header[frame + 6],
		height: (header[frame + 3] << 8) | header[frame + 4],
		channels: header[frame + 7],
		hasAlpha: false,
	};
}

/** Offset of the first start-of-frame segment's length field, or -1 when the header ends first. */
function findJpegFrame(header: Uint8Array): number {
	let offset = 2;
	while (offset + 9 < header.length) {
		if (header[offset] !== 0xff) {
			offset += 1;
			continue;
		}
		let markerOffset = offset + 1;
		while (markerOffset < header.length && header[markerOffset] === 0xff) {
			markerOffset += 1;
		}
		// The header ends inside this segment's length field. A standalone marker this close to the
		// end leaves fewer than 9 bytes to scan, which ends the scan as well.
		if (markerOffset + 2 >= header.length) return -1;

		const kind = JPEG_MARKER_KINDS[header[markerOffset]];
		const segmentOffset = markerOffset + 1;
		if (kind === JPEG_STANDALONE) {
			offset = segmentOffset;
			continue;
		}
		const segmentLength = (header[segmentOffset] << 8) | header[segmentOffset + 1];
		if (segmentLength < 2) return -1;
		if (kind === JPEG_FRAME) return segmentOffset;
		offset = segmentOffset + segmentLength;
	}
	return -1;
}

function parseGifMetadata(header: Uint8Array): ImageMetadata | null {
	if (!magicEquals(header, 0, GIF87A) && !magicEquals(header, 0, GIF89A)) return null;
	if (header.length < 10) return { mimeType: "image/gif" };
	const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
	return {
		mimeType: "image/gif",
		width: view.getUint16(6, true),
		height: view.getUint16(8, true),
		channels: 3,
	};
}

function parseWebpMetadata(header: Uint8Array): ImageMetadata | null {
	if (!magicEquals(header, 0, WEBP_RIFF_MAGIC)) return null;
	if (!magicEquals(header, 8, WEBP_MAGIC)) return null;
	if (header.length < 30) return { mimeType: "image/webp" };

	if (magicEquals(header, 12, WEBP_VP8X)) {
		const hasAlpha = (header[20] & 0x10) !== 0;
		const width = (header[24] | (header[25] << 8) | (header[26] << 16)) + 1;
		const height = (header[27] | (header[28] << 8) | (header[29] << 16)) + 1;
		return { mimeType: "image/webp", width, height, channels: hasAlpha ? 4 : 3, hasAlpha };
	}

	const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
	if (magicEquals(header, 12, WEBP_VP8L)) {
		if (header.length < 25) return { mimeType: "image/webp" };
		const bits = view.getUint32(21, true);
		const width = (bits & 0x3fff) + 1;
		const height = ((bits >> 14) & 0x3fff) + 1;
		const hasAlpha = ((bits >> 28) & 0x1) === 1;
		return { mimeType: "image/webp", width, height, channels: hasAlpha ? 4 : 3, hasAlpha };
	}

	if (magicEquals(header, 12, WEBP_VP8)) {
		const width = view.getUint16(26, true) & 0x3fff;
		const height = view.getUint16(28, true) & 0x3fff;
		return { mimeType: "image/webp", width, height, channels: 3, hasAlpha: false };
	}

	return { mimeType: "image/webp" };
}

export function parseImageMetadata(header: Uint8Array): ImageMetadata | null {
	return (
		parsePngMetadata(header) ?? parseJpegMetadata(header) ?? parseGifMetadata(header) ?? parseWebpMetadata(header)
	);
}

export function readImageMetadata(
	filePath: string,
	maxBytes = DEFAULT_IMAGE_METADATA_HEADER_BYTES,
): Promise<ImageMetadata | null> {
	return peekFile(filePath, maxBytes, parseImageMetadata);
}
