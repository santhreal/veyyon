/**
 * Write a pasted or attached image into the blob store and hand back the path a
 * marker links to.
 *
 * The markers themselves — the regex, the renumbering and the rendering — are in
 * `image-reference-markers.ts`, which the composer imports. This half is reached
 * only when a draft that holds images is submitted, so nothing on the launch
 * path pays for the blob store, `fs` or the logger.
 */

import type { ImageContent } from "@veyyon/ai";
import * as logger from "@veyyon/utils/logger";
import { errorMessage } from "@veyyon/utils/type-guards";
import { type BlobPutResult, blobExtensionForImageMimeType } from "@veyyon/kernel/session/blob-store";

type ImageBlobWriter = (data: Buffer, options?: { extension?: string }) => Promise<BlobPutResult>;
type ImageBlobWriterSync = (data: Buffer, options?: { extension?: string }) => BlobPutResult;

async function materializeImageReferenceLinkAsync(
	image: ImageContent,
	index: number,
	putBlob: ImageBlobWriter,
): Promise<string | undefined> {
	try {
		const result = await putBlob(Buffer.from(image.data, "base64"), {
			extension: blobExtensionForImageMimeType(image.mimeType),
		});
		return result.displayPath;
	} catch (error) {
		logger.warn("Failed to write image reference blob", {
			index,
			mimeType: image.mimeType,
			error: errorMessage(error),
		});
		return undefined;
	}
}

function materializeImageReferenceLink(
	image: ImageContent,
	index: number,
	putBlob: ImageBlobWriterSync,
): string | undefined {
	try {
		const result = putBlob(Buffer.from(image.data, "base64"), {
			extension: blobExtensionForImageMimeType(image.mimeType),
		});
		return result.displayPath;
	} catch (error) {
		logger.warn("Failed to write image reference blob", {
			index,
			mimeType: image.mimeType,
			error: errorMessage(error),
		});
		return undefined;
	}
}

export async function materializeImageReferenceLinks(
	images: readonly ImageContent[] | undefined,
	putBlob: ImageBlobWriter,
): Promise<(string | undefined)[] | undefined> {
	if (!images || images.length === 0) return undefined;
	const links = await Promise.all(
		images.map((image, index) => materializeImageReferenceLinkAsync(image, index + 1, putBlob)),
	);
	return links.some(link => link !== undefined) ? links : undefined;
}

export function materializeImageReferenceLinksSync(
	images: readonly ImageContent[] | undefined,
	putBlob: ImageBlobWriterSync,
): (string | undefined)[] | undefined {
	if (!images || images.length === 0) return undefined;
	const links = images.map((image, index) => materializeImageReferenceLink(image, index + 1, putBlob));
	return links.some(link => link !== undefined) ? links : undefined;
}
