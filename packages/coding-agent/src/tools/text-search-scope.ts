import type * as fs from "node:fs";
import { stat } from "node:fs/promises";
import * as path from "node:path";
import type { GrepMatch } from "@veyyon/natives";
import { errorMessage, isEnoent } from "@veyyon/utils";
import {
	isLineInRanges,
	type LineRange,
	parseSearchPathPreferringLiteral,
	resolveReadPath,
	resolveToCwd,
} from "./path-utils";
import { ToolError } from "./tool-errors";

export const NATIVE_GREP_MAX_FILE_BYTES = 4 * 1024 * 1024;

export interface GrepPathSpec {
	original: string;
	clean: string;
	literalFilesystemMatch?: boolean;
	ranges?: [LineRange, ...LineRange[]];
}

/**
 * Returns whether `targetPath` equals `dirPath` or is located inside `dirPath`.
 */
export function isPathInsideDirectory(dirPath: string, targetPath: string): boolean {
	const rel = path.relative(dirPath, targetPath);
	return rel === "" || (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

/**
 * Resolves a match's path against the search root.
 */
export function matchAbsolutePath(matchPath: string, searchPath: string): string {
	if (matchPath === "") return searchPath;
	if (path.isAbsolute(matchPath)) return matchPath;
	return path.resolve(searchPath, matchPath);
}

function matchesSearchGlob(relPath: string, globPattern: string): boolean {
	const normalizedPath = relPath.replace(/\\/g, "/");
	if (path.matchesGlob(normalizedPath, globPattern)) {
		return true;
	}
	if (!globPattern.includes("/")) {
		return path.matchesGlob(normalizedPath, `**/${globPattern}`);
	}
	return false;
}

interface UnrestrictedGlobScope {
	basePath: string;
	globPattern: string;
}

/**
 * Per-file native fetch budget that guarantees the JS range filter can still
 * surface `perFileKeep` in-range hits. Matches arrive one entry per matched
 * line in line order, so a bounded range's hits all sit within the first
 * `endLine` entries, and an open-ended range starting at S is preceded by at
 * most S-1 out-of-range entries — S-1+perFileKeep entries cover the kept
 * window or exhaust the file. Clamped to the native file-size ceiling (a
 * ≤4 MiB file cannot have more matched lines than bytes), which also keeps
 * the scaled global budget inside the native layer's u32 bounds.
 */
export function lineRangeFetchCap(pathSpecs: readonly GrepPathSpec[], perFileKeep: number): number {
	let cap = 0;
	for (const spec of pathSpecs) {
		if (!spec.ranges) continue;
		for (const range of spec.ranges) {
			cap = Math.max(cap, range.endLine ?? range.startLine - 1 + perFileKeep);
		}
	}
	return Math.min(cap, NATIVE_GREP_MAX_FILE_BYTES);
}

function mergeRangesInto(map: Map<string, LineRange[]>, key: string, ranges: readonly LineRange[]): void {
	const existing = map.get(key);
	if (existing) {
		existing.push(...ranges);
	} else {
		map.set(key, [...ranges]);
	}
}

export interface ScopeProvenanceBuildOptions {
	pathSpecs: readonly GrepPathSpec[];
	resolvedPathsByInput: readonly string[];
	virtualInputIndexes: ReadonlySet<number>;
	materializedExternalPaths: ReadonlyMap<string, string>;
	archiveDisplayMap: ReadonlyMap<string, string>;
	cwd: string;
	statPath?: (filePath: string) => Promise<fs.Stats>;
}

/**
 * Manages scope provenance and line-range constraints across multiple search targets.
 *
 * In union semantics:
 * - A target with a line-range selector (e.g. `file:90-100`) is constrained to those lines.
 * - But if the same file is reached through an unrestricted sibling scope (e.g. `.` or `dir` or unrestricted `file`),
 *   the unrestricted scope retains all its matches (union of range and unrestricted is unrestricted).
 */
export class TextSearchScopeProvenance {
	readonly #unrestrictedVirtualPaths = new Set<string>();
	readonly #unrestrictedFiles = new Set<string>();
	readonly #unrestrictedDirs = new Set<string>();
	readonly #unrestrictedGlobs: UnrestrictedGlobScope[] = [];
	readonly #rangedVirtualPaths = new Map<string, LineRange[]>();
	readonly #rangedFiles = new Map<string, LineRange[]>();
	readonly #activeRangedTargets = new Set<string>();

	static async build(opts: ScopeProvenanceBuildOptions): Promise<TextSearchScopeProvenance> {
		const statFn = opts.statPath ?? (p => stat(p));
		const prov = new TextSearchScopeProvenance();

		for (let idx = 0; idx < opts.pathSpecs.length; idx++) {
			const spec = opts.pathSpecs[idx];
			if (!spec) continue;

			const isVirtual = opts.virtualInputIndexes.has(idx);
			const ranges = spec.ranges;

			if (isVirtual) {
				if (ranges) {
					mergeRangesInto(prov.#rangedVirtualPaths, spec.clean, ranges);
				} else {
					prov.#unrestrictedVirtualPaths.add(spec.clean);
				}
				continue;
			}

			const resolved = opts.resolvedPathsByInput[idx];
			if (!resolved) continue;

			const materialized = opts.materializedExternalPaths.get(spec.clean);
			if (materialized) {
				const absMaterialized = path.resolve(materialized);
				if (ranges) {
					mergeRangesInto(prov.#rangedFiles, absMaterialized, ranges);
				} else {
					prov.#unrestrictedFiles.add(absMaterialized);
				}
				continue;
			}

			if (opts.archiveDisplayMap.has(resolved)) {
				const absArchiveScratch = path.resolve(resolved);
				if (ranges) {
					mergeRangesInto(prov.#rangedFiles, absArchiveScratch, ranges);
				} else {
					prov.#unrestrictedFiles.add(absArchiveScratch);
				}
				continue;
			}

			// Non-archive, non-virtual filesystem entry
			const absKey = path.resolve(resolveReadPath(resolved, opts.cwd));
			if (ranges) {
				let stats: fs.Stats;
				try {
					stats = await statFn(absKey);
				} catch (error) {
					if (isEnoent(error)) {
						throw new ToolError(`Path not found for line-range selector: ${spec.original}`);
					}
					throw new ToolError(
						`Could not read path for line-range selector: ${spec.original}: ${errorMessage(error)}`,
					);
				}
				if (!stats.isFile()) {
					throw new ToolError(`Line-range selector requires a single file: ${spec.original} is a directory`);
				}
				mergeRangesInto(prov.#rangedFiles, absKey, ranges);
			} else {
				const parsed = await parseSearchPathPreferringLiteral(resolved, opts.cwd);
				const absBase = path.resolve(resolveToCwd(parsed.basePath, opts.cwd));
				if (parsed.glob) {
					prov.#unrestrictedGlobs.push({
						basePath: absBase,
						globPattern: parsed.glob,
					});
				} else {
					let stats: fs.Stats | undefined;
					try {
						stats = await statFn(absBase);
					} catch {
						stats = undefined;
					}
					if (stats?.isDirectory()) {
						prov.#unrestrictedDirs.add(absBase);
					} else {
						prov.#unrestrictedFiles.add(absBase);
					}
				}
			}
		}

		prov.#reconcileActiveRanges();
		return prov;
	}

	#reconcileActiveRanges(): void {
		for (const [absFile] of this.#rangedFiles) {
			if (!this.isUnrestricted(absFile)) {
				this.#activeRangedTargets.add(absFile);
			}
		}
		for (const [virtualPath] of this.#rangedVirtualPaths) {
			if (!this.isUnrestricted(virtualPath)) {
				this.#activeRangedTargets.add(virtualPath);
			}
		}
	}

	/**
	 * Returns whether the given target (absolute path or virtual path) is covered by an unrestricted scope.
	 */
	isUnrestricted(targetPath: string): boolean {
		if (this.#unrestrictedVirtualPaths.has(targetPath)) return true;
		if (this.#unrestrictedFiles.has(targetPath)) return true;
		for (const dir of this.#unrestrictedDirs) {
			if (isPathInsideDirectory(dir, targetPath)) return true;
		}
		for (const { basePath, globPattern } of this.#unrestrictedGlobs) {
			if (isPathInsideDirectory(basePath, targetPath)) {
				const rel = path.relative(basePath, targetPath).replace(/\\/g, "/");
				if (matchesSearchGlob(rel, globPattern)) return true;
			}
		}
		return false;
	}
	/**
	 * Returns the active line ranges for a given target, or undefined if unrestricted / unconstrained.
	 */
	getRanges(targetPath: string): readonly LineRange[] | undefined {
		if (this.isUnrestricted(targetPath)) return undefined;
		return this.#rangedVirtualPaths.get(targetPath) ?? this.#rangedFiles.get(targetPath);
	}

	/**
	 * Returns whether any targets have active line range constraints remaining.
	 */
	hasActiveLineRangeFilters(): boolean {
		return this.#activeRangedTargets.size > 0;
	}

	/**
	 * Filters search matches according to scope provenance and line-range constraints.
	 */
	filterMatches(matches: readonly GrepMatch[], searchPath: string): GrepMatch[] {
		if (this.#activeRangedTargets.size === 0) {
			return matches.slice();
		}
		const filtered: GrepMatch[] = [];
		for (const match of matches) {
			const abs = matchAbsolutePath(match.path, searchPath);
			const ranges = this.getRanges(abs);
			if (!ranges) {
				filtered.push(match);
				continue;
			}
			if (!isLineInRanges(match.lineNumber, ranges)) {
				continue;
			}
			const trimBefore = match.contextBefore?.filter(c => isLineInRanges(c.lineNumber, ranges));
			const trimAfter = match.contextAfter?.filter(c => isLineInRanges(c.lineNumber, ranges));
			filtered.push({
				...match,
				contextBefore: trimBefore && trimBefore.length > 0 ? trimBefore : undefined,
				contextAfter: trimAfter && trimAfter.length > 0 ? trimAfter : undefined,
			});
		}
		return filtered;
	}
}
