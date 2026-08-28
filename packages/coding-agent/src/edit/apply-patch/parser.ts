import { ParseError } from "../diff";
import type { PatchInput } from "../modes/patch";

import {
	ADD_FILE_MARKER,
	BEGIN_PATCH_MARKER,
	DELETE_FILE_MARKER,
	END_PATCH_MARKER,
	FILE_OP_MARKERS,
	MOVE_TO_MARKER,
	UPDATE_FILE_MARKER,
} from "./markers";

interface ParseApplyPatchOptions {
	streaming?: boolean;
}

function markerPath(line: string, markerLength: number): string {
	return line.slice(markerLength).trim();
}

function requireMarkerPath(line: string, markerLength: number, lineNumber: number, streaming: boolean): string {
	const path = markerPath(line, markerLength);
	if (path.length === 0 && !streaming) {
		throw new ParseError(invalidHunkHeaderMessage(line), lineNumber);
	}
	return path;
}

function invalidHunkHeaderMessage(line: string): string {
	return `'${line}' is not a valid hunk header. Valid hunk headers: '*** Add File: {path}', '*** Delete File: {path}', '*** Update File: {path}'`;
}

export function parseApplyPatch(patchText: string): PatchInput[] {
	return parseApplyPatchWithOptions(patchText, {});
}

export function parseApplyPatchStreaming(patchText: string): PatchInput[] {
	return parseApplyPatchWithOptions(patchText, { streaming: true });
}

function parseApplyPatchWithOptions(patchText: string, options: ParseApplyPatchOptions): PatchInput[] {
	const streaming = options.streaming === true;
	let lines = patchText.trim().split("\n");

	if (lines.length >= 2) {
		const first = lines[0];
		const last = lines[lines.length - 1].trim();
		const validOpeners = new Set(["<<EOF", "<<'EOF'", '<<"EOF"']);
		if (validOpeners.has(first) && last === "EOF") {
			lines = lines.slice(1, lines.length - 1);
		}
	}

	if (lines.length === 0 || lines[0].trim() !== BEGIN_PATCH_MARKER) {
		if (streaming) return [];
		throw new ParseError("The first line of the patch must be '*** Begin Patch'");
	}
	const hasEndMarker = lines[lines.length - 1].trim() === END_PATCH_MARKER;
	if (!hasEndMarker && !streaming) {
		throw new ParseError("The last line of the patch must be '*** End Patch'");
	}

	const hunks: PatchInput[] = [];
	let remaining = hasEndMarker ? lines.slice(1, lines.length - 1) : lines.slice(1);
	let lineNumber = 2;

	while (remaining.length > 0) {
		if (remaining[0].trim() === "") {
			remaining = remaining.slice(1);
			lineNumber++;
			continue;
		}

		const firstLine = remaining[0].trim();

		if (firstLine.startsWith(ADD_FILE_MARKER)) {
			const path = requireMarkerPath(firstLine, ADD_FILE_MARKER.length, lineNumber, streaming);
			let contents = "";
			let consumed = 1;

			for (let i = 1; i < remaining.length; i++) {
				const line = remaining[i];
				if (line.startsWith("+")) {
					contents += `${line.slice(1)}\n`;
					consumed++;
				} else {
					break;
				}
			}

			hunks.push({ path, op: "create", diff: contents });
			remaining = remaining.slice(consumed);
			lineNumber += consumed;
			continue;
		}

		if (firstLine.startsWith(DELETE_FILE_MARKER)) {
			const path = requireMarkerPath(firstLine, DELETE_FILE_MARKER.length, lineNumber, streaming);
			hunks.push({ path, op: "delete" });
			remaining = remaining.slice(1);
			lineNumber++;
			continue;
		}

		if (firstLine.startsWith(UPDATE_FILE_MARKER)) {
			const path = requireMarkerPath(firstLine, UPDATE_FILE_MARKER.length, lineNumber, streaming);
			remaining = remaining.slice(1);
			lineNumber++;

			let movePath: string | undefined;
			if (remaining.length > 0 && remaining[0].startsWith(MOVE_TO_MARKER)) {
				movePath = markerPath(remaining[0], MOVE_TO_MARKER.length);
				if (movePath.length === 0 && !streaming) {
					throw new ParseError("'*** Move to:' is missing a destination path", lineNumber);
				}
				remaining = remaining.slice(1);
				lineNumber++;
			}

			const diffLines: string[] = [];
			while (remaining.length > 0) {
				const line = remaining[0];
				if (FILE_OP_MARKERS.some(marker => line.startsWith(marker))) {
					break;
				}
				diffLines.push(line);
				remaining = remaining.slice(1);
				lineNumber++;
			}

			if (diffLines.length === 0) {
				if (streaming) {
					hunks.push({ path, op: "update", rename: movePath, diff: "" });
					continue;
				}
				throw new ParseError(`Update file hunk for path '${path}' is empty`, lineNumber);
			}

			hunks.push({ path, op: "update", rename: movePath, diff: diffLines.join("\n") });
			continue;
		}

		if (streaming) {
			break;
		}
		throw new ParseError(invalidHunkHeaderMessage(firstLine), lineNumber);
	}

	return hunks;
}
