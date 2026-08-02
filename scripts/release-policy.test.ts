/**
 * The release gate's two proofs: which commit may be cut, and which tag may publish.
 *
 * WHY THIS SUITE EXISTS. A release is dispatched by a person, so this gate is the only thing standing
 * between a mistyped SHA and a tag. Each branch is pinned by name rather than covered in aggregate,
 * because the failure it prevents happened live: `v1.0.28` through `v1.0.35` were each tagged before
 * `ci.yml` had tested their sha, two red tests killed every publish downstream, and `releases/latest`
 * sat at `v1.0.27` while the tags marched on.
 *
 * The dispatch is also the ONLY trigger. A `workflow_run` completion used to cut a patch release
 * whenever a publishable package had an `## [Unreleased]` bullet; that is gone, and the CLI must
 * refuse a workflow_run-shaped event outright rather than quietly finding a version to cut.
 */

import { describe, expect, it } from "bun:test";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	assertReleaseTagGateEvidence,
	REQUIRED_RELEASE_ASSET_NAMES,
	REQUIRED_RELEASE_TAG_WORKFLOWS,
	REQUIRED_SOURCE_WORKFLOWS,
	type ReleaseTagWorkflowRun,
	type SourceWorkflowRun,
	sourceGateFailure,
	verifyPublishedReleaseAssets,
} from "./release-policy.ts";

const MAIN = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const OLDER = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CHECKS_TITLE = "Checks release gate 9001-2-checks";

async function runTagGateCli() {
	const sha = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: REPO_ROOT }).stdout.toString().trim();
	const bin = mkdtempSync(join(tmpdir(), "release-tag-gate-cli-"));
	const fakeGh = join(bin, "gh");
	const callsPath = join(bin, "calls.log");
	writeFileSync(
		fakeGh,
		`#!/bin/sh
printf '%s\\n' "$*" >> "$CALLS_PATH"
case "$*" in
  *"actions/runs/9001"*)
    printf '{"path":".github/workflows/release.yml","event":"workflow_dispatch","status":"in_progress","conclusion":null,"runAttempt":2}\n' ;;
  *"actions/workflows/checks.yml/runs?head_sha="*)
    printf '[{"headSha":"%s","headBranch":"v1.2.3","event":"workflow_dispatch","conclusion":"success","displayTitle":"Checks release gate 9001-2-checks","actor":"github-actions[bot]"}]\n' "$FAKE_SHA" ;;
  *) echo "unexpected gh invocation: $*" >&2; exit 88 ;;
esac
`,
	);
	chmodSync(fakeGh, 0o755);
	const proc = Bun.spawn(
		["bun", "scripts/release.ts", "verify-tag", "v1.2.3", sha, "9001-2-ci", "github-actions[bot]"],
		{
			cwd: REPO_ROOT,
			env: {
				...process.env,
				PATH: `${bin}:${process.env.PATH ?? ""}`,
				CALLS_PATH: callsPath,
				FAKE_SHA: sha,
			},
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return {
		exitCode,
		output: `${stdout}\n${stderr}`,
		calls: await Bun.file(callsPath).text(),
	};
}

describe("exact-tag publication provenance", () => {
	/**
	 * Publication is allowed only after the immutable-tag Checks workflow
	 * succeeded for the exact release commit.
	 */
	it("accepts an exact successful Checks tag run", () => {
		const success: ReleaseTagWorkflowRun = {
			headSha: MAIN,
			headBranch: "v1.2.3",
			event: "workflow_dispatch",
			conclusion: "success",
			displayTitle: CHECKS_TITLE,
			actor: "github-actions[bot]",
		};

		expect(() =>
			assertReleaseTagGateEvidence("v1.2.3", MAIN, CHECKS_TITLE, {
				"checks.yml": [success],
			}),
		).not.toThrow();
		expect(REQUIRED_RELEASE_TAG_WORKFLOWS).toEqual(["checks.yml"]);
	});
	/**
	 * The production CLI must query the workflow files themselves and accept the
	 * exact tag/SHA tuple before CI enables publication.
	 */
	it("verifies exact-tag provenance through the real CLI boundary", async () => {
		const result = await runTagGateCli();

		expect(result.exitCode).toBe(0);
		expect(result.output).toContain("verified Release controller 9001 and exact-tag Checks for v1.2.3");
		expect(result.calls).toContain("actions/runs/9001");
	});

	/**
	 * A green run for another commit cannot authorize bytes built from this tag,
	 * even when its branch and event look like a release run.
	 */
	it("rejects successful gate evidence from another SHA", () => {
		const wrongSha: ReleaseTagWorkflowRun = {
			headSha: OLDER,
			headBranch: "v1.2.3",
			event: "workflow_dispatch",
			conclusion: "success",
			displayTitle: CHECKS_TITLE,
			actor: "github-actions[bot]",
		};

		expect(() =>
			assertReleaseTagGateEvidence("v1.2.3", MAIN, CHECKS_TITLE, {
				"checks.yml": [wrongSha],
			}),
		).toThrow("checks.yml has no controller-correlated successful run");
	});

	/**
	 * Main and a tag can point at the same commit. A manual main run still does
	 * not prove the immutable tag ref release.yml intended to verify.
	 */
	it("rejects main-branch evidence at the same SHA", () => {
		const mainRun: ReleaseTagWorkflowRun = {
			headSha: MAIN,
			headBranch: "main",
			event: "workflow_dispatch",
			conclusion: "success",
			displayTitle: CHECKS_TITLE,
			actor: "github-actions[bot]",
		};

		expect(() =>
			assertReleaseTagGateEvidence("v1.2.3", MAIN, CHECKS_TITLE, {
				"checks.yml": [mainRun],
			}),
		).toThrow("checks.yml has no controller-correlated successful run");
	});

	/**
	 * A human or stale Checks dispatch can share the same tag and SHA. It cannot
	 * authorize publication without the active controller title and bot actor.
	 */
	it("rejects stale titles and non-controller actors", () => {
		const base: ReleaseTagWorkflowRun = {
			headSha: MAIN,
			headBranch: "v1.2.3",
			event: "workflow_dispatch",
			conclusion: "success",
			displayTitle: CHECKS_TITLE,
			actor: "github-actions[bot]",
		};
		for (const run of [
			{ ...base, displayTitle: "Checks release gate 8000-1-checks" },
			{ ...base, actor: "release-operator" },
		]) {
			expect(() =>
				assertReleaseTagGateEvidence("v1.2.3", MAIN, CHECKS_TITLE, {
					"checks.yml": [run],
				}),
			).toThrow("no controller-correlated successful run");
		}
	});

	/**
	 * Loose v-prefix tags used to enter the publication path. Strict semver keeps
	 * aliases and malformed tags from choosing an ambiguous release identity.
	 */
	it("rejects malformed release tags before reading workflow evidence", () => {
		expect(() => assertReleaseTagGateEvidence("v1junk", MAIN, CHECKS_TITLE, {})).toThrow(
			"is not strict vX.Y.Z semver",
		);
	});
});

async function runGateCli(options: {
	checks?: "success" | "failure" | "missing";
	failGh?: boolean;
	eventName?: string;
}) {
	const sha = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: REPO_ROOT }).stdout.toString().trim();
	const bin = mkdtempSync(join(tmpdir(), "release-gate-cli-"));
	const fakeGh = join(bin, "gh");
	const outputPath = join(bin, "github-output");
	const callsPath = join(bin, "calls");
	writeFileSync(callsPath, "");
	writeFileSync(outputPath, "");
	writeFileSync(
		fakeGh,
		`#!/bin/sh
printf '%s\\n' "$*" >> "$CALLS_PATH"
if [ "$FAIL_GH" = "1" ]; then echo unavailable >&2; exit 9; fi
case "$*" in
  *"commits/main"*) printf '%s\\n' "$FAKE_SHA" ;;
  *"actions/workflows/ci.yml/runs?head_sha=$FAKE_SHA&branch=main&event=push&per_page=1"*)
    printf '%s\\tcompleted\\tsuccess\\n' "$FAKE_SHA" ;;
  *"actions/workflows/checks.yml/runs?head_sha=$FAKE_SHA&branch=main&event=push&per_page=1"*)
    if [ "$CHECKS" != "missing" ]; then printf '%s\\tcompleted\\t%s\\n' "$FAKE_SHA" "$CHECKS"; fi ;;
  *) echo "unexpected gh invocation: $*" >&2; exit 88 ;;
esac
`,
	);
	chmodSync(fakeGh, 0o755);
	const proc = Bun.spawn(["bun", "scripts/release.ts", "workflow-gate"], {
		cwd: REPO_ROOT,
		env: {
			...process.env,
			PATH: `${bin}:${process.env.PATH ?? ""}`,
			FAKE_SHA: sha,
			CALLS_PATH: callsPath,
			CHECKS: options.checks ?? "success",
			FAIL_GH: options.failGh ? "1" : "0",
			GITHUB_EVENT_NAME: options.eventName ?? "workflow_dispatch",
			GITHUB_OUTPUT: outputPath,
			RELEASE_DISPATCH_VERSION: "patch",
			RELEASE_EXPECTED_SHA: sha,
		},
		stdout: "pipe",
		stderr: "pipe",
	});
	const [exitCode, stdout, stderr] = await Promise.all([
		proc.exited,
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	return {
		sha,
		exitCode,
		stdout,
		stderr,
		output: await Bun.file(outputPath).text(),
		calls: await Bun.file(callsPath).text(),
	};
}

function greenSourceRuns(sha = MAIN): SourceWorkflowRun[] {
	return REQUIRED_SOURCE_WORKFLOWS.map(name => ({
		name,
		headSha: sha,
		status: "completed",
		conclusion: "success",
	}));
}

describe("exact-source gates", () => {
	/**
	 * The dispatched commit is releasable only when every required workflow is green for that exact
	 * sha. This is the whole safety story now that nothing cuts automatically.
	 */
	it("passes only when every required workflow is green for the exact main SHA", () => {
		expect(sourceGateFailure({ mainHeadSha: MAIN, sourceWorkflowRuns: greenSourceRuns() })).toBeUndefined();

		for (const missingName of REQUIRED_SOURCE_WORKFLOWS) {
			const runs = greenSourceRuns().filter(run => run.name !== missingName);
			expect(sourceGateFailure({ mainHeadSha: MAIN, sourceWorkflowRuns: runs })).toBe(
				`${missingName} has no run for exact main SHA ${MAIN}; refusing to release an unproved tree.`,
			);
		}
	});

	it("blocks a red, cancelled, unfinished, or inconclusive exact-SHA run", () => {
		const cases = [
			{
				run: { status: "completed", conclusion: "failure" },
				reason: `Checks concluded failure for exact main SHA ${MAIN}; release is blocked.`,
			},
			{
				run: { status: "completed", conclusion: "cancelled" },
				reason: `Checks concluded cancelled for exact main SHA ${MAIN}; release is blocked.`,
			},
			{
				run: { status: "in_progress", conclusion: null },
				reason: `Checks is in_progress for exact main SHA ${MAIN}; there is no green result to release.`,
			},
			{
				run: { status: "completed", conclusion: null },
				reason: `Checks concluded without a conclusion for exact main SHA ${MAIN}; release is blocked.`,
			},
		];

		for (const { run, reason } of cases) {
			const runs = greenSourceRuns();
			runs[1] = { ...runs[1]!, ...run };
			expect(sourceGateFailure({ mainHeadSha: MAIN, sourceWorkflowRuns: runs })).toBe(reason);
		}
	});

	/** A neighbouring commit's green run is not evidence about the tree the operator named. */
	it("does not accept green runs from a different commit", () => {
		expect(sourceGateFailure({ mainHeadSha: MAIN, sourceWorkflowRuns: greenSourceRuns(OLDER) })).toBe(
			`CI has no run for exact main SHA ${MAIN}; refusing to release an unproved tree.`,
		);
	});

	it("emits the proved SHA and the requested version when both gates are green", async () => {
		const result = await runGateCli({});

		expect(result.exitCode, result.stderr).toBe(0);
		expect(result.output).toBe(`version=patch\nsource-sha=${result.sha}\n`);
	});

	/**
	 * A dispatch that cannot be proved must fail the gate job rather than exit 0 with no release: a
	 * person asked for this version, so silence is the wrong answer.
	 */
	it("the CLI fails closed for red, missing, or unknowable exact-SHA evidence", async () => {
		for (const checks of ["failure", "missing"] as const) {
			const result = await runGateCli({ checks });
			expect(result.exitCode).not.toBe(0);
			expect(result.stderr).toContain("release source gate failed");
			expect(result.output).toBe("");
		}

		const unknown = await runGateCli({ failGh: true });
		expect(unknown.exitCode).not.toBe(0);
		expect(unknown.stderr).toContain("could not establish");
		expect(unknown.output).toBe("");
	});

	/**
	 * The auto-cut is gone. A workflow_run-shaped event must be refused before the gate resolves any
	 * version or queries any evidence, so re-adding the trigger cannot silently start cutting again.
	 */
	it("refuses a workflow_run-shaped event instead of choosing a version", async () => {
		const result = await runGateCli({ eventName: "workflow_run" });

		expect(result.exitCode).not.toBe(0);
		expect(result.stderr).toContain("releases are cut only by workflow_dispatch");
		expect(result.output).toBe("");
		expect(result.calls).toBe("");
	});
});

describe("published asset manifest", () => {
	it("accepts exactly the complete five-platform binary and native-addon set with sidecars", () => {
		const result = verifyPublishedReleaseAssets(REQUIRED_RELEASE_ASSET_NAMES);
		expect(result).toEqual({ ok: true, missing: [], unexpected: [] });
	});

	it("fails when either binary platform previously omitted from verification is absent", () => {
		for (const missing of ["veyyon-darwin-x64", "veyyon-linux-arm64"]) {
			const result = verifyPublishedReleaseAssets(REQUIRED_RELEASE_ASSET_NAMES.filter(name => name !== missing));
			expect(result.ok).toBe(false);
			expect(result.missing).toContain(missing);
		}
	});

	it("fails when any checksum sidecar or required native addon is absent", () => {
		for (const missing of [
			"veyyon-linux-arm64.sha256",
			"veyyon_natives.darwin-arm64.node",
			"veyyon_natives.win32-x64-baseline.node.sha256",
		]) {
			const result = verifyPublishedReleaseAssets(REQUIRED_RELEASE_ASSET_NAMES.filter(name => name !== missing));
			expect(result.ok).toBe(false);
			expect(result.missing).toContain(missing);
		}
	});

	it("rejects distribution assets outside the exact manifest", () => {
		const result = verifyPublishedReleaseAssets([...REQUIRED_RELEASE_ASSET_NAMES, "veyyon-linux-riscv64"]);
		expect(result.ok).toBe(false);
		expect(result.unexpected).toEqual(["veyyon-linux-riscv64"]);
	});

	it("fails closed when GitHub publication state cannot be queried", async () => {
		const bin = mkdtempSync(join(tmpdir(), "release-gate-gh-"));
		const fakeGh = join(bin, "gh");
		writeFileSync(fakeGh, "#!/bin/sh\necho publication unavailable >&2\nexit 9\n");
		chmodSync(fakeGh, 0o755);

		const proc = Bun.spawn(["bun", "scripts/release.ts", "verify-assets", "v1.2.3"], {
			cwd: REPO_ROOT,
			env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` },
			stdout: "pipe",
			stderr: "pipe",
		});
		const [exitCode, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
		expect(exitCode).not.toBe(0);
		expect(stderr).toContain("could not establish publication state");
	});
});
