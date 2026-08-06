#!/usr/bin/env bun
/**
 * Prepare a release on your machine, and stop before anything leaves it.
 *
 * A release is three moves: prepare, push, tag. This script is the first, and
 * it is deliberately the only one that writes to the tree. It resolves the
 * version, refuses if the changelog does not document it, rolls every version
 * authority and changelog, refreshes the lockfiles, runs `bun run check`, and
 * commits — locally. It never tags, never pushes, and never talks to GitHub.
 *
 * The reason the mutation happens here rather than in CI is the tag. A tag must
 * sit on a commit CI has already tested green, and a bump commit created inside
 * CI is by definition a commit CI has never seen. The old controller tried to
 * close that hole after the fact by pushing the bump, then dispatching Checks
 * and CI at the new tag and waiting for both — three CI rounds per release, a
 * dispatch-correlation nonce because `workflow_dispatch` returns no run id, and
 * a pinned alert issue for the partial states in between. Preparing locally
 * removes the hole instead of chasing it: the bump commit goes through main's
 * ordinary CI like any other commit, and the tag is only ever cut on a SHA that
 * is already green.
 *
 * What you run after this script is printed at the end, and `docs/internal/releasing.md`
 * is the same three commands in prose.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { isNewerVersion } from "@veyyon/utils/semver";
import {
	bumpVersion,
	loadPackageChangelogs,
	parseReleaseRequest,
	prepareReleaseTree,
	releaseBumpSubject,
	validateReleaseVersionAuthorities,
	versionNotNewerFailure,
} from "./release";
import { assertReleaseIsDocumented, RELEASE_NOTES_CHANGELOG } from "./release-policy";

const execFileAsync = promisify(execFile);

/** No `v*` tag yet is veyyon's first-release state; treat it as a 0.0.0 baseline. */
export const NO_TAG_BASELINE = "0.0.0";

async function git(...args: string[]): Promise<string> {
	const { stdout } = await execFileAsync("git", args, { maxBuffer: 64 * 1024 * 1024 });
	return stdout;
}

/**
 * Resolve `major`/`minor`/`patch`/`x.y.z` against the latest tag, or return the
 * operator-facing refusal. The caller prints `failure` verbatim: re-cutting an
 * already-tagged version is a documented recovery, not a mistake, and the
 * advice for the two cases is opposite.
 */
export function resolveReleaseVersion(
	request: string,
	latestTag: string,
): { version: string; failure?: undefined } | { version?: undefined; failure: string[] } {
	const version =
		request === "major" || request === "minor" || request === "patch" ? bumpVersion(latestTag, request) : request;
	if (!isNewerVersion(version, latestTag)) return { failure: versionNotNewerFailure(version, latestTag) };
	return { version };
}

/**
 * The paths a `git status --porcelain -z` run reports, including both sides of
 * a rename.
 *
 * Staging is by explicit path rather than `git add -A` because this runs on a
 * developer machine, where the rule is that you stage what you changed and
 * nothing else. The tree was verified clean before preparation, so this list is
 * exactly what preparation produced — and printing it lets the operator see
 * that before it becomes a commit.
 *
 * `-z` rather than plain `--porcelain`: the plain form C-quotes any path with a
 * space or a non-ASCII byte and renders a rename as `old -> new` inside one
 * line, so a naive split mints paths that do not exist. With `-z` the records
 * are NUL-separated, never quoted, and a rename's origin is its own record.
 */
export function statusPaths(porcelainZ: string): string[] {
	const records = porcelainZ.split("\0").filter(record => record.length > 0);
	const paths: string[] = [];
	for (let index = 0; index < records.length; index++) {
		const record = records[index];
		if (record === undefined) continue;
		// `XY ` then the path; for a rename or copy the ORIGIN follows as the
		// next bare record, which must be staged too or the delete is left out.
		paths.push(record.slice(3));
		if (record.startsWith("R") || record.startsWith("C")) {
			const origin = records[++index];
			if (origin !== undefined) paths.push(origin);
		}
	}
	return paths;
}

/**
 * The three commands that turn a prepared tree into a published release, in
 * order. Kept as data with no headline of its own because a dry run and a real
 * cut need opposite ones: after a real cut the bump is HEAD, after a dry run
 * nothing was written and pointing the operator at HEAD would be a lie. The
 * releasing doc quotes these same three steps, so they live in one place.
 */
export function nextSteps(version: string): string[] {
	return [
		"  1. Push the bump to main and let ordinary CI test it:",
		"         git push origin main",
		"",
		"  2. Wait for that commit to go green:",
		"         gh run watch --exit-status",
		"",
		"  3. Tag the green commit to publish it:",
		`         git tag v${version} && git push origin v${version}`,
		"",
		"  Step 3 is the release. Tagged CI builds the binaries, verifies their",
		"  checksums, and publishes the GitHub release the installer reads.",
	];
}

async function main(argv: readonly string[]): Promise<void> {
	const dryRun = argv.includes("--dry-run");
	const request = parseReleaseRequest(argv.filter(arg => arg !== "--dry-run"));

	// A real cut demands main and a clean tree: the bump commit must contain the
	// bump and nothing else. `--dry-run` writes nothing, so it stays usable from
	// a branch or a dirty tree and reports what a cut would decide right now —
	// that is the check worth running often, and gating it would make it useless.
	const branch = (await git("branch", "--show-current")).trim();
	const status = await git("status", "--porcelain");
	if (!dryRun) {
		if (branch !== "main") throw new Error(`Must be on main to prepare a release (currently on '${branch}').`);
		if (status.trim().length > 0) {
			throw new Error(
				`Uncommitted changes present. A release cut must start from a clean tree so the bump commit contains only the bump.\n${status}`,
			);
		}
	}

	// `git describe` exits 128 when no tag matches, which must not abort the
	// first release; `.nothrow()` has no execFile equivalent, so catch it.
	const described = await git("describe", "--tags", "--abbrev=0", "--match", "v*").catch(() => "");
	const latestTag = described.trim() || NO_TAG_BASELINE;

	const resolved = resolveReleaseVersion(request, latestTag);
	if (resolved.failure) {
		for (const line of resolved.failure) console.error(line);
		process.exit(1);
	}
	const version = resolved.version;
	console.log(`Preparing v${version} (latest tag ${latestTag}).\n`);

	// Refuse before writing anything. Empty `[Unreleased]` sections once rolled
	// into no version section at all, and v1.0.44 through v1.0.46 were tagged
	// and published with no changelog entry before the website build noticed.
	assertReleaseIsDocumented(version, await loadPackageChangelogs());
	console.log(`${RELEASE_NOTES_CHANGELOG} documents ${version}.\n`);

	if (dryRun) {
		console.log(`--dry-run: nothing was written. A real cut of v${version} would then need:\n`);
		if (branch !== "main") console.log(`  (a real cut refuses here: on '${branch}', not main)`);
		if (status.trim().length > 0) {
			const dirty = statusPaths(await git("status", "--porcelain", "-z")).length;
			console.log(`  (a real cut refuses here: ${dirty} uncommitted path(s))\n`);
		}
		for (const line of nextSteps(version)) console.log(line);
		return;
	}

	await prepareReleaseTree(version, latestTag);
	await validateReleaseVersionAuthorities(".", version, `v${version}`);

	const paths = statusPaths(await git("status", "--porcelain", "-z"));
	if (paths.length === 0) {
		// Every write above is idempotent, so re-cutting a version whose bump
		// commit already landed produces nothing. That is the recovery path, not
		// a failure: HEAD is already the tree to tag.
		console.log(`Nothing to commit; v${version}'s bump already landed. HEAD is ready to tag.`);
	} else {
		console.log(`Committing ${paths.length} path(s):`);
		for (const staged of paths) console.log(`  ${staged}`);
		await git("add", "--", ...paths);
		await git("commit", "--only", "-m", releaseBumpSubject(version), "--", ...paths);
	}

	console.log(`\nPrepared v${version} locally. Nothing has been pushed.\n`);
	console.log("  Review the cut:");
	console.log("      git show --stat HEAD\n");
	for (const line of nextSteps(version)) console.log(line);
}

if (import.meta.main) {
	main(process.argv.slice(2)).catch(error => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exit(1);
	});
}
