import {
	type AppliedEdit,
	bucketAnchorEditsByLine,
	cloneAppliedEdit,
	dropTrailingPhantomDeletes,
	hasNonWhitespace,
	type IndexedEdit,
	type InsertEdit,
	insertAtEnd,
	insertAtStart,
	isReplacementInsert,
	repairReplacementBoundaries,
	STRUCTURAL_CLOSER_RE,
	validateLineBounds,
} from "./apply-helpers";
import { afterInsertLandingShiftWarning, blockInsertLandingShiftWarning, UNRESOLVED_BLOCK_INTERNAL } from "./messages";
import type { ApplyResult, Edit } from "./types";

export {
	collectEditAnchorLines,
	collectRewrittenAnchorLines,
	editRewritesItsAnchor,
	getEditAnchors,
	STRUCTURAL_CLOSER_RE,
} from "./apply-helpers";

export function leadingIndent(line: string): string {
	let end = 0;
	while (end < line.length) {
		const code = line.charCodeAt(end);
		if (code !== 9 && code !== 32) break;
		end++;
	}
	return line.slice(0, end);
}

export function isIndentDeeper(deeper: string, shallower: string): boolean {
	return deeper.length > shallower.length && deeper.startsWith(shallower);
}

interface AfterInsertGroup {
	anchor: number;
	members: number[];
	blockStart?: number;
}

export function bodyTargetIndent(rows: readonly string[]): string | undefined {
	const nonBlank = rows.filter(hasNonWhitespace);
	if (nonBlank.length === 0) return undefined;
	if (nonBlank.every(row => STRUCTURAL_CLOSER_RE.test(row))) return undefined;
	let target = leadingIndent(nonBlank[0] ?? "");
	for (const row of nonBlank) {
		const indent = leadingIndent(row);
		if (indent.startsWith(target)) continue;
		if (target.startsWith(indent)) target = indent;
		else return undefined;
	}
	return target;
}

function resolveShiftedLanding(
	group: AfterInsertGroup,
	target: string,
	fileLines: readonly string[],
	targetedLines: ReadonlySet<number>,
): { line: number; crossed: number } | undefined {
	const anchorText = fileLines[group.anchor - 1];
	if (anchorText === undefined || !hasNonWhitespace(anchorText)) return undefined;
	if (!isIndentDeeper(leadingIndent(anchorText), target)) return undefined;

	let landing = group.anchor;
	let crossed = 0;
	for (let line = group.anchor + 1; line <= fileLines.length; line++) {
		const text = fileLines[line - 1] ?? "";
		if (!hasNonWhitespace(text)) continue; // look past blanks, never land on them
		if (!STRUCTURAL_CLOSER_RE.test(text)) break; // content is never crossed
		const indent = leadingIndent(text);
		if (!indent.startsWith(target)) break; // shallower than the body — crossing would over-escape
		if (targetedLines.has(line)) return undefined; // another hunk owns this closer
		landing = line;
		crossed++;
		if (indent.length === target.length) break; // depth returned to the body's level
	}
	return landing === group.anchor ? undefined : { line: landing, crossed };
}

function resolveInwardLanding(
	group: AfterInsertGroup,
	target: string,
	blockStart: number,
	fileLines: readonly string[],
	targetedLines: ReadonlySet<number>,
): number | undefined {
	const anchorText = fileLines[group.anchor - 1];
	if (anchorText === undefined || !hasNonWhitespace(anchorText)) return undefined;
	if (!STRUCTURAL_CLOSER_RE.test(anchorText)) return undefined;
	if (!isIndentDeeper(target, leadingIndent(anchorText))) return undefined;

	let landing = group.anchor;
	for (let line = group.anchor; line > blockStart; line--) {
		const text = fileLines[line - 1] ?? "";
		if (!hasNonWhitespace(text)) {
			landing = line - 1; // look past trailing blanks, never land after one
			continue;
		}
		if (!STRUCTURAL_CLOSER_RE.test(text)) break; // content reached — land right after it
		const indent = leadingIndent(text);
		if (!isIndentDeeper(target, indent)) break; // closer at the body's depth — land after it
		if (line !== group.anchor && targetedLines.has(line)) return undefined;
		landing = line - 1;
	}
	return landing === group.anchor ? undefined : landing;
}

function repairAfterInsertLandings(
	edits: readonly AppliedEdit[],
	fileLines: readonly string[],
): { edits: readonly AppliedEdit[]; warnings: string[] } {
	const groups = new Map<string, AfterInsertGroup>();
	edits.forEach((edit, idx) => {
		if (edit.kind !== "insert" || edit.mode === "replacement") return;
		if (edit.cursor.kind !== "after_anchor") return;
		const key = `${edit.cursor.anchor.line}:${edit.lineNum}`;
		const group = groups.get(key);
		if (group === undefined)
			groups.set(key, { anchor: edit.cursor.anchor.line, members: [idx], blockStart: edit.blockStart });
		else group.members.push(idx);
	});
	if (groups.size === 0) return { edits, warnings: [] };

	const targetedLines = new Set<number>();
	for (const edit of edits) {
		if (edit.kind === "delete") targetedLines.add(edit.anchor.line);
		else if (edit.cursor.kind === "before_anchor" || edit.cursor.kind === "after_anchor")
			targetedLines.add(edit.cursor.anchor.line);
	}

	let out: AppliedEdit[] | undefined;
	const warnings: string[] = [];
	const retarget = (group: AfterInsertGroup, line: number): void => {
		out ??= edits.slice();
		for (const idx of group.members) {
			const edit = out[idx] as InsertEdit;
			out[idx] = { ...edit, cursor: { kind: "after_anchor", anchor: { line } } };
		}
	};
	for (const group of groups.values()) {
		const target = bodyTargetIndent(group.members.map(idx => (edits[idx] as InsertEdit).text));
		if (target === undefined) continue;
		const outward = resolveShiftedLanding(group, target, fileLines, targetedLines);
		if (outward !== undefined) {
			retarget(group, outward.line);
			warnings.push(afterInsertLandingShiftWarning(group.anchor, outward.line, outward.crossed));
			continue;
		}
		if (group.blockStart === undefined) continue;
		const inward = resolveInwardLanding(group, target, group.blockStart, fileLines, targetedLines);
		if (inward === undefined) continue;
		retarget(group, inward);
		warnings.push(blockInsertLandingShiftWarning(group.blockStart, group.anchor, inward));
	}
	return { edits: out ?? edits, warnings };
}

export function applyEdits(text: string, edits: readonly Edit[]): ApplyResult {
	if (edits.length === 0) return { text, firstChangedLine: undefined };

	for (const edit of edits) {
		if (edit.kind === "block") throw new Error(UNRESOLVED_BLOCK_INTERNAL);
	}
	const appliedEdits = edits as readonly AppliedEdit[];

	let fileLines = text.split("\n");

	let firstChangedLine: number | undefined;
	const trackFirstChanged = (line: number) => {
		if (firstChangedLine === undefined || line < firstChangedLine) firstChangedLine = line;
	};

	const targetEdits = dropTrailingPhantomDeletes(
		appliedEdits.map((edit, index) => cloneAppliedEdit(edit, index)),
		fileLines,
	);
	validateLineBounds(targetEdits, fileLines);
	const { edits: repaired, warnings: boundaryWarnings } = repairReplacementBoundaries(targetEdits, fileLines);
	const { edits: landed, warnings: landingWarnings } = repairAfterInsertLandings(repaired, fileLines);
	const warnings = boundaryWarnings.concat(landingWarnings);

	const bofLines: string[] = [];
	const eofLines: string[] = [];
	const anchorEdits: IndexedEdit[] = [];
	landed.forEach((edit, idx) => {
		if (edit.kind === "insert" && edit.cursor.kind === "bof") {
			bofLines.push(edit.text);
		} else if (edit.kind === "insert" && edit.cursor.kind === "eof") {
			eofLines.push(edit.text);
		} else {
			anchorEdits.push({ edit, idx });
		}
	});

	const byLine = bucketAnchorEditsByLine(anchorEdits);
	const rebuiltLines: string[] = [];
	for (let idx = 0; idx < fileLines.length; idx++) {
		const line = idx + 1;
		const currentLine = fileLines[idx] ?? "";
		const bucket = byLine.get(line);
		if (!bucket) {
			rebuiltLines.push(currentLine);
			continue;
		}
		bucket.sort((a, b) => a.idx - b.idx);

		const beforeInsertLines: string[] = [];
		const afterInsertLines: string[] = [];
		const replacementLines: string[] = [];
		let deleteLine = false;

		for (const { edit } of bucket) {
			if (isReplacementInsert(edit)) {
				replacementLines.push(edit.text);
			} else if (edit.kind === "insert" && edit.cursor.kind === "after_anchor") {
				afterInsertLines.push(edit.text);
			} else if (edit.kind === "insert") {
				beforeInsertLines.push(edit.text);
			} else if (edit.kind === "delete") {
				deleteLine = true;
			}
		}
		if (
			beforeInsertLines.length === 0 &&
			replacementLines.length === 0 &&
			afterInsertLines.length === 0 &&
			!deleteLine
		) {
			rebuiltLines.push(currentLine);
			continue;
		}

		for (const l of beforeInsertLines) {
			rebuiltLines.push(l);
		}
		for (const l of replacementLines) {
			rebuiltLines.push(l);
		}
		if (!deleteLine) {
			rebuiltLines.push(currentLine);
		}
		for (const l of afterInsertLines) {
			rebuiltLines.push(l);
		}
		trackFirstChanged(line);
	}
	fileLines = rebuiltLines;

	if (bofLines.length > 0) {
		insertAtStart(fileLines, bofLines);
		trackFirstChanged(1);
	}
	const eofChangedLine = insertAtEnd(fileLines, eofLines);
	if (eofChangedLine !== undefined) trackFirstChanged(eofChangedLine);

	return {
		text: fileLines.join("\n"),
		firstChangedLine,
		...(warnings.length > 0 ? { warnings } : {}),
	};
}
