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
 * network: see `scripts/release-policy.test.ts`.
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

/** Every independently scheduled public source gate must be green for the exact main commit. */
export const REQUIRED_SOURCE_WORKFLOWS = ["CI", "Checks"] as const;
export const RELEASE_BOT_LOGIN = "github-actions[bot]";

export interface SourceWorkflowRun {
	name: string;
	headSha: string;
	status: string;
	conclusion: string | null;
}

/** Exact-tag gates that must independently prove a release commit before CI may publish it. */
export const REQUIRED_RELEASE_TAG_WORKFLOWS = ["checks.yml"] as const;

export interface ReleaseTagWorkflowRun {
	headSha: string;
	headBranch: string;
	event: string;
	conclusion: string | null;
	displayTitle: string;
	actor: string;
}

/**
 * Require successful workflow-dispatch evidence for the immutable tag and SHA.
 *
 * File identities are used instead of mutable display names. A successful run
 * on main at the same SHA does not satisfy a tag-ref release.
 */
export function assertReleaseTagGateEvidence(
	tag: string,
	sha: string,
	expectedTitle: string,
	runsByWorkflow: Readonly<Record<string, readonly ReleaseTagWorkflowRun[]>>,
): void {
	if (!/^v\d+\.\d+\.\d+$/.test(tag)) {
		throw new Error(`release tag ${JSON.stringify(tag)} is not strict vX.Y.Z semver`);
	}
	for (const workflow of REQUIRED_RELEASE_TAG_WORKFLOWS) {
		const exactSuccess = runsByWorkflow[workflow]?.some(
			run =>
				run.headSha === sha &&
				run.headBranch === tag &&
				run.event === "workflow_dispatch" &&
				run.conclusion === "success" &&
				run.displayTitle === expectedTitle &&
				run.actor === RELEASE_BOT_LOGIN,
		);
		if (!exactSuccess) {
			throw new Error(`${workflow} has no controller-correlated successful run for ${tag} at ${sha}`);
		}
	}
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

/** A GitHub Actions conclusion. `null` is valid only before completion. */
export type CiConclusion =
	| "action_required"
	| "cancelled"
	| "failure"
	| "neutral"
	| "skipped"
	| "stale"
	| "startup_failure"
	| "success"
	| "timed_out"
	| null;

/** A tag newer than the latest published release and its furthest release run. */
export interface SilentTag {
	tag: string;
	sha: string;
	workflow: "CI" | "Checks" | null;
	status: string | null;
	conclusion: CiConclusion;
}

export interface ReleaseGateFacts {
	/** True when a publishable package's `## [Unreleased]` section holds a bullet. */
	hasUnreleasedBullets: boolean;
	/** Tags newer than the latest PUBLISHED release, newest first. Empty in the healthy case. */
	silentTags: SilentTag[];
	/** The commit the gate would release. */
	mainHeadSha: string;
	/** Workflow runs observed for this exact main commit, newest run first. */
	sourceWorkflowRuns: SourceWorkflowRun[];
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
const FAILED_CONCLUSIONS: Readonly<Record<string, true>> = Object.freeze({
	action_required: true,
	failure: true,
	cancelled: true,
	timed_out: true,
	stale: true,
	startup_failure: true,
});
const KNOWN_CONCLUSIONS: Readonly<Record<string, true>> = Object.freeze({
	action_required: true,
	cancelled: true,
	failure: true,
	neutral: true,
	skipped: true,
	stale: true,
	startup_failure: true,
	success: true,
	timed_out: true,
});

/**
 * Decide the gate from facts alone. Exact-SHA CI and Checks evidence is always
 * evaluated first; changelog and stranded-tag signals may choose whether to cut
 * only after both product gates are green.
 */
export function requiredSourceGate(facts: ReleaseGateFacts): ReleaseGateDecision | undefined {
	for (const name of REQUIRED_SOURCE_WORKFLOWS) {
		const run = facts.sourceWorkflowRuns.find(
			candidate => candidate.name === name && candidate.headSha === facts.mainHeadSha,
		);
		if (!run) {
			return {
				cut: false,
				reason: `${name} has no run for exact main SHA ${facts.mainHeadSha}; waiting rather than releasing an unproved tree.`,
				needsAttention: false,
			};
		}
		if (run.status !== "completed") {
			return {
				cut: false,
				reason: `${name} is ${run.status} for exact main SHA ${facts.mainHeadSha}; waiting for a green result.`,
				needsAttention: false,
			};
		}
		if (run.conclusion !== "success") {
			return {
				cut: false,
				reason: `${name} concluded ${run.conclusion ?? "without a conclusion"} for exact main SHA ${facts.mainHeadSha}; release is blocked.`,
				needsAttention: true,
			};
		}
	}
	return undefined;
}

export function decideReleaseGate(facts: ReleaseGateFacts): ReleaseGateDecision {
	const sourceGate = requiredSourceGate(facts);
	if (sourceGate) return sourceGate;

	const silent = facts.silentTags;
	if (silent.length === 0) {
		if (facts.hasUnreleasedBullets) {
			return {
				cut: true,
				reason: "an Unreleased changelog bullet is waiting; cutting a patch release.",
				needsAttention: false,
			};
		}
		return { cut: false, reason: "nothing unreleased and no unpublished tag; not releasing.", needsAttention: false };
	}

	const [newest] = silent;
	if (!newest) {
		return { cut: false, reason: "no unpublished tag to inspect; not releasing.", needsAttention: false };
	}
	const workflow = newest.workflow ?? "release workflow";
	if (newest.status === null) {
		return {
			cut: false,
			reason: `${newest.tag} has no tagged Checks or CI run; the controller stopped after pushing the tag.`,
			needsAttention: true,
		};
	}
	if (newest.status !== "completed") {
		return {
			cut: false,
			reason:
				newest.status === "in_progress"
					? `${newest.tag} has ${workflow} still running; waiting rather than cutting over it.`
					: `${newest.tag} has ${workflow} ${newest.status}; waiting rather than cutting over it.`,
			needsAttention: false,
		};
	}
	if (newest.conclusion === null) {
		return {
			cut: false,
			reason: `${newest.tag} has completed ${workflow} without a conclusion; release state is unknowable.`,
			needsAttention: true,
		};
	}
	if (!FAILED_CONCLUSIONS[newest.conclusion]) {
		return {
			cut: false,
			reason:
				`${newest.tag} has ${workflow} concluded ${newest.conclusion} but no published release. ` +
				"That is a publish step that reported success without creating the release; look at that run.",
			needsAttention: true,
		};
	}
	if (silent.length >= MAX_STRANDED_TAGS) {
		return {
			cut: false,
			reason:
				`${silent.length} tags are unpublished (${silent.map(tag => tag.tag).join(", ")}). ` +
				"Two stranded cuts in a row is not a flake, and another tag will not fix it: " +
				"fix the failing publish, then re-run the release workflow by hand.",
			needsAttention: true,
		};
	}
	if (newest.sha === facts.mainHeadSha) {
		return {
			cut: false,
			reason:
				`${newest.tag} failed ${workflow} (${newest.conclusion}) and points at main HEAD, so a re-cut would ` +
				"test the same tree and fail the same way. Land the fix first.",
			needsAttention: true,
		};
	}
	return {
		cut: true,
		reason:
			`${newest.tag} failed ${workflow} (${newest.conclusion}) with no published release, and main has moved ` +
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

interface ExactTagRunState {
	workflow: "CI" | "Checks";
	status: string;
	conclusion: CiConclusion;
}

async function readExactTagRun(
	workflow: "CI" | "Checks",
	file: "ci.yml" | "checks.yml",
	sha: string,
	tag: string,
): Promise<ExactTagRunState | null | undefined> {
	const output = await gh([
		"api",
		`repos/{owner}/{repo}/actions/workflows/${file}/runs?head_sha=${sha}&branch=${tag}&event=workflow_dispatch&per_page=1`,
		"--jq",
		'.workflow_runs[0] | if . == null then "" else [.status, (.conclusion // "")] | @tsv end',
	]);
	if (output === undefined) return undefined;
	const line = output.trim();
	if (!line) return null;
	const [status, conclusionText = ""] = line.split("\t");
	if (!status || (conclusionText && !KNOWN_CONCLUSIONS[conclusionText])) {
		console.error(`${file} exact-tag run evidence had an invalid state`);
		return undefined;
	}
	return {
		workflow,
		status,
		conclusion: conclusionText ? (conclusionText as Exclude<CiConclusion, null>) : null,
	};
}

/** Resolve the exact tree whose changelogs the gate read. */
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

function parseReleaseTagWorkflowRuns(raw: string, workflow: string): ReleaseTagWorkflowRun[] {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		throw new Error(`${workflow} run evidence was not valid JSON`);
	}
	if (!Array.isArray(parsed)) throw new Error(`${workflow} run evidence was not an array`);
	return parsed.map((entry, index) => {
		if (
			typeof entry !== "object" ||
			entry === null ||
			typeof (entry as Record<string, unknown>).headSha !== "string" ||
			typeof (entry as Record<string, unknown>).headBranch !== "string" ||
			typeof (entry as Record<string, unknown>).event !== "string" ||
			typeof (entry as Record<string, unknown>).displayTitle !== "string" ||
			typeof (entry as Record<string, unknown>).actor !== "string" ||
			!["string", "object"].includes(typeof (entry as Record<string, unknown>).conclusion)
		) {
			throw new Error(`${workflow} run evidence row ${index} had an invalid shape`);
		}
		const row = entry as Record<string, unknown>;
		if (row.conclusion !== null && typeof row.conclusion !== "string") {
			throw new Error(`${workflow} run evidence row ${index} had an invalid conclusion`);
		}
		return {
			headSha: row.headSha as string,
			headBranch: row.headBranch as string,
			event: row.event as string,
			conclusion: row.conclusion as string | null,
			displayTitle: row.displayTitle as string,
			actor: row.actor as string,
		};
	});
}

export async function verifyReleaseTagGates(
	tag: string,
	sha: string,
	ciNonce: string,
	dispatchActor: string,
): Promise<void> {
	const checkedOutSha = await checkedOutHeadSha();
	if (checkedOutSha === undefined || checkedOutSha !== sha) {
		throw new Error(`checked-out release SHA ${checkedOutSha ?? "unknown"} does not match ${sha}`);
	}
	if (dispatchActor !== RELEASE_BOT_LOGIN) {
		throw new Error(
			`release publication dispatch actor ${JSON.stringify(dispatchActor)} is not ${RELEASE_BOT_LOGIN}`,
		);
	}
	const nonceMatch = ciNonce.match(/^([1-9]\d*)-([1-9]\d*)-ci$/);
	if (!nonceMatch) throw new Error("release publication requires a controller-issued CI nonce");
	const runId = Number(nonceMatch[1]);
	const runAttempt = Number(nonceMatch[2]);
	if (!Number.isSafeInteger(runId) || !Number.isSafeInteger(runAttempt)) {
		throw new Error("release publication nonce contains an invalid controller run identity");
	}
	const parentOutput = await gh([
		"api",
		`repos/{owner}/{repo}/actions/runs/${runId}`,
		"--jq",
		"{path:.path,event:.event,status:.status,conclusion:.conclusion,runAttempt:.run_attempt}",
	]);
	if (parentOutput === undefined) throw new Error(`could not establish Release controller run ${runId}`);
	let parent: unknown;
	try {
		parent = JSON.parse(parentOutput);
	} catch {
		throw new Error(`Release controller run ${runId} returned invalid evidence`);
	}
	const parentRow = parent as Record<string, unknown>;
	if (
		typeof parent !== "object" ||
		parent === null ||
		parentRow.path !== ".github/workflows/release.yml" ||
		!["workflow_run", "workflow_dispatch"].includes(String(parentRow.event)) ||
		parentRow.status !== "in_progress" ||
		parentRow.conclusion !== null ||
		parentRow.runAttempt !== runAttempt
	) {
		throw new Error(`Release controller run ${runId} attempt ${runAttempt} is not the active parent`);
	}

	const checksTitle = `Checks release gate ${runId}-${runAttempt}-checks`;
	const runsByWorkflow: Record<string, ReleaseTagWorkflowRun[]> = {};
	for (const workflow of REQUIRED_RELEASE_TAG_WORKFLOWS) {
		const output = await gh([
			"api",
			`repos/{owner}/{repo}/actions/workflows/${workflow}/runs?head_sha=${sha}&branch=${tag}&event=workflow_dispatch&per_page=100`,
			"--jq",
			"[.workflow_runs[] | {headSha:.head_sha,headBranch:.head_branch,event:.event,conclusion:.conclusion,displayTitle:.display_title,actor:.actor.login}]",
		]);
		if (output === undefined) throw new Error(`could not establish ${workflow} run evidence`);
		runsByWorkflow[workflow] = parseReleaseTagWorkflowRuns(output, workflow);
	}
	assertReleaseTagGateEvidence(tag, sha, checksTitle, runsByWorkflow);
	console.log(`verified Release controller ${runId} and exact-tag Checks for ${tag} at ${sha}`);
}

/** Gather exact-tree workflow, changelog, tag, and publication facts. */
export async function gatherReleaseGateFacts(): Promise<ReleaseGateFacts | undefined> {
	const hasUnreleasedBullets = hasReleasableChanges(await readReleasableChangelogs(REPO_ROOT));
	const localHeadSha = await checkedOutHeadSha();
	if (localHeadSha === undefined) return undefined;
	const remoteMainSha = (await gh(["api", "repos/{owner}/{repo}/commits/main", "--jq", ".sha"]))?.trim();
	if (remoteMainSha === undefined) return undefined;
	if (remoteMainSha !== localHeadSha) {
		console.error(
			`checked-out main is ${localHeadSha}, but GitHub main is ${remoteMainSha}; exact-SHA gate is stale`,
		);
		return undefined;
	}
	const mainHeadSha = localHeadSha;

	const sourceWorkflowRuns: SourceWorkflowRun[] = [];
	for (const [name, workflow] of [
		["CI", "ci.yml"],
		["Checks", "checks.yml"],
	] as const) {
		const output = await gh([
			"api",
			`repos/{owner}/{repo}/actions/workflows/${workflow}/runs?head_sha=${mainHeadSha}&branch=main&event=push&per_page=1`,
			"--jq",
			'.workflow_runs[0] | if . == null then "" else [.head_sha, .status, (.conclusion // "")] | @tsv end',
		]);
		if (output === undefined) return undefined;
		const line = output.trim();
		if (!line) continue;
		const [headSha, status, conclusion = ""] = line.split("\t");
		if (!headSha || !status) {
			console.error(`${workflow} source gate evidence had an invalid shape`);
			return undefined;
		}
		sourceWorkflowRuns.push({ name, headSha, status, conclusion: conclusion || null });
	}

	// The latest PUBLISHED release, which is the line a silent tag is above.
	const latestPublished = (
		await gh([
			"release",
			"list",
			"--limit",
			"1",
			"--exclude-drafts",
			"--exclude-pre-releases",
			"--json",
			"tagName",
			"--jq",
			".[0].tagName",
		])
	)?.trim();
	if (latestPublished === undefined) return undefined;

	const releasedTagsOutput = await gh([
		"release",
		"list",
		"--limit",
		"50",
		"--exclude-drafts",
		"--exclude-pre-releases",
		"--json",
		"tagName",
		"--jq",
		".[].tagName",
	]);
	if (releasedTagsOutput === undefined) return undefined;
	const releasedTags = new Set(
		releasedTagsOutput
			.split("\n")
			.map(line => line.trim())
			.filter(line => line.length > 0),
	);

	const tagOutput = await gh([
		"api",
		"repos/{owner}/{repo}/tags?per_page=50",
		"--jq",
		'.[] | .name + " " + .commit.sha',
	]);
	if (tagOutput === undefined) return undefined;
	const tagLines = tagOutput
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
		let run = await readExactTagRun("CI", "ci.yml", sha, tag);
		if (run === undefined) return undefined;
		if (run === null) {
			run = await readExactTagRun("Checks", "checks.yml", sha, tag);
			if (run === undefined) return undefined;
		}
		silentTags.push({
			tag,
			sha,
			workflow: run?.workflow ?? null,
			status: run?.status ?? null,
			conclusion: run?.conclusion ?? null,
		});
	}
	silentTags.sort((a, b) => compareVersions(b.tag, a.tag));

	return { hasUnreleasedBullets, silentTags, mainHeadSha, sourceWorkflowRuns };
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
