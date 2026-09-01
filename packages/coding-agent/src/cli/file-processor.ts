import * as fs from "node:fs";
import * as path from "node:path";
import type { ImageContent } from "@veyyon/ai";
import { errorMessage, getProjectDir, isEnoent, readImageMetadata } from "@veyyon/utils";
import chalk from "chalk";
import { CONVERTIBLE_EXTENSIONS } from "../markit/convertible-extensions";
import { resolveReadPath } from "../tools/path-utils";
import { formatBytes } from "../tools/render-utils";
import { formatDimensionNote, resizeImage } from "../utils/image-resize";
import { convertFileWithMarkit } from "../utils/markit";

const MAX_CLI_TEXT_BYTES = 5 * 1024 * 1024; // 5MB
const MAX_CLI_IMAGE_BYTES = 25 * 1024 * 1024; // 25MB

export interface ProcessedFiles {
	text: string;
	images: ImageContent[];
}

export interface ProcessFileOptions {
	autoResizeImages?: boolean;
}

export async function processFileArguments(fileArgs: string[], options?: ProcessFileOptions): Promise<ProcessedFiles> {
	const autoResizeImages = options?.autoResizeImages ?? true;
	let text = "";
	const images: ImageContent[] = [];

	for (const fileArg of fileArgs) {
		const absolutePath = path.resolve(resolveReadPath(fileArg, getProjectDir()));

		const stat = fs.statSync(absolutePath, { throwIfNoEntry: false });
		if (!stat) {
			console.error(chalk.red(`Error: File not found: ${absolutePath}`));
			process.exit(1);
		}

		const imageMetadata = await readImageMetadata(absolutePath);
		const mimeType = imageMetadata?.mimeType;
		const ext = path.extname(absolutePath).toLowerCase();
		const maxBytes = mimeType ? MAX_CLI_IMAGE_BYTES : MAX_CLI_TEXT_BYTES;
		if (stat.size > maxBytes) {
			console.error(
				chalk.yellow(`Warning: Skipping file contents (too large: ${formatBytes(stat.size)}): ${absolutePath}`),
			);
			text += `<file name="${absolutePath}">(skipped: too large, ${formatBytes(stat.size)})</file>\n`;
			continue;
		}

		let buffer: Uint8Array;
		try {
			buffer = await Bun.file(absolutePath).bytes();
		} catch (err) {
			if (isEnoent(err)) {
				console.error(chalk.red(`Error: File not found: ${absolutePath}`));
				process.exit(1);
			}
			throw err;
		}
		if (buffer.length === 0) {
			continue;
		}

		if (mimeType) {
			const base64Content = buffer.toBase64();
			let attachment: ImageContent;
			let dimensionNote: string | undefined;

			if (autoResizeImages) {
				try {
					const resized = await resizeImage({ type: "image", data: base64Content, mimeType });
					dimensionNote = formatDimensionNote(resized);
					attachment = {
						type: "image",
						mimeType: resized.mimeType,
						data: resized.data,
					};
				} catch {
					attachment = {
						type: "image",
						mimeType,
						data: base64Content,
					};
				}
			} else {
				attachment = {
					type: "image",
					mimeType,
					data: base64Content,
				};
			}

			images.push(attachment);

			if (dimensionNote) {
				text += `<file name="${absolutePath}">${dimensionNote}</file>\n`;
			} else {
				text += `<file name="${absolutePath}"></file>\n`;
			}
		} else if (CONVERTIBLE_EXTENSIONS.has(ext)) {
			const result = await convertFileWithMarkit(absolutePath);
			if (result.ok) {
				text += `<file name="${absolutePath}">\n${result.content}\n</file>\n`;
			} else {
				text += `<file name="${absolutePath}">[Cannot read ${ext} file: ${result.error || "conversion failed"}]</file>\n`;
			}
		} else {
			try {
				const content = new TextDecoder().decode(buffer);
				text += `<file name="${absolutePath}">\n${content}\n</file>\n`;
			} catch (error: unknown) {
				const message = errorMessage(error);
				console.error(chalk.red(`Error: Could not read file ${absolutePath}: ${message}`));
				process.exit(1);
			}
		}
	}

	return { text, images };
}
