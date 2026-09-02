import * as fs from "node:fs/promises";
import { formatBytes } from "@veyyon/utils/format";
import { SUPPORTED_VIDEO_MIME_TYPES } from "@veyyon/utils/mime";
import { resolveReadPath } from "../tools/path-utils";

export const MAX_VIDEO_INPUT_BYTES = 20 * 1024 * 1024;
export const MAX_PROMPT_ATTACHMENT_BYTES = 20 * 1024 * 1024;
export const SUPPORTED_INPUT_VIDEO_MIME_TYPES = SUPPORTED_VIDEO_MIME_TYPES;

export class VideoInputTooLargeError extends Error {
	readonly bytes: number;
	readonly maxBytes: number;

	constructor(bytes: number, maxBytes: number) {
		super(`Video file too large: ${formatBytes(bytes)} exceeds ${formatBytes(maxBytes)} limit.`);
		this.name = "VideoInputTooLargeError";
		this.bytes = bytes;
		this.maxBytes = maxBytes;
	}
}

export class UnsupportedVideoTypeError extends Error {
	readonly mimeType?: string;

	constructor(message = "Unsupported video format; must be MP4, WebM, or QuickTime", mimeType?: string) {
		super(message);
		this.name = "UnsupportedVideoTypeError";
		this.mimeType = mimeType;
	}
}

/**
 * Sniff video container MIME type by inspection of magic header bytes.
 * - ISO BMFF `ftyp` box -> `video/quicktime` (if major brand is "qt  ") or `video/mp4`
 * - EBML header (`1A 45 DF A3`) -> `video/webm`
 */
export function sniffVideoMimeType(buffer: Uint8Array | Buffer): string | null {
	// EBML Header ID: 1A 45 DF A3 at offset 0 -> video/webm
	if (
		buffer.length >= 4 &&
		buffer[0] === 0x1a &&
		buffer[1] === 0x45 &&
		buffer[2] === 0xdf &&
		buffer[3] === 0xa3
	) {
		return "video/webm";
	}

	// ISO BMFF: offset 4..8 is "ftyp" (0x66 0x74 0x79 0x70)
	if (
		buffer.length >= 12 &&
		buffer[4] === 0x66 &&
		buffer[5] === 0x74 &&
		buffer[6] === 0x79 &&
		buffer[7] === 0x70
	) {
		const majorBrand = Buffer.from(buffer.subarray(8, 12)).toString("latin1");
		if (majorBrand === "qt  ") {
			return "video/quicktime";
		}
		return "video/mp4";
	}

	return null;
}

/**
 * Compute the decoded byte length of a base64 string without allocating memory for decoding.
 */
export function base64DecodedBytes(b64: string): number {
	const len = b64.length;
	if (len === 0) return 0;
	let padding = 0;
	if (b64.endsWith("==")) {
		padding = 2;
	} else if (b64.endsWith("=")) {
		padding = 1;
	}
	return Math.max(0, Math.floor((len * 3) / 4) - padding);
}

export interface LoadVideoInputOptions {
	path: string;
	cwd: string;
	maxBytes?: number;
	resolvedPath?: string;
}

export interface LoadedVideoInput {
	resolvedPath: string;
	mimeType: string;
	data: string;
	bytes: number;
}

export async function loadVideoInput(options: LoadVideoInputOptions): Promise<LoadedVideoInput> {
	const maxBytes = options.maxBytes ?? MAX_VIDEO_INPUT_BYTES;
	const resolvedPath = options.resolvedPath ?? resolveReadPath(options.path, options.cwd);

	const stat = await fs.stat(resolvedPath);
	if (stat.size > maxBytes) {
		throw new VideoInputTooLargeError(stat.size, maxBytes);
	}

	const inputBuffer = await fs.readFile(resolvedPath);
	if (inputBuffer.byteLength > maxBytes) {
		throw new VideoInputTooLargeError(inputBuffer.byteLength, maxBytes);
	}

	const mimeType = sniffVideoMimeType(inputBuffer);
	if (!mimeType || !SUPPORTED_VIDEO_MIME_TYPES.has(mimeType)) {
		throw new UnsupportedVideoTypeError(
			`Unsupported video format in "${options.path}"; must be MP4, WebM, or QuickTime`,
			mimeType ?? undefined,
		);
	}

	return {
		resolvedPath,
		mimeType,
		data: Buffer.from(inputBuffer).toString("base64"),
		bytes: inputBuffer.byteLength,
	};
}
