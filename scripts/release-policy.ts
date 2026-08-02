/**
 * The release gate: proof that a dispatched release may cut, and proof that a cut may publish.
 *
 * A release happens because a person dispatched one, never because repository state looked ready.
 * What this file decides is narrower and harder than "should we release": whether the exact commit
 * the operator named is allowed to become a tag, and whether an existing tag is allowed to become a
 * published GitHub release.
 *
 * WHY THE EXACT-SHA PROOF IS THE WHOLE STORY. `v1.0.28` through `v1.0.35` were each tagged before
 * `ci.yml` had tested their sha. Two red `packages/utils` tests killed every publish downstream, and
 * `releases/latest` stayed at `v1.0.27` while the tags marched on. A tag asserts that a tested tree
 * shipped under that name, so the gate refuses any commit whose CI and Checks runs are not both green
 * for that precise sha. A green run for a neighbouring commit is not evidence about this one.
 *
 * Publication is a second, independent proof: the immutable tag ref, the release commit sha, the
 * controller run identity, and the bot actor must all agree before CI may publish bytes.
 *
 * Both decisions are pure functions of facts gathered separately, so every branch is tested without a
 * network: see `scripts/release-policy.test.ts`.
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

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

export interface ReleaseGateFacts {
	/** The commit the operator asked to release. */
	mainHeadSha: string;
	/** Workflow runs observed for this exact main commit, newest run first. */
	sourceWorkflowRuns: SourceWorkflowRun[];
}

/**
 * The one-line reason this tree may not be released, or `undefined` when every required source
 * workflow is green for the exact commit.
 *
 * Nothing relaxes this: a missing run, an unfinished run, a run for a neighbouring commit, and a red
 * run are all the same answer, because none of them proves the tree the operator named.
 */
export function sourceGateFailure(facts: ReleaseGateFacts): string | undefined {
	for (const name of REQUIRED_SOURCE_WORKFLOWS) {
		const run = facts.sourceWorkflowRuns.find(
			candidate => candidate.name === name && candidate.headSha === facts.mainHeadSha,
		);
		if (!run) {
			return `${name} has no run for exact main SHA ${facts.mainHeadSha}; refusing to release an unproved tree.`;
		}
		if (run.status !== "completed") {
			return `${name} is ${run.status} for exact main SHA ${facts.mainHeadSha}; there is no green result to release.`;
		}
		if (run.conclusion !== "success") {
			return `${name} concluded ${run.conclusion ?? "without a conclusion"} for exact main SHA ${facts.mainHeadSha}; release is blocked.`;
		}
	}
	return undefined;
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

/** Gather the exact-commit CI and Checks evidence the dispatch gate is decided from. */
export async function gatherReleaseGateFacts(): Promise<ReleaseGateFacts | undefined> {
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

	return { mainHeadSha, sourceWorkflowRuns };
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
