import * as path from "node:path";
import {
	type ApplyResult,
	applyEdits,
	type Cursor,
	computeFileHash,
	type Edit,
	Patch as HashlinePatch,
	hasAnchorScopedEdit,
	hasBlockEdit,
	MismatchError,
	missingSnapshotTagMessage,
	normalizeToLF,
	type Patch,
	type PatchSection,
	parsePatchStreaming,
	Recovery,
	resolveBlockEdits,
	type SnapshotStore,
	stripBom,
} from "@veyyon/hashline";
import { errorMessage } from "@veyyon/utils";
import { resolveToCwd } from "../../tools/path-utils";
import { generateDiffString } from "../diff";
import { canonicalSnapshotKey } from "../file-snapshot-store";
import { readPreviewText } from "../preview-text-cache";
import { nativeBlockResolver } from "./block-resolver";

export interface HashlineDiffOptions {
	streaming?: boolean;
	skipHashValidation?: boolean;
}

function recoverSectionPathFromTag(
	section: PatchSection,
	authoredAbsolutePath: string,
	snapshots: SnapshotStore,
): string | undefined {
	if (section.fileHash === undefined) return undefined;
	const authoredName = path.basename(section.path);
	const authoredKey = canonicalSnapshotKey(authoredAbsolutePath);
	const candidates = [
		...new Set(
			snapshots
				.findByHash(section.fileHash)
				.filter(snapshot => path.basename(snapshot.path) === authoredName)
				.map(snapshot => snapshot.path),
		),
	].filter(candidate => candidate !== authoredKey);
	return candidates.length === 1 ? candidates[0] : undefined;
}

async function readSectionForPreview(
	section: PatchSection,
	authoredAbsolutePath: string,
	snapshots: SnapshotStore,
	streaming: boolean | undefined,
): Promise<{ absolutePath: string; rawContent: string }> {
	const recovered = (await Bun.file(authoredAbsolutePath).exists())
		? undefined
		: recoverSectionPathFromTag(section, authoredAbsolutePath, snapshots);
	const target = recovered ?? authoredAbsolutePath;
	return { absolutePath: target, rawContent: await readPreviewText(target, section.path, streaming) };
}

function createMismatchError(
	section: PatchSection,
	absolutePath: string,
	normalized: string,
	snapshots: SnapshotStore,
	expected: string,
): MismatchError {
	return new MismatchError({
		path: section.path,
		expectedFileHash: expected,
		actualFileHash: computeFileHash(normalized),
		fileLines: normalized.split("\n"),
		anchorLines: section.collectAnchorLines(),
		hashRecognized: snapshots.byHash(absolutePath, expected) !== null,
	});
}

function parsePreviewEdits(section: PatchSection, streaming: boolean | undefined): readonly Edit[] {
	return streaming ? parsePatchStreaming(section.diff).edits : section.edits;
}

function resolvePreviewEdits(args: {
	section: PatchSection;
	absolutePath: string;
	normalized: string;
	snapshots: SnapshotStore;
	expected: string | undefined;
	liveMatches: boolean;
	edits: readonly Edit[];
}): readonly Edit[] {
	const { section, absolutePath, normalized, snapshots, expected, liveMatches, edits } = args;
	if (!hasBlockEdit(edits)) return edits;
	const baseText = expected === undefined || liveMatches ? normalized : snapshots.byHash(absolutePath, expected)?.text;
	if (baseText === undefined) {
		throw createMismatchError(section, absolutePath, normalized, snapshots, expected ?? "");
	}
	return resolveBlockEdits(edits, baseText, section.path, nativeBlockResolver, { onUnresolved: "throw" });
}

function applyPreviewEdits(args: {
	section: PatchSection;
	absolutePath: string;
	normalized: string;
	snapshots: SnapshotStore;
	options: HashlineDiffOptions;
}): ApplyResult {
	const { section, absolutePath, normalized, snapshots, options } = args;
	const expected = section.fileHash;
	if (!options.skipHashValidation && expected === undefined) {
		throw new Error(missingSnapshotTagMessage(section.path));
	}
	const liveMatches = expected !== undefined && computeFileHash(normalized) === expected;
	const edits = parsePreviewEdits(section, options.streaming);
	const resolved = resolvePreviewEdits({ section, absolutePath, normalized, snapshots, expected, liveMatches, edits });
	if (options.skipHashValidation || expected === undefined || liveMatches) return applyEdits(normalized, resolved);
	if (!hasAnchorScopedEdit(resolved)) return applyEdits(normalized, resolved);

	const recovered = new Recovery(snapshots).tryRecover({
		path: absolutePath,
		currentText: normalized,
		fileHash: expected,
		edits: resolved,
	});
	if (recovered) return recovered;
	throw createMismatchError(section, absolutePath, normalized, snapshots, expected);
}

function insertCursorLine(cursor: Cursor, fileLineCount: number): number {
	switch (cursor.kind) {
		case "bof":
			return 1;
		case "eof":
			return fileLineCount + 1;
		case "before_anchor":
			return cursor.anchor.line;
		case "after_anchor":
			return cursor.anchor.line + 1;
	}
}

function buildStreamingSectionDiff(
	section: PatchSection,
	normalized: string,
): { diff: string; firstChangedLine: number | undefined } | { error: string } {
	const { edits, fileOp } = parsePatchStreaming(section.diff);
	const resolved = resolveBlockEdits(edits, normalized, section.path, nativeBlockResolver, { onUnresolved: "drop" });
	if (resolved.length === 0) {
		if (fileOp) return { diff: "", firstChangedLine: undefined };
		return { error: `No changes would be made to ${section.path}.` };
	}

	const fileLines = normalized.split("\n");
	const rows: string[] = [];
	let firstChangedLine: number | undefined;

	for (let i = 0; i < resolved.length; ) {
		const opLine = resolved[i].lineNum;
		const deletes: number[] = [];
		const inserts: string[] = [];
		let insertBase: number | undefined;
		while (i < resolved.length && resolved[i].lineNum === opLine) {
			const edit = resolved[i];
			if (edit.kind === "delete") deletes.push(edit.anchor.line);
			else if (edit.kind === "insert") {
				insertBase ??= insertCursorLine(edit.cursor, fileLines.length);
				inserts.push(edit.text);
			}
			i++;
		}
		deletes.sort((a, b) => a - b);
		for (const line of deletes) {
			firstChangedLine ??= line;
			const content = line >= 1 && line <= fileLines.length ? fileLines[line - 1] : "";
			rows.push(`-${line}|${content}`);
		}
		let newLine = insertBase ?? deletes[0] ?? 1;
		for (const text of inserts) {
			firstChangedLine ??= newLine;
			rows.push(`+${newLine}|${text}`);
			newLine++;
		}
	}

	if (rows.length === 0) return { error: `No changes would be made to ${section.path}.` };
	return { diff: rows.join("\n"), firstChangedLine };
}

export async function computeHashlineSectionDiff(
	section: PatchSection,
	cwd: string,
	snapshots: SnapshotStore,
	options: HashlineDiffOptions = {},
): Promise<{ diff: string; firstChangedLine: number | undefined } | { error: string }> {
	try {
		const authoredPath = resolveToCwd(section.path, cwd);
		const { absolutePath, rawContent } = await readSectionForPreview(
			section,
			authoredPath,
			snapshots,
			options.streaming,
		);
		const { text: content } = stripBom(rawContent);
		const normalized = normalizeToLF(content);
		if (options.streaming) return buildStreamingSectionDiff(section, normalized);
		const result = applyPreviewEdits({ section, absolutePath, normalized, snapshots, options });
		if (normalized === result.text) {
			if (section.fileOp) return { diff: "", firstChangedLine: undefined };
			return { error: `No changes would be made to ${section.path}.` };
		}
		return generateDiffString(normalized, result.text, undefined, { path: section.path });
	} catch (err) {
		return { error: errorMessage(err) };
	}
}

export async function computeHashlineDiff(
	input: { input: string },
	cwd: string,
	snapshots: SnapshotStore,
	options: HashlineDiffOptions = {},
): Promise<{ diff: string; firstChangedLine: number | undefined } | { error: string }> {
	let patch: Patch;
	try {
		patch = HashlinePatch.parse(input.input, { cwd });
	} catch (err) {
		return { error: errorMessage(err) };
	}
	if (patch.sections.length !== 1) {
		return { error: "Streaming diff preview supports exactly one hashline section." };
	}
	return computeHashlineSectionDiff(patch.sections[0], cwd, snapshots, options);
}
