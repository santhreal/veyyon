#!/usr/bin/env bun
/**
 * Decide whether the release gate cuts, including when a previous cut was stranded.
 *
 * The gate's only signal used to be "a publishable package has an `## [Unreleased]` bullet". That is
 * self-limiting and correct while cuts succeed, and it strands work the moment one does not:
 * `release.ts` MOVES `## [Unreleased]` into the new version's section at cut time, before CI publishes.
 * So a cut whose CI then fails leaves a tag with no GitHub release -- a SILENT TAG -- and an empty
 * `## [Unreleased]`. The gate then says there is nothing to release, forever, and the user-facing work
 * sits in a version section nobody can install. Observed live: `v1.0.33` and `v1.0.34` were both cut,
 * both failed CI on the same source lock, and the published release stayed at `v1.0.27`.
 *
 * The release-notes script already knows silent tags happen: it rolls their sections into the next
 * published release. This is the same knowledge on the CUT side.
 *
 * WHY A RE-CUT RATHER THAN A RE-RUN. Re-running the failed tag's CI reruns the same commit, and the
 * commit that fixes the failure is by definition newer than the tag, so a rerun fails exactly as it did
 * before. Recovering the stranded work means cutting a new tag from a main that contains the fix.
 *
 * WHY IT CANNOT INFLATE VERSIONS. Two bounds, both required:
 *
 *  1. A re-cut needs main to have MOVED past the failed tag. Cutting the same tree again would fail the
 *     same way, and it is the case where a rerun and a re-cut are equally useless.
 *  2. At most {@link MAX_STRANDED_TAGS} silent tags may exist. A second consecutive stranded cut means
 *     the failure is not a flake and a third tag will not fix it, so the gate refuses and says so
 *     loudly. That is the exact shape of the incident this exists for, and the answer to it is a person,
 *     not another version number.
 *
 * The decision is a pure function of facts gathered elsewhere, so every branch is tested without a
 * network: see `scripts/release-gate-decision.test.ts`.
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { hasReleasableChanges } from "./has-releasable-changes.ts";
import { discoverPackages } from "./require-changelog.ts";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * How many unpublished tags may exist before the gate stops cutting and asks for a person.
 *
 * Two, because one stranded tag is the flake this recovers from and two in a row is a real failure that
 * a third tag will not fix. `v1.0.33` and `v1.0.34` were exactly that pair.
 */
export const MAX_STRANDED_TAGS = 2;

/** A CI conclusion, as the GitHub API reports it. `null` means the run has not finished. */
export type CiConclusion = "success" | "failure" | "cancelled" | "timed_out" | "skipped" | "neutral" | null;

/** A tag newer than the latest published release, and what its CI run concluded. */
export interface SilentTag {
	/** The tag name, e.g. `v1.0.34`. */
	tag: string;
	/** The commit the tag points at, to compare against main HEAD. */
	sha: string;
	/** The conclusion of the CI run for that sha, or `null` while it is still running. */
	conclusion: CiConclusion;
}

export interface ReleaseGateFacts {
	/** True when a publishable package's `## [Unreleased]` section holds a bullet. */
	hasUnreleasedBullets: boolean;
	/** Tags newer than the latest PUBLISHED release, newest first. Empty in the healthy case. */
	silentTags: SilentTag[];
	/** The commit the gate would release. */
	mainHeadSha: string;
}

export interface ReleaseGateDecision {
	/** Whether to cut a patch release. */
	cut: boolean;
	/** Why, in one line, for the workflow log. Always populated, including when cutting. */
	reason: string;
	/**
	 * True when the gate is refusing something a person needs to look at: work is stranded and the gate
	 * will not recover it on its own. The workflow turns this into a visible warning rather than an
	 * ordinary "nothing to release" line, because a silent refusal here is how `v1.0.27` stayed the
	 * published version while two releases' worth of work sat in the changelog.
	 */
	needsAttention: boolean;
}

/** CI conclusions that mean the run is over and did not publish. */
const FAILED_CONCLUSIONS: ReadonlySet<string> = new Set(["failure", "cancelled", "timed_out"]);

/**
 * Decide the gate from facts alone.
 *
 * Order matters. The ordinary path is checked first and is untouched by any of this: a waiting
 * `## [Unreleased]` bullet cuts, exactly as before. Everything after it only runs when the changelog
 * says there is nothing to ship, which is the state a stranded cut leaves behind.
 */
export function decideReleaseGate(facts: ReleaseGateFacts): ReleaseGateDecision {
	if (facts.hasUnreleasedBullets) {
		return {
			cut: true,
			reason: "an Unreleased changelog bullet is waiting; cutting a patch release.",
			needsAttention: false,
		};
	}

	const silent = facts.silentTags;
	if (silent.length === 0) {
		return { cut: false, reason: "nothing unreleased and no unpublished tag; not releasing.", needsAttention: false };
	}

	if (silent.length >= MAX_STRANDED_TAGS) {
		return {
			cut: false,
			reason:
				`${silent.length} tags are unpublished (${silent.map(t => t.tag).join(", ")}). ` +
				"Two stranded cuts in a row is not a flake, and another tag will not fix it: " +
				"fix the failing publish, then re-run the release workflow by hand.",
			needsAttention: true,
		};
	}

	const [newest] = silent;
	if (!newest) {
		// Unreachable: length is 1 here. Stated rather than asserted so a future edit that changes the
		// bound cannot turn this into an undefined dereference.
		return { cut: false, reason: "no unpublished tag to inspect; not releasing.", needsAttention: false };
	}

	if (newest.conclusion === null) {
		return {
			cut: false,
			reason: `${newest.tag} has CI still running; waiting for it rather than cutting over it.`,
			needsAttention: false,
		};
	}

	if (!FAILED_CONCLUSIONS.has(newest.conclusion)) {
		// CI succeeded and yet no release exists for the tag. Cutting a new version would not fix that
		// and would bury the evidence, so this is reported and left alone.
		return {
			cut: false,
			reason:
				`${newest.tag} has a successful CI run (${newest.conclusion}) but no published release. ` +
				"That is a publish step that reported success without creating the release; look at that run.",
			needsAttention: true,
		};
	}

	if (newest.sha === facts.mainHeadSha) {
		return {
			cut: false,
			reason:
				`${newest.tag} failed CI (${newest.conclusion}) and points at main HEAD, so a re-cut would ` +
				"test the same tree and fail the same way. Land the fix first.",
			needsAttention: true,
		};
	}

	return {
		cut: true,
		reason:
			`${newest.tag} failed CI (${newest.conclusion}) with no published release, and main has moved ` +
			"since: re-cutting to recover the stranded changelog sections.",
		needsAttention: false,
	};
}

/** Read every publishable package's changelog, as `has-releasable-changes` does. */
async function readReleasableChangelogs(repoRoot: string): Promise<string[]> {
	const packages = await discoverPackages(repoRoot);
	const contents: string[] = [];
	for (const pkg of packages) {
		const file = Bun.file(join(repoRoot, pkg.dir, "CHANGELOG.md"));
		contents.push((await file.exists()) ? await file.text() : "");
	}
	return contents;
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
		// Reported, never swallowed: a gh failure means the stranded-tag half of the gate is blind, and a
		// blind gate that prints "nothing to release" is the exact silence this script exists to remove.
		console.error(`gh ${args.join(" ")} failed (exit ${code}): ${err.trim()}`);
		return undefined;
	}
	return out;
}

/** Semver-ish comparison of `vX.Y.Z` tags. Returns > 0 when `a` is newer. */
function compareVersions(a: string, b: string): number {
	const parse = (tag: string): number[] => tag.replace(/^v/, "").split(".").map(Number);
	const left = parse(a);
	const right = parse(b);
	for (let i = 0; i < Math.max(left.length, right.length); i++) {
		const diff = (left[i] ?? 0) - (right[i] ?? 0);
		if (diff !== 0) return diff;
	}
	return 0;
}

/** Gather the facts from git and the GitHub API. `undefined` when the API could not be reached. */
async function gatherFacts(): Promise<ReleaseGateFacts | undefined> {
	const hasUnreleasedBullets = hasReleasableChanges(await readReleasableChangelogs(REPO_ROOT));
	const mainHeadSha = (await gh(["api", "repos/{owner}/{repo}/commits/main", "--jq", ".sha"]))?.trim();
	if (mainHeadSha === undefined) return undefined;

	// The latest PUBLISHED release, which is the line a silent tag is above.
	const latestPublished = (
		await gh(["release", "list", "--limit", "1", "--json", "tagName", "--jq", ".[0].tagName"])
	)?.trim();
	if (latestPublished === undefined) return undefined;

	const releasedTags = new Set(
		((await gh(["release", "list", "--limit", "50", "--json", "tagName", "--jq", ".[].tagName"])) ?? "")
			.split("\n")
			.map(line => line.trim())
			.filter(line => line.length > 0),
	);

	const tagLines = (
		(await gh(["api", "repos/{owner}/{repo}/tags?per_page=50", "--jq", '.[] | .name + " " + .commit.sha'])) ?? ""
	)
		.split("\n")
		.map(line => line.trim())
		.filter(line => line.length > 0);

	const silentTags: SilentTag[] = [];
	for (const line of tagLines) {
		const [tag, sha] = line.split(" ");
		if (!tag || !sha) continue;
		if (!/^v\d+\.\d+\.\d+$/.test(tag)) continue;
		if (releasedTags.has(tag)) continue;
		if (latestPublished.length > 0 && compareVersions(tag, latestPublished) <= 0) continue;
		const conclusion = (
			await gh([
				"api",
				`repos/{owner}/{repo}/actions/runs?head_sha=${sha}&per_page=1`,
				"--jq",
				".workflow_runs[0].conclusion",
			])
		)?.trim();
		silentTags.push({
			tag,
			sha,
			conclusion: conclusion === "null" || !conclusion ? null : (conclusion as CiConclusion),
		});
	}
	silentTags.sort((a, b) => compareVersions(b.tag, a.tag));

	return { hasUnreleasedBullets, silentTags, mainHeadSha };
}

if (import.meta.main) {
	const facts = await gatherFacts();
	if (!facts) {
		// Fall back to the changelog signal alone, LOUDLY. The alternative is refusing every release
		// whenever the API is unreachable, which turns a transient outage into a release freeze.
		const hasUnreleasedBullets = hasReleasableChanges(await readReleasableChangelogs(REPO_ROOT));
		console.error(
			"could not reach the GitHub API; deciding on the changelog alone, so a stranded tag will not be recovered.",
		);
		console.log(hasUnreleasedBullets ? "true" : "false");
		process.exit(0);
	}

	const decision = decideReleaseGate(facts);
	console.error(decision.needsAttention ? `RELEASE NEEDS ATTENTION: ${decision.reason}` : decision.reason);
	console.log(decision.cut ? "true" : "false");
}
