// WHY THIS EXISTS.
//
// `.gitignore` held `changes/`, with no leading slash, for a scratch directory
// at the repository root. A pattern with no slash in it matches at every depth,
// so it also swallowed `hosts/gui/features/src/changes/` - ten source files of
// the GPU front end's diff route, declared `pub mod changes;` by a committed
// `lib.rs`. The working tree compiled, every gate was green, and a clean clone
// could not build, because the module the manifest declares was never in the
// repository. Nothing reported it: `git status` hides an ignored file, and the
// gates read the working tree.
//
// THE CLASS IT CLOSES. Source the build reads and the repository does not
// carry, whichever direction the mistake comes from: a pattern broad enough to
// reach a source directory, or a source directory created under a name a
// pattern already matches. Both halves are derived at run time - the first from
// what git reports as ignored, the second from every unanchored pattern in
// `.gitignore` against every directory that holds tracked source - so a new
// pattern or a new directory joins the sweep rather than needing a line here.
//
// WHAT IT DOES NOT CATCH. A file that is ignored, tracked, and stale: git
// carries it, so a clone still builds. Nor a source file nobody created, which
// is the compiler's job, nor an ignore rule in a nested `.gitignore` reaching a
// directory that holds no tracked source yet.

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import * as path from "node:path";

const repoRoot = path.join(import.meta.dir, "..");

/** What the compilers and the bundler read. A missing one breaks a clean clone. */
const SOURCE = [".rs", ".ts", ".tsx"];

/**
 * Trees that are not source: a dependency install, a build directory, and the
 * scratch tree, which is deliberately outside every gate. Anything else that is
 * ignored and holds source is the defect this file is about.
 */
const NOT_SOURCE = ["node_modules", "target", ".scratch"];

/**
 * Those trees again as pathspecs, at every depth a workspace member reaches.
 * Without them the listing of what is ignored is the whole dependency install,
 * which is megabytes and gets the child process killed rather than answered.
 */
const OUTSIDE = NOT_SOURCE.flatMap(tree => ["", "*/", "*/*/", "*/*/*/"].map(depth => `:(exclude)${depth}${tree}`));

/** Ignored source files that are meant to be ignored. Pinned by equality: a new one is a decision. */
const IGNORED_ON_PURPOSE: string[] = [];

function git(...args: string[]): string[] {
	const result = spawnSync("git", args, { cwd: repoRoot, encoding: "utf8" });
	expect(result.status, `git ${args.join(" ")} failed: ${result.stderr}`).toBe(0);
	return result.stdout.split("\n").filter(line => line.length > 0);
}

function isSource(file: string): boolean {
	return (
		SOURCE.some(extension => file.endsWith(extension)) && !NOT_SOURCE.some(tree => file.split("/").includes(tree))
	);
}

describe("every source file the build reads is in the repository", () => {
	test("no source file is ignored", () => {
		const ignored = git("ls-files", "--others", "--ignored", "--exclude-standard", "--", ...OUTSIDE).filter(isSource);

		expect(ignored).toEqual(IGNORED_ON_PURPOSE);
	});

	// The other direction, and the one that has teeth after the files are
	// committed: a pattern with no slash matches at every depth, so `changes/`
	// means "any directory called changes, anywhere". Every directory that holds
	// tracked source is read from git, so this covers the whole repository.
	test("no unanchored ignore pattern names a directory that holds source", () => {
		const directories = new Set<string>();
		for (const file of git("ls-files")) {
			if (!isSource(file)) {
				continue;
			}
			for (const segment of file.split("/").slice(0, -1)) {
				directories.add(segment);
			}
		}
		expect(directories.size, "no tracked source was found; the scan stopped matching").toBeGreaterThan(20);

		const patterns = readFileSync(path.join(repoRoot, ".gitignore"), "utf8");
		const collisions: string[] = [];
		for (const line of patterns.split("\n")) {
			const pattern = line.trim();
			if (pattern.length === 0 || pattern.startsWith("#") || pattern.startsWith("!")) {
				continue;
			}
			const name = pattern.replace(/\/$/, "");
			if (name.includes("/") || !directories.has(name)) {
				continue;
			}
			collisions.push(`${pattern} matches a source directory at every depth; anchor it as /${pattern}`);
		}

		expect(collisions).toEqual([]);
	});
});
