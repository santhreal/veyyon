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
		const inputBuffer = Uint8Array.fromBase64(img.data.trim());
		const detected = parseImageMetadata(inputBuffer);
		if (!detected) throw new Error("unsupported image type");

		const metadata = await new Bun.Image(inputBuffer).metadata();
		if (!Number.isFinite(metadata.width) || !Number.isFinite(metadata.height) || metadata.width < 1 || metadata.height < 1) {
			throw new Error("invalid image dimensions");
		}

		let buffer: Uint8Array;
		let mimeType: CanonicalImage["mimeType"];
		switch (detected.mimeType) {
			case "image/jpeg":
				buffer = await new Bun.Image(inputBuffer).jpeg({ quality: 100 }).bytes();
				mimeType = "image/jpeg";
				break;
			case "image/webp":
				if (options?.excludeWebP) {
					buffer = await new Bun.Image(inputBuffer).png().bytes();
					mimeType = "image/png";
				} else {
					buffer = await new Bun.Image(inputBuffer).webp({ quality: 100 }).bytes();
					mimeType = "image/webp";
				}
				break;
			case "image/gif":
				// Bun has no GIF encoder. A canonical PNG of the decoded first
				// frame is provider-compatible and contains no GIF extensions.
				buffer = await new Bun.Image(inputBuffer).png().bytes();
				mimeType = "image/png";
				break;
			case "image/png":
				buffer = await new Bun.Image(inputBuffer).png().bytes();
				mimeType = "image/png";
				break;
		}

		const outputMetadata = parseImageMetadata(buffer);
		if (outputMetadata?.mimeType !== mimeType) throw new Error("image encoder returned an unexpected type");

		return {
			buffer,
			mimeType,
			width: metadata.width,
			height: metadata.height,
			get data() {
				return Buffer.from(buffer).toBase64();
			},
		};
	} catch {
		// Do not include input bytes, labels, or decoder diagnostics: malformed
		// image metadata can itself contain confidential text.
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
	const excludeWebP = options?.excludeWebP ?? isWebPExcluded();
	const opts = { ...DEFAULT_OPTIONS, ...options, excludeWebP };
	const canonical = await canonicalizeImageContent(img, { excludeWebP });
	const inputBuffer = canonical.buffer;

	try {
		const originalWidth = canonical.width;
		const originalHeight = canonical.height;
		const sourceMime = canonical.mimeType;

		// Fast path: already within dimensions AND well under budget.
		// Threshold is 1/4 of budget — if already that compact, don't re-encode.
		// Avoids wasted work on tiny icons/diagrams while ensuring larger PNGs
		// still get JPEG-compressed.
		const originalSize = inputBuffer.length;
		const comfortableSize = opts.maxBytes / 4;
		// Clamp the floor to the caps so an unusually small max can't demand an
		// impossible "≥ min and ≤ max" target.
		const minDimension = Math.min(opts.minDimension, opts.maxWidth, opts.maxHeight);
		if (
			originalWidth >= minDimension &&
			originalHeight >= minDimension &&
			originalWidth <= opts.maxWidth &&
			originalHeight <= opts.maxHeight &&
			originalSize <= comfortableSize &&
			!(opts.excludeWebP && sourceMime === "image/webp")
		) {
			return {
				buffer: inputBuffer,
				mimeType: sourceMime,
				originalWidth,
				originalHeight,
				width: originalWidth,
				height: originalHeight,
				wasResized: false,
				get data() {
					return Buffer.from(inputBuffer).toBase64();
				},
			};
		}

		// Calculate initial dimensions respecting max limits
		let targetWidth = originalWidth;
		let targetHeight = originalHeight;

		if (targetWidth > opts.maxWidth) {
			targetHeight = Math.round((targetHeight * opts.maxWidth) / targetWidth);
			targetWidth = opts.maxWidth;
		}
		if (targetHeight > opts.maxHeight) {
			targetWidth = Math.round((targetWidth * opts.maxHeight) / targetHeight);
			targetHeight = opts.maxHeight;
		}

		// Lift undersized inputs up to the minimum. A uniform scale covers the
		// common case (icons, the 1x1 chart) without distortion; an aspect ratio
		// too extreme to satisfy both floor and cap falls back to stretching the
		// lagging edge up to the floor via the default fit:"fill" resize.
		if (targetWidth < minDimension || targetHeight < minDimension) {
			const shortEdge = Math.min(targetWidth, targetHeight);
			const upscale = Math.min(minDimension / shortEdge, opts.maxWidth / targetWidth, opts.maxHeight / targetHeight);
			if (upscale > 1) {
				targetWidth = Math.round(targetWidth * upscale);
				targetHeight = Math.round(targetHeight * upscale);
			}
			targetWidth = Math.min(opts.maxWidth, Math.max(minDimension, targetWidth));
			targetHeight = Math.min(opts.maxHeight, Math.max(minDimension, targetHeight));
		}

		// First-attempt encoder: try PNG and JPEG (+ WebP if not excluded) — return smallest.
		// PNG wins for line art / few-color UI; JPEG wins for photographic content;
		// WebP usually beats JPEG by 25–35% but is disabled when VEYYON_NO_WEBP is set
		// because many local inference backends (llama.cpp STB) don't decode it.
		async function encodeSmallest(
			width: number,
			height: number,
			quality: number,
		): Promise<{ buffer: Uint8Array; mimeType: string }> {
			const candidates = await Promise.all([
				new Bun.Image(inputBuffer)
					.resize(width, height)
					.png()
					.bytes()
					.then(b => ({ buffer: b, mimeType: "image/png" })),
				new Bun.Image(inputBuffer)
					.resize(width, height)
					.jpeg({ quality })
					.bytes()
					.then(b => ({ buffer: b, mimeType: "image/jpeg" })),
				...(opts.excludeWebP
					? []
					: [
							new Bun.Image(inputBuffer)
								.resize(width, height)
								.webp({ quality })
								.bytes()
								.then(b => ({ buffer: b, mimeType: "image/webp" })),
						]),
			]);
			return pickSmallest(...candidates);
		}

		// Lossy encoder for quality/dimension fallback ladders. PNG is excluded since
		// it's lossless and doesn't respond to quality parameters. WebP is included
		// unless VEYYON_NO_WEBP is set (llama.cpp STB incompatibility).
		async function encodeLossy(
			width: number,
			height: number,
			quality: number,
		): Promise<{ buffer: Uint8Array; mimeType: string }> {
			const candidates = await Promise.all([
				new Bun.Image(inputBuffer)
					.resize(width, height)
					.jpeg({ quality })
					.bytes()
					.then(b => ({ buffer: b, mimeType: "image/jpeg" })),
				...(opts.excludeWebP
					? []
					: [
							new Bun.Image(inputBuffer)
								.resize(width, height)
								.webp({ quality })
								.bytes()
								.then(b => ({ buffer: b, mimeType: "image/webp" })),
						]),
			]);
			return pickSmallest(...candidates);
		}
		// Quality ladder — more aggressive steps for tighter budgets
		const qualitySteps = [70, 60, 50, 40];
		const scaleSteps = [1.0, 0.75, 0.5, 0.35, 0.25];

		let best: { buffer: Uint8Array; mimeType: string };
		let finalWidth = targetWidth;
		let finalHeight = targetHeight;

		// First attempt: resize to target, try PNG/JPEG (+ WebP), pick smallest
		best = await encodeSmallest(targetWidth, targetHeight, opts.jpegQuality);

		if (best.buffer.length <= opts.maxBytes) {
			return {
				buffer: best.buffer,
				mimeType: best.mimeType,
				originalWidth,
				originalHeight,
				width: finalWidth,
				height: finalHeight,
				wasResized: true,
				get data() {
					return Buffer.from(best.buffer).toBase64();
				},
			};
		}

		// Still too large — lossy JPEG (+ WebP) ladder with decreasing quality
		for (const quality of qualitySteps) {
			best = await encodeLossy(targetWidth, targetHeight, quality);

			if (best.buffer.length <= opts.maxBytes) {
				return {
					buffer: best.buffer,
					mimeType: best.mimeType,
					originalWidth,
					originalHeight,
					width: finalWidth,
					height: finalHeight,
					wasResized: true,
					get data() {
						return Buffer.from(best.buffer).toBase64();
					},
				};
			}
		}

		// Still too large — reduce dimensions progressively with the lossy ladder
		for (const scale of scaleSteps) {
			finalWidth = Math.round(targetWidth * scale);
			finalHeight = Math.round(targetHeight * scale);

			if (finalWidth < 100 || finalHeight < 100) {
				break;
			}

			for (const quality of qualitySteps) {
				best = await encodeLossy(finalWidth, finalHeight, quality);

				if (best.buffer.length <= opts.maxBytes) {
					return {
						buffer: best.buffer,
						mimeType: best.mimeType,
						originalWidth,
						originalHeight,
						width: finalWidth,
						height: finalHeight,
						wasResized: true,
						get data() {
							return Buffer.from(best.buffer).toBase64();
						},
					};
				}
			}
		}

		// Last resort: return smallest version we produced
		return {
			buffer: best.buffer,
			mimeType: best.mimeType,
			originalWidth,
			originalHeight,
			width: finalWidth,
			height: finalHeight,
			wasResized: true,
			get data() {
				return Buffer.from(best.buffer).toBase64();
			},
		};
	} catch {
		// Canonicalization above already proved decodeability and stripped
		// metadata. If an optional resize encoder fails, the canonical image is
		// the only safe fallback; the caller's original bytes never escape.
		return {
			buffer: canonical.buffer,
			mimeType: canonical.mimeType,
			originalWidth: canonical.width,
			originalHeight: canonical.height,
			width: canonical.width,
			height: canonical.height,
			wasResized: false,
			get data() {
				return canonical.data;
			},
		};
	}
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
