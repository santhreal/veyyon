// The one place the runtime-cache lifecycle lives: resolve a folder to its
// project, read the immutable cache entry for the current repository state, or
// generate it once when missing. A harness calls this and does no orchestration
// of its own — it supplies only the two things Argot cannot do itself (run git)
// and the machine path where entries are stored. Everything that decides which
// dictionary a repository state gets — how the corpus is gathered, how the cache
// is keyed, when it regenerates — lives here so every harness behaves identically.

import { createHash } from "node:crypto";
import { cacheDictPath, listingSignature, readDictFile, resolveProjectCache } from "./cache.js";
import { DEFAULT_TOKEN_BUDGET } from "./constants.js";
import { type CorpusNotice, gatherRepoFiles, walkProjectTree } from "./corpus.js";
import { projectCacheId, resolveProjectRoot } from "./project.js";
import type { Vocabulary } from "./types.js";

/**
 * The git access a harness provides, the only capability Argot cannot supply
 * itself: `git rev-parse HEAD` and `git ls-files` (which respects `.gitignore`).
 * Both return `null` for a folder that is not a git repository; Argot then treats
 * it as a non-git project and walks the tree itself.
 */
export interface ProjectVocabIO {
	/** The current commit sha for a repo root, or `null` when it is not a git repo. */
	gitHead(root: string, signal?: AbortSignal): Promise<string | null>;
	/** Tracked repo-relative paths (`git ls-files`) for a root, or `null` when not a git repo. */
	listTrackedFiles(root: string, signal?: AbortSignal): Promise<string[] | null>;
}

/** A recall-preserving degrade or a misconfiguration Argot surfaced for the harness to log. */
export type ProjectVocabNotice =
	| CorpusNotice
	| {
			code: "invalid-token-budget";
			message: string;
			data: { configured: unknown; using: number };
	  };

export interface ResolveProjectVocabOptions {
	/** The folder the agent is working in; resolved up to its nearest project root. */
	folder: string;
	/** Where cache entries live on this machine (a harness-owned path). */
	cacheDir: string;
	/** Git access the harness provides; Argot cannot run git itself. */
	io: ProjectVocabIO;
	/** Dictionary token budget. Omitted or invalid uses {@link DEFAULT_TOKEN_BUDGET}. */
	tokenBudget?: number;
	/**
	 * Sink for notices Argot must not swallow: a reached content budget, a
	 * truncated or partially-unreadable non-git project tree (see
	 * {@link CorpusNotice}), or an invalid budget. A harness should wire this to its
	 * logger so no degrade is silent.
	 */
	onNotice?: (notice: ProjectVocabNotice) => void;
	signal?: AbortSignal;
}

export interface ResolvedProjectVocab {
	/** The resolved project root the vocabulary is scoped to. */
	root: string;
	/** The vocabulary to arm (possibly zero handles for a project that yields none). */
	vocab: Vocabulary;
}

/**
 * Validate an operator-supplied token budget. A finite positive number is used
 * verbatim (floored). Anything else (0, negative, NaN, a non-number from a
 * hand-edited config) is a misconfiguration, not a silent no-op: it is surfaced
 * through `onNotice` and the default is used, so a bad value never quietly yields
 * an empty dictionary.
 */
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

/**
 * Fold the effective token budget into the cache signature. A cache entry is a
 * pure function of the repository state AND the generation options that shape the
 * dictionary, so the budget must be part of the key: two budgets over the same
 * repo state are two different dictionaries and must not alias to one entry. The
 * default budget maps to the bare signature, so entries generated under the
 * default (the common case) keep their plain `<sig>.dict` name and existing
 * caches still hit; a non-default budget derives a distinct signature.
 */
export function budgetKeyedSignature(rawSig: string, tokenBudget: number): string {
	if (tokenBudget === DEFAULT_TOKEN_BUDGET) return rawSig;
	return createHash("sha256").update(`${rawSig}\0tokenBudget=${tokenBudget}`).digest("hex").slice(0, 32);
}

/**
 * Resolve a folder to its project root and produce that root's vocabulary,
 * reading the immutable cache entry when present and generating it (once, keyed
 * by content signature) when not.
 *
 * - **Git project** (`io.gitHead` returns a sha): the HEAD is the content
 *   signature. The immutable entry is tried before any listing, so an unchanged
 *   repo at an unchanged budget arms with no `git ls-files` at all. On a miss the
 *   tracked listing is gathered with bounded content and generated.
 * - **Non-git project** (`io.gitHead` returns `null`, folder has a `.argot`
 *   marker): Argot walks the tree itself and keys on a signature of the listing
 *   and its content.
 *
 * Returns the resolved root and its vocabulary, or `undefined` when `folder` has
 * no `.git`/`.argot` marker and so is not a project the cache is scoped to (a
 * normal "nothing to arm" answer, not an error).
 */
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
	return { root, vocab: result.vocab };
}
