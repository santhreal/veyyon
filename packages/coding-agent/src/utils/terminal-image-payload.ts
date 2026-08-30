/**
 * The bytes a terminal is handed for one picture.
 *
 * Two jobs live here, and they are the same operation:
 *
 * - **Format.** Kitty draws PNG and nothing else (`f=100`), so a JPEG, GIF or
 *   WebP result has to be re-encoded before it can appear at all.
 * - **Size.** Every graphics protocol scales the payload into a cell box, and a
 *   terminal's scaler is a cheap GPU filter. A 1568x882 screenshot squeezed
 *   into 850x480 by WezTerm comes out smeared to the point that code in the
 *   picture is unreadable; the same box filled by a Lanczos resample here is
 *   legible, and the transmit drops from 1.1 MB to 459 KB.
 *
 * Both happen before the picture is first drawn. A payload swapped in after
 * the fact does not reach the screen: the rows holding it are already
 * committed, an incremental frame does not rewrite them, and a frame that does
 * rewrite them erases the graphic on WezTerm.
 */
import { getImageDimensions, type ImageDimensions, type ImageRenderOptions, imagePixelBox } from "@veyyon/tui";
import { MAX_IMAGE_INPUT_PIXELS } from "./image-resize";

/** A picture as a tool or a message produced it. */
export interface TerminalImageSource {
	readonly data: string;
	readonly mimeType: string;
}

/** PNG bytes sized for the terminal, with the dimensions actually encoded. */
export interface TerminalImagePayload {
	readonly data: string;
	readonly mimeType: "image/png";
	readonly widthPx: number;
	readonly heightPx: number;
}

/**
 * Ceiling on a resample target. `calculateImageFit` bounds terminal CELLS, not
 * pixels, so a pathological cell size still multiplies out past anything a
 * display can show. Over the ceiling the box is ignored and the source is
 * re-encoded at its own size, which is the pre-existing behaviour.
 */
const MAX_PAYLOAD_PIXELS = 16_777_216;

/**
 * Re-encode `source` as PNG, resampled to `box` when that is smaller than the
 * source. Upscaling is skipped on purpose: it adds no detail, only transmit
 * bytes, and the terminal stretches the smaller payload to the same box.
 */
export async function encodeTerminalImagePayload(
	source: TerminalImageSource,
	box?: ImageDimensions,
): Promise<TerminalImagePayload> {
	const bytes = Buffer.from(source.data, "base64");
	let pipeline = new Bun.Image(bytes, { maxPixels: MAX_IMAGE_INPUT_PIXELS, autoOrient: true });
	const metadata = await pipeline.metadata();
	let widthPx = metadata.width;
	let heightPx = metadata.height;

	const target = usableBox(box, widthPx, heightPx);
	if (target) {
		pipeline = pipeline.resize(target.widthPx, target.heightPx);
		widthPx = target.widthPx;
		heightPx = target.heightPx;
	}
	const encoded = await pipeline.png().bytes();
	return { data: Buffer.from(encoded).toBase64(), mimeType: "image/png", widthPx, heightPx };
}

function usableBox(box: ImageDimensions | undefined, widthPx: number, heightPx: number): ImageDimensions | null {
	if (!box) return null;
	// A box arrives from a cell measurement, and a terminal that has not
	// reported its cell size yields NaN. Truncation keeps NaN, every comparison
	// against it is false, and the encoder would be asked to resize to NaN.
	if (!Number.isFinite(box.widthPx) || !Number.isFinite(box.heightPx)) return null;
	const targetWidth = Math.trunc(box.widthPx);
	const targetHeight = Math.trunc(box.heightPx);
	if (targetWidth < 1 || targetHeight < 1) return null;
	if (targetWidth * targetHeight > MAX_PAYLOAD_PIXELS) return null;
	if (targetWidth >= widthPx && targetHeight >= heightPx) return null;
	return { widthPx: targetWidth, heightPx: targetHeight };
}

/**
 * The pixel box the terminal will scale this picture into, from the source's
 * own dimensions and the cell caps a tool result renders under.
 *
 * Returns null when the source header is unreadable, which is also the answer
 * for a picture no protocol can draw: the caller re-encodes to PNG without
 * resizing and the component reports the format fallback.
 */
export function terminalImageBox(source: TerminalImageSource, options: ImageRenderOptions): ImageDimensions | null {
	const dimensions = getImageDimensions(source.data, source.mimeType);
	if (!dimensions) return null;
	return imagePixelBox(dimensions, options);
}
