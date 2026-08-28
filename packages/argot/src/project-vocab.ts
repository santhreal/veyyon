import { createHash } from "node:crypto";
import { cacheDictPath, listingSignature, type ResolvedCache, readDictFile, resolveProjectCache } from "./cache.js";
import { DEFAULT_TOKEN_BUDGET, GENERATOR_REVISION } from "./constants.js";
import { type CorpusNotice, gatherRepoFiles, walkProjectTree } from "./corpus.js";
import { projectCacheId, resolveProjectRoot } from "./project.js";
import type { Vocabulary } from "./types.js";

export interface ProjectVocabIO {
	gitHead(root: string, signal?: AbortSignal): Promise<string | null>;
	listTrackedFiles(root: string, signal?: AbortSignal): Promise<string[] | null>;
}

export type ProjectVocabNotice =
	| CorpusNotice
	| {
			code: "invalid-token-budget";
			message: string;
			data: { configured: unknown; using: number };
	  }
	| {
			code: "cache-write-failed";
			message: string;
			data: { path: string; error: string };
	  };

export interface ResolveProjectVocabOptions {
	folder: string;
	cacheDir: string;
	io: ProjectVocabIO;
	tokenBudget?: number;
	onNotice?: (notice: ProjectVocabNotice) => void;
	signal?: AbortSignal;
}

export interface ResolvedProjectVocab {
	root: string;
	vocab: Vocabulary;
}

export function resolveTokenBudget(raw: number | undefined, onNotice?: (n: ProjectVocabNotice) => void): number {
	if (raw === undefined) return DEFAULT_TOKEN_BUDGET;
	if (Number.isFinite(raw) && raw > 0) return Math.floor(raw);
	onNotice?.({
		code: "invalid-token-budget",
		message: "argot: token budget must be a positive number; using the default",
		data: { configured: raw, using: DEFAULT_TOKEN_BUDGET },
	});
	return DEFAULT_TOKEN_BUDGET;
}

function reportCacheWriteFailure(result: ResolvedCache, onNotice?: (n: ProjectVocabNotice) => void): void {
	if (result.writeError === undefined) return;
	onNotice?.({
		code: "cache-write-failed",
		message: result.writeError,
		data: { path: result.path, error: result.writeError },
	});
}

export function budgetKeyedSignature(rawSig: string, tokenBudget: number): string {
	if (tokenBudget === DEFAULT_TOKEN_BUDGET && GENERATOR_REVISION === 1) return rawSig;
	return createHash("sha256")
		.update(`${rawSig}\0tokenBudget=${tokenBudget}\0generator=${GENERATOR_REVISION}`)
		.digest("hex")
		.slice(0, 32);
}

export async function resolveProjectVocab(
	options: ResolveProjectVocabOptions,
): Promise<ResolvedProjectVocab | undefined> {
	const root = resolveProjectRoot(options.folder);
	if (root === undefined) return undefined;

	const tokenBudget = resolveTokenBudget(options.tokenBudget, options.onNotice);
	const cacheId = projectCacheId(root);
	const head = await options.io.gitHead(root, options.signal);

	if (head !== null) {
		const sig = budgetKeyedSignature(head, tokenBudget);
		const cached = await readDictFile(cacheDictPath(options.cacheDir, cacheId, sig));
		if (cached !== undefined) return { root, vocab: cached };

		const paths = await options.io.listTrackedFiles(root, options.signal);
		if (paths === null) {
			throw new Error(
				`argot: gitHead reported a git repo at ${root}, but listTrackedFiles returned null; the harness's git access is inconsistent`,
			);
		}
		const files = await gatherRepoFiles(root, paths, options.onNotice);
		const result = await resolveProjectCache({
			baseDir: options.cacheDir,
			cacheId,
			contentSig: sig,
			files,
			options: { tokenBudget },
		});
		reportCacheWriteFailure(result, options.onNotice);
		return { root, vocab: result.vocab };
	}

	const paths = await walkProjectTree(root, options.onNotice);
	const files = await gatherRepoFiles(root, paths, options.onNotice);
	const contentSig = budgetKeyedSignature(listingSignature(files), tokenBudget);
	const result = await resolveProjectCache({
		baseDir: options.cacheDir,
		cacheId,
		contentSig,
		files,
		options: { tokenBudget },
	});
	reportCacheWriteFailure(result, options.onNotice);
	return { root, vocab: result.vocab };
}
