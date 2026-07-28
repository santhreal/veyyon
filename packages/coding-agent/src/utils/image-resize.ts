import type { ImageContent } from "@veyyon/ai";
import { parseImageMetadata } from "@veyyon/utils/mime";

export interface ImageResizeOptions {
	maxWidth?: number;
	maxHeight?: number;
	/** Smallest allowed edge length (px). Inputs below this are scaled up. */
	minDimension?: number;
	maxBytes?: number;
	jpegQuality?: number;
	excludeWebP?: boolean;
}

export interface ResizedImage {
	buffer: Uint8Array;
	mimeType: string;
	originalWidth: number;
	originalHeight: number;
	width: number;
	height: number;
	wasResized: boolean;
	decodeFailed?: boolean;
	get data(): string;
}

export interface CanonicalImage {
	buffer: Uint8Array;
	mimeType: "image/png" | "image/jpeg" | "image/webp";
	width: number;
	height: number;
	get data(): string;
}

// 500KB target — aggressive compression; Anthropic's 5MB per-image cap is rarely the
// binding constraint once images are downsized to 1568px (Anthropic's internal threshold).
const DEFAULT_MAX_BYTES = 500 * 1024;

// Smallest edge length (px) vision backends reliably accept. They tile images into
// fixed patches (Anthropic uses 28px) and reject degenerate sub-patch images — e.g.
// the 1x1 PNG an empty chart render emits — with a hard 400 ("Could not process
// image") that can poison the whole request. 200px is the smallest size Anthropic
// documents as valid (200x200 = 64 visual tokens); undersized images are scaled up.
const DEFAULT_MIN_DIMENSION = 200;

/** Hard header ceilings enforced before Bun allocates a decoded pixel buffer. */
export const MAX_IMAGE_INPUT_WIDTH = 16_384;
export const MAX_IMAGE_INPUT_HEIGHT = 16_384;
export const MAX_IMAGE_INPUT_PIXELS = 40_000_000;
export const MAX_IMAGE_DECODED_BYTES = 128 * 1024 * 1024;
const DECODED_BYTES_PER_PIXEL = 4;

const DEFAULT_OPTIONS: Required<Omit<ImageResizeOptions, "excludeWebP">> = {
	// Anthropic's "internal recommended size" — Claude internally caps images at
	// 1568px on the longest edge before vision processing.
	maxWidth: 1568,
	maxHeight: 1568,
	maxBytes: DEFAULT_MAX_BYTES,
	jpegQuality: 80,
	minDimension: DEFAULT_MIN_DIMENSION,
};


/**
 * Read `VEYYON_NO_WEBP` per-call so runtime toggles take effect.
 * Only `"1"` and `"true"` (case-insensitive) enable exclusion — an empty string
 * or `"0"` MUST be treated as disabled.
 */
function isWebPExcluded(): boolean {
	const raw = Bun.env.VEYYON_NO_WEBP;
	if (raw === undefined) return false;
	const v = raw.toLowerCase();
	return v === "1" || v === "true";
}

/** Pick the smallest of N encoded buffers. */
function pickSmallest(...candidates: Array<{ buffer: Uint8Array; mimeType: string }>): {
	buffer: Uint8Array;
	mimeType: string;
} {
	return candidates.reduce((best, c) => (c.buffer.length < best.buffer.length ? c : best));
}

/** Polyfill for Buffer.toBase64, technically since it derives from Uint8Array it should exist but Bun reasons... */
Buffer.prototype.toBase64 = function (this: Buffer) {
	return new Uint8Array(this.buffer, this.byteOffset, this.byteLength).toBase64();
};

/**
 * Decode and canonically re-encode an image before it can cross a provider
 * boundary. The caller's MIME label is deliberately ignored: the decoder and
 * byte signature establish the actual type, while re-encoding removes
 * container metadata that a text sanitizer cannot inspect.
 */
export async function canonicalizeImageContent(
	img: Pick<ImageContent, "data">,
	options?: Pick<ImageResizeOptions, "excludeWebP">,
): Promise<CanonicalImage> {
	try {
		const source = await inspectImageInput(img.data);
		const outputMime = canonicalMimeType(source.mimeType, options?.excludeWebP === true);
		const buffer = await encodeImage(source.inputBuffer, outputMime, undefined, undefined, 100);
		assertEncodedImage(buffer, outputMime, source.width, source.height);

		return {
			buffer,
			mimeType: outputMime,
			width: source.width,
			height: source.height,
			get data() {
				return Buffer.from(buffer).toBase64();
			},
		};
	} catch {
		throw new Error("Image normalization failed: input is not a decodable supported image.");
	}
}

/**
 * Resize and recompress an image to fit within the specified max dimensions and file size.
 *
 * Strategy:
 *  1. Probe metadata. If already within all limits, return original.
 *  2. Resize to fit max dimensions and encode at high quality across PNG/JPEG (+ WebP) — return smallest.
 *  3. If still too large, walk a lossy JPEG/WebP quality ladder.
 *  4. If still too large, walk a dimension-scale ladder × quality ladder.
 *  5. If still too large, return the smallest variant produced.
 *
 * Set VEYYON_NO_WEBP to exclude WebP from encoding (llama.cpp STB doesn't decode it).
 *
 * Backed by `Bun.Image`: a chainable native pipeline that runs decode/transform/encode
 * off the JS thread when the terminal (`.bytes()`) is awaited.
 */
export async function resizeImage(img: ImageContent, options?: ImageResizeOptions): Promise<ResizedImage> {
	try {
		const excludeWebP = options?.excludeWebP ?? isWebPExcluded();
		const opts = { ...DEFAULT_OPTIONS, ...options, excludeWebP };
		assertResizeOptions(opts);
		const source = await inspectImageInput(img.data);
		const originalWidth = source.width;
		const originalHeight = source.height;
		const minDimension = Math.min(opts.minDimension, opts.maxWidth, opts.maxHeight);
		const { width: targetWidth, height: targetHeight } = targetDimensions(
			originalWidth,
			originalHeight,
			opts.maxWidth,
			opts.maxHeight,
			minDimension,
		);
		const dimensionsChanged = targetWidth !== originalWidth || targetHeight !== originalHeight;

		// A within-bounds image is still re-encoded once so EXIF/container
		// metadata never crosses the provider boundary. Oversized images skip
		// this original-resolution canonicalization entirely: their very first
		// decode pipeline includes the downsample.
		if (!dimensionsChanged) {
			const canonicalMime = canonicalMimeType(source.mimeType, excludeWebP);
			const canonicalBuffer = await encodeImage(source.inputBuffer, canonicalMime, undefined, undefined, 100);
			assertEncodedImage(canonicalBuffer, canonicalMime, originalWidth, originalHeight);
			if (canonicalBuffer.length <= opts.maxBytes / 4) {
				return resizedResult(
					canonicalBuffer,
					canonicalMime,
					originalWidth,
					originalHeight,
					originalWidth,
					originalHeight,
					false,
				);
			}
		}

		async function encodeSmallest(
			width: number,
			height: number,
			quality: number,
		): Promise<{ buffer: Uint8Array; mimeType: CanonicalImage["mimeType"] }> {
			// Run decoders sequentially. Each native decoder is individually
			// bounded, and sequencing prevents the format race from multiplying
			// that decoded-allocation ceiling by three.
			const candidates: Array<{ buffer: Uint8Array; mimeType: CanonicalImage["mimeType"] }> = [];
			for (const mimeType of [
				"image/png",
				"image/jpeg",
				...(excludeWebP ? [] : (["image/webp"] as const)),
			] as const) {
				const buffer = await encodeImage(source.inputBuffer, mimeType, width, height, quality);
				assertEncodedImage(buffer, mimeType, width, height);
				candidates.push({ buffer, mimeType });
			}
			return pickSmallest(...candidates) as { buffer: Uint8Array; mimeType: CanonicalImage["mimeType"] };
		}

		async function encodeLossy(
			width: number,
			height: number,
			quality: number,
		): Promise<{ buffer: Uint8Array; mimeType: CanonicalImage["mimeType"] }> {
			const candidates: Array<{ buffer: Uint8Array; mimeType: CanonicalImage["mimeType"] }> = [];
			for (const mimeType of [
				"image/jpeg",
				...(excludeWebP ? [] : (["image/webp"] as const)),
			] as const) {
				const buffer = await encodeImage(source.inputBuffer, mimeType, width, height, quality);
				assertEncodedImage(buffer, mimeType, width, height);
				candidates.push({ buffer, mimeType });
			}
			return pickSmallest(...candidates) as { buffer: Uint8Array; mimeType: CanonicalImage["mimeType"] };
		}

		const qualitySteps = [70, 60, 50, 40];
		const scaleSteps = [1, 0.75, 0.5, 0.35, 0.25];
		let finalWidth = targetWidth;
		let finalHeight = targetHeight;
		let best = await encodeSmallest(targetWidth, targetHeight, opts.jpegQuality);

		if (best.buffer.length <= opts.maxBytes) {
			return resizedResult(
				best.buffer,
				best.mimeType,
				originalWidth,
				originalHeight,
				finalWidth,
				finalHeight,
				true,
			);
		}

		for (const quality of qualitySteps) {
			best = await encodeLossy(targetWidth, targetHeight, quality);
			if (best.buffer.length <= opts.maxBytes) {
				return resizedResult(
					best.buffer,
					best.mimeType,
					originalWidth,
					originalHeight,
					finalWidth,
					finalHeight,
					true,
				);
			}
		}

		for (const scale of scaleSteps) {
			finalWidth = Math.round(targetWidth * scale);
			finalHeight = Math.round(targetHeight * scale);
			if (finalWidth < 100 || finalHeight < 100) break;

			for (const quality of qualitySteps) {
				best = await encodeLossy(finalWidth, finalHeight, quality);
				if (best.buffer.length <= opts.maxBytes) {
					return resizedResult(
						best.buffer,
						best.mimeType,
						originalWidth,
						originalHeight,
						finalWidth,
						finalHeight,
						true,
					);
				}
			}
		}

		return resizedResult(
			best.buffer,
			best.mimeType,
			originalWidth,
			originalHeight,
			finalWidth,
			finalHeight,
			true,
		);
	} catch {
		throw new Error("Image normalization failed: input is not a decodable supported image.");
	}
}

interface InspectedImage {
	inputBuffer: Uint8Array;
	mimeType: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
	width: number;
	height: number;
}

function checkedImageDimensions(width: unknown, height: unknown): { width: number; height: number } {
	if (
		typeof width !== "number" ||
		typeof height !== "number" ||
		!Number.isSafeInteger(width) ||
		!Number.isSafeInteger(height) ||
		width < 1 ||
		height < 1 ||
		width > MAX_IMAGE_INPUT_WIDTH ||
		height > MAX_IMAGE_INPUT_HEIGHT
	) {
		throw new Error("invalid image dimensions");
	}
	const pixels = width * height;
	if (!Number.isSafeInteger(pixels) || pixels > MAX_IMAGE_INPUT_PIXELS) {
		throw new Error("image pixel count exceeds limit");
	}
	const decodedBytes = pixels * DECODED_BYTES_PER_PIXEL;
	if (!Number.isSafeInteger(decodedBytes) || decodedBytes > MAX_IMAGE_DECODED_BYTES) {
		throw new Error("decoded image allocation exceeds limit");
	}
	return { width, height };
}

async function inspectImageInput(data: string): Promise<InspectedImage> {
	const inputBuffer = Uint8Array.fromBase64(data.trim());
	const detected = parseImageMetadata(inputBuffer);
	if (!detected) throw new Error("unsupported image type");
	const trusted = checkedImageDimensions(detected.width, detected.height);
	const native = await new Bun.Image(inputBuffer, {
		maxPixels: MAX_IMAGE_INPUT_PIXELS,
		autoOrient: true,
	}).metadata();
	const decoded = checkedImageDimensions(native.width, native.height);
	const nativeMime = native.format === "jpeg" ? "image/jpeg" : `image/${native.format}`;
	if (
		nativeMime !== detected.mimeType ||
		decoded.width !== trusted.width ||
		decoded.height !== trusted.height
	) {
		throw new Error("image metadata mismatch");
	}
	return { inputBuffer, mimeType: detected.mimeType, ...trusted };
}

function canonicalMimeType(
	sourceMime: InspectedImage["mimeType"],
	excludeWebP: boolean,
): CanonicalImage["mimeType"] {
	if (sourceMime === "image/gif" || (sourceMime === "image/webp" && excludeWebP)) return "image/png";
	return sourceMime;
}

async function encodeImage(
	inputBuffer: Uint8Array,
	mimeType: CanonicalImage["mimeType"],
	width: number | undefined,
	height: number | undefined,
	quality: number,
): Promise<Uint8Array> {
	let pipeline = new Bun.Image(inputBuffer, {
		maxPixels: MAX_IMAGE_INPUT_PIXELS,
		autoOrient: true,
	});
	if (width !== undefined && height !== undefined) {
		checkedImageDimensions(width, height);
		pipeline = pipeline.resize(width, height);
	}
	switch (mimeType) {
		case "image/jpeg":
			return pipeline.jpeg({ quality }).bytes();
		case "image/webp":
			return pipeline.webp({ quality }).bytes();
		case "image/png":
			return pipeline.png().bytes();
	}
}

function assertEncodedImage(
	buffer: Uint8Array,
	mimeType: CanonicalImage["mimeType"],
	width: number,
	height: number,
): void {
	const metadata = parseImageMetadata(buffer);
	if (metadata?.mimeType !== mimeType || metadata.width !== width || metadata.height !== height) {
		throw new Error("image encoder returned unexpected metadata");
	}
}

function assertResizeOptions(options: Required<ImageResizeOptions>): void {
	for (const [name, value] of [
		["maxWidth", options.maxWidth],
		["maxHeight", options.maxHeight],
		["minDimension", options.minDimension],
		["maxBytes", options.maxBytes],
		["jpegQuality", options.jpegQuality],
	] as const) {
		if (!Number.isSafeInteger(value) || value < 1) throw new Error(`invalid image resize option: ${name}`);
	}
	if (
		options.maxWidth > MAX_IMAGE_INPUT_WIDTH ||
		options.maxHeight > MAX_IMAGE_INPUT_HEIGHT ||
		options.jpegQuality > 100
	) {
		throw new Error("image resize option exceeds limit");
	}
}

function targetDimensions(
	originalWidth: number,
	originalHeight: number,
	maxWidth: number,
	maxHeight: number,
	minDimension: number,
): { width: number; height: number } {
	let width = originalWidth;
	let height = originalHeight;
	if (width > maxWidth) {
		height = Math.max(1, Math.round((height * maxWidth) / width));
		width = maxWidth;
	}
	if (height > maxHeight) {
		width = Math.max(1, Math.round((width * maxHeight) / height));
		height = maxHeight;
	}
	if (width < minDimension || height < minDimension) {
		const shortEdge = Math.min(width, height);
		const upscale = Math.min(minDimension / shortEdge, maxWidth / width, maxHeight / height);
		if (upscale > 1) {
			width = Math.round(width * upscale);
			height = Math.round(height * upscale);
		}
		width = Math.min(maxWidth, Math.max(minDimension, width));
		height = Math.min(maxHeight, Math.max(minDimension, height));
	}
	return checkedImageDimensions(width, height);
}

function resizedResult(
	buffer: Uint8Array,
	mimeType: CanonicalImage["mimeType"],
	originalWidth: number,
	originalHeight: number,
	width: number,
	height: number,
	wasResized: boolean,
): ResizedImage {
	return {
		buffer,
		mimeType,
		originalWidth,
		originalHeight,
		width,
		height,
		wasResized,
		get data() {
			return Buffer.from(buffer).toBase64();
		},
	};
}

/**
 * Format a dimension note for resized images.
 * This helps the model understand the coordinate mapping.
 */
export function formatDimensionNote(result: ResizedImage): string | undefined {
	if (!result.wasResized) {
		return undefined;
	}
	if (!result.originalWidth || !result.originalHeight || !result.width || !result.height) {
		return undefined;
	}
	if (result.width === result.originalWidth && result.height === result.originalHeight) {
		return undefined;
	}
	const scale = result.originalWidth / result.width;
	return `[Image: original ${result.originalWidth}x${result.originalHeight}, displayed at ${result.width}x${result.height}. Multiply coordinates by ${scale.toFixed(2)} to map to original image.]`;
}
