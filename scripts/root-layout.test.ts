/**
 * The generated directories at the repository root stay generated, and stay out of git.
 *
 * WHY THIS SUITE EXISTS. Four directories at the root hold output rather than source: `runs/` (the
 * default artifact sink for the benchmark harnesses), `website-get/` (staged by `website/build.mjs`
 * and deployed to get.veyyon.dev), `relative-cache/` (a Bun cache pile), and
 * `packages/deepswe-bench/{runs,repo-cache}` (trial output and cloned task repos, several gigabytes).
 * None of them is source, and each looks exactly like source to anyone reading `ls`.
 *
 * The failure this guards is a directory quietly becoming tracked. `relative-cache/` had no ignore
 * entry at all for a while, so every `git status` offered to add a Bun cache and any `git add -A`
 * would have taken it. Once a generated tree is committed, it is committed with whatever it happened
 * to contain that day, it conflicts on every machine, and removing it later reads as deleting real
 * files. The 4G of cloned upstream repositories under `deepswe-bench` is the version of this mistake
 * nobody recovers from casually.
 *
 * The staging assertion is the other half. `website-get/` must stay UNTRACKED and must still be
 * PRODUCED: an ignore rule that outlives the build step that writes it is how the install endpoint
 * quietly starts deploying an empty directory.
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import * as path from "node:path";

const repoRoot = path.resolve(import.meta.dir, "..");

/** Paths that hold generated output, with the ignore entry each one is expected to carry. */
const GENERATED: ReadonlyArray<{ dir: string; ignoreEntry: string; why: string }> = [
	{ dir: "runs", ignoreEntry: "/runs/", why: "default artifact sink for the benchmark harnesses" },
	{ dir: "website-get", ignoreEntry: "/website-get/", why: "staged by website/build.mjs, deployed to get.veyyon.dev" },
	{ dir: "relative-cache", ignoreEntry: "relative-cache/", why: "Bun cache pile written at the repo root" },
	{ dir: "packages/deepswe-bench/runs", ignoreEntry: "runs/", why: "benchmark trial output" },
	{ dir: "packages/deepswe-bench/repo-cache", ignoreEntry: "repo-cache/", why: "cloned upstream task repositories" },
];

function trackedFileCount(dir: string): number {
	const listed = Bun.spawnSync(["git", "ls-files", dir], { cwd: repoRoot });
	const text = new TextDecoder().decode(listed.stdout).trim();
	return text === "" ? 0 : text.split("\n").length;
}

/** The ignore file that is expected to carry an entry, since deepswe-bench has its own. */
function ignoreFileFor(dir: string): string {
	return dir.startsWith("packages/deepswe-bench/") ? "packages/deepswe-bench/.gitignore" : ".gitignore";
}

describe("generated directories at the root", () => {
	for (const { dir, ignoreEntry, why } of GENERATED) {
		it(`ignores ${dir} (${why})`, () => {
			// Asserted against the ignore FILE rather than `git check-ignore`, so the entry has to
			// be a deliberate line somebody can read and not an incidental match from a broader
			// pattern that a later edit could narrow without noticing.
			const ignoreFile = ignoreFileFor(dir);
			const lines = readFileSync(path.join(repoRoot, ignoreFile), "utf-8")
				.split("\n")
				.map(line => line.trim());

			expect(lines, `${ignoreFile} must list ${ignoreEntry}`).toContain(ignoreEntry);
		});

		it(`tracks no file under ${dir}`, () => {
			// The assertion that actually protects the repository. An ignore entry does nothing
			// for a file that was already added, so the ignore rule and the tracked set are two
			// separate facts and both are checked.
			expect(trackedFileCount(dir), `${dir} must hold no tracked files`).toBe(0);
		});
	}

	it("still stages website-get from the website build", () => {
		// The ignore entry above is only correct while something produces the directory. If this
		// staging step is removed or renamed, `website-get/` becomes an ignored directory nobody
		// writes and the install endpoint deploys whatever is left over on the runner.
		const build = readFileSync(path.join(repoRoot, "website/build.mjs"), "utf-8");

		expect(build).toContain('const GET = join(REPO, "website-get")');
		expect(build).toContain("install.sh");
	});

	it("keeps the source directories at the root tracked, so the check is not vacuous", () => {
		// The guard on the guard. Every assertion above is satisfied by a repository with nothing
		// in it; this one proves `git ls-files` is answering at all.
		expect(trackedFileCount("scripts")).toBeGreaterThan(50);
		expect(trackedFileCount("packages/utils/src")).toBeGreaterThan(20);
	});
});
