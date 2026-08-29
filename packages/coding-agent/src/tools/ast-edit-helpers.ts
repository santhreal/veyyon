import * as path from "node:path";
import { type AstReplaceChange, type AstReplaceFileChange, astEdit } from "@veyyon/natives";
import { type } from "arktype";
import type { OutputMeta } from "./output-meta";
import { expandDelimitedPathEntriesSync } from "./path-utils";

export const DIFF_PREVIEW_MAX_CHARS = 120;

export const astEditOpSchema = type({
	pat: type("string").describe("ast pattern"),
	out: type("string").describe("replacement template"),
});

export const astEditSchema = type({
	ops: astEditOpSchema.array().atLeastLength(1).describe("rewrite ops"),
	paths: type("string")
		.describe("file, directory, glob, or internal URL to rewrite")
		.array()
		.atLeastLength(1)
		.describe("files, directories, globs, or internal URLs to rewrite"),
});

export interface AstEditCallOptions {
	rewrites: Record<string, string>;
	dryRun: boolean;
	maxFiles: number;
	failOnParseError: boolean;
	signal?: AbortSignal;
}

export interface AstEditAggregatedResult {
	changes: AstReplaceChange[];
	fileChanges: AstReplaceFileChange[];
	totalReplacements: number;
	filesTouched: number;
	filesSearched: number;
	applied: boolean;
	limitReached: boolean;
	parseErrors?: string[];
}

async function runAstEditTargets(
	targets: Array<{ basePath: string; glob?: string }>,
	commonBasePath: string,
	options: AstEditCallOptions,
): Promise<AstEditAggregatedResult> {
	const aggregatedChanges: AstReplaceChange[] = [];
	const fileCounts = new Map<string, number>();
	const parseErrors: string[] = [];
	let totalReplacements = 0;
	let filesSearched = 0;
	let limitReached = false;
	let applied = !options.dryRun;
	for (const target of targets) {
		const targetResult = await astEdit({
			rewrites: options.rewrites,
			path: target.basePath,
			glob: target.glob,
			dryRun: options.dryRun,
			maxFiles: options.maxFiles,
			failOnParseError: options.failOnParseError,
			signal: options.signal,
		});
		totalReplacements += targetResult.totalReplacements;
		filesSearched += targetResult.filesSearched;
		limitReached = limitReached || targetResult.limitReached;
		applied = applied && targetResult.applied;
		if (targetResult.parseErrors) {
			for (let pi = 0; pi < targetResult.parseErrors.length; pi++) parseErrors.push(targetResult.parseErrors[pi]!);
		}
		for (const change of targetResult.changes) {
			const absolute = path.resolve(target.basePath, change.path);
			const rebased = path.relative(commonBasePath, absolute).replace(/\\/g, "/");
			aggregatedChanges.push({ ...change, path: rebased });
		}
		for (const fileChange of targetResult.fileChanges) {
			const absolute = path.resolve(target.basePath, fileChange.path);
			const rebased = path.relative(commonBasePath, absolute).replace(/\\/g, "/");
			fileCounts.set(rebased, (fileCounts.get(rebased) ?? 0) + fileChange.count);
		}
	}
	const fileChanges: AstReplaceFileChange[] = Array.from(fileCounts, ([changePath, count]) => ({
		path: changePath,
		count,
	}));
	return {
		changes: aggregatedChanges,
		fileChanges,
		totalReplacements,
		filesTouched: fileChanges.length,
		filesSearched,
		applied,
		limitReached,
		parseErrors: parseErrors.length > 0 ? parseErrors : undefined,
	};
}

export function runAstEditOnce(
	targets: Array<{ basePath: string; glob?: string }> | undefined,
	resolvedSearchPath: string,
	globFilter: string | undefined,
	options: AstEditCallOptions,
): Promise<AstEditAggregatedResult> {
	if (targets) {
		return runAstEditTargets(targets, resolvedSearchPath, options);
	}
	return astEdit({
		rewrites: options.rewrites,
		path: resolvedSearchPath,
		glob: globFilter,
		dryRun: options.dryRun,
		maxFiles: options.maxFiles,
		failOnParseError: options.failOnParseError,
		signal: options.signal,
	});
}

export interface AstEditToolDetails {
	totalReplacements: number;
	filesTouched: number;
	filesSearched: number;
	applied: boolean;
	limitReached: boolean;
	parseErrors?: string[];
	parseErrorsTotal?: number;
	scopePath?: string;
	files?: string[];
	fileReplacements?: Array<{ path: string; count: number }>;
	meta?: OutputMeta;
	displayContent?: string;
	searchPath?: string;
	cwd?: string;
}

export type AstEditSchemaInfer = typeof astEditSchema.infer;

export function astEditFilesystemTargets(args: unknown, cwd = process.cwd()): string[] {
	if (!args || typeof args !== "object" || !("paths" in args)) return [];
	const paths = args.paths;
	if (!Array.isArray(paths)) return [];
	const rawEntries = paths.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0);
	if (rawEntries.length === 0) return [];
	const expanded = expandDelimitedPathEntriesSync(rawEntries, cwd);
	return expanded.filter(entry => entry.trim().length > 0);
}
