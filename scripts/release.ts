#!/usr/bin/env bun
/**
 * Release script for pi-mono
 *
 * Usage:
 *   bun scripts/release.ts <version|major|minor|patch>   Full release (preflight, version, changelog, commit, push, watch)
 *   bun scripts/release.ts watch                         Watch CI for current commit
 *
 * Example: bun scripts/release.ts minor
 */
import { isNewerVersion } from "@veyyon/utils/semver";
import { $, Glob } from "bun";
import { runChangelogFixer } from "./fix-changelogs";
import { parseUnreleasedBullets } from "./require-changelog.ts";
import { buildRootChangelog, ROOT_PATH } from "./sync-root-changelog";

const changelogGlob = new Glob("packages/*/CHANGELOG.md");
const packageJsonGlob = new Glob("packages/*/package.json");
const cargoTomlGlob = new Glob("crates/*/Cargo.toml");

function git(args: readonly string[]) {
	return $`git -c core.fsmonitor=false -c core.untrackedCache=false -c fetch.pruneTags=false ${args}`;
}

// The `owner/repo` slug parsed from `origin`, cached. Every `gh` call in this
// script passes it as `-R` so the release watcher targets THIS repo. Without it,
// `gh` auto-resolves the repo from the remotes, and a checkout that also has an
// `upstream` remote (veyyon forks oh-my-pi) resolves to the fork's base — the
// watcher would then poll the wrong repo's runs and never see our release CI.
let _originRepoSlug: string | undefined;
async function originRepoSlug(): Promise<string> {
	if (_originRepoSlug) return _originRepoSlug;
	const url = (await git(["remote", "get-url", "origin"]).text()).trim();
	const match = url.match(/github\.com[/:]([^/]+)\/(.+?)(?:\.git)?$/);
	if (!match) {
		throw new Error(`Cannot parse a GitHub owner/repo from origin URL: ${url}`);
	}
	_originRepoSlug = `${match[1]}/${match[2]}`;
	return _originRepoSlug;
}

// =============================================================================
// Shared functions
// =============================================================================

// The workflow (ci.yml `name:`) that carries the release chain
// (release_binary → release_github → release_github_verify → release_site). The
// GitHub release is the only publish target; there is no npm or Homebrew step.
// The release outcome is gated on THIS workflow only: a sibling workflow
// (Security, Docs, Checks) that fails on the same commit must neither mask a
// successful publish nor abort the watch before the release chain finishes.
const RELEASE_WORKFLOW_NAME = "CI";

export interface WorkflowRun {
	databaseId: number;
	status: string; // "queued" | "in_progress" | "completed"
	conclusion: string | null; // "success" | "failure" | "cancelled" | "skipped" | null
	name: string; // workflow display name
}

export interface ReleaseGate {
	// "pending": the release workflow is still running (or not started) — keep watching.
	// "passed":  the release workflow finished green — the publish is done.
	// "failed":  the release workflow finished non-green — the release failed.
	state: "pending" | "passed" | "failed";
	// Runs of the release-bearing workflow. When NO run matches the release
	// workflow name (e.g. `release watch` on a non-release commit, or a fork
	// that renamed the workflow) this falls back to ALL runs so the watcher
	// still gates on something rather than reporting a vacuous pass.
	releaseRuns: WorkflowRun[];
	// Completed non-release runs that did NOT succeed. Surfaced loudly to the
	// operator but they do NOT gate the release outcome.
	siblingFailures: WorkflowRun[];
	usedFallback: boolean;
}

// A completed run/job counts as a failure for any terminal conclusion that is
// not success and not skipped (failure, cancelled, timed_out, action_required,
// startup_failure, …). `null` only appears while still pending.
function isFailureConclusion(conclusion: string | null): boolean {
	return conclusion !== null && conclusion !== "success" && conclusion !== "skipped";
}

/**
 * Decide the release outcome from the raw list of workflow runs for a commit.
 * Pure (no IO) so it can be unit-tested against synthetic run sets; watchCI
 * layers the gh log-tailing IO on top of this decision.
 */
export function decideReleaseGate(runs: WorkflowRun[], releaseWorkflow: string = RELEASE_WORKFLOW_NAME): ReleaseGate {
	const matching = runs.filter(r => r.name === releaseWorkflow);
	const usedFallback = matching.length === 0;
	const releaseRuns = usedFallback ? runs : matching;
	const siblingRuns = usedFallback ? [] : runs.filter(r => r.name !== releaseWorkflow);

	const siblingFailures = siblingRuns.filter(r => r.status === "completed" && isFailureConclusion(r.conclusion));

	let state: ReleaseGate["state"];
	if (releaseRuns.some(r => r.status === "completed" && isFailureConclusion(r.conclusion))) {
		state = "failed";
	} else if (releaseRuns.length > 0 && releaseRuns.every(r => r.status === "completed")) {
		state = "passed";
	} else {
		state = "pending";
	}

	return { state, releaseRuns, siblingFailures, usedFallback };
}

async function watchCI(): Promise<boolean> {
	const commitSha = (await git(["rev-parse", "HEAD"]).text()).trim();
	const repo = await originRepoSlug();
	console.log(`  Commit: ${commitSha.slice(0, 8)} (${repo})`);

	// Tail the last 20 lines of every failed job in a run (best-effort).
	const reportFailedJobs = async (databaseId: number, workflow: string): Promise<void> => {
		const jobsOutput = await $`gh run view -R ${repo} ${databaseId} --json jobs`.quiet().nothrow().text();
		let jobs: Array<{ name: string; databaseId: number; status: string; conclusion: string | null }> = [];
		try {
			({ jobs } = JSON.parse(jobsOutput));
		} catch {
			return;
		}
		for (const job of jobs) {
			if (job.status !== "completed" || !isFailureConclusion(job.conclusion)) continue;
			console.error(`  - ${workflow} / ${job.name} (job ${job.databaseId}): ${job.conclusion ?? "unknown"}`);
			const log = await $`gh run view -R ${repo} --job ${job.databaseId} --log-failed`.quiet().nothrow().text();
			if (log.trim()) {
				const tail = log.trimEnd().split("\n").slice(-20).join("\n");
				console.error(`\n--- Last 20 lines of ${job.name} (job ${job.databaseId}) ---\n${tail}\n`);
			}
		}
	};

	// Only surface each sibling-workflow failure once across polls.
	const warnedSiblings = new Set<string>();

	while (true) {
		const runsOutput =
			await $`gh run list -R ${repo} --commit ${commitSha} --json databaseId,status,conclusion,name`.text();
		const runs: WorkflowRun[] = JSON.parse(runsOutput);

		if (runs.length === 0) {
			console.log("  Waiting for CI to start...");
			await Bun.sleep(3000);
			continue;
		}

		const gate = decideReleaseGate(runs);

		// Fail fast within the release workflow: a completed-but-failed job in a
		// still-running release run means the chain cannot publish, so stop early
		// and tail the failure. Sibling runs are deliberately NOT scanned here.
		const releaseInProgress = gate.releaseRuns.filter(r => r.status === "in_progress" || r.status === "queued");
		for (const run of releaseInProgress) {
			const jobsOutput = await $`gh run view -R ${repo} ${run.databaseId} --json jobs`.quiet().nothrow().text();
			try {
				const { jobs } = JSON.parse(jobsOutput) as {
					jobs: Array<{ name: string; status: string; conclusion: string | null }>;
				};
				if (jobs.some(j => j.status === "completed" && isFailureConclusion(j.conclusion))) {
					console.error("\nRelease CI job failed:");
					await reportFailedJobs(run.databaseId, run.name);
					return false;
				}
			} catch {
				// Ignore parse errors; the run-level check below still gates.
			}
		}

		// Report newly-completed sibling failures loudly, but keep watching the
		// release chain — they do not gate the publish.
		for (const sibling of gate.siblingFailures) {
			const key = `${sibling.name}#${sibling.databaseId}`;
			if (warnedSiblings.has(key)) continue;
			warnedSiblings.add(key);
			console.error(`\n⚠ Non-release workflow failed (does NOT block publish, but fix it): ${sibling.name}`);
			await reportFailedJobs(sibling.databaseId, sibling.name);
		}

		const releasePending = gate.releaseRuns.filter(r => r.status !== "completed").length;
		const releasePassed = gate.releaseRuns.filter(r => r.status === "completed" && r.conclusion === "success").length;
		console.log(
			`  release: ${releasePassed} passed, ${releasePending} pending` +
				(gate.siblingFailures.length ? ` | ${gate.siblingFailures.length} sibling workflow(s) failing` : "") +
				(gate.usedFallback ? " (no CI workflow matched; gating on all runs)" : ""),
		);

		if (gate.state === "failed") {
			console.error("\nRelease CI failed:");
			for (const r of gate.releaseRuns.filter(r => r.status === "completed" && isFailureConclusion(r.conclusion))) {
				await reportFailedJobs(r.databaseId, r.name);
			}
			return false;
		}

		if (gate.state === "passed") {
			if (gate.siblingFailures.length > 0) {
				console.log(
					`  Release chain passed. NOTE: ${gate.siblingFailures.length} non-release workflow(s) are red — ` +
						`${gate.siblingFailures.map(s => s.name).join(", ")} — fix them, they don't block the publish.\n`,
				);
			} else {
				console.log("  All CI checks passed!\n");
			}
			return true;
		}

		await Bun.sleep(5000);
	}
}

function removeEmptyVersionEntries(content: string): string {
	// Remove version entries that have no content (just whitespace until next ## [ or EOF)
	return content.replace(/## \[\d+\.\d+\.\d+\] - \d{4}-\d{2}-\d{2}\s*\n(?=## \[|\s*$)/g, "");
}

/**
 * Roll a single changelog's `## [Unreleased]` into a dated `## [version]` entry.
 *
 * The fresh `## [Unreleased]` header stays exactly where the old one sat, and the
 * dated version section is inserted directly BELOW it. This matters for a
 * changelog whose `## [Unreleased]` lives under a fork-notice blockquote (e.g.
 * `packages/hashline/CHANGELOG.md`): a title-anchored insert (`# Changelog\n\n` +
 * a fresh `## [Unreleased]`) jammed `[Unreleased]` above the fork notice and left
 * the real bullets stranded in a phantom version that never published. When
 * `[Unreleased]` has no bullets, no version entry is created — using the SAME
 * bullet-based predicate (`parseUnreleasedBullets`) the release gate
 * (`has-releasable-changes`) decides on, so the two can never disagree: a stray
 * `### Fixed` header with no bullets does not mint a hollow version section for
 * one package just because another package triggered the cut. Any pre-existing
 * empty dated section is dropped either way. Pure so the ordering contract is
 * pinned by a test rather than only observed after a real release runs.
 */
export function applyReleaseToChangelog(content: string, version: string, date: string): string {
	if (parseUnreleasedBullets(content).length > 0) {
		content = content.replace("## [Unreleased]", `## [Unreleased]\n\n## [${version}] - ${date}`);
	}
	return removeEmptyVersionEntries(content);
}

async function updateChangelogsForRelease(version: string): Promise<void> {
	const date = new Date().toISOString().split("T")[0];

	for await (const changelog of changelogGlob.scan(".")) {
		const content = await Bun.file(changelog).text();

		if (!content.includes("## [Unreleased]")) {
			console.log(`  Skipping ${changelog}: no [Unreleased] section`);
			continue;
		}

		await Bun.write(changelog, applyReleaseToChangelog(content, version, date));
		console.log(`  Updated ${changelog}`);
	}
}

// =============================================================================
// Subcommands
// =============================================================================

async function cmdWatch(): Promise<void> {
	console.log("\n=== Watching CI ===\n");
	const success = await watchCI();
	process.exit(success ? 0 : 1);
}

export function parseVersion(v: string): [number, number, number] {
	const match = v.replace(/^v/, "").match(/^(\d+)\.(\d+)\.(\d+)/);
	if (!match) throw new Error(`Invalid version: ${v}`);
	return [parseInt(match[1], 10), parseInt(match[2], 10), parseInt(match[3], 10)];
}

export function bumpVersion(current: string, bump: "major" | "minor" | "patch"): string {
	const [major, minor, patch] = parseVersion(current);
	switch (bump) {
		case "major":
			return `${major + 1}.0.0`;
		case "minor":
			return `${major}.${minor + 1}.0`;
		case "patch":
			return `${major}.${minor}.${patch + 1}`;
	}
}

/** The `__veyyonNativesV…` sentinel export name for a version (non-alphanumerics -> `_`). */
export function sentinelExportName(version: string): string {
	return `__veyyonNativesV${version.replace(/^v/, "").replace(/[^A-Za-z0-9]/g, "_")}`;
}

/**
 * The single from->to sentinel rename a release performs: the PREVIOUS release's
 * sentinel to the new one. A release must never blanket-replace every
 * `__veyyonNativesV…` literal — the contract test pins historical fixtures
 * (`versionSentinelExportFor("1.0.14")` -> `"__veyyonNativesV1_0_14"`, and
 * V1_0_13/V16_5_2/V2_0_0_build_5) that must not track the current version, and a
 * blanket replace bricked the native test bucket on every bump. Only the current
 * build's sentinel (lib.rs `js_name`, its generated mirrors, and harnesses that
 * load the current `.node`) moves; every other version literal is left alone.
 */
export function planSentinelRewrite(prevVersion: string, nextVersion: string): { from: string; to: string } {
	return { from: sentinelExportName(prevVersion), to: sentinelExportName(nextVersion) };
}

/**
 * True for a source file the sentinel rewrite must NEVER touch even when it holds
 * the previous sentinel. Test files carry the sentinel as an intentional
 * historical FIXTURE (a `.toBe("__veyyonNativesV<prev>")` where `<prev>` is a
 * deliberate past version). Because `<prev>` can be the IMMEDIATELY previous
 * release, its literal equals the rewrite's `from`, so an `sd -F` rename clobbers
 * the fixture and bricks the native bucket — the recurring NATIVE-SENTINEL bug
 * (it re-fired on v1.0.19, rewriting a 1_0_18 fixture to 1_0_19). Only production
 * source that EMITS or mirrors the CURRENT sentinel must advance (lib.rs
 * `js_name`, the generated native/index.{js,d.ts}, the render-stress harnesses —
 * none of which are `.test.` files). The `.test.` filename convention excludes
 * `foo.test.ts` while keeping non-test mirrors like `render-stress-harness.ts`.
 */
export function isSentinelRewriteExcluded(file: string): boolean {
	return file.includes("node_modules") || file.includes("/dist/") || /\.test\.[cm]?[jt]s$/.test(file);
}

/**
 * Whether this run is the release workflow rather than a workstation. Set by
 * `.github/workflows/release.yml`; deliberately its own variable and not bare
 * `CI`, so a release run from any other CI context still behaves normally.
 */
function releaseRunsInCI(): boolean {
	return process.env.VEYYON_RELEASE_IN_CI === "1";
}

async function cmdRelease(versionOrBump: string): Promise<void> {
	console.log("\n=== Release Script ===\n");

	// 1. Pre-flight checks
	console.log("Pre-flight checks...");

	const branch = await git(["branch", "--show-current"]).text();
	if (branch.trim() !== "main") {
		console.error(`Error: Must be on main branch (currently on '${branch.trim()}')`);
		process.exit(1);
	}
	console.log("  On main branch");

	const status = await git(["status", "--porcelain"]).text();
	if (status.trim()) {
		console.error("Error: Uncommitted changes detected. Commit or stash first.");
		console.error(status);
		process.exit(1);
	}
	console.log("  Working directory clean");

	// No `v*` tag yet is the expected state for veyyon's first release — it forked
	// oh-my-pi's source (and its inherited changelog history) but carried over none
	// of its git tags, and cuts its own release line starting at 1.0.0. Treat the
	// empty result as a 0.0.0 baseline so `release major` yields 1.0.0 and an
	// explicit `1.0.0` passes the monotonicity check below, instead of `git
	// describe` exiting 128 and aborting the whole release.
	const describe = await git(["describe", "--tags", "--abbrev=0", "--match", "v*"]).nothrow().text();
	const latestTag = describe.trim() || "0.0.0";
	let version = versionOrBump;
	if (version === "major" || version === "minor" || version === "patch") {
		version = bumpVersion(latestTag, version);
		console.log(`Bumping ${versionOrBump} version from ${latestTag} -> ${version}`);
	}

	if (!isNewerVersion(version, latestTag)) {
		console.error(`Error: Version ${version} must be greater than latest tag ${latestTag}`);
		process.exit(1);
	}
	console.log(`  Version ${version} > ${latestTag}\n`);

	// 2. Update package versions
	console.log(`Updating package versions to ${version}…`);
	const pkgJsonPaths = await Array.fromAsync(packageJsonGlob.scan("."));

	// Filter out private packages
	const publicPkgPaths: string[] = [];
	for (const pkgPath of pkgJsonPaths) {
		const pkgJson = await Bun.file(pkgPath).json();
		if (pkgJson.private) {
			console.log(`  Skipping ${pkgJson.name} (private)`);
			continue;
		}
		publicPkgPaths.push(pkgPath);
	}

	await $`sd '"version": "[^"]+"' ${`"version": "${version}"`} ${publicPkgPaths}`;

	// Verify
	console.log("  Verifying versions:");
	for (const pkgPath of publicPkgPaths) {
		const pkgJson = await Bun.file(pkgPath).json();
		console.log(`    ${pkgJson.name}: ${pkgJson.version}`);
	}
	console.log();

	// Update @veyyon/* catalog entries in root package.json
	console.log("Updating root catalog versions...");
	let rootPkgRaw = await Bun.file("package.json").text();
	rootPkgRaw = rootPkgRaw.replace(/("@veyyon\/[^"]+":\s*)"[^"]+"/g, `$1"${version}"`);
	await Bun.write("package.json", rootPkgRaw);
	console.log("  Updated root catalog @veyyon/* entries");

	// 3. Update Rust workspace version
	console.log(`Updating Rust workspace version to ${version}…`);
	await $`sd '^version = "[^"]+"' ${`version = "${version}"`} Cargo.toml`;

	// Verify
	const cargoToml = await Bun.file("Cargo.toml").text();
	const versionMatch = cargoToml.match(/^\[workspace\.package\][\s\S]*?^version = "([^"]+)"/m);
	if (versionMatch) {
		console.log(`  workspace: ${versionMatch[1]}`);
	}

	// List crates using workspace version
	for await (const cargoPath of cargoTomlGlob.scan(".")) {
		const content = await Bun.file(cargoPath).text();
		if (content.includes("version.workspace = true")) {
			const nameMatch = content.match(/^name = "([^"]+)"/m);
			if (nameMatch) {
				console.log(`  ${nameMatch[1]}: ${version} (workspace)`);
			}
		}
	}
	console.log();

	// 3b. Rename the veyyon-natives version sentinel so any `.node` left on disk from
	// a previous release physically cannot expose the symbol the new `index.js`
	// expects. The JS loader derives `VERSION_SENTINEL_EXPORT` from `package.json`
	// at runtime, so the only thing that has to move on the Rust side is the
	// `js_name = "__veyyonNativesV…"` literal. `gen-enums.ts` regenerates the matching
	// entries in `packages/natives/native/{index.d.ts,index.js}` on the next napi
	// build, but bump them here too so the committed surface tracks the version
	// without waiting for a local rebuild on the release host.
	console.log(`Bumping veyyon-natives version sentinel to v${version}…`);
	// planSentinelRewrite returns ONLY the previous->new sentinel rename (see its
	// doc: a blanket replace of every `__veyyonNativesV…` literal bricked the
	// native test bucket every release by rewriting the contract test's historical
	// fixtures). Discover the files that reference the previous sentinel with
	// Bun.Glob (the release runner has no rg/grep) and rename it literally.
	const { from: prevSentinelName, to: sentinelName } = planSentinelRewrite(latestTag, version);
	if (prevSentinelName === sentinelName) {
		console.error(
			`Error: previous sentinel ${prevSentinelName} equals the new one — version ${version} is not ahead of ${latestTag}.`,
		);
		process.exit(1);
	}
	const sentinelGlob = new Bun.Glob("{crates,packages}/**/*.{rs,ts,mts,cts,js,mjs,cjs}");
	const sentinelFiles: string[] = [];
	for await (const file of sentinelGlob.scan(".")) {
		// Skip vendored/build outputs and, crucially, TEST files: a test can hold
		// the previous sentinel as an intentional fixture, and rewriting it bricks
		// the native bucket. Single owner: isSentinelRewriteExcluded (release.ts).
		if (isSentinelRewriteExcluded(file)) continue;
		if ((await Bun.file(file).text()).includes(prevSentinelName)) {
			sentinelFiles.push(file);
		}
	}
	if (!sentinelFiles.includes("crates/veyyon-natives/src/lib.rs")) {
		console.error(
			`Error: could not locate the previous veyyon-natives sentinel ${prevSentinelName} in ` +
				"crates/veyyon-natives/src/lib.rs. It must currently emit the previous release's sentinel; " +
				"reconcile lib.rs (or the latest tag) before releasing.",
		);
		process.exit(1);
	}
	await $`sd -F ${prevSentinelName} ${sentinelName} ${sentinelFiles}`;
	const libRs = await Bun.file("crates/veyyon-natives/src/lib.rs").text();
	if (!libRs.includes(`js_name = "${sentinelName}"`)) {
		console.error(
			`Error: veyyon-natives version sentinel did not move to ${sentinelName} in crates/veyyon-natives/src/lib.rs. ` +
				"The `__veyyonNativesV…` literal may have been removed or renamed; restore it before releasing.",
		);
		process.exit(1);
	}
	console.log(`  sentinel: ${sentinelName}\n`);

	// 4. Regenerate lockfiles
	console.log("Regenerating lockfiles...");
	await $`rm -f bun.lock`;
	await $`bun install`;
	await $`cargo generate-lockfile`;
	console.log();

	// 5. Update changelogs
	console.log("Updating CHANGELOGs...");
	// Omit `since` so the fixer resolves its own baseline: the `clog` tag (last
	// authoritative rewrite) when newer than `latestTag`, else `latestTag`. This
	// keeps a release run from re-promoting bullets a prior `--recover` restored.
	const fixResult = await runChangelogFixer({});
	for (const fixed of fixResult.changedFiles) {
		console.log(
			`  Fixed ${fixed.path}: ${fixed.promotedItems} promoted, ` +
				`${fixed.mergedDuplicateHeadings} duplicate heading(s) merged, ` +
				`${fixed.removedEmptyHeadings} empty heading(s) removed`,
		);
	}
	await updateChangelogsForRelease(version);
	// Regenerate the repo-root CHANGELOG.md from the just-finalized source so the
	// changelog GitHub shows on the repo page carries this release. Same render
	// the website uses; the `changelog:root:check` CI guard fails if it drifts.
	await Bun.write(ROOT_PATH, buildRootChangelog());
	console.log("  Updated CHANGELOG.md (repo root)");
	console.log();

	// 6. Run checks
	console.log("Running checks...");
	await $`bun run check`;
	console.log();

	// 7. Commit
	console.log("Committing...");
	await git(["add", "."]);
	await git(["commit", "-m", `chore: bump version to ${version}`]);
	console.log();

	// 8. Tag, then push branch + tag atomically — pushing the tag by object id.
	//
	// This repo is in the global `[maintenance] repo = …` list, so a scheduled
	// `git maintenance run` fetches origin with `fetch.pruneTags=true` (set
	// globally) and deletes any local tag not yet on the remote — i.e. the
	// brand-new release tag. The `-c fetch.pruneTags=false` on our git wrapper
	// only governs our own git calls, not the concurrent maintenance process, so
	// a local tag ref may vanish before or while the push resolves it.
	//
	// A bare push refspec (`refs/tags/v…` with no `:dst`) re-resolves the tag on
	// disk during refspec matching (git's remote.c:match_explicit); if the prune
	// lands in that window git dies with
	// "refs/tags/v… cannot be resolved to branch", and if it lands before the
	// push it dies with "src refspec … does not match any". We sidestep both by
	// pushing the HEAD commit object id straight into the remote tag ref
	// (`<sha>:refs/tags/v…`): the push has no dependency on a local tag, and the
	// commit is reachable from main so maintenance cannot prune it. The local
	// tag we still create is only for `git describe`; losing it is harmless. The
	// default Git LFS pre-push hook uploads the branch's LFS objects as part of
	// this same atomic push — no separate `git lfs push` is needed.
	console.log("Tagging and pushing to remote...");
	const tagRef = `v${version}`;
	// `bun run check` above takes minutes, and main is a busy branch (concurrent
	// pushes land during that window). A single atomic push of the bump commit
	// then loses the race with `! [rejected] main -> main (fetch first)` and the
	// release dies with the tree fully checked but never shipped. Retry: on a
	// rejection, rebase the one version-bump commit onto the advanced origin/main
	// and push again. The bump only rewrites version files (package.json, Cargo
	// tomls, the lockfile, CHANGELOG, the natives sentinel), so replaying it over
	// unrelated fleet commits is normally conflict-free; a real conflict (someone
	// else bumped versions) aborts loudly rather than force over anyone's work.
	// The check is NOT re-run per attempt — that would lengthen the race window,
	// and the tag we push triggers the full CI release chain (release_binary
	// `needs: check`), which re-validates the exact shipped tree before anything
	// is published, so no unchecked state can ship. main is never force-pushed
	// (it must fast-forward after the rebase); only the tag ref is forced, so a
	// stale tag from a prior failed attempt is overwritten.
	const maxPushAttempts = 10;
	for (let attempt = 1; ; attempt++) {
		const sha = (await git(["rev-parse", "HEAD"]).text()).trim();
		await git(["tag", "-f", tagRef]);
		try {
			await git(["push", "--atomic", "origin", "refs/heads/main:refs/heads/main", `+${sha}:refs/tags/${tagRef}`]);
			break;
		} catch (pushErr) {
			if (attempt >= maxPushAttempts) {
				console.error(
					`Atomic push of the release bump was rejected ${maxPushAttempts} times running; main is advancing faster than the release can rebase onto it. Re-run the release.`,
				);
				throw pushErr;
			}
			console.log(
				`  push rejected (attempt ${attempt}/${maxPushAttempts}); rebasing the bump onto origin/main and retrying…`,
			);
			await git(["fetch", "origin", "main"]);
			try {
				await git(["rebase", "origin/main"]);
			} catch (rebaseErr) {
				await git(["rebase", "--abort"]).nothrow();
				console.error(
					"Rebasing the version-bump commit onto origin/main hit a conflict (a concurrent commit touched the same version files). Aborting so no half-pushed release is left; re-run the release.",
				);
				throw rebaseErr;
			}
		}
	}
	console.log();

	// 9. Watch CI
	//
	// Skipped when the release itself is running as a CI job: the push above
	// starts the release run, and this script is not the thing that should sit
	// and poll it. The dispatching workflow reports its own outcome, and
	// `bun scripts/release.ts watch` re-attaches from a workstation if someone
	// wants to follow along.
	if (releaseRunsInCI()) {
		console.log(`Pushed v${version}. The release run picks it up from here.`);
		return;
	}

	console.log("Watching CI...");
	const success = await watchCI();

	if (success) {
		console.log(`=== Released v${version} ===`);
	} else {
		// CI's `concurrency` block (.github/workflows/ci.yml) recognizes a
		// release run by its `chore: bump version to X.Y.Z` subject (#2564),
		// so retries that keep that subject also get the per-sha, never-cancel
		// group. Reword the body, not the subject.
		console.log("\nTo retry after fixing (repeat until CI passes):");
		console.log(`  git commit -m "chore: bump version to ${version}" -m "<what was fixed>"`);
		console.log(`  git tag -f v${version}`);
		console.log(
			`  git push --atomic origin refs/heads/main:refs/heads/main "+$(git rev-parse HEAD):refs/tags/v${version}"`,
		);
		console.log("  bun scripts/release.ts watch");
		process.exit(1);
	}
}

// =============================================================================
// Main
// =============================================================================

// Guard the CLI dispatch so importing this module (e.g. from release-watch.test.ts
// to unit-test decideReleaseGate) does not execute the release/watch commands.
if (import.meta.main) {
	const arg = process.argv[2];

	if (!arg) {
		console.error("Usage:");
		console.error("  bun scripts/release.ts <version|major|minor|patch>   Full release");
		console.error("  bun scripts/release.ts watch                         Watch CI for current commit");
		process.exit(1);
	}

	if (arg === "watch") {
		await cmdWatch();
	} else if (arg === "major" || arg === "minor" || arg === "patch" || /^\d+\.\d+\.\d+$/.test(arg)) {
		await cmdRelease(arg);
	} else {
		console.error(`Unknown command or invalid version: ${arg}`);
		console.error("Usage:");
		console.error("  bun scripts/release.ts <version|major|minor|patch>   Full release");
		console.error("  bun scripts/release.ts watch                         Watch CI for current commit");
		process.exit(1);
	}
}
