#!/usr/bin/env bun
/**
 * Cut a release.
 *
 *     bun run release:dry <major|minor|patch|x.y.z>    say what a cut would do
 *     bun run release     <major|minor|patch|x.y.z>    do it
 *
 * That is the whole surface. The real one rolls every version authority and
 * changelog, commits the bump, shows you the commit and the tag, asks once,
 * then pushes main, waits for that commit's checks, and tags it. The tag is
 * what publishes; everything before it is local and reversible by doing
 * nothing.
 *
 * WHY THE BUMP IS WRITTEN HERE AND NOT IN CI. A tag must sit on a commit CI has
 * already tested green, and a bump commit created inside CI is by definition a
 * commit CI has never seen. The old controller tried to close that after the
 * fact: push the bump, dispatch Checks and CI at the new tag, wait for both.
 * Three CI rounds per release, a correlation nonce because `workflow_dispatch`
 * returns no run id, and a pinned alert issue for the partial states in
 * between. Writing the bump locally removes the hole rather than chasing it.
 *
 * WHY THERE IS NO `--yes`. The prompt is the approval, and a release that can
 * be published without a human answering it is the controller again. A dry run
 * is the non-interactive mode, and it is non-interactive precisely because it
 * publishes nothing.
 *
 * `docs/internal/releasing.md` is the same flow in prose.
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
import { nextSteps, shipRelease } from "./release-ship";

const execFileAsync = promisify(execFile);

/** No `v*` tag yet is veyyon's first-release state; treat it as a 0.0.0 baseline. */
export const NO_TAG_BASELINE = "0.0.0";

/**
 * How many dirty paths a dry run lists before summarizing the rest. Enough to
 * recognize a tree at a glance; short enough that the next steps below it stay
 * on screen, which is the part the operator came for.
 */
const DIRTY_PATHS_SHOWN = 12;

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
 * Every path a `git status --porcelain -z` run reports, restorable ones first.
 *
 * Staging is by explicit path rather than `git add -A` because this runs on a
 * developer machine, where the rule is that you stage what you changed and
 * nothing else. The tree was verified clean before preparation, so this list is
 * exactly what preparation produced — and printing it lets the operator see
 * that before it becomes a commit.
 */
export function statusPaths(porcelainZ: string): string[] {
	const { tracked, untracked } = preparationLeftovers(porcelainZ);
	return [...tracked, ...untracked];
}

/**
 * The same records, split by whether git can undo them.
 *
 * A tracked path is restorable: it has committed bytes to go back to. An
 * untracked path was created by preparation and has none, so nothing here
 * deletes it — a release script that removes files on a failure path is one
 * bug away from removing the wrong one. It gets named instead, which is the
 * corrective action the operator needs, because the next run's clean-tree
 * refusal otherwise reports a dirty tree with no clue which paths to look at.
 *
 * Both sides of a rename count as tracked. The origin's delete is a committed
 * path going missing, and restoring only the new side would leave the tree
 * still dirty and the retry still blocked.
 *
 * `-z` rather than plain `--porcelain`: the plain form C-quotes any path with a
 * space or a non-ASCII byte and renders a rename as `old -> new` inside one
 * line, so a naive split mints paths that do not exist. With `-z` the records
 * are NUL-separated, never quoted, and a rename's origin is its own record.
 */
export function preparationLeftovers(porcelainZ: string): { tracked: string[]; untracked: string[] } {
	const records = porcelainZ.split("\0").filter(record => record.length > 0);
	const tracked: string[] = [];
	const untracked: string[] = [];
	for (let index = 0; index < records.length; index++) {
		const record = records[index];
		if (record === undefined) continue;
		// `XY ` then the path; for a rename or copy the ORIGIN follows as the
		// next bare record, which must be staged too or the delete is left out.
		const path = record.slice(3);
		if (record.startsWith("??")) untracked.push(path);
		else tracked.push(path);
		if (record.startsWith("R") || record.startsWith("C")) {
			const origin = records[++index];
			if (origin !== undefined) tracked.push(origin);
		}
	}
	return { tracked, untracked };
}

/**
 * What to tell the operator after preparation failed and the tree was put back.
 *
 * The failure itself leads, because the restore is housekeeping and the cause
 * is the thing to fix. The counts follow so it is unambiguous that re-running
 * is safe: without them the operator has a tree that was rewritten by a command
 * that then failed, and no way to tell whether the rewrite survived.
 */
export function rollbackReport(
	failure: string,
	leftovers: { tracked: readonly string[]; untracked: readonly string[] },
): string[] {
	const lines = [failure, ""];
	if (leftovers.tracked.length > 0) {
		lines.push(
			`Preparation was rolled back: ${leftovers.tracked.length} modified path(s) restored to HEAD.`,
			"Fix the cause above and re-run; the tree is clean enough to start over.",
		);
	} else lines.push("Preparation wrote nothing that needed rolling back.");
	if (leftovers.untracked.length > 0) {
		lines.push(
			"",
			`It also created ${leftovers.untracked.length} new file(s), which are left in place:`,
			...leftovers.untracked.map(path => `  ${path}`),
			"Remove them yourself if they are not wanted; a real cut refuses while they are there.",
		);
	}
	return lines;
}

// `nextSteps` lives in `release-ship.ts`: this module imports that one, so the
// shared text has to sit on that side or the two form a cycle.

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
		console.log(`Dry run: nothing was written, and nothing was pushed.\n`);
		console.log(`A real cut would commit the v${version} bump, push main, wait for its checks, and tag it.\n`);
		if (branch !== "main") console.log(`  (a real cut refuses here: on '${branch}', not main)`);
		if (status.trim().length > 0) {
			const dirty = statusPaths(await git("status", "--porcelain", "-z"));
			console.log(`  (a real cut refuses here: ${dirty.length} uncommitted path(s))`);
			// Naming them is the point of running this before a cut. A bare count
			// sends the operator to `git status` to find out the one thing that
			// decides what to do next: whether the tree holds their own leftovers,
			// which they commit, or somebody else's in-flight work, which they must
			// not touch. This tree routinely carries both.
			for (const dirtyPath of dirty.slice(0, DIRTY_PATHS_SHOWN)) console.log(`      ${dirtyPath}`);
			if (dirty.length > DIRTY_PATHS_SHOWN) {
				console.log(`      … and ${dirty.length - DIRTY_PATHS_SHOWN} more`);
			}
			console.log("");
		}
		for (const line of nextSteps(version)) console.log(line);
		return;
	}

	// Preparation rewrites versions, lockfiles and every changelog before the
	// checks that can reject the result, so a failure anywhere past this line
	// used to leave the tree rewritten. The clean-tree refusal above then
	// blocked the retry, and the operator had to work out by hand which of ~40
	// dirty paths belonged to the release. Restoring is safe precisely because
	// that refusal ran: everything dirty now is preparation's own writing.
	try {
		await prepareReleaseTree(version, latestTag);
		await validateReleaseVersionAuthorities(".", version, `v${version}`);
	} catch (error) {
		const leftovers = preparationLeftovers(await git("status", "--porcelain", "-z"));
		// A restore that itself fails must not replace the real cause with a git
		// error, so the original failure is reported either way.
		if (leftovers.tracked.length > 0) {
			await git("checkout", "--", ...leftovers.tracked).catch(restoreError => {
				console.error(
					`Could not restore the tree: ${restoreError instanceof Error ? restoreError.message : String(restoreError)}`,
				);
			});
		}
		const failure = error instanceof Error ? error.message : String(error);
		throw new Error(rollbackReport(failure, leftovers).join("\n"));
	}

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

	console.log(`\nCommitted the v${version} bump. Nothing has been pushed yet.\n`);
	console.log("  Review the cut:");
	console.log("      git show --stat HEAD\n");
	await shipRelease(version);
}

if (import.meta.main) {
	main(process.argv.slice(2)).catch(error => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exit(1);
	});
}
