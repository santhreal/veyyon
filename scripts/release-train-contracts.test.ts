// Contracts for the release train's 2026-07-24 derailment fixes. Eight
// consecutive releases (v1.0.28-v1.0.35) were tagged and never published:
// release.yml tagged main HEAD on raw push before ci.yml had tested the sha,
// two red packages/utils tests killed every publish downstream, and nothing
// anywhere alerted — `releases/latest` served a stale binary for hours until a
// manual audit found the jam. Each test here locks one structural fix so the
// same failure mode cannot quietly return.

import { describe, expect, it } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

const workflowsDir = path.resolve(import.meta.dir, "..", ".github");

async function loadYaml(rel: string): Promise<any> {
	return Bun.YAML.parse(await Bun.file(path.join(workflowsDir, rel)).text());
}

async function runDecideStep(options: {
	eventName?: "workflow_run" | "workflow_dispatch";
	triggerSha?: string;
	mainSha?: string;
	expectedSha?: string;
	bunExit?: number;
	bunOutput?: string;
}) {
	const wf = await loadYaml("workflows/release.yml");
	const decide = wf.jobs.gate.steps.find((step: { id?: string }) => step.id === "decide");
	const dir = mkdtempSync(path.join(tmpdir(), "release-workflow-"));
	const output = path.join(dir, "github-output");
	const calls = path.join(dir, "calls");
	writeFileSync(output, "");
	writeFileSync(calls, "");
	const git = path.join(dir, "git");
	const bun = path.join(dir, "bun");
	writeFileSync(git, `#!/bin/sh\nprintf '%s\\n' '${options.mainSha ?? "main-sha"}'\n`);
	writeFileSync(
		bun,
		`#!/bin/sh\nprintf '%s\\n' "$*" >> "$CALLS"\nprintf '%s\\n' '${options.bunOutput ?? "true"}'\nexit ${options.bunExit ?? 0}\n`,
	);
	chmodSync(git, 0o755);
	chmodSync(bun, 0o755);
	const proc = Bun.spawn(["bash", "-c", decide.run], {
		cwd: path.resolve(import.meta.dir, ".."),
		env: {
			...process.env,
			PATH: `${dir}:${process.env.PATH ?? ""}`,
			CALLS: calls,
			GITHUB_OUTPUT: output,
			EVENT_NAME: options.eventName ?? "workflow_run",
			DISPATCH_VERSION: "minor",
			HEAD_COMMIT_MESSAGE: "fix: ready",
			TRIGGER_HEAD_SHA: options.triggerSha ?? "main-sha",
			EXPECTED_SHA: options.expectedSha ?? "main-sha",
			GH_TOKEN: "read-only-test-token",
		},
		stdout: "pipe",
		stderr: "pipe",
	});
	const [exitCode, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
	return {
		exitCode,
		stderr,
		output: readFileSync(output, "utf8"),
		calls: readFileSync(calls, "utf8"),
	};
}

async function runMaterializeGatedSha(options: { checkedOutSha: string; sourceSha: string }) {
	const wf = await loadYaml("workflows/release.yml");
	const step = wf.jobs.release.steps.find(
		(candidate: { name?: string }) => candidate.name === "Materialize the gated SHA as main",
	);
	const dir = mkdtempSync(path.join(tmpdir(), "release-source-sha-"));
	const calls = path.join(dir, "calls");
	writeFileSync(calls, "");
	const git = path.join(dir, "git");
	writeFileSync(
		git,
		`#!/bin/sh
printf '%s\n' "$*" >> "$CALLS"
case "$*" in
  "rev-parse HEAD") printf '%s\n' "$CHECKED_OUT_SHA" ;;
  "switch -C main $RELEASE_SOURCE_SHA") ;;
  *) printf 'unexpected git invocation: %s\n' "$*" >&2; exit 88 ;;
esac
`,
	);
	chmodSync(git, 0o755);
	const proc = Bun.spawn(["bash", "-c", step.run], {
		cwd: path.resolve(import.meta.dir, ".."),
		env: {
			...process.env,
			PATH: `${dir}:${process.env.PATH ?? ""}`,
			CALLS: calls,
			CHECKED_OUT_SHA: options.checkedOutSha,
			RELEASE_SOURCE_SHA: options.sourceSha,
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
		exitCode,
		stderr,
		stdout,
		calls: readFileSync(calls, "utf8").trim().split("\n").filter(Boolean),
	};
}

describe("release.yml exact-SHA source gates", () => {
	it("is triggered by completed CI, Checks, and Security runs on main, never a raw push", async () => {
		const wf = await loadYaml("workflows/release.yml");
		expect(wf.on.push).toBeUndefined();
		expect(wf.on.workflow_run).toEqual({
			workflows: ["CI", "Checks", "Security"],
			types: ["completed"],
			branches: ["main"],
		});
		expect(wf.on.workflow_dispatch.inputs.version).toMatchObject({
			required: true,
			default: "patch",
			type: "string",
		});
		expect(wf.on.workflow_dispatch.inputs.expected_sha).toEqual({
			description: "Exact origin/main SHA validated by the release operator",
			required: true,
			type: "string",
		});
		expect(wf.permissions.actions).toBe("read");
	});

	it("runs every source gate on every main commit so exact-SHA proof cannot be absent", async () => {
		for (const file of ["ci.yml", "checks.yml", "security.yml"]) {
			const wf = await loadYaml(`workflows/${file}`);
			expect(wf.on.push.branches, `${file} must gate main`).toContain("main");
			expect(wf.on.push["paths-ignore"], `${file} must not omit an exact main SHA`).toBeUndefined();
		}
	});

	it("uses the repository token and explicitly dispatches the tagged publish pipeline", async () => {
		const workflowText = await Bun.file(path.join(workflowsDir, "workflows/release.yml")).text();
		const wf = await loadYaml("workflows/release.yml");
		const release = wf.jobs.release;
		const checkout = release.steps.find((step: { uses?: string }) => step.uses?.startsWith("actions/checkout@"));
		const dispatch = release.steps.find(
			(step: { name?: string }) => step.name === "Gate the bump and dispatch the publish pipeline",
		);

		expect(workflowText).not.toContain("RELEASE_PAT");
		expect(workflowText).not.toContain("cargo install sd");
		expect(release.permissions).toEqual({ contents: "write", actions: "write" });
		expect(checkout.with.token).toBeUndefined();
		expect(checkout.with.ref).toContain("needs.gate.outputs.source-sha");
		expect(wf.jobs.gate.outputs["source-sha"]).toContain("steps.decide.outputs.source-sha");
		expect(dispatch.env.GH_TOKEN).toContain("GITHUB_TOKEN");
		expect(dispatch.run).toContain("git tag --points-at HEAD");
		expect(dispatch.run).toContain("dispatch_and_wait checks.yml Checks");
		expect(dispatch.run).toContain("dispatch_and_wait security.yml Security");
		expect(dispatch.run).toContain('gh run watch "$run_id" --exit-status');
		expect(dispatch.run).toContain('gh workflow run ci.yml --ref "$release_tag"');
		expect(dispatch.run.indexOf("dispatch_and_wait security.yml")).toBeLessThan(
			dispatch.run.indexOf("gh workflow run ci.yml"),
		);
	});

	it("defers a successful but stale workflow completion without invoking release selection", async () => {
		const result = await runDecideStep({ triggerSha: "stale-sha", mainSha: "new-main-sha" });
		expect(result.exitCode).toBe(0);
		expect(result.output).toContain("should-release=false");
		expect(result.calls).toBe("");
	});

	it("selects an automatic release only after the exact-SHA decision succeeds", async () => {
		const result = await runDecideStep({});
		expect(result.exitCode).toBe(0);
		expect(result.calls.trim()).toBe("scripts/release-gate-decision.ts");
		expect(result.output).toContain("should-release=true");
		expect(result.output).toContain("version=patch");
	});

	/**
	 * The release job must receive the exact SHA whose three source workflows passed, not resolve main again later.
	 */
	it("exports the gated source SHA alongside the release decision", async () => {
		const result = await runDecideStep({ mainSha: "proved-main-sha", triggerSha: "proved-main-sha" });
		expect(result.exitCode).toBe(0);
		expect(result.output).toContain("source-sha=proved-main-sha");
		expect(result.output).toContain("should-release=true");
	});

	/** The cutter requires a local main branch, so the immutable checkout is materialized under that exact name. */
	it("materializes the exact gated checkout as the local main branch", async () => {
		const result = await runMaterializeGatedSha({ checkedOutSha: "proved-main-sha", sourceSha: "proved-main-sha" });
		expect(result.exitCode).toBe(0);
		expect(result.calls).toEqual(["rev-parse HEAD", "switch -C main proved-main-sha"]);
	});

	/** A checkout race must stop before the workflow creates or moves its local main branch. */
	it("refuses to materialize a checkout that differs from the gated SHA", async () => {
		const result = await runMaterializeGatedSha({ checkedOutSha: "newer-main-sha", sourceSha: "proved-main-sha" });
		expect(result.exitCode).not.toBe(0);
		expect(result.stdout).toContain("expected gated SHA proved-main-sha");
		expect(result.calls).toEqual(["rev-parse HEAD"]);
	});

	/**
	 * A queued manual run must fail closed if main moved after local validation, while an unchanged main
	 * proceeds with the exact expected SHA and original version selection.
	 */
	it("binds manual release selection to the operator-validated main SHA", async () => {
		const unchanged = await runDecideStep({
			eventName: "workflow_dispatch",
			expectedSha: "validated-sha",
			mainSha: "validated-sha",
		});
		expect(unchanged.exitCode).toBe(0);
		expect(unchanged.calls.trim()).toBe("scripts/release-gate-decision.ts --green-only");
		expect(unchanged.output).toContain("source-sha=validated-sha");
		expect(unchanged.output).toContain("version=minor");

		const advanced = await runDecideStep({
			eventName: "workflow_dispatch",
			expectedSha: "validated-sha",
			mainSha: "advanced-main-sha",
		});
		expect(advanced.exitCode).not.toBe(0);
		expect(advanced.calls).toBe("");
		expect(advanced.output).not.toContain("should-release=true");
		expect(advanced.output).not.toContain("version=minor");

		const missing = await runDecideStep({ eventName: "workflow_dispatch", expectedSha: "" });
		expect(missing.exitCode).not.toBe(0);
		expect(missing.calls).toBe("");
		expect(missing.output).not.toContain("should-release=true");
	});

	it("manual dispatch proves the same gates and fails when that proof fails", async () => {
		const success = await runDecideStep({ eventName: "workflow_dispatch" });
		expect(success.exitCode).toBe(0);
		expect(success.calls.trim()).toBe("scripts/release-gate-decision.ts --green-only");
		expect(success.output).toContain("version=minor");

		const failure = await runDecideStep({ eventName: "workflow_dispatch", bunExit: 1 });
		expect(failure.exitCode).not.toBe(0);
		expect(failure.output).not.toContain("should-release=true");
	});
});

describe("required publication artifacts", () => {
	/**
	 * One local command must validate the intended main checkout and dispatch the
	 * remote release orchestrator instead of exposing its mutating cutter.
	 */
	it("exposes the safe workflow dispatcher as bun run release", async () => {
		const manifest = await Bun.file("package.json").json();
		expect(manifest.scripts.release).toBe("bun scripts/trigger-release.ts");
	});

	/**
	 * CI is publicly dispatchable for diagnostics, so tag syntax alone cannot
	 * authorize publication. The metadata job must re-prove both exact-tag gates.
	 */
	it("permits publication only from a verified strict-tag workflow dispatch", async () => {
		const wf = await loadYaml("workflows/ci.yml");
		const metadata = wf.jobs.release_metadata;
		const detect = metadata.steps.find((step: { id?: string }) => step.id === "detect");
		const setupBun = metadata.steps.find((step: { uses?: string }) => step.uses?.startsWith("oven-sh/setup-bun@"));

		// biome-ignore lint/suspicious/noTemplateCurlyInString: exact GitHub Actions expression is the contract
		expect(detect.env.GH_TOKEN).toBe("${{ secrets.GITHUB_TOKEN }}");
		// biome-ignore lint/suspicious/noTemplateCurlyInString: exact GitHub Actions expression is the contract
		expect(detect.run).toContain('if [ "${{ github.event_name }}" != "workflow_dispatch" ]');
		expect(detect.run).toContain("grep -Eq '^v[0-9]+\\.[0-9]+\\.[0-9]+$'");
		expect(detect.run).toContain(
			// biome-ignore lint/suspicious/noTemplateCurlyInString: exact GitHub Actions expression is the contract
			'bun scripts/release-gate-decision.ts verify-tag-gates "$release_tag" "${{ github.sha }}"',
		);
		expect(detect.run).not.toContain("git tag --points-at HEAD");
		expect(setupBun.if).toBe("startsWith(github.ref, 'refs/tags/')");
	});

	it("release Pages deployment fails when disabled or either credential is missing", async () => {
		const wf = await loadYaml("workflows/ci.yml");
		const releaseSite = wf.jobs.release_site;
		const preflight = releaseSite.steps.find(
			(step: { name?: string }) => step.name === "Require release Pages deployment credentials and policy",
		);
		expect(releaseSite.if).toBe(
			// biome-ignore lint/suspicious/noTemplateCurlyInString: exact GitHub Actions expression is the behavior under test
			"${{ needs.release_metadata.outputs.is-release == 'true' && !cancelled() && needs.release_github.result == 'success' }}",
		);
		const run = async (env: Record<string, string>) => {
			const proc = Bun.spawn(["bash", "-c", preflight.run], {
				env: { ...process.env, ...env },
				stdout: "pipe",
				stderr: "pipe",
			});
			return proc.exited;
		};

		expect(await run({ SITE_AUTODEPLOY: "off", HAS_CF_TOKEN: "true", HAS_CF_ACCOUNT_ID: "true" })).not.toBe(0);
		expect(await run({ SITE_AUTODEPLOY: "on", HAS_CF_TOKEN: "false", HAS_CF_ACCOUNT_ID: "true" })).not.toBe(0);
		expect(await run({ SITE_AUTODEPLOY: "on", HAS_CF_TOKEN: "true", HAS_CF_ACCOUNT_ID: "false" })).not.toBe(0);
		expect(await run({ SITE_AUTODEPLOY: "on", HAS_CF_TOKEN: "true", HAS_CF_ACCOUNT_ID: "true" })).toBe(0);
	});

	it("every release and standalone production deploy shares one never-cancel concurrency group", async () => {
		const ci = await loadYaml("workflows/ci.yml");
		const site = await loadYaml("workflows/site.yml");
		const expected = {
			group: "production-site-deploy",
			"cancel-in-progress": false,
		};

		expect(ci.jobs.release_site.concurrency).toEqual(expected);
		expect(ci.jobs.release_site_finalize.concurrency).toEqual(expected);
		expect(site.concurrency).toEqual(expected);
	});

	it("release deployment and installer verification cannot be conditionally skipped", async () => {
		const wf = await loadYaml("workflows/ci.yml");
		const steps = wf.jobs.release_site.steps;
		for (const name of [
			"Deploy to Cloudflare Pages (project veyyon → veyyon.dev)",
			"Deploy to Cloudflare Pages (project veyyon-get → get.veyyon.dev)",
			"Verify get.veyyon.dev serves THIS repository's install scripts",
		]) {
			const step = steps.find((candidate: { name?: string }) => candidate.name === name);
			expect(step).toBeDefined();
			expect(step.if).toBeUndefined();
		}
	});

	it("every production workflow uses the canonical verified Pages deployer", async () => {
		for (const workflow of ["workflows/ci.yml", "workflows/site.yml"]) {
			const parsed = await loadYaml(workflow);
			const job = workflow.endsWith("/ci.yml") ? parsed.jobs.release_site : parsed.jobs.build_and_deploy;
			const steps = job.steps;
			const main = steps.find(
				(step: { name?: string }) => step.name === "Deploy to Cloudflare Pages (project veyyon → veyyon.dev)",
			);
			const installer = steps.find(
				(step: { name?: string }) =>
					step.name === "Deploy to Cloudflare Pages (project veyyon-get → get.veyyon.dev)",
			);

			expect(main.run, workflow).toBe("node website/deploy.mjs --skip-build");
			expect(main["working-directory"], workflow).toBeUndefined();
			expect(installer.run, workflow).toBe("node website/deploy.mjs --skip-build");
			expect(installer.env.VEYYON_PAGES_PROJECT, workflow).toBe("veyyon-get");
		}
	});
	it("draft asset verification is part of the GitHub preparation job", async () => {
		const wf = await loadYaml("workflows/ci.yml");
		const step = wf.jobs.release_github.steps.find(
			(candidate: { name?: string }) => candidate.name === "Verify the exact draft asset manifest",
		);
		expect(step).toBeDefined();
		expect(step.env.GH_TOKEN).toBeDefined();
	});

	/** Existing release metadata is mutable; only the Git tag ref proves the immutable SHA. */
	it("resolves the release tag ref before draft preparation and publication", async () => {
		const wf = await loadYaml("workflows/ci.yml");
		const prepare = wf.jobs.release_github.steps.find((step: { id?: string }) => step.id === "draft");
		const publish = wf.jobs.release_github_publish.steps.find(
			(step: { name?: string }) => step.name === "Publish the exact verified draft",
		);

		for (const step of [prepare, publish]) {
			expect(step.run).toContain("/git/ref/tags/");
			expect(step.run).toContain("ref_type=\"$(jq -r '.object.type'");
			expect(step.run).toContain("ref_sha=\"$(jq -r '.object.sha'");
			expect(step.run).not.toContain("target_commitish");
		}
	});

	/** A draft asset mutation after platform verification must be caught before the publish PATCH. */
	it("rechecks every release asset digest immediately before publication", async () => {
		const wf = await loadYaml("workflows/ci.yml");
		const prepareSteps = wf.jobs.release_github.steps;
		const publishSteps = wf.jobs.release_github_publish.steps;
		const preserved = prepareSteps.find(
			(step: { name?: string }) => step.name === "Preserve the verified asset digest manifest",
		);
		const downloaded = publishSteps.find(
			(step: { name?: string }) => step.name === "Download the verified asset digest manifest",
		);
		const publish = publishSteps.find((step: { name?: string }) => step.name === "Publish the exact verified draft");

		expect(preserved).toBeDefined();
		expect(downloaded).toBeDefined();
		expect(publish.run).toContain("diff -u release-proof/local-assets.sha256 remote-assets.sha256");
		expect(publish.run.indexOf("diff -u release-proof/local-assets.sha256")).toBeLessThan(
			publish.run.indexOf("releases/$RELEASE_ID"),
		);
	});

	/** API publication is incomplete until the public selector used by installers resolves this exact tag. */
	it("waits for public latest propagation on fresh publication and idempotent retries", async () => {
		const wf = await loadYaml("workflows/ci.yml");
		const publish = wf.jobs.release_github_publish.steps.find(
			(step: { name?: string }) => step.name === "Publish the exact verified draft",
		);

		expect(publish.run).toContain("https://github.com/$GITHUB_REPOSITORY/releases/latest?veyyon-proof=");
		expect(publish.run).toContain("Cache-Control: no-cache");
		expect(publish.run).toContain("--connect-timeout 10 --max-time 30");
		// biome-ignore lint/suspicious/noTemplateCurlyInString: literal shell parameter expansion from the workflow fixture
		expect(publish.run).toContain('effective_without_query="${effective%%\\?*}"');
		expect(publish.run).toContain('"https://github.com/$GITHUB_REPOSITORY/releases/tag/$RELEASE_TAG"');
		expect(publish.run.indexOf("latest_ok=false")).toBeGreaterThan(
			publish.run.indexOf('if [ "$ALREADY_PUBLISHED" = true ]'),
		);
		expect(publish.run).not.toContain(
			'echo "Published release $RELEASE_TAG was already byte-identical; nothing changed."\\n                exit 0',
		);
	});

	/** Publishing changes changelog reconciliation, so the final deploy must rebuild and prove the live link. */
	it("rebuilds and verifies the website after GitHub publication", async () => {
		const wf = await loadYaml("workflows/ci.yml");
		const finalize = wf.jobs.release_site_finalize;
		const names = finalize.steps.map((step: { name?: string }) => step.name).filter(Boolean);

		expect(finalize.needs).toContain("release_github_publish");
		expect(names).toContain("Rebuild changelog after GitHub publication");
		expect(names).toContain("Deploy finalized changelog to veyyon.dev");
		expect(names).toContain("Verify veyyon.dev links the published release");
		expect(names.indexOf("Rebuild changelog after GitHub publication")).toBeLessThan(
			names.indexOf("Deploy finalized changelog to veyyon.dev"),
		);
		expect(names.indexOf("Deploy finalized changelog to veyyon.dev")).toBeLessThan(
			names.indexOf("Verify veyyon.dev links the published release"),
		);
	});

	/** The completed train must exercise releases/latest through every shipped platform installer. */
	it("requires published installer round trips before reporting the train green", async () => {
		const wf = await loadYaml("workflows/ci.yml");
		const verify = wf.jobs.release_install_verify;
		const alertNeeds = wf.jobs.release_train_alert.needs;

		expect(verify.needs).toContain("release_site_finalize");
		expect(verify.strategy.matrix.include.map((entry: { name: string }) => entry.name)).toEqual([
			"linux-x64",
			"linux-arm64",
			"macos-arm64",
			"macos-x64",
			"windows-x64",
		]);
		for (const step of verify.steps.filter((entry: { run?: string }) => entry.run)) {
			expect(step["continue-on-error"]).toBeUndefined();
		}
		// biome-ignore lint/suspicious/noTemplateCurlyInString: literal GitHub Actions expression from the parsed workflow
		const expectedTag = "${{ needs.release_metadata.outputs.release-tag }}";
		const posix = verify.steps.find((entry: { name?: string }) => entry.name?.includes("POSIX"));
		const windows = verify.steps.find((entry: { name?: string }) => entry.name?.includes("Windows"));
		expect(posix.env.VEYYON_EXPECTED_RELEASE_TAG).toBe(expectedTag);
		expect(windows.env.VEYYON_EXPECTED_RELEASE_TAG).toBe(expectedTag);
		expect(alertNeeds).toContain("release_site_finalize");
		expect(alertNeeds).toContain("release_install_verify");
	});
	it("a cancelled required site artifact cannot be reported as a green release", async () => {
		const wf = await loadYaml("workflows/ci.yml");
		const alert = wf.jobs.release_train_alert.steps.find(
			(step: { name?: string }) => step.name === "File or clear the pinned release-train issue",
		);
		const bin = mkdtempSync(path.join(tmpdir(), "release-alert-"));
		const calls = path.join(bin, "calls");
		const gh = path.join(bin, "gh");
		writeFileSync(calls, "");
		writeFileSync(
			gh,
			`#!/bin/sh
printf '%s\\n' "$*" >> "$CALLS"
case "$*" in *"issue list"*) printf '\\n' ;; esac
`,
		);
		chmodSync(gh, 0o755);
		const run = async (siteResult: "success" | "cancelled") => {
			const needs = {
				release_metadata: { result: "success" },
				release_site: { result: siteResult },
			};
			const proc = Bun.spawn(["bash", "-c", alert.run], {
				env: {
					...process.env,
					PATH: `${bin}:${process.env.PATH ?? ""}`,
					CALLS: calls,
					NEEDS_JSON: JSON.stringify(needs),
					GITHUB_REPOSITORY: "owner/repo",
					RELEASE_TAG: "v1.2.3",
					RUN_URL: "https://example.test/run",
					GH_TOKEN: "fake",
				},
				stdout: "pipe",
				stderr: "pipe",
			});
			return proc.exited;
		};

		expect(await run("cancelled")).not.toBe(0);
		expect(readFileSync(calls, "utf8")).toContain("issue create");
		writeFileSync(calls, "");
		expect(await run("success")).toBe(0);
		expect(readFileSync(calls, "utf8")).not.toContain("issue create");
	});
});

describe("a red release run is loud (release_train_alert)", () => {
	it("ci.yml has an always()-guarded alert job with issues:write", async () => {
		const wf = await loadYaml("workflows/ci.yml");
		const alert = wf.jobs.release_train_alert;
		expect(alert).toBeDefined();
		expect(alert.if).toContain("always()");
		expect(alert.if).toContain("is-release");
		expect(alert.permissions.issues).toBe("write");
	});

	it("the alert observes every release-path job defined in ci.yml", async () => {
		const wf = await loadYaml("workflows/ci.yml");
		const needs: string[] = wf.jobs.release_train_alert.needs;
		// Every job whose failure can jam or falsify a release must feed the
		// alert; a new release_* job added without wiring it here is exactly the
		// silent gap this suite exists to prevent.
		for (const [id, job] of Object.entries<any>(wf.jobs)) {
			if (id === "release_train_alert") continue;
			const releaseCritical = id.startsWith("release_")
				? id !== "release_metadata" && id !== "release_notes_dryrun"
				: false;
			if (releaseCritical) {
				expect(needs).toContain(id);
			}
			void job;
		}
		// The gate signal itself and the test/build jobs the publish depends on.
		expect(needs).toContain("release_metadata");
		expect(needs).toContain("test_workspace");
		expect(needs).toContain("release_github");
	});

	// The CUT side has its own failure modes that never reach ci.yml (preflight
	// check failure, atomic bump push rejection because main advanced, or an
	// exact-tag Checks/dispatch failure); a red cut with no alert is the same
	// silent jam the publish alert exists to prevent.
	it("release.yml alerts on a failed cut with the same release-train issue", async () => {
		const wf = await loadYaml("workflows/release.yml");
		const alert = wf.jobs.cut_failed_alert;
		expect(alert).toBeDefined();
		expect(alert.if).toContain("always()");
		expect(alert.if).toContain("needs.release.result == 'failure'");
		expect(alert.permissions.issues).toBe("write");
	});
});

describe("workflow runtime pins", () => {
	it("uses the exact Bun version declared by the root package manager", async () => {
		const manifest = await Bun.file(path.resolve(import.meta.dir, "..", "package.json")).json();
		const expected = String(manifest.packageManager).replace(/^bun@/, "");
		const pins: Array<{ workflow: string; version: string }> = [];
		const glob = new Bun.Glob("workflows/*.yml");
		for await (const rel of glob.scan({ cwd: workflowsDir })) {
			const text = await Bun.file(path.join(workflowsDir, rel)).text();
			for (const match of text.matchAll(/bun-version:\s*"([^"]+)"/g)) {
				pins.push({ workflow: rel, version: match[1]! });
			}
		}
		expect(pins.length).toBeGreaterThan(0);
		expect(pins.filter(pin => pin.version !== expected)).toEqual([]);
	});
});

describe("every third-party action is sha-pinned", () => {
	// Mutable tags (`@v4`, `@main`) let a compromised or broken upstream action
	// land in the release path unreviewed. Every non-local `uses:` must pin a
	// full 40-hex commit sha (with a trailing version comment for humans).
	it("no workflow or composite action references a mutable ref", async () => {
		const glob = new Bun.Glob("**/*.yml");
		const offenders: string[] = [];
		for await (const rel of glob.scan({ cwd: workflowsDir })) {
			const text = await Bun.file(path.join(workflowsDir, rel)).text();
			for (const line of text.split("\n")) {
				const m = /uses:\s*([^\s#]+)/.exec(line);
				if (!m) continue;
				const ref = m[1]!;
				if (ref.startsWith("./")) continue; // local composite actions have no ref
				if (!/@[0-9a-f]{40}$/.test(ref)) offenders.push(`${rel}: ${ref}`);
			}
		}
		expect(offenders).toEqual([]);
	});
});
