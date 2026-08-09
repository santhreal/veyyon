/**
 * The two decisions `bun run release` makes on the operator's behalf.
 *
 * WHY IT EXISTS. Shipping automates the wait between pushing a bump and tagging
 * it, and the whole value of that wait is that the tag lands on a SHA whose
 * gates finished green. Getting the verdict wrong in the optimistic direction
 * publishes binaries from an untested commit, which is how v1.0.36 shipped with
 * its Checks run cancelled. Getting it wrong pessimistically is cheap by
 * comparison, so every case below is written from the question "could this
 * reading of the run list tag something it should not".
 *
 * The verdict is a pure function precisely so it can be tested against real
 * `gh run list` conclusions instead of by cutting releases.
 */
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { checkVerdict, failureAdvice, REQUIRED_WORKFLOWS, type RunSummary, runsForSha } from "./release-ship";

/** Run ids ascend in construction order, so a later-built run is the newer one. */
let nextRunId = 1;

function run(workflowName: string, status: string, conclusion = "", createdAt = "2026-08-07T10:00:00Z"): RunSummary {
	return {
		workflowName,
		status,
		conclusion,
		url: `https://example.invalid/${workflowName}`,
		createdAt,
		databaseId: nextRunId++,
	};
}

const done = (name: string, conclusion: string, createdAt?: string) => run(name, "completed", conclusion, createdAt);

describe("checkVerdict", () => {
	it("is green only once every required workflow has finished successfully", () => {
		expect(checkVerdict([done("CI", "success"), done("Checks", "success")])).toEqual({ state: "green" });
	});

	/**
	 * The dangerous case. Seconds after a push GitHub may have registered only
	 * one workflow, and a verdict that judged "everything I can see passed"
	 * would tag on the strength of a run list that had not filled in yet.
	 */
	it("waits for a required workflow that has not appeared yet", () => {
		const verdict = checkVerdict([done("CI", "success")]);
		expect(verdict).toEqual({ state: "pending", waitingOn: ["Checks (not started)"] });
	});

	it("waits while a required workflow is still queued or running", () => {
		expect(checkVerdict([run("CI", "in_progress"), done("Checks", "success")])).toEqual({
			state: "pending",
			waitingOn: ["CI"],
		});
		expect(checkVerdict([run("CI", "queued"), done("Checks", "success")])).toEqual({
			state: "pending",
			waitingOn: ["CI"],
		});
	});

	/**
	 * Path-filtered workflows are not required, but a release must not step over
	 * one that ran and failed. Only the waiting is scoped to the required set;
	 * the passing is not.
	 */
	it("fails on a workflow that is not required but did run and fail", () => {
		const verdict = checkVerdict([done("CI", "success"), done("Checks", "success"), done("Docs", "failure")]);
		expect(verdict.state).toBe("failed");
		expect(verdict.state === "failed" && verdict.failures.map(f => f.workflowName)).toEqual(["Docs"]);
	});

	/** A path filter that skipped a workflow is the filter working, not a gate failing. */
	it("treats a skipped workflow as a pass", () => {
		expect(checkVerdict([done("CI", "success"), done("Checks", "success"), done("Site", "skipped")])).toEqual({
			state: "green",
		});
	});

	/**
	 * A cancelled run proves nothing about the SHA. #2564 was exactly this: a
	 * release whose gate was cancelled by later branch churn, and "not a
	 * failure" read as "a pass".
	 */
	it("refuses a cancelled run rather than reading it as not-a-failure", () => {
		const verdict = checkVerdict([done("CI", "success"), done("Checks", "cancelled")]);
		expect(verdict.state).toBe("failed");
	});

	it("refuses timed_out, neutral and action_required alike", () => {
		for (const conclusion of ["timed_out", "neutral", "action_required", "stale"]) {
			expect(checkVerdict([done("CI", "success"), done("Checks", conclusion)]).state).toBe("failed");
		}
	});

	/**
	 * Pending outranks failed while anything is still running, so the caller
	 * keeps polling and reports one final verdict rather than racing a failure
	 * against a run that has not finished.
	 */
	it("reports pending rather than failed while a run is still going", () => {
		expect(checkVerdict([done("CI", "failure"), run("Checks", "in_progress")]).state).toBe("pending");
	});

	/** An empty list is the instant after a push, not a clean bill of health. */
	it("never calls an empty run list green", () => {
		expect(checkVerdict([]).state).toBe("pending");
	});

	/**
	 * WHY. One SHA carries several runs of the same workflow: a re-run after a
	 * cancellation, a `workflow_dispatch` on top of the push run, a run someone
	 * stopped by hand. Counting every run made a green verdict unreachable,
	 * because a cancelled run never leaves the list: four of the last six `CI`
	 * runs on main were cancelled, and re-running CI to green could not clear the
	 * cut, so the release had to be tagged by hand. Only the newest run of each
	 * workflow decides, in whichever order GitHub lists them, and a newer red
	 * still outvotes an older green.
	 *
	 * What this does NOT catch: whether the newest run is the one that ran the
	 * gates. A dispatched run with a narrower job set has the same shape here.
	 */
	describe("several runs of one workflow", () => {
		const older = "2026-08-07T10:00:00Z";
		const newer = "2026-08-07T11:00:00Z";

		it("lets a re-run clear a cancelled gate, in either list order", () => {
			const ci = done("CI", "success", older);
			const cancelled = done("Checks", "cancelled", older);
			const rerun = done("Checks", "success", newer);
			expect(checkVerdict([ci, cancelled, rerun])).toEqual({ state: "green" });
			expect(checkVerdict([rerun, cancelled, ci])).toEqual({ state: "green" });
		});

		it("keeps a newer failure over an older success", () => {
			const verdict = checkVerdict([
				done("CI", "success", older),
				done("Checks", "success", older),
				done("Checks", "failure", newer),
			]);
			expect(verdict.state).toBe("failed");
			expect(verdict.state === "failed" && verdict.failures.map(entry => entry.workflowName)).toEqual(["Checks"]);
		});

		it("waits while the newest run of a workflow is still going", () => {
			expect(
				checkVerdict([
					done("CI", "success", older),
					done("Checks", "failure", older),
					run("Checks", "in_progress", "", newer),
				]),
			).toEqual({ state: "pending", waitingOn: ["Checks"] });
		});

		it("breaks a creation-time tie on the run id GitHub increments", () => {
			const ci = done("CI", "success", older);
			const stale = done("Checks", "cancelled", older);
			const fresh = done("Checks", "success", older);
			expect(fresh.databaseId).toBeGreaterThan(stale.databaseId);
			expect(checkVerdict([ci, stale, fresh])).toEqual({ state: "green" });
			expect(checkVerdict([ci, fresh, done("Checks", "cancelled", older)]).state).toBe("failed");
		});
	});
});

/**
 * WHY. A red verdict has two causes that look identical in a run list and want
 * opposite responses. A failing suite means fix main. A CANCELLED run means the
 * release commit was never judged: nothing is broken and the run needs re-running.
 * Printing "fix main" for that sends the operator to look for a defect that does
 * not exist, which is how a recoverable cut turns into a hand-tagged release.
 *
 * What this does NOT catch: whether the run ids printed are re-runnable. A run
 * from a deleted workflow file cannot be re-run and this still offers it.
 */
describe("failureAdvice", () => {
	it("offers a re-run, and never says fix main, when every failure is a cancellation", () => {
		const advice = failureAdvice([done("CI", "cancelled"), done("Checks", "cancelled")], "v9.9.9").join("\n");
		expect(advice).toContain("CANCELLED");
		expect(advice).toContain("gh run rerun");
		expect(advice).toContain("no defect to look for");
		expect(advice).not.toContain("Fix main");
	});

	it("names each cancelled run's id, so the re-run does not have to be looked up", () => {
		const ci = done("CI", "cancelled");
		const checks = done("Checks", "cancelled");
		const advice = failureAdvice([ci, checks], "v9.9.9").join("\n");
		expect(advice).toContain(`gh run rerun ${ci.databaseId}`);
		expect(advice).toContain(`gh run rerun ${checks.databaseId}`);
	});

	it("says fix main when a cancellation sits beside a real failure", () => {
		const advice = failureAdvice([done("CI", "cancelled"), done("Checks", "failure")], "v9.9.9").join("\n");
		expect(advice).toContain("Fix main");
		expect(advice).not.toContain("gh run rerun");
	});

	it("says fix main for a plain failure", () => {
		const advice = failureAdvice([done("Checks", "timed_out")], "v9.9.9").join("\n");
		expect(advice).toContain("Fix main");
	});

	/** Both branches end at the same place: the commit is on main and still tag-able. */
	it("always ends with the tag command for this version", () => {
		for (const failures of [[done("CI", "cancelled")], [done("CI", "failure")]]) {
			expect(failureAdvice(failures, "v9.9.9").join("\n")).toContain("git tag v9.9.9 && git push origin v9.9.9");
		}
	});
});

/**
 * `REQUIRED_WORKFLOWS` is the set the waiter blocks on, and it is a hand-kept
 * mirror of which workflows fire on every main push. Add an unconditional gate
 * without updating it and shipping stops waiting for that gate: it would tag
 * the moment CI and Checks finished, while the new one was still running. That
 * is the same class of hole as the cancelled-gate release, so it is pinned
 * against the workflow files rather than trusted to review.
 */
describe("REQUIRED_WORKFLOWS", () => {
	const dir = path.resolve(import.meta.dirname, "..", ".github", "workflows");

	/** The workflow's `name:`, plus whether `on.push` fires for main with no `paths:` filter. */
	function inspect(file: string): { name: string; unconditionalOnMain: boolean } {
		const lines = fs.readFileSync(path.join(dir, file), "utf8").split("\n");
		const name =
			lines
				.find(line => line.startsWith("name:"))
				?.slice(5)
				.trim() ?? file;

		const onIndex = lines.findIndex(line => /^on:/.test(line));
		if (onIndex < 0) return { name, unconditionalOnMain: false };
		// The `on:` block runs until the next top-level key. Indent width differs
		// between these files (ci.yml uses three spaces, checks.yml two), so the
		// block is bounded by dedent-to-column-zero rather than by a fixed width.
		let end = lines.length;
		for (let i = onIndex + 1; i < lines.length; i++) {
			if (/^\S/.test(lines[i] ?? "")) {
				end = i;
				break;
			}
		}
		const block = lines.slice(onIndex + 1, end);

		const pushAt = block.findIndex(line => /^\s+push:/.test(line));
		if (pushAt < 0) return { name, unconditionalOnMain: false };
		const pushIndent = (block[pushAt] ?? "").search(/\S/);
		let pushEnd = block.length;
		for (let i = pushAt + 1; i < block.length; i++) {
			const line = block[i] ?? "";
			if (line.trim().length > 0 && line.search(/\S/) <= pushIndent) {
				pushEnd = i;
				break;
			}
		}
		const pushBlock = block.slice(pushAt + 1, pushEnd);
		const onMain = pushBlock.some(line => /branches:.*\bmain\b/.test(line));
		const filtered = pushBlock.some(line => /^\s+paths(-ignore)?:/.test(line));
		return { name, unconditionalOnMain: onMain && !filtered };
	}

	it("names exactly the workflows that run on every push to main", () => {
		const files = fs.readdirSync(dir).filter(file => file.endsWith(".yml"));
		expect(files.length).toBeGreaterThan(2);
		const unconditional = files
			.map(inspect)
			.filter(entry => entry.unconditionalOnMain)
			.map(entry => entry.name)
			.sort();
		expect(unconditional).toEqual([...REQUIRED_WORKFLOWS].sort());
	});
});

/**
 * WHY. The verdict is only as good as the run list it reads, and the obvious
 * query returns a list that is not the one you want. `gh run list --commit
 * <sha>` is every workflow GitHub associates with that SHA, newest first, and
 * schedules land on main's tip too: `Upstream radar` runs hourly. Asked for
 * `d406c561` with a 50-run window, GitHub returned 50 `Upstream radar` runs and
 * neither `CI` nor `Checks`, so the waiter reported "not started" for two
 * workflows that had already run and FAILED. Raising the limit moves the cliff.
 * Scoping the query removes it.
 */
describe("runsForSha", () => {
	function withFakeGh(body: string): { dir: string; calls: () => string[] } {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "release-ship-gh-"));
		const log = path.join(dir, "calls.log");
		fs.writeFileSync(path.join(dir, "gh"), `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(log)}\n${body}\n`, {
			mode: 0o755,
		});
		return {
			dir,
			calls: () => (fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n") : []),
		};
	}

	it("asks per required workflow, so an unrelated schedule cannot displace a required run", async () => {
		const fake = withFakeGh(
			`case "$*" in
  *"--workflow CI"*) echo '[{"workflowName":"CI","status":"completed","conclusion":"failure","url":"u/ci","createdAt":"2026-08-07T10:00:00Z","databaseId":1}]' ;;
  *"--workflow Checks"*) echo '[{"workflowName":"Checks","status":"completed","conclusion":"failure","url":"u/checks","createdAt":"2026-08-07T10:00:00Z","databaseId":2}]' ;;
  *) echo '[]' ;;
esac`,
		);
		const previousPath = process.env.PATH;
		process.env.PATH = `${fake.dir}${path.delimiter}${previousPath}`;
		try {
			const runs = await runsForSha("deadbeef");
			// Both required runs are visible, which is the whole point: an
			// unscoped query returned neither for this exact commit.
			expect(checkVerdict(runs)).toEqual({
				state: "failed",
				failures: [
					{
						workflowName: "CI",
						status: "completed",
						conclusion: "failure",
						url: "u/ci",
						createdAt: "2026-08-07T10:00:00Z",
						databaseId: 1,
					},
					{
						workflowName: "Checks",
						status: "completed",
						conclusion: "failure",
						url: "u/checks",
						createdAt: "2026-08-07T10:00:00Z",
						databaseId: 2,
					},
				],
			});
			// One scoped query per required workflow, never one broad one.
			const calls = fake.calls();
			expect(calls).toHaveLength(REQUIRED_WORKFLOWS.length);
			for (const workflow of REQUIRED_WORKFLOWS) {
				expect(calls.some(call => call.includes(`--workflow ${workflow}`))).toBe(true);
			}
			for (const call of calls) expect(call).toContain("--commit deadbeef");
		} finally {
			process.env.PATH = previousPath;
			fs.rmSync(fake.dir, { recursive: true, force: true });
		}
	});

	/**
	 * WHY. `latestPerWorkflow` can only order runs it was given the ordering
	 * fields for, and those fields come from the `--json` list in this file. Drop
	 * `createdAt` from that list and every run ties, the first entry wins, and a
	 * superseded cancellation quietly decides the release again. So the fake
	 * answers with the ordering fields only when the query asks for them, and it
	 * lists the older cancelled run FIRST: the verdict is green only if the query
	 * asked and the newer run was picked.
	 */
	it("asks for the fields the newest-run rule needs", async () => {
		const fake = withFakeGh(
			`ordered=""
case "$*" in
  *createdAt*databaseId*) ordered=yes ;;
esac
case "$*" in
  *"--workflow CI"*)
    if [ -n "$ordered" ]; then
      echo '[{"workflowName":"CI","status":"completed","conclusion":"success","url":"u/ci","createdAt":"2026-08-07T10:00:00Z","databaseId":1}]'
    else
      echo '[{"workflowName":"CI","status":"completed","conclusion":"success","url":"u/ci"}]'
    fi ;;
  *"--workflow Checks"*)
    if [ -n "$ordered" ]; then
      echo '[{"workflowName":"Checks","status":"completed","conclusion":"cancelled","url":"u/old","createdAt":"2026-08-07T10:00:00Z","databaseId":2},{"workflowName":"Checks","status":"completed","conclusion":"success","url":"u/new","createdAt":"2026-08-07T11:00:00Z","databaseId":3}]'
    else
      echo '[{"workflowName":"Checks","status":"completed","conclusion":"cancelled","url":"u/old"},{"workflowName":"Checks","status":"completed","conclusion":"success","url":"u/new"}]'
    fi ;;
  *) echo '[]' ;;
esac`,
		);
		const previousPath = process.env.PATH;
		process.env.PATH = `${fake.dir}${path.delimiter}${previousPath}`;
		try {
			expect(checkVerdict(await runsForSha("deadbeef"))).toEqual({ state: "green" });
		} finally {
			process.env.PATH = previousPath;
			fs.rmSync(fake.dir, { recursive: true, force: true });
		}
	});

	it("refuses output that is not a run list rather than reading it as no runs", async () => {
		const fake = withFakeGh("echo 'not json'");
		const previousPath = process.env.PATH;
		process.env.PATH = `${fake.dir}${path.delimiter}${previousPath}`;
		try {
			await expect(runsForSha("deadbeef")).rejects.toThrow();
		} finally {
			process.env.PATH = previousPath;
			fs.rmSync(fake.dir, { recursive: true, force: true });
		}
	});
});
