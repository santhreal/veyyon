// Building the corpus the generator learns from: which project files to read,
// how much of each, and how to keep it bounded and deterministic. This is codec
// quality, not harness plumbing — the generator ranks a handle by how central a
// string is (how many distinct files reference it), so what content it sees
// decides which handles exist. Every harness must gather the corpus the SAME
// way or its dictionaries diverge, so the policy lives here, once, and a harness
// supplies only the raw file access it owns (git, the filesystem).

import type { Dirent } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { RepoFile } from "./generate.js";

/** Read at most this many bytes from any single file; a longer file is truncated to this prefix. */
export const MAX_FILE_CONTENT_BYTES = 128 * 1024;
/** Stop reading content once this many total bytes are scanned; remaining files enter path-only. */
export const TOTAL_CONTENT_BUDGET_BYTES = 8 * 1024 * 1024;
/** Upper bound on files gathered from a non-git walk, so a huge tree cannot stall startup. */
export const WALK_FILE_CAP = 5000;

/** Directory/entry names skipped by the non-git walk: VCS, dependencies, and build output. */
export const WALK_IGNORE_NAMES: ReadonlySet<string> = new Set([
	".git",
	"node_modules",
	".veyyon",
	"dist",
	"target",
	".next",
	"vendor",
]);

/**
 * Exact basenames whose content is never scanned: machine-generated lockfiles.
 * They are enormous, repeat identical lines thousands of times, and a model never
 * retypes them, so their content is pure noise for handle selection. The path
 * itself still enters as a candidate.
 */
export const CONTENT_SKIP_BASENAMES: ReadonlySet<string> = new Set([
	"Cargo.lock",
	"package-lock.json",
	"yarn.lock",
	"pnpm-lock.yaml",
	"bun.lock",
	"bun.lockb",
	"Gemfile.lock",
	"poetry.lock",
	"composer.lock",
	"go.sum",
	"flake.lock",
	"deno.lock",
]);

/**
 * Suffixes whose content is never scanned: assets, fonts, archives, images,
 * source maps, and pre-minified bundles. None are strings a model re-emits, and
 * many are binary. Matched case-insensitively against the path suffix.
 */
export const CONTENT_SKIP_SUFFIXES: readonly string[] = [
	".lock",
	".lockb",
	".min.js",
	".min.css",
	".map",
	".svg",
	".png",
	".jpg",
	".jpeg",
	".gif",
	".webp",
	".ico",
	".bmp",
	".pdf",
	".woff",
	".woff2",
	".ttf",
	".otf",
	".eot",
	".wasm",
	".zip",
	".gz",
	".tgz",
	".tar",
	".bin",
	".exe",
	".dll",
	".so",
	".dylib",
	".class",
	".jar",
	".mp4",
	".mp3",
	".mov",
	".snap",
];

/**
 * A recall-preserving degrade the corpus builder took, surfaced so the harness
 * can log it (never a silent truncation). Today the only case is reaching the
 * total content budget, after which the remaining files are ranked on their path
 * alone: the dictionary is still correct, just built from fewer signals.
 */
export interface CorpusNotice {
	code: "content-budget-reached";
	message: string;
	data: { budgetBytes: number; totalFiles: number };
}

/** Whether a path's content should be scanned for centrality, or only the path itself proposed. */
export function shouldScanContent(relPath: string): boolean {
	const slash = relPath.lastIndexOf("/");
	const base = slash === -1 ? relPath : relPath.slice(slash + 1);
	if (CONTENT_SKIP_BASENAMES.has(base)) return false;
	const lower = relPath.toLowerCase();
	for (const suffix of CONTENT_SKIP_SUFFIXES) {
		if (lower.endsWith(suffix)) return false;
	}
	return true;
}

/**
 * Turn repo-relative paths into {@link RepoFile}s carrying bounded content, so
 * the generator ranks handles by document-frequency centrality rather than by
 * path length alone.
 *
 * Every path always enters as a candidate. For source-like files (see
 * {@link shouldScanContent}) up to {@link MAX_FILE_CONTENT_BYTES} is read,
 * stopping altogether once the run has scanned {@link TOTAL_CONTENT_BUDGET_BYTES}.
 * Content with an embedded NUL byte is treated as binary and dropped to
 * path-only. When the total budget is reached, the remaining files enter
 * path-only and `onNotice` is called (never a silent truncation).
 *
 * Paths are sorted first so the same repository state always reads the same
 * prefix under the budget, keeping the generated dictionary deterministic.
 */
export async function gatherRepoFiles(
	root: string,
	paths: readonly string[],
	onNotice?: (notice: CorpusNotice) => void,
): Promise<RepoFile[]> {
	const sorted = [...paths].sort();
	const files: RepoFile[] = [];
	let scannedBytes = 0;
	let budgetHit = false;

	for (const rel of sorted) {
		if (budgetHit || !shouldScanContent(rel)) {
			files.push({ path: rel });
			continue;
		}
		if (scannedBytes >= TOTAL_CONTENT_BUDGET_BYTES) {
			budgetHit = true;
			files.push({ path: rel });
			continue;
		}
		let content: string | undefined;
		try {
			const buffer = await readFile(join(root, rel));
			const slice = buffer.subarray(0, MAX_FILE_CONTENT_BYTES);
			if (!slice.includes(0)) {
				content = slice.toString("utf8");
				scannedBytes += slice.byteLength;
			}
		} catch {
			// Unreadable file (permissions, race, symlink to nowhere): fall back to
			// path-only for this entry. The path still contributes a candidate.
			content = undefined;
		}
		files.push(content === undefined ? { path: rel } : { path: rel, content });
	}

	if (budgetHit && onNotice !== undefined) {
		onNotice({
			code: "content-budget-reached",
			message: "argot: content budget reached during dict generation; ranking remaining files on path only",
			data: { budgetBytes: TOTAL_CONTENT_BUDGET_BYTES, totalFiles: sorted.length },
		});
	}
	return files;
}

/**
 * List a project's files by walking the tree, for a project with no git index
 * (opted in with a bare `.argot` marker). Bounded by {@link WALK_FILE_CAP} and
 * ignoring VCS, dependency, and build-output directories ({@link WALK_IGNORE_NAMES})
 * plus dotfiles other than `.argot`. Returns repo-relative paths;
 * {@link gatherRepoFiles} reads their bounded content. For a git project use the
 * harness's `git ls-files` instead, which respects `.gitignore`.
 */
export async function walkProjectTree(root: string): Promise<string[]> {
	const out: string[] = [];
	const stack: string[] = [""];
	while (stack.length > 0 && out.length < WALK_FILE_CAP) {
		const rel = stack.pop() as string;
		let entries: Dirent[];
		try {
			entries = await readdir(join(root, rel), { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			if (out.length >= WALK_FILE_CAP) break;
			if (entry.name.startsWith(".") && entry.name !== ".argot") continue;
			if (WALK_IGNORE_NAMES.has(entry.name)) continue;
			const childRel = rel === "" ? entry.name : `${rel}/${entry.name}`;
			if (entry.isDirectory()) {
				stack.push(childRel);
			} else if (entry.isFile()) {
				out.push(childRel);
			}
		}
	}
	return out;
}
