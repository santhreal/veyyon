#!/usr/bin/env bun
/**
 * Workflow-internal release cutter.
 *
 * The Release workflow invokes:
 *   bun scripts/release.ts <version|major|minor|patch>
 *
 * Operators use `bun run release [version]`; this process does not watch,
 * rebase, retry, or depend on a maintainer workstation.
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

/** Rewrite only a package manifest's own version, preserving every other byte. */
export function rewritePackageVersion(content: string, version: string): string {
	const pattern = /("version":\s*)"[^"]+"/;
	if (!pattern.test(content)) throw new Error('Package manifest has no top-level "version" field.');
	return content.replace(pattern, `$1"${version}"`);
}

/** Rewrite the root Cargo workspace version, never an unrelated package version. */
export function rewriteCargoWorkspaceVersion(content: string, version: string): string {
	const pattern = /^(\[workspace\.package\][\s\S]*?^version = ")[^"]+"/m;
	if (!pattern.test(content)) throw new Error("Cargo.toml has no [workspace.package] version.");
	return content.replace(pattern, `$1${version}"`);
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
 * Classify lib.rs' sentinel state for a cut of `sentinelName` (previous release
 * emitted `prevSentinelName`). `rewrite`: the ordinary cut — lib.rs still emits
 * the previous sentinel and the rename applies. `alreadyBumped`: a RE-CUT of a
 * version whose bump commit already landed on main but whose tag died before
 * publish (dead-tag delete, v1.0.37 2026-07-24) — the tree is already correct
 * and the cut must proceed without rewriting. `missing`: neither sentinel is
 * present — a genuinely inconsistent tree the cut must refuse.
 */
export function classifySentinelBumpState(
	libRsText: string,
	prevSentinelName: string,
	sentinelName: string,
): "rewrite" | "alreadyBumped" | "missing" {
	if (libRsText.includes(`js_name = "${prevSentinelName}"`)) return "rewrite";
	if (libRsText.includes(`js_name = "${sentinelName}"`)) return "alreadyBumped";
	return "missing";
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

async function prepareReleaseTree(version: string, latestTag: string): Promise<void> {
	console.log(`Updating package versions to ${version}…`);
	const pkgJsonPaths = await Array.fromAsync(packageJsonGlob.scan("."));
	const publicPkgPaths: string[] = [];
	for (const pkgPath of pkgJsonPaths) {
		const pkgJson = await Bun.file(pkgPath).json();
		if (pkgJson.private) {
			console.log(`  Skipping ${pkgJson.name} (private)`);
			continue;
		}
		publicPkgPaths.push(pkgPath);
	}
	for (const pkgPath of publicPkgPaths) {
		const file = Bun.file(pkgPath);
		const content = await file.text();
		await Bun.write(pkgPath, rewritePackageVersion(content, version));
	}
	console.log("  Verifying versions:");
	for (const pkgPath of publicPkgPaths) {
		const pkgJson = await Bun.file(pkgPath).json();
		console.log(`    ${pkgJson.name}: ${pkgJson.version}`);
	}
	console.log();

	console.log("Updating root catalog versions...");
	let rootPkgRaw = await Bun.file("package.json").text();
	rootPkgRaw = rootPkgRaw.replace(/("@veyyon\/[^"]+":\s*)"[^"]+"/g, `$1"${version}"`);
	await Bun.write("package.json", rootPkgRaw);
	console.log("  Updated root catalog @veyyon/* entries");

	console.log(`Updating Rust workspace version to ${version}…`);
	const cargoFile = Bun.file("Cargo.toml");
	const cargoBefore = await cargoFile.text();
	await Bun.write("Cargo.toml", rewriteCargoWorkspaceVersion(cargoBefore, version));
	const cargoToml = await Bun.file("Cargo.toml").text();
	const versionMatch = cargoToml.match(/^\[workspace\.package\][\s\S]*?^version = "([^"]+)"/m);
	if (versionMatch) console.log(`  workspace: ${versionMatch[1]}`);
	for await (const cargoPath of cargoTomlGlob.scan(".")) {
		const content = await Bun.file(cargoPath).text();
		if (!content.includes("version.workspace = true")) continue;
		const nameMatch = content.match(/^name = "([^"]+)"/m);
		if (nameMatch) console.log(`  ${nameMatch[1]}: ${version} (workspace)`);
	}
	console.log();

	console.log(`Bumping veyyon-natives version sentinel to v${version}…`);
	const { from: prevSentinelName, to: sentinelName } = planSentinelRewrite(latestTag, version);
	if (prevSentinelName === sentinelName) {
		throw new Error(
			`previous sentinel ${prevSentinelName} equals the new one — version ${version} is not ahead of ${latestTag}.`,
		);
	}
	const sentinelGlob = new Bun.Glob("{crates,packages}/**/*.{rs,ts,mts,cts,js,mjs,cjs}");
	const sentinelFiles: Array<{ path: string; content: string }> = [];
	for await (const path of sentinelGlob.scan(".")) {
		if (isSentinelRewriteExcluded(path)) continue;
		const content = await Bun.file(path).text();
		if (content.includes(prevSentinelName)) sentinelFiles.push({ path, content });
	}
	const libRsBefore = await Bun.file("crates/veyyon-natives/src/lib.rs").text();
	const sentinelState = classifySentinelBumpState(libRsBefore, prevSentinelName, sentinelName);
	if (sentinelState === "missing") {
		throw new Error(
			`could not locate the previous veyyon-natives sentinel ${prevSentinelName} or target ${sentinelName} in ` +
				"crates/veyyon-natives/src/lib.rs; reconcile lib.rs (or the latest tag) before releasing.",
		);
	}
	if (sentinelFiles.length > 0) {
		await Promise.all(
			sentinelFiles.map(file => Bun.write(file.path, file.content.replaceAll(prevSentinelName, sentinelName))),
		);
	}
	const libRs = await Bun.file("crates/veyyon-natives/src/lib.rs").text();
	if (!libRs.includes(`js_name = "${sentinelName}"`)) {
		throw new Error(
			`veyyon-natives version sentinel did not move to ${sentinelName} in crates/veyyon-natives/src/lib.rs.`,
		);
	}
	console.log(`  sentinel: ${sentinelName}${sentinelState === "alreadyBumped" ? " (already bumped)" : ""}\n`);

	// Preserve the reviewed dependency graph; refresh only workspace versions.
	console.log("Refreshing lockfiles...");
	await $`bun install`;
	await $`cargo generate-lockfile`;
	console.log();

	console.log("Updating CHANGELOGs...");
	const fixResult = await runChangelogFixer({});
	for (const fixed of fixResult.changedFiles) {
		console.log(
			`  Fixed ${fixed.path}: ${fixed.promotedItems} promoted, ` +
				`${fixed.mergedDuplicateHeadings} duplicate heading(s) merged, ` +
				`${fixed.mergedDuplicateVersions} duplicate version(s) merged, ` +
				`${fixed.removedEmptyHeadings} empty heading(s) removed`,
		);
	}
	await updateChangelogsForRelease(version);
	await Bun.write(ROOT_PATH, buildRootChangelog());
	console.log("  Updated CHANGELOG.md (repo root)\n");

	console.log("Running checks...");
	await $`bun run check`;
	console.log();
}

export interface ReleasePushOperations {
	currentSha(): Promise<string>;
	forceLocalTag(tag: string): Promise<void>;
	atomicPush(tag: string, sha: string): Promise<void>;
}

/**
 * Push the exact tree whose CI and Checks runs the release gate approved.
 *
 * One attempt only. If main advanced while preparation ran, the atomic push
 * fails without moving either main or the tag. The newer main SHA gets its own
 * CI and Checks runs, and their workflow completion starts a fresh release cut.
 * Rebasing here would publish a tree the exact-SHA gate never approved.
 */
export async function pushPreparedRelease(tag: string, operations: ReleasePushOperations): Promise<void> {
	const sha = await operations.currentSha();
	await operations.forceLocalTag(tag);
	await operations.atomicPush(tag, sha);
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

	// Prepare the exact tree that will be tagged. This helper is intentionally
	// idempotent: a rejected push rebases, then runs the whole preparation again
	// so concurrent main changes cannot bypass versioning, changelog finalization,
	// root generation, lock refresh, or checks.
	await prepareReleaseTree(version, latestTag);

	// 7. Commit. A re-cut of a version whose bump commit already landed (dead
	// tag deleted after a failed publish) can produce a zero diff here — every
	// version/sentinel/changelog write above was an idempotent no-op. `git
	// commit` on an empty tree fails and would wedge the train on a state that
	// is already correct, so tag the existing HEAD instead.
	console.log("Committing...");
	await git(["add", "."]);
	const staged = (await git(["status", "--porcelain"]).text()).trim();
	const hasReleaseCommit = staged.length > 0;
	if (!hasReleaseCommit) {
		console.log(`  nothing to commit (a prior cut of v${version} already landed the bump); tagging HEAD`);
	} else {
		await git(["commit", "-m", `chore: bump version to ${version}`]);
	}
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
	// Main can advance during preparation. Do not rebase or retry here: the gate
	// approved this exact SHA, not whatever arrived later. A rejected atomic push
	// leaves both remote refs untouched; the newer main workflow starts a fresh
	// cut after its own CI and Checks runs are green.
	await pushPreparedRelease(tagRef, {
		currentSha: async () => (await git(["rev-parse", "HEAD"]).text()).trim(),
		forceLocalTag: async tag => {
			await git(["tag", "-f", tag]);
		},
		atomicPush: async (tag, sha) => {
			await git(["push", "--atomic", "origin", "refs/heads/main:refs/heads/main", `${sha}:refs/tags/${tag}`]);
		},
	});
	console.log();

	// Publication is a separate workflow dispatch. Keeping this cutter finite
	// means it never polls, retries a newer tree, or depends on a workstation.
	console.log(`Pushed v${version}. The release workflow will dispatch the publish pipeline at that tag.`);
}

// =============================================================================
// Main
// =============================================================================

// Guard the CLI dispatch so importing this module from tests does not cut a release.
if (import.meta.main) {
	if (Bun.env.VEYYON_RELEASE_IN_CI !== "1") {
		console.error("This is the workflow-internal release cutter. Run bun run release [major|minor|patch|x.y.z].");
		process.exit(1);
	}

	const arg = process.argv[2];

	if (arg === "major" || arg === "minor" || arg === "patch" || /^\d+\.\d+\.\d+$/.test(arg ?? "")) {
		await cmdRelease(arg);
	} else {
		console.error("Usage: bun scripts/release.ts <version|major|minor|patch>");
		console.error("This workflow-internal cutter is invoked only by .github/workflows/release.yml.");
		process.exit(1);
	}
}
