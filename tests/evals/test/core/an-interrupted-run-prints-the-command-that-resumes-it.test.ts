/**
 * WHY: a run stopped by SIGINT or SIGTERM prints the command that resumes it. The command named the
 * suite, the run id and `--resume` and nothing else, so it was refused for want of `--model`, and
 * with the model restated by hand it still planned a different run: without `--build`, `--config`,
 * `--prompts` or `--attempts`, the plan digest no longer matched the journal, or the resumed trials
 * ran under other settings than the settled ones.
 *
 * THE CLASS: a resume command that drops part of the invocation it resumes. The case writes an
 * invocation that states every flag the grammar declares, swept from `VALUE_FLAGS` and
 * `BOOLEAN_FLAGS` so a flag added there fails here until it has a value, and asserts the resume
 * arguments of each suite parse to that invocation with only the suite, its tasks, the run id and
 * `--resume` replaced, for both spellings of a value flag.
 *
 * Not caught: the shell quoting of the printed line, which is not parsed back here.
 */
import { describe, expect, it } from "bun:test";
import { BOOLEAN_FLAGS, parseEvalsArgs, resumeArguments, tasksForSuite, VALUE_FLAGS } from "../../evals";

/** A valid value for every value flag. Two suites, so a resume names one of them. */
const VALUE: Record<string, string> = {
	"--suite": "browser,miniwob",
	"--harness": "veyyon",
	"--config": "/overlays/a.yml",
	"--prompts": "/overlays/p.json",
	"--build": "base=/src/base,head=/src/head",
	"--model": "vendor/model-a,vendor/model-b",
	"--tasks": "browser=task-one,miniwob=task-two,shared-task",
	"--limit": "3",
	"--repeats": "2",
	"--attempts": "3",
	"--jobs": "4",
	"--runs-dir": "/runs",
	"--work-dir": "/work",
	"--dataset-dir": "/data",
	"--run-id": "interrupted",
	"--trial-timeout": "60",
	"--agent-timeout": "30",
	"--timeout-multiplier": "1.5",
};

/** A harness-declared flag, which the grammar accepts beside its own. */
const HARNESS_FLAGS = ["auth-db"];

function invocation(spelling: "apart" | "joined"): string[] {
	const argv: string[] = [];
	for (const flag of Object.keys(VALUE_FLAGS)) {
		const value = VALUE[flag] as string;
		argv.push(...(spelling === "apart" ? [flag, value] : [`${flag}=${value}`]));
	}
	argv.push("--auth-db", "/stores/agent.db", ...Object.keys(BOOLEAN_FLAGS));
	return argv;
}

describe("the command an interrupted run prints to resume it", () => {
	it("is checked against every value flag the grammar declares", () => {
		expect(Object.keys(VALUE).sort()).toEqual(Object.keys(VALUE_FLAGS).sort());
	});

	for (const spelling of ["apart", "joined"] as const) {
		it(`plans the interrupted run again, with each value written ${spelling}`, () => {
			const argv = invocation(spelling);
			const original = parseEvalsArgs(argv, HARNESS_FLAGS);
			expect(original.suites).toEqual(["browser", "miniwob"]);
			for (const suite of original.suites) {
				const tasks = tasksForSuite(original.tasks, suite, original.suites);
				const runId = `interrupted-${suite}`;

				const resumed = parseEvalsArgs(resumeArguments(argv, { suite, tasks, runId }), HARNESS_FLAGS);

				expect(resumed).toEqual({ ...original, suites: [suite], tasks: [...tasks], runId, resume: true });
				// The resumed invocation runs one suite, so its tasks are the ones that applied to it.
				expect(tasksForSuite(resumed.tasks, suite, resumed.suites)).toEqual(tasks);
			}
		});
	}
});
