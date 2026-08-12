/**
 * Every workflow job declares its own deadline.
 *
 * WHY THIS SUITE EXISTS. A job with no `timeout-minutes` inherits GitHub's default of 360
 * minutes, so a step that stops making progress holds a runner slot for six hours and reports
 * nothing while it does. That is not a hypothetical: the `Changelog entry` job, which normally
 * answers in seconds, sat in one step for over an hour with no output and no verdict. It matters
 * beyond the wasted slot, because a release waits for `CI` and `Checks` to CONCLUDE on the tagged
 * commit (`REQUIRED_WORKFLOWS` in `scripts/release-ship.ts`): a job that can hang for six hours is
 * a release that can hang for six hours, and the operator sees a spinner rather than a failure.
 *
 * WHAT IT CLOSES. Not the one job that hung: every job in every workflow, including the ones
 * added after this was written. The job table is read from the workflow files at run time, so a
 * new job with no deadline turns this red rather than inheriting the six-hour default in silence.
 *
 * WHAT IT DOES NOT CATCH. A deadline that is merely generous. The upper bound below rejects a
 * number large enough to be indistinguishable from no deadline, but a 30-minute cap on a job that
 * should answer in one still passes. It also says nothing about STEP-level timeouts, and nothing
 * about a job that fails fast for the wrong reason.
 */
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

const WORKFLOWS = path.join(import.meta.dir, "..", ".github", "workflows");

/**
 * The longest deadline any job may declare.
 *
 * The nightly sweep runs one process per test file across the whole tree and is the reason this
 * is not tighter. A job that wants more than this is either doing something the CI account cannot
 * afford or has no bound in practice, and either answer belongs in review rather than in a
 * default.
 */
const MAX_MINUTES = 120;

interface WorkflowJob {
	workflow: string;
	job: string;
	timeout: unknown;
}

/** Every job in every workflow, read from disk so a new one cannot arrive unnoticed. */
function workflowJobs(): WorkflowJob[] {
	const jobs: WorkflowJob[] = [];
	for (const file of fs.readdirSync(WORKFLOWS).sort()) {
		if (!file.endsWith(".yml") && !file.endsWith(".yaml")) continue;
		const doc = Bun.YAML.parse(fs.readFileSync(path.join(WORKFLOWS, file), "utf8")) as {
			jobs?: Record<string, { "timeout-minutes"?: unknown }>;
		};
		for (const [job, body] of Object.entries(doc.jobs ?? {})) {
			jobs.push({ workflow: file, job, timeout: body?.["timeout-minutes"] });
		}
	}
	return jobs;
}

describe("every workflow job has a deadline", () => {
	it("finds the workflows it claims to read", () => {
		const jobs = workflowJobs();
		// A sweep that silently reads nothing is the failure mode this guards: the assertions
		// below all pass over an empty list.
		expect(jobs.length).toBeGreaterThan(20);
		expect([...new Set(jobs.map(entry => entry.workflow))]).toContain("ci.yml");
	});

	it("declares timeout-minutes on every job, so none inherits the six-hour default", () => {
		const withoutDeadline = workflowJobs()
			.filter(entry => typeof entry.timeout !== "number")
			.map(entry => `${entry.workflow}: ${entry.job}`);

		expect(
			withoutDeadline,
			"a job with no timeout-minutes runs for up to 360 minutes on a stuck step, and a release " +
				"waiting on CI or Checks waits with it. Give each job the smallest deadline its slowest " +
				"honest run fits inside.",
		).toEqual([]);
	});

	it("keeps every deadline inside a bound a stuck job cannot hide behind", () => {
		const outOfRange = workflowJobs()
			.filter(entry => typeof entry.timeout === "number" && (entry.timeout < 1 || entry.timeout > MAX_MINUTES))
			.map(entry => `${entry.workflow}: ${entry.job} -> ${String(entry.timeout)}`);

		expect(outOfRange, `a deadline must be between 1 and ${MAX_MINUTES} minutes`).toEqual([]);
	});
});
