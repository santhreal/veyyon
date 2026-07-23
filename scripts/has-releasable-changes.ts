#!/usr/bin/env bun
/**
 * Decide whether main has anything worth releasing right now.
 *
 * The push-triggered auto-release in `.github/workflows/release.yml` cuts a
 * patch release only when a publishable package's `## [Unreleased]` changelog
 * section has content. That single signal is what makes automatic releasing
 * safe and self-limiting:
 *
 *   - The ship-feature ritual requires an `## [Unreleased]` bullet for every
 *     user-facing change, so "something is unreleased" == "a user-facing change
 *     is waiting to ship".
 *   - `release.ts` moves `## [Unreleased]` into the new version section when it
 *     cuts a release, so right after a release nothing is unreleased.
 *   - The release's own `chore: bump version to X` commit is what empties it,
 *     so the push that commit makes never triggers another release. No loop.
 *   - A docs/test/chore-only merge adds no bullet, so it does not release.
 *
 * Every publishable package is considered, not just `coding-agent`: a
 * user-facing change to `@veyyon/ai` lands its bullet in that package's own
 * CHANGELOG, and it still ships inside the binary, so it must still release.
 *
 * Prints `true` or `false` on stdout and always exits 0, so a workflow step can
 * capture the value without `set -e` aborting on the `false` case.
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { discoverPackages, parseUnreleasedBullets } from "./require-changelog.ts";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** True when any package's `## [Unreleased]` section holds at least one bullet. */
export function hasReleasableChanges(changelogContents: string[]): boolean {
	return changelogContents.some(content => parseUnreleasedBullets(content).length > 0);
}

async function readReleasableChangelogs(repoRoot: string): Promise<string[]> {
	const packages = await discoverPackages(repoRoot);
	const contents: string[] = [];
	for (const pkg of packages) {
		const file = Bun.file(join(repoRoot, pkg.dir, "CHANGELOG.md"));
		contents.push((await file.exists()) ? await file.text() : "");
	}
	return contents;
}

if (import.meta.main) {
	const releasable = hasReleasableChanges(await readReleasableChangelogs(REPO_ROOT));
	console.log(releasable ? "true" : "false");
}
