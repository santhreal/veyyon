// Contracts for the release train's 2026-07-24 derailment fixes. Eight
// consecutive releases were tagged but never published. These tests lock the
// exact-SHA gates, single controller, and complete publication path.

import { describe, expect, it } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import {
	decideWorkflowRelease,
	materializeGatedReleaseSource,
	type ReleaseTrainOperations,
	runReleaseTrain,
	type WorkflowGateOperations,
} from "./release";
import type { ReleaseGateFacts } from "./release-policy";

interface WorkflowStep {
	name: string;
	id: string;
	uses: string;
	run: string;
	if: string;
	env: Record<string, string>;
	with: Record<string, unknown>;
	"working-directory"?: string;
	"continue-on-error"?: boolean;
}

interface WorkflowSteps extends Iterable<WorkflowStep> {
	find(predicate: (step: WorkflowStep) => unknown): WorkflowStep;
	filter(predicate: (step: WorkflowStep) => unknown): WorkflowStep[];
	map<Result>(callback: (step: WorkflowStep) => Result): Result[];
}

interface WorkflowJob {
	steps: WorkflowSteps;
	permissions: Record<string, string>;
	outputs: Record<string, string>;
	if: string;
	needs: string[];
	concurrency: unknown;
	strategy: { matrix: { include: Array<{ name: string }> } };
}

interface WorkflowDocument {
	on: {
		push: { branches: string[]; "paths-ignore"?: string[] };
		workflow_dispatch: {
			inputs: Record<string, { description: string; required: boolean; default?: string; type: string }>;
		};
	};
	permissions: Record<string, string>;
	jobs: Record<string, WorkflowJob>;
	concurrency: unknown;
}

const workflowsDir = path.resolve(import.meta.dir, "..", ".github");

async function loadYaml(rel: string): Promise<WorkflowDocument> {
	return Bun.YAML.parse(await Bun.file(path.join(workflowsDir, rel)).text()) as WorkflowDocument;
}

function greenFacts(mainHeadSha = "main-sha"): ReleaseGateFacts {
	return {
		mainHeadSha,
		sourceWorkflowRuns: [
			{ name: "CI", headSha: mainHeadSha, status: "completed", conclusion: "success" },
			{ name: "Checks", headSha: mainHeadSha, status: "completed", conclusion: "success" },
		],
	};
}

function gateOperations(options: { mainSha?: string; facts?: ReleaseGateFacts } = {}): WorkflowGateOperations {
	return {
		currentSha: async () => options.mainSha ?? "main-sha",
		gatherFacts: async () => options.facts ?? greenFacts(options.mainSha),
	};
}

describe("release.yml exact-SHA source gates", () => {
	/**
	 * Releases are deliberate. The automatic `workflow_run` cut is gone, so a dispatch carrying the
	 * version and the operator-validated SHA is the only way a tag can come into existence.
	 */
	it("has exactly one trigger, an explicit workflow_dispatch", async () => {
		const workflow = await loadYaml("workflows/release.yml");
		expect(Object.keys(workflow.on)).toEqual(["workflow_dispatch"]);
		expect(workflow.on.workflow_dispatch.inputs.version).toMatchObject({
			required: true,
			default: "patch",
			type: "string",
		});
		expect(workflow.on.workflow_dispatch.inputs.expected_sha).toEqual({
			description: "Exact origin/main SHA validated by the release operator",
			required: true,
			type: "string",
		});
		expect(workflow.permissions.actions).toBe("read");
		expect(workflow.concurrency).toEqual({
			group: "release",
			queue: "max",
			"cancel-in-progress": false,
		});
	});

	/**
	 * Exact-SHA proof exists only if both source workflows run on every main
	 * commit. A paths-ignore filter would create unprovable release candidates.
	 */
	it("runs every source gate on every main commit", async () => {
		for (const file of ["ci.yml", "checks.yml"]) {
			const workflow = await loadYaml(`workflows/${file}`);
			expect(workflow.on.push.branches, `${file} must gate main`).toContain("main");
			expect(workflow.on.push["paths-ignore"], `${file} must not omit an exact main SHA`).toBeUndefined();
		}
	});

	/**
	 * The workflow delegates the entire mutable train to release.ts with the
	 * repository token. It does not carry a second shell orchestrator.
	 */
	it("uses one controller for cutting, gating, publishing, and verification", async () => {
		const workflowText = await Bun.file(path.join(workflowsDir, "workflows/release.yml")).text();
		const workflow = await loadYaml("workflows/release.yml");
		const release = workflow.jobs.release;
		const checkout = release.steps.find(step => step.uses?.startsWith("actions/checkout@"));
		const controller = release.steps.find(step => step.name === "Cut, gate, publish, and verify the release");

		expect(workflowText).not.toContain("RELEASE_PAT");
		expect(release.permissions).toEqual({ contents: "write", actions: "write" });
		expect(checkout.with.token).toBeUndefined();
		expect(checkout.with.ref).toContain("needs.gate.outputs.source-sha");
		expect(workflow.jobs.gate.outputs["source-sha"]).toContain("steps.decide.outputs.source-sha");
		const gate = workflow.jobs.gate.steps.find(step => step.id === "decide");
		expect(gate.env.RELEASE_DISPATCH_VERSION).toContain("inputs.version");
		expect(gate.env.RELEASE_EXPECTED_SHA).toContain("inputs.expected_sha");
		expect(controller.env.GH_TOKEN).toContain("GITHUB_TOKEN");
		expect(controller.run).toBe('bun scripts/release.ts workflow-release "$RELEASE_VERSION"');
	});

	/**
	 * The auto-cut is gone. A workflow_run-shaped event must be refused before the gate resolves a
	 * SHA or gathers any evidence, so an automatic patch release cannot return by accident.
	 */
	it("refuses a workflow_run-shaped event and gathers no facts", async () => {
		let shaRead = false;
		let gathered = false;

		await expect(
			decideWorkflowRelease(
				{ eventName: "workflow_run", dispatchVersion: "patch", expectedSha: "main-sha" },
				{
					currentSha: async () => {
						shaRead = true;
						return "main-sha";
					},
					gatherFacts: async () => {
						gathered = true;
						return greenFacts();
					},
				},
			),
		).rejects.toThrow("releases are cut only by workflow_dispatch");
		expect(shaRead).toBe(false);
		expect(gathered).toBe(false);
	});

	/**
	 * The cutter requires a local main branch. The controller materializes the
	 * approved immutable checkout under that exact branch before mutation.
	 */
	it("materializes the exact gated checkout as local main", async () => {
		const events: string[] = [];
		await materializeGatedReleaseSource("proved-main-sha", {
			currentSha: async () => "proved-main-sha",
			switchMain: async sha => {
				events.push(`switch:${sha}`);
			},
			configureGitIdentity: async () => {
				events.push("identity");
			},
		});
		expect(events).toEqual(["switch:proved-main-sha", "identity"]);
	});

	/**
	 * A checkout race must stop before the controller moves main or configures
	 * commit identity for a different tree.
	 */
	it("refuses a checkout that differs from the gated SHA", async () => {
		const events: string[] = [];
		await expect(
			materializeGatedReleaseSource("proved-main-sha", {
				currentSha: async () => "newer-main-sha",
				switchMain: async sha => {
					events.push(`switch:${sha}`);
				},
				configureGitIdentity: async () => {
					events.push("identity");
				},
			}),
		).rejects.toThrow("release checkout is newer-main-sha, expected gated SHA proved-main-sha");
		expect(events).toEqual([]);
	});

	/**
	 * The controller executes one ordered transaction from the gated source
	 * through the exact published release and returns all run evidence.
	 */
	it("runs materialization, cut, and publication in order", async () => {
		const events: string[] = [];
		const operations: ReleaseTrainOperations = {
			materialize: async sha => {
				events.push(`materialize:${sha}`);
			},
			cut: async version => {
				events.push(`cut:${version}`);
				return { tag: "v1.2.3", sha: "release-sha", version: "1.2.3" };
			},
			publish: async (tag, sha) => {
				events.push(`publish:${tag}:${sha}`);
				return {
					checksRunId: 201,
					ciRunId: 202,
					url: "https://github.com/santhreal/veyyon/releases/tag/v1.2.3",
				};
			},
		};

		const result = await runReleaseTrain("patch", "source-sha", operations);
		expect(events).toEqual(["materialize:source-sha", "cut:patch", "publish:v1.2.3:release-sha"]);
		expect(result).toEqual({
			tag: "v1.2.3",
			sha: "release-sha",
			version: "1.2.3",
			checksRunId: 201,
			ciRunId: 202,
			url: "https://github.com/santhreal/veyyon/releases/tag/v1.2.3",
		});
	});

	/**
	 * A failed cut leaves no valid tag to publish. The controller must preserve
	 * that failure and never enter either dispatched workflow.
	 */
	it("stops before publication when the atomic cut fails", async () => {
		let published = false;
		await expect(
			runReleaseTrain("patch", "source-sha", {
				materialize: async () => {},
				cut: async () => {
					throw new Error("atomic push rejected");
				},
				publish: async () => {
					published = true;
					return { checksRunId: 201, ciRunId: 202, url: "unexpected" };
				},
			}),
		).rejects.toThrow("atomic push rejected");
		expect(published).toBe(false);
	});

	/**
	 * The dispatched version is bound to the operator-validated SHA and to CI and Checks evidence for
	 * that exact commit. This gate is the only path to a tag.
	 */
	it("binds the dispatched version to exact main and source gates", async () => {
		const accepted = await decideWorkflowRelease(
			{
				eventName: "workflow_dispatch",
				dispatchVersion: "minor",
				expectedSha: "validated-sha",
			},
			gateOperations({ mainSha: "validated-sha", facts: greenFacts("validated-sha") }),
		);
		expect(accepted).toEqual({
			version: "minor",
			sourceSha: "validated-sha",
			reason: "manual release request passed exact-SHA CI and Checks",
		});

		await expect(
			decideWorkflowRelease(
				{ eventName: "workflow_dispatch", dispatchVersion: "minor", expectedSha: "validated-sha" },
				gateOperations({ mainSha: "advanced-main-sha" }),
			),
		).rejects.toThrow("main is at advanced-main-sha, but the operator validated validated-sha");

		const redFacts = greenFacts("validated-sha");
		redFacts.sourceWorkflowRuns[0] = {
			name: "CI",
			headSha: "validated-sha",
			status: "completed",
			conclusion: "failure",
		};
		await expect(
			decideWorkflowRelease(
				{ eventName: "workflow_dispatch", dispatchVersion: "minor", expectedSha: "validated-sha" },
				gateOperations({ mainSha: "validated-sha", facts: redFacts }),
			),
		).rejects.toThrow("release source gate failed");
	});
});

describe("required publication artifacts", () => {
	/**
	 * A release is requested only by dispatching the Release workflow, so the
	 * manifest must expose no workstation entry point into the mutating cutter.
	 */
	it("exposes no workstation release entry point", async () => {
		const manifest = await Bun.file("package.json").json();
		expect(manifest.scripts.release).toBeUndefined();
		expect(Object.values(manifest.scripts as Record<string, string>).some(s => s.includes("release.ts"))).toBe(false);
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
		const install = metadata.steps.find(
			(step: { name?: string }) => step.name === "Install release controller dependencies",
		);

		// biome-ignore lint/suspicious/noTemplateCurlyInString: exact GitHub Actions expression is the contract
		expect(detect.env.GH_TOKEN).toBe("${{ secrets.GITHUB_TOKEN }}");
		expect(detect.env.RELEASE_NONCE).toContain("inputs.release_nonce");
		expect(detect.env.DISPATCH_ACTOR).toContain("github.actor");
		// biome-ignore lint/suspicious/noTemplateCurlyInString: exact GitHub Actions expression is the contract
		expect(detect.run).toContain('if [ "${{ github.event_name }}" != "workflow_dispatch" ]');
		expect(detect.run).toContain("grep -Eq '^v[0-9]+\\.[0-9]+\\.[0-9]+$'");
		expect(detect.run).toContain(
			// biome-ignore lint/suspicious/noTemplateCurlyInString: exact GitHub Actions expression is the contract
			'bun scripts/release.ts verify-tag "$release_tag" "${{ github.sha }}" "$RELEASE_NONCE" "$DISPATCH_ACTOR"',
		);
		expect(detect.run).not.toContain("git tag --points-at HEAD");
		expect(setupBun.if).toBe("startsWith(github.ref, 'refs/tags/')");
		expect(install.if).toBe("startsWith(github.ref, 'refs/tags/')");
		expect(install.run).toBe("bun install --frozen-lockfile");
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
		const steps = wf.jobs.release_github.steps;
		const install = steps.find(
			(candidate: { name?: string }) => candidate.name === "Install release tooling dependencies",
		);
		const step = steps.find(
			(candidate: { name?: string }) => candidate.name === "Verify the exact draft asset manifest",
		);
		const draft = steps.find((candidate: { id?: string }) => candidate.id === "draft");
		expect(step).toBeDefined();
		expect(step.env.GH_TOKEN).toBeDefined();
		expect(install.run).toBe("bun install --frozen-lockfile");
		expect([...steps].indexOf(install)).toBeLessThan([...steps].indexOf(step));
		expect(draft.run).toContain('gh api --method POST "repos/$repo/releases"');
		expect(draft.run).toContain("-F draft=true -F prerelease=false -F body=@release-notes.md");
		expect(draft.run).not.toContain("gh release create");
	});

	/** Draft asset APIs return 403 to read-only job tokens, so isolated verification jobs require contents: write. */
	it("downloads draft assets through the release asset API", async () => {
		const wf = await loadYaml("workflows/ci.yml");
		const jobs = [
			wf.jobs.release_github_verify,
			wf.jobs.release_github_verify_linux,
			wf.jobs.release_github_verify_windows,
		];
		for (const [index, job] of jobs.entries()) {
			const download = job.steps.find((step: { name?: string }) => step.name?.startsWith("Download draft"));
			expect(job.permissions.contents).toBe("write");
			expect(download).toBeDefined();
			expect(download.env.GH_TOKEN).toBeDefined();
			// biome-ignore lint/suspicious/noTemplateCurlyInString: `${{ … }}` is a GitHub Actions expression from the workflow YAML, not a missed template literal.
			expect(download.env.RELEASE_ID).toBe("${{ needs.release_github.outputs.release-id }}");
			expect(download.run).toMatch(/releases\/\$(?:env:)?RELEASE_ID\/assets/);
			expect(download.run).toContain("releases/assets/$asset");
			expect(download.run).toContain("application/octet-stream");
			expect(download.run).toContain("has no asset named");
			expect(download.run).not.toContain("gh release download");
			if (index === 2) {
				expect(download.run).toContain("-OutFile $Name");
				expect(download.run).toContain("$LASTEXITCODE -ne 0");
			} else {
				expect(download.run).toContain('> "$name"');
				expect(download.run).toContain("set -euo pipefail");
			}
		}
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
		expect(publish.run).toContain('releases/$RELEASE_ID")');
		expect(publish.run).not.toContain("releases/tags/$RELEASE_TAG");
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
		expect(publish.run).toContain("releases/$RELEASE_ID/assets");
		expect(publish.run).toContain("releases/assets/$asset_id");
		expect(publish.run).toContain("Accept: application/octet-stream");
		expect(publish.run).toContain('> "$remote_dir/$name"');
		expect(publish.run).toContain("release asset has unsafe name");
		expect(publish.run).not.toContain("gh release download");
		expect(publish.run).toContain("diff -u release-proof/local-assets.sha256 remote-assets.sha256");
		expect(publish.run.indexOf("diff -u release-proof/local-assets.sha256")).toBeLessThan(
			publish.run.indexOf('gh api --method PATCH "repos/$GITHUB_REPOSITORY/releases/$RELEASE_ID"'),
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
	/**
	 * The trigger must survive the failure it exists to report.
	 *
	 * This assertion used to require `is-release`, which read the alert's arming condition off
	 * `release_metadata`'s OUTPUT. That is what stranded v1.0.39 in silence: `release_metadata` died
	 * resolving the tag, so it emitted no `is-release`, so the monitor was skipped by the very failure
	 * that needed reporting, producing a job with zero steps and zero output. Whether a run is a
	 * release attempt is knowable from the `github` context alone, and no upstream crash can take that
	 * away, so the tag ref is the trigger and the old condition is now the thing this test forbids.
	 */
	it("arms off the tag ref, not off a job whose death it must report", async () => {
		const wf = await loadYaml("workflows/ci.yml");
		const alert = wf.jobs.release_train_alert;
		expect(alert).toBeDefined();
		expect(alert.if).toContain("always()");
		expect(alert.if).toContain("refs/tags/v");
		expect(alert.if).not.toContain("needs.release_metadata");
		expect(alert.permissions.issues).toBe("write");
	});

	it("the alert observes every release-path job defined in ci.yml", async () => {
		const wf = await loadYaml("workflows/ci.yml");
		const needs: string[] = wf.jobs.release_train_alert.needs;
		// Every job whose failure can jam or falsify a release must feed the
		// alert; a new release_* job added without wiring it here is exactly the
		// silent gap this suite exists to prevent.
		for (const [id, job] of Object.entries(wf.jobs)) {
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

	// The outer controller has failure modes that can precede or follow tagged
	// CI: preflight, an atomic push race, dispatch correlation, and final
	// publication verification. Every one must update the same pinned issue.
	it("release.yml alerts on any failed release controller stage", async () => {
		const wf = await loadYaml("workflows/release.yml");
		const alert = wf.jobs.release_failed_alert;
		expect(alert).toBeDefined();
		expect(alert.if).toContain("always()");
		expect(alert.if).toContain("needs.release.result == 'failure'");
		expect(alert.if).toContain("needs.gate.result == 'cancelled'");
		expect(alert.if).toContain("needs.release.result == 'cancelled'");
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

describe("every third-party action is pinned to one version", () => {
	/**
	 * Sha-pinning above stops a mutable ref. It does not stop TWO immutable refs.
	 *
	 * `actions/checkout` was pinned at v4.4.0 in checks.yml, docs.yml, hashline-soak.yml, leak-sweep.yml
	 * and upstream-radar.yml while ci.yml, release.yml and site.yml were on v6.0.3, and
	 * `actions/download-artifact` was split v4.3.0/v8.0.1 inside ci.yml alone. Nothing failed, because
	 * each pin is individually valid. What the repo had was two checkout behaviours nobody chose,
	 * decided by which file a job happened to live in, and a bump that looked done after touching the
	 * files someone thought to grep.
	 *
	 * The version comment is part of the identity on purpose: two sites naming the same sha with
	 * different version comments are lying to the next reader about what is pinned.
	 */
	async function actionPins(): Promise<Map<string, Map<string, string[]>>> {
		const byAction = new Map<string, Map<string, string[]>>();
		for await (const rel of new Bun.Glob("**/*.yml").scan({ cwd: workflowsDir })) {
			const text = await Bun.file(path.join(workflowsDir, rel)).text();
			text.split("\n").forEach((line, i) => {
				const m = /uses:\s*([A-Za-z0-9._-]+\/[A-Za-z0-9._/-]+)@(\S+)(?:\s*#\s*(.*))?/.exec(line);
				if (!m) return;
				const [, action, sha, comment] = m;
				const pin = `${sha} # ${(comment ?? "").trim()}`;
				const pins = byAction.get(action!) ?? new Map<string, string[]>();
				pins.set(pin, [...(pins.get(pin) ?? []), `${rel}:${i + 1}`]);
				byAction.set(action!, pins);
			});
		}
		return byAction;
	}

	it("names exactly one sha and version comment for each action", async () => {
		const disagreements: string[] = [];
		for (const [action, pins] of await actionPins()) {
			if (pins.size < 2) continue;
			const where = [...pins].map(([pin, sites]) => `${pin} at ${sites.join(", ")}`).join(" | ");
			disagreements.push(`${action}: ${where}`);
		}
		expect(disagreements, "one version per action; bump every site or none").toEqual([]);
	});

	/**
	 * The non-vacuity twin. The assertion above passes over an empty scan and over a scan that found
	 * one lonely site per action, which is exactly the state a broken glob produces.
	 */
	it("scans every workflow and composite action", async () => {
		const pins = await actionPins();
		expect(pins.has("actions/checkout")).toBe(true);
		const sites = [...pins.get("actions/checkout")!.values()].flat();
		// checkout is the one action used by essentially every job, across workflows and both runners.
		expect(sites.length).toBeGreaterThan(20);
		expect(sites.some(site => site.startsWith("workflows/ci.yml"))).toBe(true);
		expect(sites.some(site => site.startsWith("workflows/checks.yml"))).toBe(true);
		expect(sites.some(site => site.startsWith("workflows/release.yml"))).toBe(true);
		// And the composite actions, which live outside `workflows/` and are the easiest to miss.
		expect([...pins.get("actions/upload-artifact")!.values()].flat().some(s => s.startsWith("actions/"))).toBe(true);
	});
});
