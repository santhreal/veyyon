/**
 * Central Git baseline reader for parity and equivalence verification suites.
 *
 * WHY THIS MODULE EXISTS:
 * Rather than committing tens of thousands of lines of static baseline fixture dumps (such as
 * full package manifest copies, 4800+ file hashes, or 5700+ diff file lists), parity suites
 * read baseline file contents directly from the pinned immutable Git commit object.
 *
 * This provides:
 * 1. ZERO duplication: The Git object database itself is the single source of truth for baseline contents.
 * 2. High throughput: Batched object streaming via `git cat-file --batch -Z` reads thousands of blobs in milliseconds.
 * 3. Fail-closed safety: Explicitly checks baseline object availability, validates streaming integrity,
 *    and gives clear corrective actions if missing.
 */

import { execFileSync, spawn } from "node:child_process";
import { resolve } from "node:path";

/**
 * Pinned merge-base commit against which all parity ledgers and differential suites are measured.
 */
export const PINNED_BASELINE_COMMIT = "aa14e0da82494dac5a06d240180cec88038a105f";

/** Repository root path derived from this file's location. */
export const REPO_ROOT = import.meta.dirname ? resolve(import.meta.dirname, "..") : process.cwd();

/**
 * Asserts that the pinned baseline commit object is reachable in the local Git repository.
 * Throws a descriptive fail-closed error with corrective action if the commit is missing or shallow.
 */
export function ensureBaselineAvailable(repoRoot: string = REPO_ROOT, commit: string = PINNED_BASELINE_COMMIT): void {
	try {
		execFileSync("git", ["cat-file", "-e", `${commit}^{commit}`], {
			cwd: repoRoot,
			stdio: ["pipe", "pipe", "pipe"],
		});
	} catch {
		throw new Error(
			`The pinned baseline commit ${commit} is not available in the local repository object store (it may be shallow or unfetched).\n` +
				`Corrective action: Run 'git fetch origin ${commit}' (or fetch origin/main) to make baseline objects reachable.`,
		);
	}
}

export interface GitTreeEntry {
	readonly mode: string;
	readonly type: "blob" | "commit" | "tree";
	readonly sha: string;
	readonly path: string;
}

/**
 * Lists all tracked files at the specified commit using `git ls-tree -r -z` for null-safe path extraction.
 * Enforces strict shape validation on all tree records, metadata columns, modes, and object hashes.
 */
export function readGitTree(
	commit: string = PINNED_BASELINE_COMMIT,
	repoRoot: string = REPO_ROOT,
): Map<string, GitTreeEntry> {
	ensureBaselineAvailable(repoRoot, commit);
	const output = execFileSync("git", ["ls-tree", "-r", "-z", commit], {
		cwd: repoRoot,
		maxBuffer: 64 * 1024 * 1024,
	});

	const tree = new Map<string, GitTreeEntry>();
	let offset = 0;
	const len = output.length;

	while (offset < len) {
		const nulIdx = output.indexOf(0, offset);
		if (nulIdx === -1) {
			throw new Error(`Malformed git ls-tree -r -z output: incomplete entry at offset ${offset}`);
		}
		const entry = output.subarray(offset, nulIdx).toString("utf-8");
		offset = nulIdx + 1;

		const tabIdx = entry.indexOf("\t");
		if (tabIdx === -1) {
			throw new Error(`Malformed git ls-tree -r -z entry: missing tab separator in "${entry}"`);
		}

		const meta = entry.slice(0, tabIdx);
		const filePath = entry.slice(tabIdx + 1);
		if (filePath.length === 0) {
			throw new Error(`Malformed git ls-tree -r -z entry: empty path in "${entry}"`);
		}

		const parts = meta.split(" ");
		if (parts.length !== 3) {
			throw new Error(`Malformed git ls-tree -r -z metadata: "${meta}" in "${entry}"`);
		}

		const mode = parts[0] ?? "";
		const type = parts[1] ?? "";
		const sha = parts[2] ?? "";

		if (!/^\d{6}$/.test(mode)) {
			throw new Error(`Invalid mode "${mode}" in git ls-tree entry "${entry}"`);
		}
		if (type !== "blob" && type !== "tree" && type !== "commit") {
			throw new Error(`Invalid type "${type}" in git ls-tree entry "${entry}"`);
		}
		if (!/^[0-9a-f]{40}$/.test(sha)) {
			throw new Error(`Invalid sha "${sha}" in git ls-tree entry "${entry}"`);
		}

		tree.set(filePath, { mode, type, sha, path: filePath });
	}

	if (offset !== len) {
		throw new Error(`Malformed git ls-tree -r -z output: ${len - offset} trailing unparsed bytes`);
	}

	return tree;
}

/**
 * Reads a single file as Buffer from the specified commit.
 * Returns null if the path does not exist in the commit; throws on git execution errors.
 */
export function readGitFileBuffer(
	relativePath: string,
	commit: string = PINNED_BASELINE_COMMIT,
	repoRoot: string = REPO_ROOT,
): Buffer | null {
	ensureBaselineAvailable(repoRoot, commit);
	try {
		return execFileSync("git", ["show", `${commit}:${relativePath}`], {
			cwd: repoRoot,
			maxBuffer: 64 * 1024 * 1024,
			stdio: ["pipe", "pipe", "pipe"],
		});
	} catch (err: unknown) {
		const execError = err as { stderr?: Buffer; message?: string };
		const stderr = execError.stderr ? execError.stderr.toString("utf-8") : "";
		const isMissing =
			stderr.includes("does not exist in") ||
			stderr.includes("exists on disk, but not in") ||
			stderr.includes("not a valid object name") ||
			stderr.includes("path not found");
		if (isMissing) {
			return null;
		}
		throw new Error(
			`Failed to read git object ${commit}:${relativePath}: ${stderr || execError.message || String(err)}`,
		);
	}
}

/**
 * Reads a single file as string from the specified commit.
 * Returns null if the path does not exist in the commit; throws on git execution errors.
 */
export function readGitFileText(
	relativePath: string,
	commit: string = PINNED_BASELINE_COMMIT,
	repoRoot: string = REPO_ROOT,
): string | null {
	const buffer = readGitFileBuffer(relativePath, commit, repoRoot);
	return buffer ? buffer.toString("utf-8") : null;
}

/**
 * High-throughput streaming batch reader using `git cat-file --batch -Z`.
 * Accepts an array of object specifications (e.g. `"${commit}:${relativePath}"` or sha hexes)
 * and returns a Map mapping each specifier to its Buffer (or null if missing).
 *
 * Enforces fail-closed stream parsing:
 * - Uses NUL-delimited request stream (`\0`) to handle arbitrarily formatted paths safely.
 * - Enforces exact blob object headers (`<sha> blob <size>\0`).
 * - Strictly validates pure integer byte sizes (rejecting suffixes like `12junk`).
 * - Asserts exact trailing NUL delimiter after every blob body.
 * - Asserts exact matching record counts and complete consumption of stream buffer (`offset === len`).
 * - Traps process exit codes, signals, and stdin errors.
 */
export async function batchReadGitBlobs(
	objectSpecs: readonly string[],
	repoRoot: string = REPO_ROOT,
): Promise<Map<string, Buffer | null>> {
	if (objectSpecs.length === 0) return new Map();
	ensureBaselineAvailable(repoRoot);

	const { promise, resolve: resolvePromise, reject } = Promise.withResolvers<Map<string, Buffer | null>>();
	const cat = spawn("git", ["cat-file", "--batch", "-Z"], {
		cwd: repoRoot,
		stdio: "pipe",
	});

	const chunks: Buffer[] = [];
	cat.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
	let errOutput = "";
	cat.stderr.on("data", (chunk: Buffer) => {
		errOutput += chunk.toString("utf-8");
	});

	cat.stdin.on("error", (stdinErr: Error) => {
		reject(new Error(`git cat-file --batch -Z stdin error: ${stdinErr.message}`));
	});

	cat.on("error", reject);
	cat.on("close", (code: number | null, signal: NodeJS.Signals | null) => {
		if (code !== 0 || signal !== null) {
			reject(new Error(`git cat-file --batch -Z terminated with code ${code} signal ${signal}: ${errOutput}`));
			return;
		}

		try {
			const outputBuffer = Buffer.concat(chunks);
			const results = new Map<string, Buffer | null>();
			let offset = 0;
			const len = outputBuffer.length;
			let specIdx = 0;

			while (offset < len && specIdx < objectSpecs.length) {
				const nulIdx = outputBuffer.indexOf(0, offset);
				if (nulIdx === -1) {
					throw new Error(
						`Malformed git cat-file --batch -Z stream: incomplete header at offset ${offset} for ${objectSpecs[specIdx]}`,
					);
				}
				const headerLine = outputBuffer.subarray(offset, nulIdx).toString("utf-8");
				offset = nulIdx + 1;

				const currentSpec = objectSpecs[specIdx++];
				if (headerLine.endsWith(" missing")) {
					results.set(currentSpec, null);
					continue;
				}

				const parts = headerLine.split(" ");
				if (parts.length !== 3) {
					throw new Error(`Malformed git cat-file --batch -Z header "${headerLine}" for ${currentSpec}`);
				}

				const [sha, type, sizeStr] = parts;
				if (!/^[0-9a-f]{40}$/.test(sha ?? "")) {
					throw new Error(`Invalid sha in git cat-file --batch -Z header "${headerLine}" for ${currentSpec}`);
				}

				if (type !== "blob") {
					throw new Error(
						`git cat-file --batch -Z returned non-blob object type "${type}" for ${currentSpec} (expected blob)`,
					);
				}

				if (!/^\d+$/.test(sizeStr ?? "")) {
					throw new Error(
						`Invalid object size in git cat-file --batch -Z header "${headerLine}" for ${currentSpec}`,
					);
				}

				const size = Number.parseInt(sizeStr ?? "0", 10);
				if (offset + size > len) {
					throw new Error(
						`Truncated git cat-file --batch -Z stream: expected ${size} bytes for ${currentSpec}, only ${len - offset} available`,
					);
				}

				const data = outputBuffer.subarray(offset, offset + size);
				results.set(currentSpec, data);
				offset += size;

				if (offset >= len || outputBuffer[offset] !== 0) {
					throw new Error(
						`Malformed git cat-file --batch -Z stream: expected trailing NUL byte after ${currentSpec}`,
					);
				}
				offset += 1;
			}

			if (specIdx < objectSpecs.length) {
				throw new Error(
					`git cat-file --batch -Z stream terminated prematurely: parsed ${specIdx} of ${objectSpecs.length} requested objects`,
				);
			}

			if (offset !== len) {
				throw new Error(`Malformed git cat-file --batch -Z stream has ${len - offset} trailing unparsed bytes`);
			}

			resolvePromise(results);
		} catch (parseError: unknown) {
			reject(parseError instanceof Error ? parseError : new Error(String(parseError)));
		}
	});

	cat.stdin.write(`${objectSpecs.join("\0")}\0`);
	cat.stdin.end();

	return promise;
}

export interface RenameDetectionResult {
	readonly pairs: [string, string][];
	readonly deleted: string[];
}

/**
 * Extracts rename pairs and deleted paths between baseCommit and headRef using null-safe `git diff -z`.
 * Uses `--find-renames=${similarityThreshold}%` and `-l0` to avoid missing cross-package moves.
 */
export function getRenamePairs(
	baseCommit: string = PINNED_BASELINE_COMMIT,
	headRef = "HEAD",
	repoRoot: string = REPO_ROOT,
	similarityThreshold = 20,
): RenameDetectionResult {
	ensureBaselineAvailable(repoRoot, baseCommit);
	const raw = execFileSync(
		"git",
		[
			"diff",
			"-z",
			`--find-renames=${similarityThreshold}%`,
			"-l0",
			"--diff-filter=RD",
			"--name-status",
			`${baseCommit}...${headRef}`,
		],
		{
			cwd: repoRoot,
			maxBuffer: 64 * 1024 * 1024,
		},
	);

	const pairs: [string, string][] = [];
	const deleted: string[] = [];
	let offset = 0;
	const len = raw.length;

	while (offset < len) {
		const nulIdx1 = raw.indexOf(0, offset);
		if (nulIdx1 === -1) {
			throw new Error(`Malformed git diff -z output: incomplete status at offset ${offset}`);
		}
		const status = raw.subarray(offset, nulIdx1).toString("utf-8");
		offset = nulIdx1 + 1;

		if (status.startsWith("R")) {
			const nulIdx2 = raw.indexOf(0, offset);
			if (nulIdx2 === -1) {
				throw new Error(
					`Malformed git diff -z rename: missing old path for status "${status}" at offset ${offset}`,
				);
			}
			const oldPath = raw.subarray(offset, nulIdx2).toString("utf-8");
			offset = nulIdx2 + 1;

			const nulIdx3 = raw.indexOf(0, offset);
			if (nulIdx3 === -1) {
				throw new Error(`Malformed git diff -z rename: missing new path for "${oldPath}" at offset ${offset}`);
			}
			const newPath = raw.subarray(offset, nulIdx3).toString("utf-8");
			offset = nulIdx3 + 1;

			if (oldPath.length === 0 || newPath.length === 0) {
				throw new Error(`Malformed git diff -z rename: empty path in rename pair`);
			}

			pairs.push([oldPath, newPath]);
		} else if (status === "D") {
			const nulIdx2 = raw.indexOf(0, offset);
			if (nulIdx2 === -1) {
				throw new Error(`Malformed git diff -z delete: missing deleted path at offset ${offset}`);
			}
			const delPath = raw.subarray(offset, nulIdx2).toString("utf-8");
			offset = nulIdx2 + 1;

			if (delPath.length === 0) {
				throw new Error(`Malformed git diff -z delete: empty deleted path`);
			}

			deleted.push(delPath);
		} else {
			throw new Error(`Unexpected diff status "${status}" in git diff -z output (expected R* or D)`);
		}
	}

	if (offset !== len) {
		throw new Error(`Malformed git diff -z output: ${len - offset} trailing unparsed bytes`);
	}

	return { pairs, deleted };
}
