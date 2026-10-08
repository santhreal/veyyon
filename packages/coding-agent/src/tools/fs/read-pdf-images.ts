/**
 * The images a PDF contains, extracted once into a per-session cache and read as
 * `<file>.pdf:<member>.png`.
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolResult } from "@veyyon/agent-core";
import { formatMoreLines } from "@veyyon/utils/format";
import { isMissingPath } from "@veyyon/utils/fs-error";
import { readImageMetadata } from "@veyyon/utils/mime";
import { isSessionFileName, sessionFileStem } from "@veyyon/utils/session-file";
import type { ToolSession } from "../../sdk";
import { truncateHead } from "../../session/streaming-output";
import { loadImageInput, MAX_IMAGE_INPUT_BYTES, webpExclusionForModel } from "../../utils/image-loading";
import { convertFileWithMarkit } from "../../utils/markit";
import { inlineBudgetFor } from "../core/output-artifact";
import { formatBytes } from "../core/render-utils";
import { ToolError } from "../core/tool-errors";
import { toolResult } from "../core/tool-result";
import { prependSuffixResolutionNotice } from "./read-paths";
import type { ReadContext, ReadToolDetails } from "./read-types";

const PDF_IMAGE_PLACEHOLDER_RE = /<!--\s*image:\s*([^\s<>]+)(.*?)-->/g;
const PDF_IMAGE_MEMBER_RE = /^(.*\.pdf):(.*)$/i;
const PDF_IMAGE_MEMBER_EXTENSION_RE = /\.png$/i;

function pdfImageMemberPath(pdfPath: string, imageId: string): string {
	const member = PDF_IMAGE_MEMBER_EXTENSION_RE.test(imageId) ? imageId : `${imageId}.png`;
	return `${pdfPath}:${member}`;
}

export function rewritePdfImagePlaceholders(markdown: string, pdfPath: string): string {
	return markdown.replace(PDF_IMAGE_PLACEHOLDER_RE, (_match: string, imageId: string, metadataText: string) => {
		const metadata = metadataText.trim();
		const suffix = metadata.length > 0 ? ` (${metadata})` : "";
		return `Image ${imageId}${suffix}: read \`${pdfImageMemberPath(pdfPath, imageId)}\``;
	});
}

export function splitPdfImageMemberReadPath(readPath: string): { pdfPath: string; member: string } | null {
	const match = PDF_IMAGE_MEMBER_RE.exec(readPath);
	if (!match) return null;
	const pdfPath = match[1];
	const member = match[2];
	if (pdfPath === undefined || member === undefined) return null;
	if (member.length !== 0 && !PDF_IMAGE_MEMBER_EXTENSION_RE.test(member)) return null;
	return { pdfPath, member };
}

function pdfImageCacheDir(session: ToolSession, absolutePdfPath: string): string {
	const artifactsDir = session.getArtifactsDir?.();
	let root = artifactsDir ?? undefined;
	if (root === undefined) {
		const sessionFile = session.getSessionFile();
		// `sessionFileStem`, not `slice(0, -6)`: that 6 was the length of ".jsonl" written as a number,
		// which is the same value again in the form a grep for the extension never finds.
		root =
			sessionFile && isSessionFileName(sessionFile)
				? sessionFileStem(sessionFile)
				: path.join(os.tmpdir(), "veyyon-read-pdf-images");
	}
	const basename = path.basename(absolutePdfPath).replace(/[^A-Za-z0-9._-]/g, "_");
	return path.join(root, "read-pdf-images", `${basename}-${Bun.hash(absolutePdfPath).toString(36)}`);
}

async function listPdfImageMembers(imageDir: string): Promise<string[]> {
	try {
		const entries = await fs.readdir(imageDir, { withFileTypes: true });
		const members: string[] = [];
		for (const entry of entries) {
			if (entry.isFile() && PDF_IMAGE_MEMBER_EXTENSION_RE.test(entry.name)) members.push(entry.name);
		}
		return members.sort();
	} catch (error) {
		if (isMissingPath(error)) return [];
		throw error;
	}
}

async function ensurePdfImageCache(
	session: ToolSession,
	absolutePdfPath: string,
	signal?: AbortSignal,
): Promise<string> {
	const imageDir = pdfImageCacheDir(session, absolutePdfPath);
	const markerPath = path.join(imageDir, ".extracted");
	try {
		await fs.stat(markerPath);
		return imageDir;
	} catch (error) {
		if (!isMissingPath(error)) throw error;
	}

	await fs.rm(imageDir, { recursive: true, force: true });
	await fs.mkdir(imageDir, { recursive: true });
	const result = await convertFileWithMarkit(absolutePdfPath, signal, { imageDir });
	if (!result.ok) {
		await fs.rm(imageDir, { recursive: true, force: true });
		throw new ToolError(`Cannot extract images from PDF: ${result.error ?? "conversion failed"}`);
	}
	await Bun.write(markerPath, "ok");
	return imageDir;
}

export async function readPdfImageMember(
	ctx: ReadContext,
	absolutePdfPath: string,
	pdfDisplayPath: string,
	member: string,
	suffixResolution: { from: string; to: string } | undefined,
	signal?: AbortSignal,
): Promise<AgentToolResult<ReadToolDetails>> {
	const imageDir = await ensurePdfImageCache(ctx.session, absolutePdfPath, signal);
	const members = await listPdfImageMembers(imageDir);
	if (member.length === 0) {
		// A scanned document extracts thousands of members, and this list is a
		// tool result: it takes the same budget as a directory or archive
		// listing rather than riding on how many images the file happens to
		// hold.
		const bounded = truncateHead(members.map(entry => `- read \`${pdfDisplayPath}:${entry}\``).join("\n"), {
			maxBytes: inlineBudgetFor(ctx.session),
			maxLines: Number.MAX_SAFE_INTEGER,
		});
		const shown = bounded.content.length === 0 ? 0 : bounded.content.split("\n").length;
		const remaining = members.length - shown;
		const text =
			members.length === 0
				? "No extractable PDF image members found."
				: `Extractable PDF image members:\n${bounded.content}${
						remaining > 0 ? `\n[${formatMoreLines(remaining)} of members; read one of the above to continue]` : ""
					}`;
		return toolResult<ReadToolDetails>({ resolvedPath: absolutePdfPath, suffixResolution })
			.text(prependSuffixResolutionNotice(text, suffixResolution))
			.sourcePath(absolutePdfPath)
			.done();
	}

	if (!members.includes(member)) {
		const available = members.length === 0 ? "(none)" : members.join(", ");
		throw new ToolError(`PDF image member '${member}' not found. Available members: ${available}`);
	}

	const imagePath = path.join(imageDir, member);
	const imageStat = await Bun.file(imagePath).stat();
	if (imageStat.size > MAX_IMAGE_INPUT_BYTES) {
		const sizeStr = formatBytes(imageStat.size);
		const maxStr = formatBytes(MAX_IMAGE_INPUT_BYTES);
		throw new ToolError(`Image file too large: ${sizeStr} exceeds ${maxStr} limit.`);
	}
	const metadata = await readImageMetadata(imagePath);
	const mimeType = metadata?.mimeType;
	if (!mimeType) throw new ToolError(`PDF image member '${member}' is not a supported image.`);
	const imageInput = await loadImageInput({
		path: `${pdfDisplayPath}:${member}`,
		cwd: ctx.session.cwd,
		autoResize: ctx.autoResizeImages,
		maxBytes: MAX_IMAGE_INPUT_BYTES,
		resolvedPath: imagePath,
		detectedMimeType: mimeType,
		excludeWebP: webpExclusionForModel(ctx.session.getActiveModel?.()),
	});
	if (!imageInput) {
		throw new ToolError(`Read image file [${mimeType}] failed: unsupported image format.`);
	}
	const textNote = prependSuffixResolutionNotice(imageInput.textNote, suffixResolution);
	return toolResult<ReadToolDetails>({ resolvedPath: absolutePdfPath, suffixResolution })
		.content([
			{ type: "text", text: textNote },
			{ type: "image", data: imageInput.data, mimeType: imageInput.mimeType },
		])
		.sourcePath(imageInput.resolvedPath)
		.done();
}
