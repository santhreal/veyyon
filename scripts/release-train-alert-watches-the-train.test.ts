/**
 * The release-train monitor watches every job that can strand a release, and
 * its own trigger cannot be disarmed by the jobs it is watching.
 *
 * `release_train_alert` is the only thing standing between a stalled release
 * train and nobody noticing. It watches the release jobs through `needs:`,
 * reads their results out of the `needs` context, and files or clears one
 * pinned `release-train` issue. Two properties make that work, and neither is
 * visible from reading the job in isolation.
 *
 * First, the watch list has to keep up with the graph. A release job that is
 * not in `needs:` does not appear in the `needs` context at all, so the alert
 * cannot see it fail: the run goes red somewhere the monitor is not looking and
 * the report comes back clean. Adding a job to the release chain and forgetting
 * to add it here is a one-line omission that reintroduces the original silence.
 *
 * Second, and this is the one that actually bit: the alert used to be gated on
 * `needs.release_metadata.result == 'success'`. v1.0.39 (run 30699220856) died
 * inside `Resolve release metadata` itself, that condition went false, and the
 * monitor was SKIPPED on precisely the run that stranded the tag. A monitor
 * whose trigger depends on a job it monitors has a hole exactly where its
 * subject fails hardest, so the gate must rest on the `github` context, which
 * no upstream crash can take away.
 *
 * If this regresses, a release is tagged and never ships, and the job whose
 * entire purpose is to say so either never runs or reports green.
 */
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dir, "..");
const CI_PATH = path.join(REPO_ROOT, ".github", "workflows", "ci.yml");

interface WorkflowJob {
	if?: string;
	needs?: string[] | string;
	permissions?: Record<string, string> | string;
	steps?: { run?: string }[];
}

interface WorkflowDocument {
	jobs?: Record<string, WorkflowJob>;
}

const ALERT = "release_train_alert";
/** The job that turns a draft into a published release. Nothing ships without it. */
const PUBLISH = "release_github_publish";

/** An `if:` reference to an upstream job's outcome, e.g. `needs.foo.result`. */
const JOB_RESULT_REF = /needs\.([A-Za-z0-9_-]+)\.result/g;

function parse(yaml: string): Record<string, WorkflowJob> {
	const doc = Bun.YAML.parse(yaml) as WorkflowDocument;
	return doc.jobs ?? {};
}

/** `needs:` accepts a bare string for the single-dependency case. */
function needsOf(job: WorkflowJob | undefined): string[] {
	const raw = job?.needs;
	if (!raw) return [];
	return typeof raw === "string" ? [raw] : raw;
}

/**
 * Every job whose result decides whether `release_github_publish` runs, plus
 * that job, plus everything waiting downstream of it. Derived from the graph
 * rather than listed by hand, so a new release job joins the required watch
 * list the moment it is wired in, without anyone remembering to update a
 * constant here.
 */
function releasePath(jobs: Record<string, WorkflowJob>): Set<string> {
	const ancestors = new Set<string>();
	const walkUp = (name: string): void => {
		for (const dep of needsOf(jobs[name])) {
			if (ancestors.has(dep)) continue;
			ancestors.add(dep);
			walkUp(dep);
		}
	};
	walkUp(PUBLISH);

	const descendants = new Set<string>();
	for (let changed = true; changed; ) {
		changed = false;
		for (const [name, job] of Object.entries(jobs)) {
			if (name === PUBLISH || descendants.has(name)) continue;
			const deps = needsOf(job);
			if (deps.includes(PUBLISH) || deps.some(d => descendants.has(d))) {
				descendants.add(name);
				changed = true;
			}
		}
	}

	const all = new Set([...ancestors, PUBLISH, ...descendants]);
	all.delete(ALERT);
	return all;
}

const CI_SOURCE = fs.readFileSync(CI_PATH, "utf8");
const CI_JOBS = parse(CI_SOURCE);

describe("the release-train alert watches the whole release train", () => {
	it("watches every job that can strand a release", () => {
		const required = releasePath(CI_JOBS);
		const watched = new Set(needsOf(CI_JOBS[ALERT]));
		expect([...required].filter(job => !watched.has(job)).sort()).toEqual([]);
	});

	/**
	 * Proves the check above is load-bearing rather than vacuous. If the graph
	 * walk silently found nothing, the assertion would pass over an empty set.
	 */
	it("derives a release path that actually contains the publish chain", () => {
		const required = releasePath(CI_JOBS);
		expect(required.has(PUBLISH)).toBe(true);
		expect(required.has("release_github")).toBe(true);
		expect(required.has("release_metadata")).toBe(true);
		expect(required.size).toBeGreaterThan(10);
	});

	/**
	 * The v1.0.39 shape. A trigger that reads a watched job's result is a
	 * trigger that job can switch off by dying, which is when the alert is
	 * needed most.
	 */
	it("does not gate its own trigger on a job it is watching", () => {
		const watched = new Set(needsOf(CI_JOBS[ALERT]));
		const gatedOn = [...(CI_JOBS[ALERT]?.if ?? "").matchAll(JOB_RESULT_REF)]
			.map(m => m[1])
			.filter(job => watched.has(job));
		expect(gatedOn).toEqual([]);
	});

	it("still runs when everything upstream is incomplete", () => {
		expect(CI_JOBS[ALERT]?.if).toContain("always()");
	});

	/**
	 * Reporting is the whole job. `gh issue create`/`comment`/`close` and
	 * `gh label create` are all issues-scoped writes, so without this the alert
	 * detects correctly and then dies unable to say anything.
	 */
	it("carries the permission it needs to report", () => {
		expect(CI_JOBS[ALERT]?.permissions).toMatchObject({ issues: "write" });
	});
});

describe("the checker", () => {
	const chain = `name: CI
jobs:
  release_metadata:
    runs-on: ubuntu-22.04
    steps: [{ run: echo hi }]
  release_github:
    needs: [release_metadata]
    runs-on: ubuntu-22.04
    steps: [{ run: echo hi }]
  release_github_publish:
    needs: [release_github]
    runs-on: ubuntu-22.04
    steps: [{ run: echo hi }]
  release_site_finalize:
    needs: [release_github_publish]
    runs-on: ubuntu-22.04
    steps: [{ run: echo hi }]
  release_train_alert:
    if: \${{ always() && startsWith(github.ref, 'refs/tags/v') }}
    needs: [release_metadata, release_github, release_github_publish, release_site_finalize]
    permissions: { contents: read, issues: write }
    runs-on: ubuntu-22.04
    steps: [{ run: echo hi }]
`;

	it("accepts a fully watched train", () => {
		const jobs = parse(chain);
		const watched = new Set(needsOf(jobs[ALERT]));
		expect([...releasePath(jobs)].filter(j => !watched.has(j))).toEqual([]);
	});

	it("catches a release job that was added to the chain but not to the watch list", () => {
		const jobs = parse(
			chain.replace(
				"needs: [release_metadata, release_github, release_github_publish, release_site_finalize]",
				"needs: [release_metadata, release_github, release_github_publish]",
			),
		);
		const watched = new Set(needsOf(jobs[ALERT]));
		expect([...releasePath(jobs)].filter(j => !watched.has(j))).toEqual(["release_site_finalize"]);
	});

	/** The exact condition that skipped the monitor on v1.0.39. */
	it("catches a trigger gated on a watched job's result", () => {
		const jobs = parse(
			chain.replace(
				"always() && startsWith(github.ref, 'refs/tags/v')",
				"always() && needs.release_metadata.result == 'success'",
			),
		);
		const watched = new Set(needsOf(jobs[ALERT]));
		const gatedOn = [...(jobs[ALERT]?.if ?? "").matchAll(JOB_RESULT_REF)].map(m => m[1]).filter(j => watched.has(j));
		expect(gatedOn).toEqual(["release_metadata"]);
	});

	it("catches a monitor that cannot write issues", () => {
		const jobs = parse(
			chain.replace("permissions: { contents: read, issues: write }", "permissions: { contents: read }"),
		);
		expect(jobs[ALERT]?.permissions).not.toMatchObject({ issues: "write" });
	});
});
