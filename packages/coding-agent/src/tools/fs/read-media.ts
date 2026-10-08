/**
 * Reads of files that are not plain text: images, notebooks, and documents converted to markdown.
 */

import type { AgentToolResult } from "@veyyon/agent-core";
import type { ImageContent, TextContent } from "@veyyon/ai";
import type { ImageMetadata } from "@veyyon/utils/mime";
import { readEditableNotebookText } from "../../edit/notebook";
import type { ToolSession } from "../../sdk";
import {
	ImageInputTooLargeError,
	loadImageInput,
	MAX_IMAGE_INPUT_BYTES,
	webpExclusionForModel,
} from "../../utils/image-loading";
import { convertFileWithMarkit } from "../../utils/markit";
import { formatPathRelativeToCwd, type ParsedSelector } from "../core/path-utils";
import { formatBytes } from "../core/render-utils";
import { ToolError } from "../core/tool-errors";
import { buildInMemoryResult } from "./read-in-memory";
import { rewritePdfImagePlaceholders } from "./read-pdf-images";
import type { ReadContext, ReadToolDetails } from "./read-types";

/**
 * The outcome of converting a document through markit.
 *
 * `unavailable` carries the placeholder text a failed conversion shows, so the caller records the
 * reason on its own details object rather than the converter reaching into it.
 */
type ConvertedDocumentRead =
	| { readonly kind: "result"; readonly result: AgentToolResult<ReadToolDetails> }
	| { readonly kind: "unavailable"; readonly content: Array<TextContent | ImageContent> };

/**
 * Build content blocks for an on-disk image file: an `inspect_image`
 * metadata note when inspection is enabled, otherwise the decoded image
 * block. Shared by the plain-file read path and the `local://` image fast
 * path so both honor `inspect_image.enabled`, the size cap, and auto-resize
 * identically. Too-large / unsupported images surface as {@link ToolError}.
 */
export async function loadImageContent(
	ctx: ReadContext,
	options: {
		readPath: string;
		absolutePath: string;
		mimeType: string;
		imageMetadata: ImageMetadata | null;
		fileSize: number;
	},
): Promise<{ content: Array<TextContent | ImageContent>; details: ReadToolDetails; sourcePath: string }> {
	const { readPath, absolutePath, mimeType, imageMetadata, fileSize } = options;
	if (ctx.inspectImageEnabled) {
		const outputMime = imageMetadata?.mimeType ?? mimeType;
		const metadataLines = [
			"Image metadata:",
			`- MIME: ${outputMime}`,
			`- Bytes: ${fileSize} (${formatBytes(fileSize)})`,
			imageMetadata?.width !== undefined && imageMetadata.height !== undefined
				? `- Dimensions: ${imageMetadata.width}x${imageMetadata.height}`
				: "- Dimensions: unknown",
			imageMetadata?.channels !== undefined ? `- Channels: ${imageMetadata.channels}` : "- Channels: unknown",
			imageMetadata?.hasAlpha === true
				? "- Alpha: yes"
				: imageMetadata?.hasAlpha === false
					? "- Alpha: no"
					: "- Alpha: unknown",
			"",
			`If you want to analyze the image, call inspect_image with path="${formatPathRelativeToCwd(
				absolutePath,
				ctx.session.cwd,
			)}" and a question describing what to inspect and the desired output format.`,
		];
		return { content: [{ type: "text", text: metadataLines.join("\n") }], details: {}, sourcePath: absolutePath };
	}

	if (fileSize > MAX_IMAGE_INPUT_BYTES) {
		const sizeStr = formatBytes(fileSize);
		const maxStr = formatBytes(MAX_IMAGE_INPUT_BYTES);
		throw new ToolError(`Image file too large: ${sizeStr} exceeds ${maxStr} limit.`);
	}
	try {
		const imageInput = await loadImageInput({
			path: readPath,
			cwd: ctx.session.cwd,
			autoResize: ctx.autoResizeImages,
			maxBytes: MAX_IMAGE_INPUT_BYTES,
			resolvedPath: absolutePath,
			detectedMimeType: mimeType,
			excludeWebP: webpExclusionForModel(ctx.session.getActiveModel?.()),
		});
		if (!imageInput) {
			throw new ToolError(`Read image file [${mimeType}] failed: unsupported image format.`);
		}
		return {
			content: [
				{ type: "text", text: imageInput.textNote },
				{ type: "image", data: imageInput.data, mimeType: imageInput.mimeType },
			],
			details: {},
			sourcePath: imageInput.resolvedPath,
		};
	} catch (error) {
		if (error instanceof ImageInputTooLargeError) {
			throw new ToolError(error.message);
		}
		throw error;
	}
}

/** Read a notebook as editable text, honouring a line selector. */
export async function readNotebook(
	session: ToolSession,
	absolutePath: string,
	localReadPath: string,
	parsed: ParsedSelector,
): Promise<AgentToolResult<ReadToolDetails>> {
	const notebookText = await readEditableNotebookText(absolutePath, localReadPath);
	return buildInMemoryResult(session, notebookText, parsed, {
		details: { resolvedPath: absolutePath },
		sourcePath: absolutePath,
		entityLabel: "notebook",
	});
}

/**
 * Convert a document through markit and apply the selector to the converted markdown.
 *
 * The selector applies to the CONVERTED output, so `file.pdf:50-100` reads lines 50-100 of the
 * extracted text rather than the head of the document.
 */
export async function readConvertedDocument(
	session: ToolSession,
	absolutePath: string,
	localReadPath: string,
	ext: string,
	parsed: ParsedSelector,
	signal?: AbortSignal,
): Promise<ConvertedDocumentRead> {
	const result = await convertFileWithMarkit(absolutePath, signal);
	if (!result.ok) {
		return {
			kind: "unavailable",
			content: [{ type: "text", text: `[Cannot read ${ext} file: ${result.error || "conversion failed"}]` }],
		};
	}
	const rendered = ext === ".pdf" ? rewritePdfImagePlaceholders(result.content, localReadPath) : result.content;
	const options = {
		details: { resolvedPath: absolutePath },
		sourcePath: absolutePath,
		entityLabel: "document",
	};
	return {
		kind: "result",
		result: buildInMemoryResult(session, rendered, parsed, options),
	};
}
