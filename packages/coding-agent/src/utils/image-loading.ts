import * as fs from "node:fs/promises";
import type { ImageContent, Model } from "@veyyon/ai";
import { formatBytes } from "@veyyon/utils/format";
// Owners, not the `@veyyon/utils` barrel: 2 modules against 74.
import { SUPPORTED_IMAGE_MIME_TYPES } from "@veyyon/utils/mime";
import { resolveReadPath } from "../tools/path-utils";
import {
	canonicalizeImageContent,
	formatDimensionNote,
	type ImageResizeOptions,
	resizeImage,
} from "./image-resize";

export const MAX_IMAGE_INPUT_BYTES = 20 * 1024 * 1024;
export const SUPPORTED_INPUT_IMAGE_MIME_TYPES = SUPPORTED_IMAGE_MIME_TYPES;

/**
 * Ollama and its local-backend family decode image input through llama.cpp /
 * `stb_image`, which is compiled without WebP support, so a WebP upload fails
 * with an opaque HTTP 400. Detect those models so the resize pipeline encodes
 * to PNG/JPEG instead — the automatic equivalent of `VEYYON_NO_WEBP=1`.
 */
export function modelLacksWebpSupport(
	model: Pick<Model, "provider" | "api" | "imageInputDecoder"> | undefined,
): boolean {
	if (!model) return false;
	return (
		model.imageInputDecoder === "stb" ||
		model.provider === "ollama" ||
		model.provider === "ollama-cloud" ||
		model.provider === "llama.cpp" ||
		model.provider === "lm-studio" ||
		model.provider === "local-server" ||
		model.api === "ollama-chat"
	);
}

/**
 * `true` when `model` cannot decode WebP, otherwise `undefined` so the
 * `VEYYON_NO_WEBP` env fallback in {@link resizeImage} still applies. Feed straight
 * into {@link ImageResizeOptions.excludeWebP}.
 */
export function webpExclusionForModel(model: Pick<Model, "provider" | "api"> | undefined): true | undefined {
	return modelLacksWebpSupport(model) ? true : undefined;
}

export interface LoadImageInputOptions {
	path: string;
	cwd: string;
	autoResize: boolean;
	maxBytes?: number;
	resolvedPath?: string;
	detectedMimeType?: string;
	/** Force non-WebP output (e.g. for Ollama). Leave unset to honor `VEYYON_NO_WEBP`. */
	excludeWebP?: boolean;
}

/** Options for loading an in-memory chat image attachment as a vision-model input. */
export interface LoadImageAttachmentInputOptions {
	image: ImageContent;
	label: string;
	uri: string;
	autoResize: boolean;
	maxBytes?: number;
	/** Force non-WebP output (e.g. for Ollama). Leave unset to honor `VEYYON_NO_WEBP`. */
	excludeWebP?: boolean;
}

export interface LoadedImageInput {
	resolvedPath: string;
	mimeType: string;
	data: string;
	textNote: string;
	dimensionNote?: string;
	bytes: number;
}

export class ImageInputTooLargeError extends Error {
	readonly bytes: number;
	readonly maxBytes: number;

	constructor(bytes: number, maxBytes: number) {
		super(`Image file too large: ${formatBytes(bytes)} exceeds ${formatBytes(maxBytes)} limit.`);
		this.name = "ImageInputTooLargeError";
		this.bytes = bytes;
		this.maxBytes = maxBytes;
	}
}

export async function ensureSupportedImageInput(image: ImageContent): Promise<ImageContent | null> {
	try {
		const canonical = await canonicalizeImageContent(image);
		return { type: "image", data: canonical.data, mimeType: canonical.mimeType };
	} catch {
		return null;
	}
}

export interface NormalizeModelContextImagesOptions {
	/** Model the images are bound for; used to derive encoder constraints (WebP exclusion for Ollama). */
	model?: Model;
	resize?: ImageResizeOptions;
}

/**
 * Normalize image blocks before they enter agent/model context. This keeps
 * provider request construction from having to resize an unbounded batch of
 * large images on the streaming hot path. Images are processed sequentially on
 * purpose: `resizeImage` may fan out multiple encoders for one image, so the
 * outer image batch must stay bounded.
 */
export async function normalizeModelContextImages(
	images: ImageContent[] | undefined,
	options?: NormalizeModelContextImagesOptions,
): Promise<ImageContent[] | undefined> {
	if (!images || images.length === 0) return undefined;
	const resize: ImageResizeOptions | undefined = modelLacksWebpSupport(options?.model)
		? { ...options?.resize, excludeWebP: true }
		: options?.resize;
	const normalized: ImageContent[] = [];
	for (const image of images) {
		const resized = await resizeImage(image, resize);
		normalized.push({ type: "image", data: resized.data, mimeType: resized.mimeType });
	}
	return normalized;
}

export async function loadImageInput(options: LoadImageInputOptions): Promise<LoadedImageInput | null> {
	const maxBytes = options.maxBytes ?? MAX_IMAGE_INPUT_BYTES;
	const resolvedPath = options.resolvedPath ?? resolveReadPath(options.path, options.cwd);
	// detectedMimeType is only an earlier probe hint. Provider-bound MIME is
	// established below from decoded bytes and never inherited from this value.

	const stat = await Bun.file(resolvedPath).stat();
	if (stat.size > maxBytes) {
		throw new ImageInputTooLargeError(stat.size, maxBytes);
	}

	const inputBuffer = await fs.readFile(resolvedPath);
	if (inputBuffer.byteLength > maxBytes) {
		throw new ImageInputTooLargeError(inputBuffer.byteLength, maxBytes);
	}

	const sourceImage: ImageContent = {
		type: "image",
		data: Buffer.from(inputBuffer).toBase64(),
		mimeType: "application/octet-stream",
	};
	let outputData: string;
	let outputMimeType: string;
	let outputBytes: number;
	let dimensionNote: string | undefined;

	try {
		if (options.autoResize) {
			const resized = await resizeImage(sourceImage, { excludeWebP: options.excludeWebP });
			outputData = resized.data;
			outputMimeType = resized.mimeType;
			outputBytes = resized.buffer.byteLength;
			dimensionNote = formatDimensionNote(resized);
		} else {
			const canonical = await canonicalizeImageContent(sourceImage, { excludeWebP: options.excludeWebP });
			outputData = canonical.data;
			outputMimeType = canonical.mimeType;
			outputBytes = canonical.buffer.byteLength;
		}
	} catch {
		return null;
	}
	if (outputBytes > maxBytes) {
		throw new ImageInputTooLargeError(outputBytes, maxBytes);
	}

	let textNote = `Read image file [${outputMimeType}]`;
	if (dimensionNote) {
		textNote += `\n${dimensionNote}`;
	}

	return {
		resolvedPath,
		mimeType: outputMimeType,
		data: outputData,
		textNote,
		dimensionNote,
		bytes: outputBytes,
	};
}

/** Loads a chat attachment image through the same size and encoder policy as file-backed image inputs. */
export async function loadImageAttachmentInput(
	options: LoadImageAttachmentInputOptions,
): Promise<LoadedImageInput | null> {
	const maxBytes = options.maxBytes ?? MAX_IMAGE_INPUT_BYTES;
	const inputBytes = Buffer.byteLength(options.image.data, "base64");
	if (inputBytes > maxBytes) {
		throw new ImageInputTooLargeError(inputBytes, maxBytes);
	}
	const sourceImage: ImageContent = {
		type: "image",
		data: options.image.data,
		mimeType: "application/octet-stream",
	};
	let outputData: string;
	let outputMimeType: string;
	let outputBytes: number;
	let dimensionNote: string | undefined;

	try {
		if (options.autoResize) {
			const resized = await resizeImage(sourceImage, { excludeWebP: options.excludeWebP });
			outputData = resized.data;
			outputMimeType = resized.mimeType;
			outputBytes = resized.buffer.byteLength;
			dimensionNote = formatDimensionNote(resized);
		} else {
			const canonical = await canonicalizeImageContent(sourceImage, { excludeWebP: options.excludeWebP });
			outputData = canonical.data;
			outputMimeType = canonical.mimeType;
			outputBytes = canonical.buffer.byteLength;
		}
	} catch {
		return null;
	}
	if (outputBytes > maxBytes) {
		throw new ImageInputTooLargeError(outputBytes, maxBytes);
	}

	let textNote = `Read image attachment ${options.label} [${outputMimeType}]`;
	if (dimensionNote) {
		textNote += `\n${dimensionNote}`;
	}

	return {
		resolvedPath: options.uri,
		mimeType: outputMimeType,
		data: outputData,
		textNote,
		dimensionNote,
		bytes: outputBytes,
	};
}
