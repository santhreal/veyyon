/**
 * The release gate's decision, including the case where a previous cut was stranded.
 *
 * WHY THIS SUITE EXISTS. The gate governs every release, so each branch is pinned by name rather than
 * covered in aggregate. The failure it recovers from happened live: `release.ts` moves
 * `## [Unreleased]` into the new version's section AT CUT TIME, before CI publishes, so a cut whose CI
 * then fails leaves a tag with no GitHub release and an empty `## [Unreleased]`. The gate then reported
 * "nothing to release" on every subsequent push, and `v1.0.33` and `v1.0.34` sat unpublished while the
 * installable version stayed at `v1.0.27`.
 *
 * A recovery that can bump a version is dangerous in a different direction, so both bounds are asserted
 * as hard as the recovery itself: a re-cut requires main to have MOVED past the failed tag, and two
 * stranded tags stop the gate and ask for a person. The in-progress and success cases are pinned too,
 * because cutting over a run that has not finished, or over one that succeeded, would create the very
 * silent tag this is about.
 */

import { describe, expect, it } from "bun:test";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	assertReleaseTagGateEvidence,
	type CiConclusion,
	decideReleaseGate,
	MAX_STRANDED_TAGS,
	REQUIRED_RELEASE_ASSET_NAMES,
	REQUIRED_RELEASE_TAG_WORKFLOWS,
	REQUIRED_SOURCE_WORKFLOWS,
	type ReleaseTagWorkflowRun,
	type SilentTag,
	type SourceWorkflowRun,
	verifyPublishedReleaseAssets,
} from "./release-gate-decision.ts";

const MAIN = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const OLDER = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

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
  *"--workflow checks.yml"*)
    printf '[{"headSha":"%s","headBranch":"v1.2.3","event":"workflow_dispatch","conclusion":"success"}]\\n' "$FAKE_SHA" ;;
  *) echo "unexpected gh invocation: $*" >&2; exit 88 ;;
esac
`,
	);
	chmodSync(fakeGh, 0o755);
	const proc = Bun.spawn(["bun", "scripts/release-gate-decision.ts", "verify-tag-gates", "v1.2.3", sha], {
		cwd: REPO_ROOT,
		env: {
			...process.env,
			PATH: `${bin}:${process.env.PATH ?? ""}`,
			CALLS_PATH: callsPath,
			FAKE_SHA: sha,
		},
		stdout: "pipe",
		stderr: "pipe",
	});
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
		};

		expect(() =>
			assertReleaseTagGateEvidence("v1.2.3", MAIN, {
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
		expect(result.output).toContain("verified exact-tag Checks for v1.2.3");
		expect(result.calls).toContain("run list --workflow checks.yml");
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
		};

		expect(() =>
			assertReleaseTagGateEvidence("v1.2.3", MAIN, {
				"checks.yml": [wrongSha],
			}),
		).toThrow("checks.yml has no successful workflow_dispatch run");
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
		};

		expect(() =>
			assertReleaseTagGateEvidence("v1.2.3", MAIN, {
				"checks.yml": [mainRun],
			}),
		).toThrow("checks.yml has no successful workflow_dispatch run");
	});

	/**
	 * Loose v-prefix tags used to enter the publication path. Strict semver keeps
	 * aliases and malformed tags from choosing an ambiguous release identity.
	 */
	it("rejects malformed release tags before reading workflow evidence", () => {
		expect(() => assertReleaseTagGateEvidence("v1junk", MAIN, {})).toThrow("is not strict vX.Y.Z semver");
	});
});

async function runGateCli(options: {
	checks?: "success" | "failure" | "missing";
	greenOnly?: boolean;
	failGh?: boolean;
	silentTag?: boolean;
}) {
	const sha = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: REPO_ROOT }).stdout.toString().trim();
	const bin = mkdtempSync(join(tmpdir(), "release-gate-cli-"));
	const fakeGh = join(bin, "gh");
	writeFileSync(
		fakeGh,
		`#!/bin/sh
if [ "$FAIL_GH" = "1" ]; then echo unavailable >&2; exit 9; fi
case "$*" in
  *"commits/main"*) printf '%s\\n' "$FAKE_SHA" ;;
  *"actions/runs?head_sha=$FAKE_SHA"*)
    printf 'CI\\t%s\\tcompleted\\tsuccess\\n' "$FAKE_SHA"
    if [ "$CHECKS" != "missing" ]; then printf 'Checks\\t%s\\tcompleted\\t%s\\n' "$FAKE_SHA" "$CHECKS"; fi ;;
  *"actions/workflows/ci.yml/runs?head_sha=$SILENT_SHA&per_page=1"*) printf 'failure\\n' ;;
  *"release list --limit 1"*) printf 'v0.0.1\\n' ;;
  *"release list --limit 50"*) printf 'v0.0.1\\n' ;;
  *"tags?per_page=50"*)
    if [ "$SILENT_TAG" = "1" ]; then printf 'v0.0.2 %s\\n' "$SILENT_SHA"; fi
    printf 'v0.0.1 %s\\n' "$FAKE_SHA" ;;
  *) echo "unexpected gh invocation: $*" >&2; exit 88 ;;
esac
`,
	);
	chmodSync(fakeGh, 0o755);
	const args = ["bun", "scripts/release-gate-decision.ts"];
	if (options.greenOnly) args.push("--green-only");
	const proc = Bun.spawn(args, {
		cwd: REPO_ROOT,
		env: {
			...process.env,
			PATH: `${bin}:${process.env.PATH ?? ""}`,
			FAKE_SHA: sha,
			CHECKS: options.checks ?? "success",
			FAIL_GH: options.failGh ? "1" : "0",
			SILENT_TAG: options.silentTag ? "1" : "0",
			SILENT_SHA: OLDER,
		},
		stdout: "pipe",
		stderr: "pipe",
	});
	const [exitCode, stdout, stderr] = await Promise.all([
		proc.exited,
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	return { exitCode, stdout, stderr };
}

function greenSourceRuns(sha = MAIN): SourceWorkflowRun[] {
	return REQUIRED_SOURCE_WORKFLOWS.map(name => ({
		name,
		headSha: sha,
		status: "completed",
		conclusion: "success",
	}));
}

function tag(name: string, conclusion: CiConclusion, sha = OLDER): SilentTag {
	return { tag: name, sha, conclusion };
}

function decide(
	options: {
		bullets?: boolean;
		silentTags?: SilentTag[];
		mainHeadSha?: string;
		sourceWorkflowRuns?: SourceWorkflowRun[];
	} = {},
) {
	const mainHeadSha = options.mainHeadSha ?? MAIN;
	return decideReleaseGate({
		hasUnreleasedBullets: options.bullets ?? false,
		silentTags: options.silentTags ?? [],
		mainHeadSha,
		sourceWorkflowRuns: options.sourceWorkflowRuns ?? greenSourceRuns(mainHeadSha),
	});
}

describe("exact-source gates", () => {
	it("requires CI and Checks to be green for the exact main SHA", () => {
		expect(decide({ bullets: true }).cut).toBe(true);

		for (const missingName of REQUIRED_SOURCE_WORKFLOWS) {
			const runs = greenSourceRuns().filter(run => run.name !== missingName);
			const decision = decide({ bullets: true, sourceWorkflowRuns: runs });
			expect(decision.cut).toBe(false);
			expect(decision.reason).toContain(`${missingName} has no run`);
		}
	});

	it("blocks a red or unfinished exact-SHA run even when a changelog bullet is waiting", () => {
		for (const conclusion of ["failure", "cancelled", null]) {
			const runs = greenSourceRuns();
			runs[1] = {
				...runs[1]!,
				status: conclusion === null ? "in_progress" : "completed",
				conclusion,
			};
			expect(decide({ bullets: true, sourceWorkflowRuns: runs }).cut).toBe(false);
		}
	});

	it("does not accept green runs from a different commit", () => {
		const decision = decide({ bullets: true, sourceWorkflowRuns: greenSourceRuns(OLDER) });
		expect(decision.cut).toBe(false);
		expect(decision.reason).toContain("exact main SHA");
	});

	it("the CLI fails closed for red, missing, or unknowable exact-SHA evidence", async () => {
		for (const options of [{ checks: "failure" }, { checks: "missing" }] as const) {
			const automatic = await runGateCli(options);
			expect(automatic.exitCode).toBe(0);
			expect(automatic.stdout.trim()).toBe("false");

			const manual = await runGateCli({ ...options, greenOnly: true });
			expect(manual.exitCode).not.toBe(0);
		}

		const unknown = await runGateCli({ failGh: true });
		expect(unknown.exitCode).not.toBe(0);
		expect(unknown.stderr).toContain("fails closed");
	});
	/**
	 * Recovery must inspect the CI workflow specifically, because another workflow on the same tag can finish later.
	 */
	it("reads a silent tag conclusion from the CI workflow endpoint", async () => {
		const result = await runGateCli({ silentTag: true });
		expect(result.exitCode).toBe(0);
		expect(result.stdout.trim()).toBe("true");
	});
});

describe("the ordinary path", () => {
	/**
	 * Unchanged, and checked first. Everything else in this file only runs when the changelog says there
	 * is nothing to ship, so a bug in the stranded-tag logic cannot suppress a normal release.
	 */
	it("cuts when a publishable package has an Unreleased bullet", () => {
		const decision = decide({ bullets: true });

		expect(decision.cut).toBe(true);
		expect(decision.needsAttention).toBe(false);
		expect(decision.reason).toContain("Unreleased changelog bullet");
	});

	it("cuts on a waiting bullet even while a tag is unpublished, rather than stopping to reason about it", () => {
		// The bullet is newer work than the stranded tag, and cutting ships both: the release-notes
		// script rolls the silent tag's sections into the new release.
		const decision = decide({ bullets: true, silentTags: [tag("v1.0.34", "failure")] });

		expect(decision.cut).toBe(true);
		expect(decision.needsAttention).toBe(false);
	});

	it("does not cut when nothing is unreleased and every tag is published", () => {
		const decision = decide();

		expect(decision.cut).toBe(false);
		expect(decision.needsAttention).toBe(false);
		expect(decision.reason).toContain("no unpublished tag");
	});
});

describe("one stranded tag", () => {
	/**
	 * THE recovery. The changelog is empty because the failed cut consumed it, so the only evidence that
	 * work is waiting is the tag itself.
	 */
	it("re-cuts when its CI failed and main has moved since", () => {
		const decision = decide({ silentTags: [tag("v1.0.34", "failure")] });

		expect(decision.cut).toBe(true);
		expect(decision.needsAttention).toBe(false);
		expect(decision.reason).toContain("v1.0.34");
		expect(decision.reason).toContain("re-cutting");
	});

	it("re-cuts for a cancelled run, which also published nothing", () => {
		expect(decide({ silentTags: [tag("v1.0.34", "cancelled")] }).cut).toBe(true);
	});

	it("re-cuts for a timed-out run, for the same reason", () => {
		expect(decide({ silentTags: [tag("v1.0.34", "timed_out")] }).cut).toBe(true);
	});

	/**
	 * BOUND ONE. Cutting the same tree again fails the same way, so a re-cut is only recovery when main
	 * carries something the failed tag did not. Without this, a persistent failure would bump a version
	 * on every gate entry.
	 */
	it("refuses when the failed tag IS main HEAD, because the tree has not changed", () => {
		const decision = decide({ silentTags: [tag("v1.0.34", "failure", MAIN)] });

		expect(decision.cut).toBe(false);
		expect(decision.needsAttention).toBe(true);
		expect(decision.reason).toContain("same tree");
	});

	/** A run still going may yet publish. Cutting over it would create a second silent tag by hand. */
	it("waits while its CI is still running", () => {
		const decision = decide({ silentTags: [tag("v1.0.34", null)] });

		expect(decision.cut).toBe(false);
		expect(decision.needsAttention).toBe(false);
		expect(decision.reason).toContain("still running");
	});

	/**
	 * A green run with no release is a different bug: the publish step reported success without creating
	 * the release. A new version would bury the evidence, so this is reported and left alone.
	 */
	it("reports a successful run with no release instead of cutting over it", () => {
		const decision = decide({ silentTags: [tag("v1.0.34", "success")] });

		expect(decision.cut).toBe(false);
		expect(decision.needsAttention).toBe(true);
		expect(decision.reason).toContain("without creating the release");
	});

	it("treats a skipped run as successful for this purpose, so it does not cut over it", () => {
		// `skipped` and `neutral` are not failures. Neither published anything, but neither is evidence
		// that a re-cut would help, and guessing here is how a version-inflation loop starts.
		expect(decide({ silentTags: [tag("v1.0.34", "skipped")] }).cut).toBe(false);
		expect(decide({ silentTags: [tag("v1.0.34", "neutral")] }).cut).toBe(false);
	});
});

describe("two stranded tags", () => {
	/**
	 * BOUND TWO, and the exact incident: `v1.0.33` and `v1.0.34` both cut, both failed on the same source
	 * lock. A third tag would have failed identically. The gate stops and says so.
	 */
	it("refuses to cut a third and asks for a person", () => {
		const decision = decide({ silentTags: [tag("v1.0.34", "failure"), tag("v1.0.33", "failure")] });

		expect(decision.cut).toBe(false);
		expect(decision.needsAttention).toBe(true);
		expect(decision.reason).toContain("v1.0.34");
		expect(decision.reason).toContain("v1.0.33");
		expect(decision.reason).toContain("re-run the release workflow by hand");
	});

	it("refuses regardless of what the newest run concluded, because the count is the signal", () => {
		for (const conclusion of ["failure", "success", null] as CiConclusion[]) {
			expect(decide({ silentTags: [tag("v1.0.35", conclusion), tag("v1.0.34", "failure")] }).cut).toBe(false);
		}
	});

	it("still cuts a genuinely new Unreleased bullet, so the bound does not freeze ordinary releasing", () => {
		// The bound stops the gate from inventing versions. It must not stop a human's new work from
		// shipping, or one bad cut would freeze the release train until someone noticed.
		const decision = decide({ bullets: true, silentTags: [tag("v1.0.34", "failure"), tag("v1.0.33", "failure")] });

		expect(decision.cut).toBe(true);
	});

	it("uses the documented bound rather than a literal 2 in the branch", () => {
		// Pins the constant to the behaviour: a list one short of the bound recovers, a list at the bound
		// refuses. If someone raises MAX_STRANDED_TAGS, this test follows them instead of going stale.
		const belowBound = Array.from({ length: MAX_STRANDED_TAGS - 1 }, (_, i) => tag(`v1.0.${40 + i}`, "failure"));
		const atBound = Array.from({ length: MAX_STRANDED_TAGS }, (_, i) => tag(`v1.0.${40 + i}`, "failure"));

		expect(decide({ silentTags: belowBound }).cut).toBe(true);
		expect(decide({ silentTags: atBound }).cut).toBe(false);
	});
});

describe("every refusal", () => {
	/**
	 * A refusal that a person needs to act on must be distinguishable from "nothing to release", because
	 * the incident was precisely a gate reporting the second while the first was true.
	 */
	it("carries a reason, and only the ones needing action are flagged", () => {
		const cases: Array<{ decision: ReturnType<typeof decide>; attention: boolean }> = [
			{ decision: decide(), attention: false },
			{ decision: decide({ silentTags: [tag("v1.0.34", null)] }), attention: false },
			{ decision: decide({ silentTags: [tag("v1.0.34", "success")] }), attention: true },
			{ decision: decide({ silentTags: [tag("v1.0.34", "failure", MAIN)] }), attention: true },
			{ decision: decide({ silentTags: [tag("v1.0.34", "failure"), tag("v1.0.33", "failure")] }), attention: true },
		];

		for (const { decision, attention } of cases) {
			expect(decision.cut).toBe(false);
			expect(decision.reason.length).toBeGreaterThan(20);
			expect(decision.needsAttention).toBe(attention);
		}
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

		const proc = Bun.spawn(["bun", "scripts/release-gate-decision.ts", "verify-assets", "v1.2.3"], {
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
