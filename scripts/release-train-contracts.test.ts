// Contracts for the release train's 2026-07-24 derailment fixes. Eight
// consecutive releases (v1.0.28-v1.0.35) were tagged and never published:
// release.yml tagged main HEAD on raw push before ci.yml had tested the sha,
// two red packages/utils tests killed every publish downstream, and nothing
// anywhere alerted — `releases/latest` served a stale binary for hours until a
// manual audit found the jam. Each test here locks one structural fix so the
// same failure mode cannot quietly return.

import { describe, expect, it } from "bun:test";
import * as path from "node:path";

const workflowsDir = path.resolve(import.meta.dir, "..", ".github");

async function loadYaml(rel: string): Promise<any> {
	return Bun.YAML.parse(await Bun.file(path.join(workflowsDir, rel)).text());
}

describe("release.yml tags only after CI is green", () => {
	// The root cause: `on: push` tagged shas whose tests then failed. The
	// workflow must instead consume completed CI runs, so a red main can never
	// grow a release tag.
	it("triggers on workflow_run of CI (completed, main), never on raw push", async () => {
		const wf = await loadYaml("workflows/release.yml");
		expect(wf.on.push).toBeUndefined();
		expect(wf.on.workflow_run).toEqual({ workflows: ["CI"], types: ["completed"], branches: ["main"] });
		// Manual dispatch stays as the explicit human override.
		expect(wf.on.workflow_dispatch).toBeDefined();
	});

	it("the gate job refuses non-green CI conclusions at the job level", async () => {
		const wf = await loadYaml("workflows/release.yml");
		expect(wf.jobs.gate.if).toContain("github.event.workflow_run.conclusion == 'success'");
	});

	it("the gate's decide step defers when the green run is not main HEAD (stale-sha guard)", async () => {
		const raw = await Bun.file(path.join(workflowsDir, "workflows/release.yml")).text();
		// The step must compare the CI run's head sha against the checked-out
		// main HEAD and defer to the newer run's gate instead of releasing
		// commits CI has not finished testing.
		expect(raw).toContain('if [ "$CI_HEAD_SHA" != "$main_head" ]');
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
	// check failure, atomic bump push rejected because main advanced mid-cut,
	// missing RELEASE_PAT); a red cut with no alert is the same silent jam the
	// publish alert exists to prevent.
	it("release.yml alerts on a failed cut with the same release-train issue", async () => {
		const wf = await loadYaml("workflows/release.yml");
		const alert = wf.jobs.cut_failed_alert;
		expect(alert).toBeDefined();
		expect(alert.if).toContain("always()");
		expect(alert.if).toContain("needs.release.result == 'failure'");
		expect(alert.permissions.issues).toBe("write");
		const raw = await Bun.file(path.join(workflowsDir, "workflows/release.yml")).text();
		expect(raw).toContain("--label release-train");
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
