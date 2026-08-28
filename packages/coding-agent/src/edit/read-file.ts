/** Shared file-read helper for edit-mode utilities. Reads a file via Bun and rethrows ENOENT as a user-facing "File not found" */
import { hasUtf8Bom } from "@veyyon/hashline";
import { isEnoent } from "@veyyon/utils";
import { isNotebookPath, readEditableNotebookText, serializeEditedNotebookText } from "./notebook";

export async function readEditFileText(absolutePath: string, path: string): Promise<string> {
	try {
		if (isNotebookPath(absolutePath)) return await readEditableNotebookText(absolutePath, path);
		return await Bun.file(absolutePath).text();
	} catch (error) {
		if (isEnoent(error)) {
			throw new Error(`File not found: ${path}`);
		}
		throw error;
	}
}

/** Read an editable file, separating any leading UTF-8 BOM from the content. `readEditFileText` decodes through a text reader (`Bun.file().text()`), which */
export async function readEditFileTextWithBom(
	absolutePath: string,
	path: string,
): Promise<{ bom: string; content: string }> {
	if (isNotebookPath(absolutePath)) {
		return { bom: "", content: await readEditFileText(absolutePath, path) };
	}
	try {
		const bytes = await Bun.file(absolutePath).bytes();
		// TextDecoder (default) consumes a leading BOM, matching Bun.file().text();
		// hasUtf8Bom sniffs the raw bytes so the dropped BOM is recovered.
		return { bom: hasUtf8Bom(bytes) ? "﻿" : "", content: new TextDecoder("utf-8").decode(bytes) };
	} catch (error) {
		if (isEnoent(error)) {
			throw new Error(`File not found: ${path}`);
		}
		throw error;
	}
}

export async function serializeEditFileText(absolutePath: string, path: string, content: string): Promise<string> {
	if (isNotebookPath(absolutePath)) return serializeEditedNotebookText(absolutePath, path, content);
	return content;
}
