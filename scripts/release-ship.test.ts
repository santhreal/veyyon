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
import * as path from "node:path";
import { checkVerdict, REQUIRED_WORKFLOWS, type RunSummary } from "./release-ship";

function run(workflowName: string, status: string, conclusion = ""): RunSummary {
	return { workflowName, status, conclusion, url: `https://example.invalid/${workflowName}` };
}

const done = (name: string, conclusion: string) => run(name, "completed", conclusion);

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
