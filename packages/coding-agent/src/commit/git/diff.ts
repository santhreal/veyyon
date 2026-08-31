import type { DiffHunk, FileDiff, FileHunks, NumstatEntry } from "../../commit/types";
import { parseUnifiedHunkHeader } from "../../utils/unified-hunk-header";

export function parseNumstat(output: string): NumstatEntry[] {
	const entries: NumstatEntry[] = [];
	for (const line of output.split("\n")) {
		if (!line.trim()) continue;
		const parts = line.split("\t");
		if (parts.length < 3) continue;
		const [addedRaw, deletedRaw, pathRaw] = parts;
		const additions = Number.parseInt(addedRaw, 10);
		const deletions = Number.parseInt(deletedRaw, 10);
		const path = extractPathFromRename(pathRaw);
		entries.push({
			path,
			additions: Number.isNaN(additions) ? 0 : additions,
			deletions: Number.isNaN(deletions) ? 0 : deletions,
		});
	}
	return entries;
}

export function parseFileDiffs(diff: string): FileDiff[] {
	const sections: FileDiff[] = [];
	const parts = diff.split("\ndiff --git ");
	for (let index = 0; index < parts.length; index += 1) {
		const part = index === 0 ? parts[index] : `diff --git ${parts[index]}`;
		if (!part.trim()) continue;
		const lines = part.split("\n");
		const header = lines[0] ?? "";
		const match = header.match(/diff --git a\/(.+?) b\/(.+)$/);
		if (!match) continue;
		const filename = match[2];
		const content = part;
		const isBinary = lines.some(line => line.startsWith("Binary files "));
		let additions = 0;
		let deletions = 0;
		for (const line of lines) {
			if (line.startsWith("+++") || line.startsWith("---")) continue;
			if (line.startsWith("+")) additions += 1;
			else if (line.startsWith("-")) deletions += 1;
		}
		sections.push({
			filename,
			content,
			additions,
			deletions,
			isBinary,
		});
	}
	return sections;
}

/**
 * Hunks per file for a whole `git diff`. Named for what it returns: `edit/diff.ts` owns a
 * `parseDiffHunks` that answers the apply-patch parser's hunks (with line CONTENT in
 * `oldLines`), and one name serving two incompatible shapes is what made `utils/git.ts`
 * import this one under an alias.
 */
export function parseDiffFileHunks(diff: string): FileHunks[] {
	const files = parseFileDiffs(diff);
	return files.map(file => parseFileHunks(file));
}

export function parseFileHunks(fileDiff: FileDiff): FileHunks {
	if (fileDiff.isBinary) {
		return { filename: fileDiff.filename, isBinary: true, hunks: [] };
	}

	const lines = fileDiff.content.split("\n");
	const hunks: DiffHunk[] = [];
	let current: DiffHunk | null = null;
	let buffer: string[] = [];
	let index = 0;

	for (const line of lines) {
		if (line.startsWith("@@")) {
			if (current) {
				current.content = buffer.join("\n");
				hunks.push(current);
			}
			const headerData = parseUnifiedHunkHeader(line.trimEnd());
			if (!headerData) {
				// Never invent line numbers here. This used to answer `{0, 0, 0, 0}`, which
				// sent every hunk of the file to line zero and made a line-range selection
				// silently select nothing at all (`selectHunks` in `utils/git.ts`).
				throw new Error(`Unrecognized unified diff hunk header for ${fileDiff.filename}: ${line.trim()}`);
			}
			current = {
				index,
				header: line,
				oldStart: headerData.oldStart,
				oldLines: headerData.oldLines,
				newStart: headerData.newStart,
				newLines: headerData.newLines,
				content: "",
			};
			buffer = [line];
			index += 1;
			continue;
		}
		if (current) {
			buffer.push(line);
		}
	}

	if (current) {
		current.content = buffer.join("\n");
		hunks.push(current);
	}

	return {
		filename: fileDiff.filename,
		isBinary: fileDiff.isBinary,
		hunks,
	};
}

/**
 * The single owner of git rename-path normalization. `git diff --numstat` emits
 * a compact rename display: `oldpath => newpath`, or with a common prefix/suffix
 * `prefix/{old => new}/suffix`. This resolves it to the NEW path, preserving the
 * suffix after `}`. Do not re-implement this elsewhere; import it.
 */
export function extractPathFromRename(pathPart: string): string {
	const braceStart = pathPart.indexOf("{");
	if (braceStart !== -1) {
		const arrowPos = pathPart.indexOf(" => ", braceStart);
		if (arrowPos !== -1) {
			const braceEnd = pathPart.indexOf("}", arrowPos);
			if (braceEnd !== -1) {
				// A rename brace can be a mid-path segment, e.g.
				// `src/{old => new}/file.ts`. Keep the prefix before `{`, the new
				// segment inside the brace, AND the suffix after `}` — dropping the
				// suffix returned `src/new` instead of `src/new/file.ts`.
				const prefix = pathPart.slice(0, braceStart);
				const newName = pathPart.slice(arrowPos + 4, braceEnd).trim();
				const suffix = pathPart.slice(braceEnd + 1);
				return `${prefix}${newName}${suffix}`.trim();
			}
		}
	}

	if (pathPart.includes(" => ")) {
		const parts = pathPart.split(" => ");
		return parts[1]?.trim() ?? pathPart.trim();
	}

	return pathPart.trim();
}
