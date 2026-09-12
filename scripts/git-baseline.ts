/**
 * Git object readers for suites that compare the working tree against an approved commit.
 *
 * A suite reads an approved snapshot straight from the Git object database instead of committing
 * a copy of it as a fixture. Every reader checks that the commit is reachable first and fails with
 * the fetch command that makes it reachable.
 */

import { execFileSync } from "node:child_process";
import { existingOnly, REPO_ROOT } from "./workspace-layout";

export { REPO_ROOT };

/**
 * Asserts that the commit object is reachable in the local Git repository.
 * Throws a descriptive fail-closed error with corrective action if the commit is missing or shallow.
 */
export function ensureBaselineAvailable(repoRoot: string, commit: string): void {
	try {
		execFileSync("git", ["cat-file", "-e", `${commit}^{commit}`], {
			cwd: repoRoot,
			stdio: ["pipe", "pipe", "pipe"],
		});
	} catch {
		throw new Error(
			`The commit ${commit} is not available in the local repository object store (it may be shallow or unfetched).\n` +
				`Corrective action: Run 'git fetch origin ${commit}' (or fetch origin/main) to make its objects reachable.`,
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
export function readGitTree(commit: string, repoRoot: string = REPO_ROOT): Map<string, GitTreeEntry> {
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
export function readGitFileBuffer(relativePath: string, commit: string, repoRoot: string = REPO_ROOT): Buffer | null {
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
export function readGitFileText(relativePath: string, commit: string, repoRoot: string = REPO_ROOT): string | null {
	const buffer = readGitFileBuffer(relativePath, commit, repoRoot);
	return buffer ? buffer.toString("utf-8") : null;
}

/**
 * Lists tracked files in the repository using null-safe git ls-files.
 */
export function listTrackedFiles(
	repoRoot: string = REPO_ROOT,
	paths?: string | readonly string[],
	flags: readonly string[] = ["--cached", "--others", "--exclude-standard"],
	maxBuffer = 64 * 1024 * 1024,
): string[] {
	const args = ["ls-files", "-z", ...flags];
	if (typeof paths === "string") {
		args.push("--", paths);
	} else if (Array.isArray(paths) && paths.length > 0) {
		args.push("--", ...paths);
	}
	try {
		const output = execFileSync("git", args, {
			cwd: repoRoot,
			maxBuffer,
		});
		return existingOnly(repoRoot, output.toString("utf-8").split("\0").filter(Boolean));
	} catch (error) {
		throw new Error(
			`Failed to enumerate files under "${typeof paths === "string" ? paths : Array.isArray(paths) ? paths.join(", ") : "."}" via git ls-files at ${repoRoot}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}
