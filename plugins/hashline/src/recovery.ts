/**
 * Recovers stale section tags by proving that every anchored line still maps
 * to one unchanged, contiguous region in the current file, then replaying the
 * edit against that live content.
 *
 * Recovery fails closed when the target changed or became ambiguous. The
 * patcher then returns a mismatch with fresh context instead of guessing.
 */
import { lazy } from "@veyyon/utils/abortable";
import type * as Diff from "diff";
import { applyEdits, collectEditAnchorLines } from "./apply";
import { RECOVERY_EXTERNAL_WARNING, RECOVERY_LINE_REMAP_WARNING, RECOVERY_SESSION_CHAIN_WARNING } from "./messages";
import type { SnapshotStore } from "./snapshots";
import type { ApplyResult, Edit } from "./types";

/** The `diff` package, evaluated on the first recovery rather than when the patcher loads. */
const diffPackage = lazy(() => require("diff") as typeof Diff);

export interface RecoveryArgs {
	path: string;
	currentText: string;
	fileHash: string;
	edits: readonly Edit[];
}

export interface RecoveryResult {
	/** Post-recovery text. */
	text: string;
	/** First changed line (1-indexed) relative to the live `currentText`, or `undefined`. */
	firstChangedLine: number | undefined;
	/** Warnings collected during recovery, including the user-facing recovery banner. */
	warnings: string[];
}

function buildLineMap(previousText: string, currentText: string): Map<number, number> {
	const previousLines = previousText.split("\n");
	const currentLines = currentText.split("\n");
	const changes = diffPackage.value.diffArrays(previousLines, currentLines);
	const map = new Map<number, number>();
	let previousLine = 1;
	let currentLine = 1;

	for (const change of changes) {
		const count = change.value.length;
		if (change.added) {
			currentLine += count;
			continue;
		}
		if (change.removed) {
			previousLine += count;
			continue;
		}
		for (let offset = 0; offset < count; offset++) {
			map.set(previousLine + offset, currentLine + offset);
		}
		previousLine += count;
		currentLine += count;
	}

	return map;
}

/** Values appearing two or more times in `lines`, for O(1) duplicate checks. */
function collectDuplicatedValues(lines: readonly string[]): Set<string> {
	const seen = new Set<string>();
	const duplicated = new Set<string>();
	for (const value of lines) {
		if (seen.has(value)) duplicated.add(value);
		else seen.add(value);
	}
	return duplicated;
}

interface AnchorNeighbors {
	/** Nearest non-anchor line above the anchor's run (`start - 1`), or `undefined` at the file edge. */
	before: number | undefined;
	/** Nearest non-anchor line below the anchor's run (`end + 1`), or `undefined` at the file edge. */
	after: number | undefined;
}

/**
 * Nearest non-anchor context line on each side of every anchor, computed in
 * one sweep over the sorted anchor set. Anchors in one contiguous run share
 * both neighbors (the lines just outside the run), so this replaces the
 * per-anchor directional walk across anchored ranges — O(anchors²) on a
 * large block replacement — with one O(anchors log anchors) pass.
 */
function computeAnchorNeighbors(anchorLines: ReadonlySet<number>, lineCount: number): Map<number, AnchorNeighbors> {
	const sorted = Array.from(anchorLines).sort((a, b) => a - b);
	const neighbors = new Map<number, AnchorNeighbors>();
	for (let i = 0; i < sorted.length; ) {
		let j = i;
		while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1) j++;
		const start = sorted[i];
		const end = sorted[j];
		const before = start - 1 >= 1 && start - 1 <= lineCount ? start - 1 : undefined;
		const after = end + 1 <= lineCount ? end + 1 : undefined;
		for (let k = i; k <= j; k++) neighbors.set(sorted[k], { before, after });
		i = j + 1;
	}
	return neighbors;
}

function validateDuplicateAnchorContext(
	line: number,
	mapped: number,
	neighbors: AnchorNeighbors,
	lineMap: ReadonlyMap<number, number>,
): boolean {
	let checked = false;
	const { before, after } = neighbors;
	if (before !== undefined) {
		checked = true;
		if (lineMap.get(before) !== mapped - (line - before)) return false;
	}
	if (after !== undefined) {
		checked = true;
		if (lineMap.get(after) !== mapped + (after - line)) return false;
	}
	return checked;
}

function validateUniqueAnchorContext(
	line: number,
	mapped: number,
	neighbors: AnchorNeighbors,
	lineMap: ReadonlyMap<number, number>,
): boolean {
	const offset = mapped - line;
	const { before, after } = neighbors;
	if (after !== undefined && lineMap.get(after) === after + offset) return true;
	return before !== undefined && lineMap.get(before) === before + offset;
}

function validateRemappedAnchorContext(
	previousText: string,
	currentText: string,
	lineMap: ReadonlyMap<number, number>,
	edits: readonly Edit[],
): boolean {
	const previousLines = previousText.split("\n");
	const currentLines = currentText.split("\n");
	const anchorLines = new Set(collectEditAnchorLines(edits));
	// Precompute once per validation pass: which line values are duplicated,
	// and each anchor's nearest non-anchor context. The per-anchor forms —
	// indexOf/lastIndexOf full-file scans plus directional walks across
	// anchored ranges — are O(anchors×lines) + O(anchors²) and blow up on
	// large block replacements.
	const duplicatedPrevious = collectDuplicatedValues(previousLines);
	const duplicatedCurrent = collectDuplicatedValues(currentLines);
	const anchorNeighbors = computeAnchorNeighbors(anchorLines, previousLines.length);

	for (const [line, neighbors] of anchorNeighbors) {
		const mapped = lineMap.get(line);
		if (mapped === undefined) return false;
		if (!duplicatedPrevious.has(previousLines[line - 1]) && !duplicatedCurrent.has(currentLines[mapped - 1])) {
			if (!validateUniqueAnchorContext(line, mapped, neighbors, lineMap)) {
				return false;
			}
			continue;
		}
		if (!validateDuplicateAnchorContext(line, mapped, neighbors, lineMap)) {
			return false;
		}
	}

	return true;
}

interface RemappedEdits {
	edits: Edit[];
	offset: number;
}

function remapEditsToCurrent(previousText: string, currentText: string, edits: readonly Edit[]): RemappedEdits | null {
	const lineMap = buildLineMap(previousText, currentText);
	if (!validateRemappedAnchorContext(previousText, currentText, lineMap, edits)) return null;
	const remap = new AnchorRemap(lineMap);
	const remapped: Edit[] = [];
	for (const edit of edits) {
		const mapped = remap.edit(edit);
		if (mapped === null) return null;
		remapped.push(mapped);
	}
	const offset = remap.offset;
	return offset === undefined ? null : { edits: remapped, offset };
}

/**
 * Maps edit anchors from the tagged snapshot to the live text. Every mapped
 * line must move by the same offset; a line with no mapping, or one that moves
 * by a different offset than the first, fails the edit that names it.
 */
class AnchorRemap {
	readonly #lineMap: Map<number, number>;
	/** The shift every mapped line moved by, or `undefined` before the first mapping. */
	offset: number | undefined;

	constructor(lineMap: Map<number, number>) {
		this.#lineMap = lineMap;
	}

	/** `edit` with every anchor moved to the live text, or `null` when one cannot move. */
	edit(edit: Edit): Edit | null {
		if (edit.kind !== "insert") {
			const line = this.#line(edit.anchor.line);
			return line === null ? null : { ...edit, anchor: { line } };
		}
		let blockStart = edit.blockStart;
		if (blockStart !== undefined) {
			const mappedBlockStart = this.#line(blockStart);
			if (mappedBlockStart === null) return null;
			blockStart = mappedBlockStart;
		}
		const cursor = edit.cursor;
		if (cursor.kind !== "before_anchor" && cursor.kind !== "after_anchor") {
			return blockStart === edit.blockStart ? edit : { ...edit, blockStart };
		}
		const line = this.#line(cursor.anchor.line);
		return line === null ? null : { ...edit, cursor: { kind: cursor.kind, anchor: { line } }, blockStart };
	}

	#line(line: number): number | null {
		const mapped = this.#lineMap.get(line);
		if (mapped === undefined) return null;
		const offset = mapped - line;
		this.offset ??= offset;
		return offset === this.offset ? mapped : null;
	}
}

function replayRemappedAnchorsOnCurrent(
	previousText: string,
	currentText: string,
	edits: readonly Edit[],
	recoveryWarning: string,
): RecoveryResult | null {
	const remapped = remapEditsToCurrent(previousText, currentText, edits);
	if (remapped === null) return null;
	let applied: ApplyResult;
	try {
		applied = applyEdits(currentText, remapped.edits);
	} catch {
		// Recovery is an ATTEMPT: null means "these edits could not be replayed onto the current text", which
		// is the same answer a failed remap gives above, and the caller then reports the original conflict to
		// the user rather than a recovery failure. Applying half of them would corrupt the file.
		return null;
	}
	if (applied.text === currentText) return null;
	return {
		text: applied.text,
		firstChangedLine: applied.firstChangedLine,
		warnings: [remapped.offset === 0 ? recoveryWarning : RECOVERY_LINE_REMAP_WARNING, ...(applied.warnings ?? [])],
	};
}
/**
 * Stateless recovery driver over a {@link SnapshotStore}. Construct once and
 * call {@link Recovery.tryRecover} per stale-tag incident.
 *
 * Recovery maps every stale anchor through unchanged lines from the tagged
 * snapshot to the live text, validates surrounding context, and replays the
 * edit directly on live content. All anchors must move by one consistent
 * offset. A changed, deleted, split, or ambiguous target is rejected so the
 * caller can surface a {@link MismatchError} with current context.
 */
export class Recovery {
	constructor(readonly store: SnapshotStore) {}
	/**
	 * Attempt recovery. Returns `null` when no path forward is found — the
	 * caller should then surface a {@link MismatchError}.
	 */
	tryRecover(args: RecoveryArgs): RecoveryResult | null {
		const { path, currentText, fileHash, edits } = args;
		// When retained texts collide on the 16-bit tag, use the latest one.
		// Recovery still requires its anchors and context to map unambiguously.
		const snapshot = this.store.byHash(path, fileHash);
		if (!snapshot) return null;
		const recoveryWarning =
			this.store.head(path) === snapshot ? RECOVERY_EXTERNAL_WARNING : RECOVERY_SESSION_CHAIN_WARNING;
		return replayRemappedAnchorsOnCurrent(snapshot.text, currentText, edits, recoveryWarning);
	}
}
