import { applyEdits, collectEditAnchorLines } from "./apply";
import { resolveBlockEdits } from "./block";
import type { RawSection } from "./input-helpers";
import { normalizeHashlinePath, splitRawSections } from "./input-helpers";
import { parsePatch, parsePatchStreaming } from "./parser";
import type { ApplyResult, BlockResolver, Edit, FileOp, SplitOptions } from "./types";

export { containsRecognizableHashlineOperations } from "./input-helpers";

export class PatchSection {
	readonly path: string;
	readonly fileHash: string | undefined;
	readonly diff: string;
	#parsed: { edits: Edit[]; fileOp?: FileOp; warnings: string[] } | undefined;

	constructor(raw: RawSection) {
		this.path = raw.path;
		this.fileHash = raw.fileHash;
		this.diff = raw.diff;
	}

	parse(): { edits: Edit[]; fileOp?: FileOp; warnings: readonly string[] } {
		this.#parsed ??= parsePatch(this.diff);
		const parsed = this.#parsed;
		const fileOp =
			parsed.fileOp === undefined
				? undefined
				: parsed.fileOp.kind === "move"
					? { kind: "move" as const, dest: normalizeHashlinePath(parsed.fileOp.dest) }
					: parsed.fileOp;
		return fileOp === parsed.fileOp
			? parsed
			: { edits: parsed.edits, ...(fileOp === undefined ? {} : { fileOp }), warnings: parsed.warnings };
	}

	get edits(): readonly Edit[] {
		return this.parse().edits;
	}

	get fileOp(): FileOp | undefined {
		return this.parse().fileOp;
	}

	collectAnchorLines(): readonly number[] {
		return Array.from(new Set(collectEditAnchorLines(this.edits))).sort((a, b) => a - b);
	}

	applyTo(text: string, blockResolver?: BlockResolver): ApplyResult {
		const { edits, warnings } = this.parse();
		const resolveWarnings: string[] = [];
		const resolved = resolveBlockEdits(edits, text, this.path, blockResolver, {
			onUnresolved: "throw",
			onWarning: warning => resolveWarnings.push(warning),
		});
		const result = applyEdits(text, resolved);
		const merged = warnings.concat(resolveWarnings, result.warnings ?? []);
		return merged.length > 0
			? { ...result, warnings: merged }
			: { text: result.text, firstChangedLine: result.firstChangedLine };
	}

	applyPartialTo(text: string, blockResolver?: BlockResolver): ApplyResult {
		const { edits, warnings } = parsePatchStreaming(this.diff);
		const resolveWarnings: string[] = [];
		const resolved = resolveBlockEdits(edits, text, this.path, blockResolver, {
			onUnresolved: "drop",
			onWarning: warning => resolveWarnings.push(warning),
		});
		const result = applyEdits(text, resolved);
		const merged = warnings.concat(resolveWarnings, result.warnings ?? []);
		return merged.length > 0
			? { ...result, warnings: merged }
			: { text: result.text, firstChangedLine: result.firstChangedLine };
	}

	withPath(path: string): PatchSection {
		const next = new PatchSection({
			path,
			...(this.fileHash !== undefined ? { fileHash: this.fileHash } : {}),
			diff: this.diff,
		});
		next.#parsed = this.#parsed;
		return next;
	}
}

export class Patch {
	readonly sections: readonly PatchSection[];

	private constructor(sections: PatchSection[]) {
		this.sections = sections;
	}

	static parse(input: string, options: SplitOptions = {}): Patch {
		const raw = mergeSamePathSections(splitRawSections(input, options));
		return new Patch(raw.map(section => new PatchSection(section)));
	}

	static parseSingle(input: string, options: SplitOptions = {}): PatchSection {
		const patch = Patch.parse(input, options);
		const first = patch.sections[0];
		if (!first) throw new Error("Patch input did not produce any sections.");
		return first;
	}
}

function mergeSamePathSections(sections: RawSection[]): RawSection[] {
	const byPath = new Map<string, { fileHash?: string; diffs: string[] }>();
	for (const section of sections) {
		const existing = byPath.get(section.path);
		if (existing) {
			if (
				existing.fileHash !== undefined &&
				section.fileHash !== undefined &&
				existing.fileHash !== section.fileHash
			) {
				throw new Error(
					`Conflicting hashline snapshot tags for ${section.path}: #${existing.fileHash} and #${section.fileHash}. Re-read the file and retry with one current header.`,
				);
			}
			if (existing.fileHash === undefined && section.fileHash !== undefined) existing.fileHash = section.fileHash;
			existing.diffs.push(section.diff);
			continue;
		}
		byPath.set(section.path, {
			...(section.fileHash !== undefined ? { fileHash: section.fileHash } : {}),
			diffs: [section.diff],
		});
	}
	return Array.from(byPath, ([sectionPath, entry]) => ({
		path: sectionPath,
		...(entry.fileHash !== undefined ? { fileHash: entry.fileHash } : {}),
		diff: entry.diffs.join("\n"),
	}));
}
