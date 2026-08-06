/**
 * The release gate: proof that a tag may become a published release.
 *
 * WHY THE TESTED-TREE PROOF IS THE WHOLE STORY. `v1.0.28` through `v1.0.35` were each tagged before
 * `ci.yml` had tested their sha. Two red `packages/utils` tests killed every publish downstream, and
 * `releases/latest` stayed at `v1.0.27` while the tags marched on. A tag asserts that a tested tree
 * shipped under that name.
 *
 * The release commit is now prepared locally (`scripts/prerelease.ts`) and pushed to main like any
 * other commit, so main's ordinary CI tests it before a tag exists. That turns the proof into one
 * question with one answer: is the tagged commit on main? A commit reachable from main is a commit
 * main's CI ran; anything else — a local branch, a rewritten commit, a fork — was never tested.
 * See {@link releaseTagRefusal}.
 *
 * Publication carries a second, independent proof: the complete asset manifest actually exists on
 * the release. See {@link verifyPublishedAssetManifest}.
 *
 * A cut carries a third, independent of both: the version being tagged is documented. See
 * {@link assertReleaseIsDocumented}.
 *
 * Each decision is a pure function of facts gathered separately, so every branch is tested without a
 * network: see `scripts/release-policy.test.ts`.
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isReleaseTag } from "@veyyon/utils/semver";
import { hasVersionHeading, unreleasedEntries } from "./changelog-unreleased.ts";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * How the tagged commit relates to `main`, as GitHub's compare API reports it
 * with `main` as the base.
 *
 * `identical` means the tag is main's tip; `behind` means the tag is an
 * ancestor of main, i.e. it landed and main moved on. Both mean the commit
 * went through main's CI. `ahead` and `diverged` mean it never did.
 */
export type MainComparison = "ahead" | "behind" | "diverged" | "identical";

export interface ReleaseTagFacts {
	tag: string;
	sha: string;
	/** HEAD of the tagged checkout, which must be the commit being published. */
	checkedOutSha: string | undefined;
	/** `undefined` when the comparison could not be established at all. */
	mainComparison: MainComparison | undefined;
}

/**
 * Why this tag may not publish, or `undefined` when it may.
 *
 * The old gate proved that the Release controller had dispatched this exact
 * run: a nonce encoding the controller's run id and attempt, an actor equal to
 * the release bot, and a correlated exact-tag Checks run. All of it existed to
 * make a bump commit that CI had never seen safe to publish, because the
 * controller created that commit inside CI and pushed it.
 *
 * The bump is now prepared and pushed by a person, so main's ordinary CI tests
 * it before any tag exists, and the property worth proving is the simple one:
 * this commit is on main. A commit reachable from main is a commit main's CI
 * ran. A tag on anything else — a local branch, a rewritten commit, a fork —
 * would publish bytes no gate ever tested, which is exactly what v1.0.28
 * through v1.0.35 did.
 *
 * Blindness is refusal, never a pass: an unestablished comparison means the
 * gate cannot see what it exists to check.
 */
export function releaseTagRefusal(facts: ReleaseTagFacts): string | undefined {
	if (!isReleaseTag(facts.tag)) return `release tag ${JSON.stringify(facts.tag)} is not strict vX.Y.Z semver`;
	if (facts.checkedOutSha === undefined) return `could not read the checked-out HEAD for ${facts.tag}`;
	if (facts.checkedOutSha !== facts.sha) {
		return `checked-out release SHA ${facts.checkedOutSha} does not match ${facts.sha}`;
	}
	if (facts.mainComparison === undefined) {
		return `could not establish whether ${facts.sha} is on main; refusing to publish ${facts.tag}`;
	}
	if (facts.mainComparison !== "identical" && facts.mainComparison !== "behind") {
		return [
			`${facts.tag} points at ${facts.sha}, which is not on main (compare against main: ${facts.mainComparison}).`,
			"Only a commit that landed on main has been tested by main's CI.",
			"Push the release commit to main, wait for CI, then tag the commit that went green.",
		].join(" ");
	}
	return undefined;
}

const RELEASE_ARTIFACTS = [
	"veyyon-linux-x64",
	"veyyon-linux-arm64",
	"veyyon-darwin-x64",
	"veyyon-darwin-arm64",
	"veyyon-windows-x64.exe",
	"veyyon_natives.linux-x64-baseline.node",
	"veyyon_natives.linux-x64-modern.node",
	"veyyon_natives.linux-arm64.node",
	"veyyon_natives.darwin-x64-baseline.node",
	"veyyon_natives.darwin-arm64.node",
	"veyyon_natives.win32-x64-baseline.node",
] as const;

/** Exact distribution manifest: every binary/native artifact and its installer checksum sidecar. */
export const REQUIRED_RELEASE_ASSET_NAMES: readonly string[] = Object.freeze(
	RELEASE_ARTIFACTS.flatMap(name => [name, `${name}.sha256`]),
);
const REQUIRED_RELEASE_ASSET_LOOKUP: Readonly<Record<string, true>> = Object.freeze(
	Object.fromEntries(REQUIRED_RELEASE_ASSET_NAMES.map(name => [name, true] as const)),
);

export interface PublishedAssetVerification {
	ok: boolean;
	missing: string[];
	unexpected: string[];
}

/** Compare GitHub's published asset names with the complete release manifest. */
export function verifyPublishedReleaseAssets(actualNames: readonly string[]): PublishedAssetVerification {
	const actual = new Set(actualNames);
	const missing = REQUIRED_RELEASE_ASSET_NAMES.filter(name => !actual.has(name));
	const unexpected = [...actual].filter(name => !REQUIRED_RELEASE_ASSET_LOOKUP[name]).sort();
	return { ok: missing.length === 0 && unexpected.length === 0, missing, unexpected };
}

export function assertPublishedReleaseAssets(actualNames: readonly string[]): void {
	const result = verifyPublishedReleaseAssets(actualNames);
	if (result.ok) return;
	const details = [
		result.missing.length ? `missing: ${result.missing.join(", ")}` : "",
		result.unexpected.length ? `unexpected: ${result.unexpected.join(", ")}` : "",
	].filter(Boolean);
	throw new Error(`published release asset manifest is incomplete or incoherent (${details.join("; ")})`);
}

/** Run `gh` and return stdout, or `undefined` when the call fails. */
async function gh(args: string[]): Promise<string | undefined> {
	const proc = Bun.spawn(["gh", ...args], { stdout: "pipe", stderr: "pipe" });
	const [out, err, code] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	if (code !== 0) {
		// Reported, never swallowed: a gh failure means the gate cannot see the evidence it exists to
		// check, and every caller turns that blindness into a refusal rather than a release.
		console.error(`gh ${args.join(" ")} failed (exit ${code}): ${err.trim()}`);
		return undefined;
	}
	return out;
}

/** The exact commit the controller has checked out. */
export async function checkedOutHeadSha(): Promise<string | undefined> {
	const proc = Bun.spawn(["git", "rev-parse", "HEAD"], { cwd: REPO_ROOT, stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	if (exitCode !== 0) {
		console.error(`git rev-parse HEAD failed (exit ${exitCode}): ${stderr.trim()}`);
		return undefined;
	}
	return stdout.trim();
}

/**
 * Refuse to publish a tag whose commit is not on main, or throw the reason.
 *
 * Asks GitHub rather than the local clone: a tag-ref checkout has no main to
 * compare against without a second fetch, and the remote is the authority on
 * what actually landed.
 */
export async function verifyReleaseTagIsOnMain(tag: string, sha: string): Promise<void> {
	const status = (await gh(["api", `repos/{owner}/{repo}/compare/main...${sha}`, "--jq", ".status"]))?.trim();
	const refusal = releaseTagRefusal({
		tag,
		sha,
		checkedOutSha: await checkedOutHeadSha(),
		mainComparison:
			status === "identical" || status === "behind" || status === "ahead" || status === "diverged"
				? status
				: undefined,
	});
	if (refusal) throw new Error(refusal);
	console.log(`verified ${tag} points at ${sha}, which is on main and therefore CI-tested.`);
}

export async function verifyPublishedAssetManifest(tag: string): Promise<void> {
	const output = await gh(["release", "view", tag, "--json", "assets", "--jq", ".assets[].name"]);
	if (output === undefined) throw new Error(`could not establish publication state for ${tag}`);
	const names = output
		.split("\n")
		.map(name => name.trim())
		.filter(Boolean);
	assertPublishedReleaseAssets(names);
	console.log(`verified ${names.length} exact release assets for ${tag}`);
}

// =============================================================================
// The third proof: the version being cut is documented
// =============================================================================

/**
 * The one changelog every published version is read back from.
 *
 * `website/tools/gen-changelog.mjs` reconciles published GitHub releases against this single file and
 * `reportUndocumentedReleases` fails the website build for any published version missing from it. A
 * package changelog that documents nothing costs nothing; this one costs a public, undocumented
 * release, so it is the file a cut may never leave behind.
 */
export const RELEASE_NOTES_CHANGELOG = "packages/coding-agent/CHANGELOG.md";

/** One package changelog, read as data so the gate is decided without a filesystem. */
export interface PackageChangelog {
	/** Repo-relative path, e.g. `packages/coding-agent/CHANGELOG.md`. */
	path: string;
	/** The owning package's manifest name, so an error names who has to write the entry. */
	name: string;
	content: string;
}

const MISSING_NOTES_FAILURE = `${RELEASE_NOTES_CHANGELOG} is missing; the release notes and the changelog page are built from it.`;

function label(changelog: PackageChangelog): string {
	return `${changelog.name} (${changelog.path})`;
}

function changelogGateError(version: string, headline: string, failures: readonly string[]): Error {
	return new Error(
		`${headline}\n- ${failures.join("\n- ")}\n` +
			`Write the entry under "## [Unreleased]" in ${RELEASE_NOTES_CHANGELOG}, land it on main, then dispatch ` +
			`the release again. There is no skip marker for this: a release publishes npm packages, a git tag and a ` +
			`GitHub release under ${version}, and every one of them is a promise that the changelog says what changed.`,
	);
}

/**
 * Why this version may not be cut yet, one line per offending package.
 *
 * Decided BEFORE the tree is touched, off the changelogs as they sit on main. An empty
 * `## [Unreleased]` used to be silently acceptable: `applyReleaseToChangelog` wrote no version section
 * and the cut proceeded, which is how v1.0.44, v1.0.45 and v1.0.46 each shipped with no entry at all.
 *
 * A version already carrying its own section passes: re-cutting a version whose bump commit landed
 * before a failed publish is a supported recovery, and its entry is already written.
 */
export function undocumentedReleaseFailures(version: string, changelogs: readonly PackageChangelog[]): string[] {
	const notes = changelogs.find(changelog => changelog.path === RELEASE_NOTES_CHANGELOG);
	if (!notes) return [MISSING_NOTES_FAILURE];
	if (hasVersionHeading(notes.content, version)) return [];
	if (unreleasedEntries(notes.content).length > 0) return [];
	return [`${label(notes)} has no bullet under "## [Unreleased]" and no "## [${version}]" section.`];
}

/** Refuse to cut a version nothing describes, before any file is written. */
export function assertReleaseIsDocumented(version: string, changelogs: readonly PackageChangelog[]): void {
	const failures = undocumentedReleaseFailures(version, changelogs);
	if (failures.length === 0) return;
	throw changelogGateError(version, `Release ${version} has nothing to document:`, failures);
}

/**
 * Why a prepared tree may not become a tag, one line per offending package.
 *
 * The post-condition of the changelog roll, checked against what the roll actually wrote. Two ways it
 * can be wrong: the version has no section in the changelog the release notes are built from, or a
 * package still holds bullets under `## [Unreleased]` (the roll found nothing to anchor to and left
 * real entries stranded, which is how `packages/hashline` once published a phantom version).
 */
export function preparedReleaseChangelogFailures(version: string, changelogs: readonly PackageChangelog[]): string[] {
	const failures: string[] = [];
	const notes = changelogs.find(changelog => changelog.path === RELEASE_NOTES_CHANGELOG);
	if (!notes) {
		failures.push(MISSING_NOTES_FAILURE);
	} else if (!hasVersionHeading(notes.content, version)) {
		failures.push(`${label(notes)} has no "## [${version}]" section after the changelog roll.`);
	}
	for (const changelog of changelogs) {
		const stranded = unreleasedEntries(changelog.content);
		if (stranded.length === 0) continue;
		failures.push(
			`${label(changelog)} still has ${stranded.length} bullet(s) under "## [Unreleased]" after the ` +
				`changelog roll, so they would ship inside ${version} undocumented.`,
		);
	}
	return failures;
}

/** Refuse to commit, tag or push a prepared tree whose changelogs do not describe the version. */
export function assertPreparedReleaseChangelogs(version: string, changelogs: readonly PackageChangelog[]): void {
	const failures = preparedReleaseChangelogFailures(version, changelogs);
	if (failures.length === 0) return;
	throw changelogGateError(version, `Release ${version} was prepared without a changelog entry:`, failures);
}
