/** High-level patch orchestrator. */
import * as path from "node:path";
import { truncate } from "@veyyon/utils/format";
import { applyEdits, collectRewrittenAnchorLines } from "./apply";
import { hasAnchorScopedEdit, hasBlockEdit, resolveBlockEdits } from "./block";
import { computeFileHash, formatHashlineHeader } from "./format";
import type { Filesystem, WriteResult } from "./fs";
import { isNotFound } from "./fs";
import type { Patch, PatchSection } from "./input";
import {
	HEADTAIL_DRIFT_WARNING,
	missingSnapshotTagMessage,
	pathRecoveredFromTagMessage,
	type RevealedLine,
	unseenLinesMessage,
} from "./messages";
import { MismatchError } from "./mismatch";
import {
	detectLineEnding,
	hasUtf8Bom,
	type LineEnding,
	normalizeToLF,
	restoreLineEndings,
	stripBom,
} from "./normalize";
import { Recovery, type RecoveryResult } from "./recovery";
import type { Snapshot, SnapshotStore } from "./snapshots";
import type { ApplyResult, BlockResolution, BlockResolver, Edit, FileOp } from "./types";

/** Maximum unseen anchor lines revealed in rejection error. */
const SEEN_LINE_REVEAL_CAP = 40;

/** Per-revealed-line character limit. */
const SEEN_LINE_REVEAL_MAX_COLUMNS = 512;

export interface PatcherOptions {
	/** Storage backend used for all reads and writes. */
	fs: Filesystem;
	/** Snapshot store that minted and resolves hashline section tags. Required. */
	snapshots: SnapshotStore;
	/** Tree-sitter block resolver. */
	blockResolver?: BlockResolver;
}

/** Per-section result returned by {@link Patcher.apply} / {@link Patcher.commit}. */
export interface PatchSectionResult {
	/** Section path (as authored, after cwd-resolution at parse time). */
	path: string;
	/** Filesystem-canonical key for this section (e.g. absolute path). */
	canonicalPath: string;
	/** `"noop"` when the apply produced no change; `"delete"` removes the file; otherwise `"create"` / `"update"`. */
	op: "create" | "update" | "delete" | "noop";
	/** Pre-edit text (LF-normalized, BOM-stripped). */
	before: string;
	/** Post-edit text (LF-normalized, BOM-stripped). For `"noop"` equals `before`. */
	after: string;
	/** Same text as `after` but with the original BOM and line ending restored. */
	persisted: string;
	/** Final text that the {@link Filesystem} actually wrote (may differ if the FS transformed it). */
	written: string;
	/** 4-hex content-hash tag for `after`. Use to anchor follow-up edits. */
	fileHash: string;
	/** Hashline section header (`[path#tag]`) of the post-edit content. */
	header: string;
	/** 1-indexed first changed line in `after`, or `undefined` for noops. */
	firstChangedLine?: number;
	/** Warnings collected by the parser, applier, and (optionally) recovery. */
	warnings: string[];
	/** Destination path when this section includes `MV DEST`. */
	moveDest?: string;
	/** Resolved spans for replace_block/delete_block ops. */
	blockResolutions?: BlockResolution[];
}

export interface PatcherApplyResult {
	sections: PatchSectionResult[];
}

/** Prepared section token holding parsed state and in-memory apply result. */
export class PreparedSection {
	/** @internal */
	constructor(
		readonly section: PatchSection,
		readonly canonicalPath: string,
		readonly exists: boolean,
		readonly rawContent: string,
		readonly bom: string,
		readonly lineEnding: LineEnding,
		readonly normalized: string,
		readonly applyResult: ApplyResult,
		readonly parseWarnings: readonly string[],
		readonly fileOp: FileOp | undefined,
	) {}

	/** Convenience: returns true when the apply produced no change and no file op. */
	get isNoop(): boolean {
		return this.fileOp === undefined && this.applyResult.text === this.normalized;
	}
}

function assertSectionHashPresent(sectionPath: string, fileHash: string | undefined): void {
	if (fileHash !== undefined) return;
	throw new Error(missingSnapshotTagMessage(sectionPath));
}

function recoveryToApplyResult(result: RecoveryResult): ApplyResult {
	return {
		text: result.text,
		firstChangedLine: result.firstChangedLine,
		warnings: result.warnings,
	};
}
function mergeWarnings(...sources: ReadonlyArray<readonly string[] | undefined>): string[] {
	const out: string[] = [];
	for (const source of sources) {
		if (!source) continue;
		for (const warning of source) out.push(warning);
	}
	return out;
}

/** Assert that no two prepared sections target the same canonical file path. */
export function assertUniqueCanonicalPaths(prepared: readonly PreparedSection[]): void {
	const seen = new Map<string, string>();
	for (const entry of prepared) {
		const previous = seen.get(entry.canonicalPath);
		if (previous !== undefined) {
			throw new Error(
				`Multiple hashline sections resolve to the same file (${previous} and ${entry.section.path}). Merge their ops under one header before applying.`,
			);
		}
		seen.set(entry.canonicalPath, entry.section.path);
	}
}

/** High-level patcher orchestrating filesystem and snapshot store. */
export class Patcher {
	readonly fs: Filesystem;
	readonly snapshots: SnapshotStore;
	readonly recovery: Recovery;
	readonly blockResolver: BlockResolver | undefined;

	constructor(options: PatcherOptions) {
		if (!options.snapshots) {
			throw new Error("Hashline Patcher requires a SnapshotStore; section tags are opaque store pointers.");
		}
		this.fs = options.fs;
		this.snapshots = options.snapshots;
		this.recovery = new Recovery(options.snapshots);
		this.blockResolver = options.blockResolver;
	}

	/** Apply every section in patch. */
	async apply(patch: Patch): Promise<PatcherApplyResult> {
		if (patch.sections.length === 1) {
			const prepared = await this.prepare(patch.sections[0]);
			return { sections: [await this.commit(prepared)] };
		}

		const prepared: PreparedSection[] = [];
		for (const section of patch.sections) prepared.push(await this.prepare(section));
		assertUniqueCanonicalPaths(prepared);
		for (const entry of prepared) {
			if (entry.isNoop) {
				throw new Error(`Edits to ${entry.section.path} resulted in no changes being made.`);
			}
		}

		const results: PatchSectionResult[] = [];
		for (let index = 0; index < prepared.length; index++) {
			try {
				results.push(await this.commit(prepared[index]));
			} catch (error) {
				const written = prepared.slice(0, index).map(entry => entry.section.path);
				const notWritten = prepared.slice(index + 1).map(entry => entry.section.path);
				const message = error instanceof Error ? error.message : String(error);
				throw new Error(
					`Failed to write ${prepared[index].section.path}: ${message}` +
						(written.length > 0 ? ` Sections already written: ${written.join(", ")}.` : "") +
						(notWritten.length > 0 ? ` Sections not written: ${notWritten.join(", ")}.` : ""),
					{ cause: error },
				);
			}
		}
		return { sections: results };
	}

	/** Run preflight pass in memory without writing to filesystem. */
	async preflight(patch: Patch): Promise<void> {
		const prepared: PreparedSection[] = [];
		for (const section of patch.sections) prepared.push(await this.prepare(section));
		assertUniqueCanonicalPaths(prepared);
		for (const entry of prepared) {
			if (entry.isNoop) {
				throw new Error(`Edits to ${entry.section.path} resulted in no changes being made.`);
			}
		}
	}

	/** Read, parse, validate, and apply edits in memory. */
	async prepare(section: PatchSection): Promise<PreparedSection> {
		const parsed = section.parse();
		const parseWarnings = parsed.warnings.slice();
		const fileOp = parsed.fileOp;
		assertSectionHashPresent(section.path, section.fileHash);

		let target = section;
		let canonicalPath = this.fs.canonicalPath(target.path);
		let read = await this.#tryRead(target.path);

		if (!read.exists) {
			const recovered = this.#recoverSectionPathFromTag(target, canonicalPath);
			if (recovered && this.fs.allowTagPathRecovery(target.path, recovered.section.path)) {
				parseWarnings.push(
					pathRecoveredFromTagMessage(target.path, recovered.section.path, target.fileHash as string),
				);
				target = recovered.section;
				canonicalPath = recovered.canonicalPath;
				read = await this.#tryRead(target.path);
			}
		}

		await this.fs.preflightWrite(target.path, { fileOp });

		if (!read.exists) {
			throw new Error(`File not found: ${target.path}. Use the write tool to create new files.`);
		}

		if (fileOp?.kind === "move" && this.fs.canonicalPath(fileOp.dest) === canonicalPath) {
			throw new Error(`MV destination is the same as ${target.path}.`);
		}

		if (fileOp?.kind === "move" && (await this.fs.exists(fileOp.dest))) {
			if (!(await this.fs.isSameExistingFile(target.path, fileOp.dest))) {
				throw new Error(
					`MV destination ${fileOp.dest} already exists; refusing to overwrite it. ` +
						`Edit ${fileOp.dest} directly, or remove it first, then move.`,
				);
			}
		}

		const { bom: bomFromText, text } = stripBom(read.rawContent);
		const bom = bomFromText || (await this.#readBinaryBom(target.path));
		const lineEnding = detectLineEnding(text);
		const normalized = normalizeToLF(text);

		if (fileOp?.kind === "rem") {
			const expected = target.fileHash as string;
			if (computeFileHash(normalized) !== expected) {
				const hashRecognized = this.snapshots.byHash(canonicalPath, expected) !== null;
				throw this.#mismatchError(target, canonicalPath, normalized, expected, hashRecognized);
			}
		}

		const applyResult =
			fileOp?.kind === "rem"
				? this.#applyWithRecovery({
						section: target,
						canonicalPath,
						exists: read.exists,
						normalized,
						edits: [],
					})
				: this.#applyWithRecovery({
						section: target,
						canonicalPath,
						exists: read.exists,
						normalized,
						edits: parsed.edits,
					});

		return new PreparedSection(
			target,
			canonicalPath,
			read.exists,
			read.rawContent,
			bom,
			lineEnding,
			normalized,
			applyResult,
			parseWarnings,
			fileOp,
		);
	}

	/** Resolve missing authored path by matching filename and snapshot tag. */
	#recoverSectionPathFromTag(
		section: PatchSection,
		originalCanonicalPath: string,
	): { section: PatchSection; canonicalPath: string } | null {
		if (section.fileHash === undefined) return null;
		const authoredName = path.basename(section.path);
		const candidates = [
			...new Set(
				this.snapshots
					.findByHash(section.fileHash)
					.filter(snapshot => path.basename(snapshot.path) === authoredName)
					.map(snapshot => snapshot.path),
			),
		].filter(candidate => this.fs.canonicalPath(candidate) !== originalCanonicalPath);
		if (candidates.length !== 1) return null;
		const resolved = candidates[0];
		return { section: section.withPath(resolved), canonicalPath: this.fs.canonicalPath(resolved) };
	}

	/** Commit prepared section to filesystem. */
	async commit(prepared: PreparedSection): Promise<PatchSectionResult> {
		const { section, normalized, bom, lineEnding, parseWarnings, exists, applyResult, canonicalPath, fileOp } =
			prepared;
		const after = applyResult.text;
		const warnings = mergeWarnings(parseWarnings, applyResult.warnings);
		const moveDest = fileOp?.kind === "move" ? fileOp.dest : undefined;
		const resultPath = moveDest ?? section.path;

		if (fileOp?.kind === "rem") {
			await this.fs.delete(section.path);
			this.snapshots.invalidate(canonicalPath);
			return {
				path: section.path,
				canonicalPath,
				op: "delete",
				before: normalized,
				after: normalized,
				persisted: prepared.rawContent,
				written: prepared.rawContent,
				fileHash: computeFileHash(normalized),
				header: formatHashlineHeader(section.path, computeFileHash(normalized)),
				warnings,
			};
		}

		if (after === normalized && moveDest === undefined) {
			const hash = this.#recordFullSnapshot(canonicalPath, normalized);
			return {
				path: section.path,
				canonicalPath,
				op: "noop",
				before: normalized,
				after: normalized,
				persisted: prepared.rawContent,
				written: prepared.rawContent,
				fileHash: hash,
				header: formatHashlineHeader(section.path, hash),
				warnings,
			};
		}

		const persisted = bom + restoreLineEndings(after, lineEnding);

		if (moveDest !== undefined) {
			const destCanonical = this.fs.canonicalPath(moveDest);
			this.snapshots.relocate(canonicalPath, destCanonical);
			await this.fs.move(section.path, moveDest, persisted);
			const fileHash = this.#recordFullSnapshot(destCanonical, after);
			return {
				path: resultPath,
				canonicalPath: destCanonical,
				op: "update",
				before: normalized,
				after,
				persisted,
				written: persisted,
				fileHash,
				header: formatHashlineHeader(moveDest, fileHash),
				firstChangedLine: applyResult.firstChangedLine,
				blockResolutions: applyResult.blockResolutions,
				moveDest,
				warnings,
			};
		}

		const write: WriteResult = await this.fs.writeText(section.path, persisted);
		const fileHash = this.#recordFullSnapshot(canonicalPath, after);
		const op = exists ? "update" : "create";

		return {
			path: section.path,
			canonicalPath,
			op,
			before: normalized,
			after,
			persisted,
			written: write.text,
			fileHash,
			header: formatHashlineHeader(section.path, fileHash),
			firstChangedLine: applyResult.firstChangedLine,
			blockResolutions: applyResult.blockResolutions,
			warnings,
		};
	}

	async #readBinaryBom(path: string): Promise<string> {
		if (!this.fs.readBinary) return "";
		const bytes = await this.fs.readBinary(path);
		return hasUtf8Bom(bytes) ? "\uFEFF" : "";
	}

	async #tryRead(path: string): Promise<{ exists: boolean; rawContent: string }> {
		try {
			const content = await this.fs.readText(path);
			return { exists: true, rawContent: content };
		} catch (error) {
			if (isNotFound(error)) return { exists: false, rawContent: "" };
			throw error;
		}
	}

	#recordFullSnapshot(canonicalPath: string, normalized: string): string {
		return this.snapshots.record(canonicalPath, normalized);
	}

	/** Reject anchored edits referencing lines not seen in snapshot. */
	#assertSeenLines(section: PatchSection, expected: string, matchedSnapshot: Snapshot | null): void {
		const seen = matchedSnapshot?.seenLines;
		if (!seen || seen.size === 0) return;
		const clipped = matchedSnapshot?.clippedLines;
		const rewritten = collectRewrittenAnchorLines(section.edits);
		const unseen = section
			.collectAnchorLines()
			.filter(line => !seen.has(line) && !(clipped?.has(line) === true && !rewritten.has(line)));
		if (unseen.length === 0) return;
		const sourceLines = matchedSnapshot?.text.split("\n") ?? [];
		const revealed: RevealedLine[] = [];
		const revealCount = Math.min(unseen.length, SEEN_LINE_REVEAL_CAP);
		let columnTruncated = false;
		for (let i = 0; i < revealCount; i++) {
			const line = unseen[i];
			if (line < 1 || line > sourceLines.length) continue;
			const source = sourceLines[line - 1] ?? "";
			const clipped =
				source.length > SEEN_LINE_REVEAL_MAX_COLUMNS ? truncate(source, SEEN_LINE_REVEAL_MAX_COLUMNS, "") : source;
			if (clipped === source) {
				revealed.push({ line, text: source });
			} else {
				revealed.push({ line, text: `${clipped}…` });
				columnTruncated = true;
			}
		}
		const overCap = unseen.length > revealed.length;
		const anyUnseenTooWide =
			columnTruncated || unseen.some(line => (sourceLines[line - 1]?.length ?? 0) > SEEN_LINE_REVEAL_MAX_COLUMNS);
		const truncated = overCap || anyUnseenTooWide;
		if (!truncated) {
			for (const { line } of revealed) seen.add(line);
		}
		throw new Error(
			unseenLinesMessage(section.path, unseen, expected, {
				lines: revealed,
				truncated,
				overCap,
				columnClipped: anyUnseenTooWide,
			}),
		);
	}
	#mismatchError(
		section: PatchSection,
		canonicalPath: string,
		normalized: string,
		expected: string,
		hashRecognized: boolean,
	): MismatchError {
		const actualFileHash = this.#recordFullSnapshot(canonicalPath, normalized);
		return new MismatchError({
			path: section.path,
			expectedFileHash: expected,
			actualFileHash,
			fileLines: normalized.split("\n"),
			anchorLines: section.collectAnchorLines(),
			hashRecognized,
		});
	}

	#applyWithRecovery(args: {
		section: PatchSection;
		canonicalPath: string;
		exists: boolean;
		normalized: string;
		edits: readonly Edit[];
	}): ApplyResult {
		const { section, canonicalPath, exists, normalized, edits } = args;
		const expected = exists ? section.fileHash : undefined;
		// Derive snapshot match and verify live hash.
		const storedSnapshotForTag = expected === undefined ? null : this.snapshots.byHash(canonicalPath, expected);
		const liveMatches = expected !== undefined && computeFileHash(normalized) === expected;
		const matchedSnapshot = liveMatches ? this.snapshots.byContent(canonicalPath, normalized) : null;

		const blockResolutions: BlockResolution[] = [];
		const resolveWarnings: string[] = [];
		let resolved: readonly Edit[] = edits;
		if (hasBlockEdit(edits)) {
			const baseText = expected === undefined || liveMatches ? normalized : storedSnapshotForTag?.text;
			if (baseText === undefined) {
				throw this.#mismatchError(section, canonicalPath, normalized, expected ?? "", false);
			}
			resolved = resolveBlockEdits(edits, baseText, section.path, this.blockResolver, {
				onUnresolved: "throw",
				onResolved: resolution => blockResolutions.push(resolution),
				onWarning: warning => resolveWarnings.push(warning),
			});
		}
		const withResolveWarnings = (result: ApplyResult): ApplyResult =>
			resolveWarnings.length === 0 ? result : { ...result, warnings: resolveWarnings.concat(result.warnings ?? []) };

		if (expected === undefined || liveMatches) {
			if (expected !== undefined) this.#assertSeenLines(section, expected, matchedSnapshot);
			const result = applyEdits(normalized, resolved);
			return withResolveWarnings(blockResolutions.length > 0 ? { ...result, blockResolutions } : result);
		}
		if (!hasAnchorScopedEdit(resolved)) {
			const result = applyEdits(normalized, resolved);
			return withResolveWarnings({ ...result, warnings: [HEADTAIL_DRIFT_WARNING, ...(result.warnings ?? [])] });
		}
		const recovered = this.recovery.tryRecover({
			path: canonicalPath,
			currentText: normalized,
			fileHash: expected,
			edits: resolved,
		});
		if (recovered) return withResolveWarnings(recoveryToApplyResult(recovered));
		const hashRecognized = this.snapshots.byHash(canonicalPath, expected) !== null;
		throw this.#mismatchError(section, canonicalPath, normalized, expected, hashRecognized);
	}
}
