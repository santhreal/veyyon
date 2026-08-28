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

/** Machine-generated lockfiles skipped for content scanning. */
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

/** File extensions skipped for content scanning (binaries, assets, maps). */
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

/** Diagnostic notices emitted during corpus generation. */
export type CorpusNotice =
	| {
			code: "content-budget-reached";
			message: string;
			data: { budgetBytes: number; totalFiles: number };
	  }
	| {
			code: "unreadable-files-skipped";
			message: string;
			data: { count: number; totalFiles: number };
	  }
	| {
			code: "walk-file-cap-reached";
			message: string;
			data: { cap: number };
	  }
	| {
			code: "unreadable-directory-skipped";
			message: string;
			data: { path: string; isRoot: boolean };
	  };

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

/** Gather repository files and read bounded content for candidate extraction. */
export async function gatherRepoFiles(
	root: string,
	paths: readonly string[],
	onNotice?: (notice: CorpusNotice) => void,
): Promise<RepoFile[]> {
	const sorted = paths.slice().sort();
	const files: RepoFile[] = [];
	let scannedBytes = 0;
	let budgetHit = false;
	let unreadable = 0;

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
			content = undefined;
			unreadable++;
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
	if (unreadable > 0 && onNotice !== undefined) {
		onNotice({
			code: "unreadable-files-skipped",
			message: `argot: ${unreadable} of ${sorted.length} files could not be read during dict generation; those are ranked on path only`,
			data: { count: unreadable, totalFiles: sorted.length },
		});
	}
	return files;
}

/** List project files by walking directory tree up to WALK_FILE_CAP. */
export async function walkProjectTree(root: string, onNotice?: (notice: CorpusNotice) => void): Promise<string[]> {
	const out: string[] = [];
	const stack: string[] = [""];
	let capHit = false;
	while (stack.length > 0 && out.length < WALK_FILE_CAP) {
		const rel = stack.pop() as string;
		let entries: Dirent[];
		try {
			entries = await readdir(join(root, rel), { withFileTypes: true });
		} catch {
			const isRoot = rel === "";
			onNotice?.({
				code: "unreadable-directory-skipped",
				message: isRoot
					? `argot: project root ${root} could not be read during dict generation; the listing is empty`
					: `argot: directory ${rel} could not be read during dict generation; its subtree is omitted`,
				data: { path: isRoot ? root : rel, isRoot },
			});
			continue;
		}
		for (const entry of entries) {
			if (out.length >= WALK_FILE_CAP) {
				capHit = true;
				break;
			}
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
	if (capHit || stack.length > 0) {
		onNotice?.({
			code: "walk-file-cap-reached",
			message: `argot: project tree exceeded ${WALK_FILE_CAP} files during dict generation; the listing is truncated and the remaining files contribute no handles`,
			data: { cap: WALK_FILE_CAP },
		});
	}
	return out;
}
