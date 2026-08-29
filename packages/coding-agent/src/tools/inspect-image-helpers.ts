import type { ImageContent } from "@veyyon/ai";
import { type } from "arktype";
import { type LoadedImageInput, loadImageAttachmentInput, MAX_IMAGE_INPUT_BYTES } from "../utils/image-loading";
import { ToolError } from "./tool-errors";

export const inspectImageSchema = type({
	path: type("string").describe("image file path, Image #N label, or attachment://N URI"),
	question: type("string").describe("question about image"),
	"+": "reject",
});

export type InspectImageParams = typeof inspectImageSchema.infer;

export interface ImageAttachmentReference {
	index: number;
}

export const IMAGE_ATTACHMENT_REFERENCE_REGEX =
	/^\s*(?:\[?Image #([1-9]\d*)(?:,[^\]\n]*)?\]?|(?:attachment|image):\/\/([1-9]\d*))\s*$/i;

export function parseImageAttachmentReference(path: string): ImageAttachmentReference | null {
	const match = IMAGE_ATTACHMENT_REFERENCE_REGEX.exec(path);
	if (!match) return null;
	const rawIndex = match[1] ?? match[2];
	if (!rawIndex) return null;
	return { index: Number(rawIndex) };
}

/** Filesystem path this call would read, for the cwd boundary (cwd-boundary.ts). `inspect_image` reads an image FILE from `params.path` (relative to cwd or */
export function inspectImageFilesystemTargets(args: unknown): string[] {
	const raw = (args as { path?: unknown } | null)?.path;
	if (typeof raw !== "string" || raw.trim().length === 0) return [];
	return parseImageAttachmentReference(raw) ? [] : [raw];
}

function formatAvailableImageAttachments(attachments: readonly { label: string; uri: string }[]): string {
	if (attachments.length === 0) return "none";
	return attachments.map(attachment => `${attachment.label} -> ${attachment.uri}`).join(", ");
}

export async function loadAttachmentReferenceInput(options: {
	path: string;
	reference: ImageAttachmentReference;
	attachments: readonly { label: string; uri: string; image: ImageContent }[];
	autoResize: boolean;
	excludeWebP: boolean | undefined;
}): Promise<LoadedImageInput | null> {
	const attachment = options.attachments[options.reference.index - 1];
	if (!attachment) {
		const available = formatAvailableImageAttachments(options.attachments);
		if (options.attachments.length === 0) {
			throw new ToolError(
				`No image attachments are available in this turn. path="${options.path}" must be a readable file path or attachment URI.`,
			);
		}
		throw new ToolError(
			`Could not resolve image attachment '${options.path}'. Available image attachments: ${available}. Pass an attachment URI or a readable filesystem path.`,
		);
	}
	return loadImageAttachmentInput({
		image: attachment.image,
		label: attachment.label,
		uri: attachment.uri,
		autoResize: options.autoResize,
		maxBytes: MAX_IMAGE_INPUT_BYTES,
		excludeWebP: options.excludeWebP,
	});
}

export interface InspectImageToolDetails {
	model: string;
	imagePath: string;
	mimeType: string;
}
