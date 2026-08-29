import * as fs from "node:fs/promises";
import * as path from "node:path";
import { type AstFindMatch, astGrep } from "@veyyon/natives";
import { type } from "arktype";
import type { OutputMeta } from "./output-meta";
import { throwIfAborted } from "./tool-errors";

export const astGrepSchema = type({
	pat: type("string").describe("ast pattern"),
	"path?": type("string").describe(
		'file, directory, glob, or internal URL to search; pass several as a semicolon-delimited list ("src; tests"). Omitted -> searches the workspace root (".")',
	),
	"skip?": type("number").describe("matches to skip"),
});

export function compareAstFindMatch(left: AstFindMatch, right: AstFindMatch): number {
	const pathCmp = left.path.localeCompare(right.path);
	if (pathCmp !== 0) return pathCmp;
	if (left.startLine !== right.startLine) return left.startLine - right.startLine;
	if (left.startColumn !== right.startColumn) return left.startColumn - right.startColumn;
	if (left.endLine !== right.endLine) return left.endLine - right.endLine;
	if (left.endColumn !== right.endColumn) return left.endColumn - right.endColumn;
	if (left.byteStart !== right.byteStart) return left.byteStart - right.byteStart;
	return left.byteEnd - right.byteEnd;
}

export function retainAstFindMatch(matches: AstFindMatch[], capacity: number, candidate: AstFindMatch): void {
	if (matches.length < capacity) {
		matches.push(candidate);
		return;
	}
	let worstIndex = 0;
	for (let index = 1; index < matches.length; index++) {
		if (compareAstFindMatch(matches[index]!, matches[worstIndex]!) > 0) {
			worstIndex = index;
		}
	}
	if (compareAstFindMatch(candidate, matches[worstIndex]!) < 0) {
		matches[worstIndex] = candidate;
	}
}

export async function runMultiTargetAstGrep(
	targets: Array<{ basePath: string; glob?: string }>,
	options: { patterns: string[]; commonBasePath: string; skip: number; limit: number; signal?: AbortSignal },
): Promise<{
	matches: AstFindMatch[];
	totalMatches: number;
	filesWithMatches: number;
	filesSearched: number;
	limitReached: boolean;
	parseErrors?: string[];
}> {
	const retainedMatches: AstFindMatch[] = [];
	const seenMatchKeys = new Set<string>();
	const seenFilesWithMatches = new Set<string>();
	const retainedCapacity = options.skip + options.limit + 1;
	const parseErrors: string[] = [];
	let totalMatches = 0;
	let filesWithMatches = 0;
	let filesSearched = 0;
	let limitReached = false;
	throwIfAborted(options.signal, "ast_grep");
	const targetStats = await Promise.all(
		targets.map(async target => {
			const resolvedBase = path.resolve(target.basePath);
			const isFile = await fs
				.stat(resolvedBase)
				.then(stat => stat.isFile())
				.catch(() => false);
			return { basePath: resolvedBase, isFile };
		}),
	);
	const settled = await Promise.allSettled(
		targets.map(target =>
			astGrep({
				patterns: options.patterns,
				path: target.basePath,
				glob: target.glob,
				offset: 0,
				limit: options.skip + options.limit + 1,
				includeMeta: true,
				signal: options.signal,
			}),
		),
	);
	for (const [targetIndex, outcome] of settled.entries()) {
		if (outcome.status === "rejected") throw outcome.reason;
		const targetInfo = targetStats[targetIndex]!;
		const targetResult = outcome.value;
		const targetSeenFiles = new Set<string>();
		totalMatches += targetResult.totalMatches;
		filesWithMatches += targetResult.filesWithMatches;
		filesSearched += targetResult.filesSearched;
		limitReached = limitReached || targetResult.limitReached;
		if (targetResult.parseErrors) {
			for (let pi = 0; pi < targetResult.parseErrors.length; pi++) parseErrors.push(targetResult.parseErrors[pi]!);
		}
		for (const match of targetResult.matches) {
			const absolute = targetInfo.isFile ? targetInfo.basePath : path.resolve(targetInfo.basePath, match.path);
			const matchKey = `${absolute}\0${match.startLine}\0${match.startColumn}`;
			if (seenMatchKeys.has(matchKey)) {
				totalMatches = Math.max(0, totalMatches - 1);
				if (seenFilesWithMatches.has(absolute) && !targetSeenFiles.has(absolute)) {
					filesWithMatches = Math.max(0, filesWithMatches - 1);
					targetSeenFiles.add(absolute);
				}
				continue;
			}
			seenMatchKeys.add(matchKey);
			if (!seenFilesWithMatches.has(absolute)) {
				seenFilesWithMatches.add(absolute);
				targetSeenFiles.add(absolute);
			}
			const rebased = path.relative(options.commonBasePath, absolute).replace(/\\/g, "/");
			retainAstFindMatch(retainedMatches, retainedCapacity, { ...match, path: rebased });
		}
	}
	retainedMatches.sort(compareAstFindMatch);
	const visible = retainedMatches.slice(options.skip);
	const paged = visible.slice(0, options.limit);
	return {
		matches: paged,
		totalMatches,
		filesWithMatches,
		filesSearched,
		limitReached: limitReached || visible.length > options.limit,
		parseErrors: parseErrors.length > 0 ? parseErrors : undefined,
	};
}

export interface AstGrepToolDetails {
	matchCount: number;
	fileCount: number;
	filesSearched: number;
	limitReached: boolean;
	parseErrors?: string[];
	parseErrorsTotal?: number;
	scopePath?: string;
	files?: string[];
	fileMatches?: Array<{ path: string; count: number }>;
	meta?: OutputMeta;
	displayContent?: string;
	searchPath?: string;
	cwd?: string;
}
